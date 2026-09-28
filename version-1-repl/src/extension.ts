import * as vscode from "vscode";
import { ChatViewProvider } from "./webviewProvider";
import { ReplManager } from "./replManager";

export function activate(context: vscode.ExtensionContext) {
  const repl = new ReplManager(context);
  const provider = new ChatViewProvider(context, repl);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    repl,
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("gleanCode.focusChat", async () => {
      await vscode.commands.executeCommand("gleanCode.chatView.focus");
    }),
    vscode.commands.registerCommand("gleanCode.restartRepl", () => {
      repl.restart();
      provider.notifyRestarted();
    }),
    vscode.commands.registerCommand("gleanCode.runSlashCommand", async () => {
      const input = await vscode.window.showInputBox({
        prompt: "Run a glean-code slash command",
        placeHolder: "/search quarterly planning",
      });
      if (!input) return;
      await vscode.commands.executeCommand("gleanCode.focusChat");
      provider.runLine(input);
    }),
    vscode.commands.registerCommand("gleanCode.search", async () => {
      const q = await vscode.window.showInputBox({ prompt: "Glean search", placeHolder: "query" });
      if (!q) return;
      await vscode.commands.executeCommand("gleanCode.focusChat");
      provider.runLine(`/search ${q}`);
    }),
    vscode.commands.registerCommand("gleanCode.chat", async () => {
      const q = await vscode.window.showInputBox({ prompt: "Ask Glean Assistant", placeHolder: "message" });
      if (!q) return;
      await vscode.commands.executeCommand("gleanCode.focusChat");
      provider.runLine(`/chat ${q}`);
    }),
  );
}

export function deactivate() {
  // ReplManager is a Disposable already wired into context.subscriptions
}
