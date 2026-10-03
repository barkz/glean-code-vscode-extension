import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { prepareGraphHtml } from "./graphPage";
import { PythonBridge } from "./pythonBridge";
import {
  CliCommand,
  SLASH_COMMANDS,
  SlashSpec,
  isWebLink,
  maskSecrets,
  mergeCatalog,
  parseLine,
} from "./slashCommands";

/** Graph pages kept for "Open interactive graph"; older ones are dropped. */
const MAX_GRAPHS = 20;

export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = "gleanCodeBridge.chatView";
  private view?: vscode.WebviewView;
  /** The panel's commands plus the CLI's (cliOnly); see mergeCatalog. */
  private catalog: SlashSpec[] = SLASH_COMMANDS;
  /** Graph HTML by id. Kept host-side so the sidebar never holds the pages. */
  private graphs = new Map<string, { title: string; html: string }>();
  private nextGraph = 1;
  private cliTerminal?: vscode.Terminal;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly bridge: PythonBridge,
  ) {
    this.bridge.on("ready", (status) => this.post({ kind: "ready", status }));
    this.bridge.on("log", (msg) => this.post({ kind: "log", text: msg }));
    this.bridge.on("exit", (code) => this.post({ kind: "exit", code }));
    context.subscriptions.push(
      vscode.window.onDidCloseTerminal((t) => {
        if (t === this.cliTerminal) this.cliTerminal = undefined;
      }),
    );
  }

  /**
   * Replace the built-in list with the CLI's catalogue. An older CLI without
   * the `commands` method just keeps the built-in list.
   */
  private async loadCatalog() {
    try {
      const r = await this.bridge.call<{ commands: CliCommand[] }>("commands", {});
      this.catalog = mergeCatalog(SLASH_COMMANDS, r.commands || []);
      this.post({ kind: "slashCommands", items: this.catalog });
    } catch {
      /* keep SLASH_COMMANDS */
    }
  }

  /** Commands the panel offers: its own plus the CLI's, once loaded. */
  commandCatalog(): SlashSpec[] {
    return this.catalog;
  }

  /**
   * Open the full CLI REPL in a terminal (reusing one that is still open) and
   * optionally type a command into it. This is how the panel reaches every
   * CLI command it doesn't render itself.
   */
  runInCliTerminal(line?: string): vscode.Terminal | undefined {
    if (!this.cliTerminal || this.cliTerminal.exitStatus !== undefined) {
      const opts = this.bridge.cliTerminalOptions();
      if ("error" in opts) {
        this.notify("stderr", opts.error);
        vscode.window.showErrorMessage(opts.error);
        return undefined;
      }
      this.cliTerminal = vscode.window.createTerminal(opts);
    }
    this.cliTerminal.show();
    if (line) this.cliTerminal.sendText(line);
    return this.cliTerminal;
  }

  /** Show a graph from an earlier /graph result in an editor tab. */
  openGraph(id: string): vscode.WebviewPanel | undefined {
    const g = this.graphs.get(id);
    if (!g) {
      this.notify("stderr", "That graph is no longer available — run /graph again.");
      return undefined;
    }
    const panel = vscode.window.createWebviewPanel(
      "gleanCodeBridge.graph",
      g.title,
      vscode.ViewColumn.Active,
      // The page is self-contained: scripts on, no local files, no network.
      { enableScripts: true, localResourceRoots: [] },
    );
    panel.webview.html = prepareGraphHtml(g.html, randomNonce(), panel.webview.cspSource);
    return panel;
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
          this.post({ kind: "slashCommands", items: this.catalog });
          this.bridge
            .start()
            .then(() => this.loadCatalog())
            .catch((e) => this.post({ kind: "notify", level: "stderr", text: (e as Error).message }));
          break;
        case "openGraph":
          if (typeof msg.id === "string") this.openGraph(msg.id);
          break;
        case "runInTerminal":
          if (typeof msg.line === "string") this.runInCliTerminal(msg.line);
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
        // /help lists the full catalogue, not just what the parser knows.
        this.post({ kind: "result", method: parsed.method, payload: { items: this.catalog } });
        return;
      case "error": {
        const known = parsed.unknown && this.catalog.find((c) => c.cmd === parsed.unknown);
        if (known && known.cliOnly) {
          // A real CLI command the panel doesn't render: offer the terminal
          // rather than calling it unknown. The masked line is what's shown;
          // the button sends the line as typed.
          this.post({
            kind: "result",
            method: "cliOnly",
            payload: { cmd: known.cmd, summary: known.summary, line: trimmed },
          });
          return;
        }
        this.post({ kind: "result", method: "error", payload: { error: parsed.error } });
        return;
      }
      case "call":
        return this.callMethod(parsed.method, parsed.params);
    }
  }

  private async callMethod(method: string, params: Record<string, unknown>) {
    try {
      const result = await this.bridge.call(method, params);
      if (method === "graph" && result && typeof result.html === "string") {
        // Keep the page here; the card only needs an id to ask for it.
        const id = String(this.nextGraph++);
        this.graphs.set(id, { title: `Graph: ${result.query}`, html: result.html });
        if (this.graphs.size > MAX_GRAPHS) this.graphs.delete(this.graphs.keys().next().value!);
        const { html: _html, ...card } = result;
        this.post({ kind: "result", method, payload: { ...card, graph_id: id } });
        return;
      }
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
  return randomBytes(16).toString("hex");
}
