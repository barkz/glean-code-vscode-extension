import * as vscode from "vscode";
import { ReplManager } from "./replManager";

const SLASH_COMMANDS = [
  "/help",
  "/status",
  "/doctor",
  "/login",
  "/logout",
  "/config",
  "/mode",
  "/history",
  "/clear",
  "/chat",
  "/search",
  "/datasources.list",
  "/datasources.status",
  "/autocomplete",
  "/recommendations",
  "/feedback",
  "/insights",
  "/agents.list",
  "/agents.run",
  "/tools.list",
  "/tools.call",
  "/docs.get",
  "/docs.permissions",
  "/entities.list",
  "/people.get",
  "/collections.list",
  "/pins.list",
  "/scaffold",
];

export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = "gleanCode.chatView";
  private view?: vscode.WebviewView;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly repl: ReplManager,
  ) {
    this.repl.on("stdout", (text) => this.post({ kind: "stdout", text }));
    this.repl.on("stderr", (text) => this.post({ kind: "stderr", text }));
    this.repl.on("exit", (code) => this.post({ kind: "exit", code }));
    this.repl.on("spawned", () => this.post({ kind: "spawned" }));
  }

  private post(msg: any) {
    this.view?.webview.postMessage(msg);
  }

  notifyRestarted() {
    this.post({ kind: "restarted" });
  }

  runLine(line: string) {
    if (!this.view) return;
    this.post({ kind: "echo", text: line });
    this.repl.send(line);
  }

  resolveWebviewView(view: vscode.WebviewView): void | Thenable<void> {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
    };
    view.webview.html = this.getHtml(view.webview);

    view.webview.onDidReceiveMessage((msg) => {
      switch (msg?.type) {
        case "ready":
          this.repl.start();
          this.post({ kind: "slashCommands", items: SLASH_COMMANDS });
          break;
        case "send":
          if (typeof msg.line === "string" && msg.line.trim()) {
            this.runLine(msg.line);
          }
          break;
        case "restart":
          this.repl.restart();
          this.post({ kind: "restarted" });
          break;
        case "copy":
          if (typeof msg.text === "string") {
            vscode.env.clipboard.writeText(msg.text);
            vscode.window.setStatusBarMessage("Glean Code: copied", 1500);
          }
          break;
        case "openUrl":
          // URLs are scraped from REPL output, i.e. from indexed content, so
          // only web links are opened — never command:, file: or vscode: URIs.
          if (typeof msg.url === "string") {
            let uri: vscode.Uri | undefined;
            try {
              uri = vscode.Uri.parse(msg.url, true);
            } catch {
              uri = undefined;
            }
            if (uri && (uri.scheme === "http" || uri.scheme === "https")) {
              vscode.env.openExternal(uri);
            } else {
              vscode.window.showWarningMessage(
                `Glean Code: not opening ${msg.url} — only http and https links are opened.`,
              );
            }
          }
          break;
      }
    });
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
      <div class="gc-title">Glean Code <span class="gc-tag">REPL</span></div>
      <div class="gc-actions">
        <button id="gc-restart" title="Restart the Python REPL">Restart</button>
      </div>
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
