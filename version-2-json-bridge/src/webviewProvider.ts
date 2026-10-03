import * as vscode from "vscode";
import { PythonBridge } from "./pythonBridge";
import { SLASH_COMMANDS, isWebLink, maskSecrets, parseLine } from "./slashCommands";

export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = "gleanCodeBridge.chatView";
  private view?: vscode.WebviewView;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly bridge: PythonBridge,
  ) {
    this.bridge.on("ready", (status) => this.post({ kind: "ready", status }));
    this.bridge.on("log", (msg) => this.post({ kind: "log", text: msg }));
    this.bridge.on("exit", (code) => this.post({ kind: "exit", code }));
  }

  private post(msg: any) {
    this.view?.webview.postMessage(msg);
  }

  notify(level: "system" | "stderr", text: string) {
    this.post({ kind: "notify", level, text });
  }

  /** Public entry point used by command-palette commands. */
  async dispatchSlash(line: string) {
    if (!this.view) {
      await vscode.commands.executeCommand("gleanCodeBridge.focusChat");
    }
    this.handleLine(line).catch((e) =>
      this.post({ kind: "result", method: "error", payload: { error: (e as Error).message } }),
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void | Thenable<void> {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
    };
    view.webview.html = this.getHtml(view.webview);

    view.webview.onDidReceiveMessage(async (msg) => {
      switch (msg?.type) {
        case "ready":
          this.post({ kind: "slashCommands", items: SLASH_COMMANDS });
          this.bridge.start().catch((e) =>
            this.post({ kind: "notify", level: "stderr", text: (e as Error).message }),
          );
          break;
        case "send":
          if (typeof msg.line === "string" && msg.line.trim()) {
            await this.handleLine(msg.line.trim());
          }
          break;
        case "openUrl":
          if (typeof msg.url === "string") this.openLink(msg.url);
          break;
        case "copy":
          if (typeof msg.text === "string") {
            vscode.env.clipboard.writeText(msg.text);
            vscode.window.setStatusBarMessage("Glean Code: copied", 1500);
          }
          break;
        case "feedback":
          if (typeof msg.tracking_token === "string" && typeof msg.rating === "string") {
            try {
              await this.bridge.call("feedback", {
                tracking_token: msg.tracking_token,
                rating: msg.rating,
              });
              this.post({
                kind: "notify",
                level: "system",
                text: `Feedback recorded (${msg.rating}).`,
              });
            } catch (e) {
              this.post({ kind: "notify", level: "stderr", text: (e as Error).message });
            }
          }
          break;
      }
    });
  }

  /** Open a result or citation link; see `isWebLink` for why only http(s). */
  private openLink(url: string) {
    if (!isWebLink(url)) {
      this.notify("stderr", `Not opening ${url}: only http and https links are opened.`);
      return;
    }
    vscode.env.openExternal(vscode.Uri.parse(url, true));
  }

  private async handleLine(line: string) {
    const trimmed = line.trim();
    if (!trimmed) return;
    // The webview shows this and keeps it as up-arrow history, so a token
    // typed into /login must not survive into either.
    this.post({ kind: "echo", text: maskSecrets(trimmed) });

    const parsed = parseLine(trimmed);
    if (!parsed) return;

    switch (parsed.kind) {
      case "clear":
        this.post({ kind: "clear" });
        return;
      case "local":
        this.post({ kind: "result", method: parsed.method, payload: parsed.payload });
        return;
      case "error":
        this.post({ kind: "result", method: "error", payload: { error: parsed.error } });
        return;
      case "call":
        return this.callMethod(parsed.method, parsed.params);
    }
  }

  private async callMethod(method: string, params: Record<string, unknown>) {
    try {
      const result = await this.bridge.call(method, params);
      this.post({ kind: "result", method, payload: result });
    } catch (e) {
      this.post({
        kind: "result",
        method: "error",
        payload: { error: (e as Error).message, of: method },
      });
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = randomNonce();
    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "main.css"),
    );
    const jsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "main.js"),
    );
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} https: data:`,
    ].join("; ");

    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <link rel="stylesheet" href="${cssUri}" />
    <title>Glean Code</title>
  </head>
  <body>
    <header class="gc-header">
      <div class="gc-title">Glean Code <span class="gc-tag">JSON</span></div>
      <div id="gc-statusbar" class="gc-statusbar">connecting...</div>
    </header>
    <section id="gc-history" aria-live="polite"></section>
    <div id="gc-suggest" hidden></div>
    <form id="gc-form" autocomplete="off">
      <textarea id="gc-input" rows="2" placeholder="Ask Glean or type / for commands" spellcheck="false"></textarea>
      <button id="gc-send" type="submit">Send</button>
    </form>
    <script nonce="${nonce}" src="${jsUri}"></script>
  </body>
</html>`;
  }
}

function randomNonce(): string {
  const bytes = new Uint8Array(16);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
