import * as vscode from "vscode";
import { ChatViewProvider } from "./webviewProvider";
import { PythonBridge } from "./pythonBridge";

/** Surface returned from activate() so integration tests can drive the bridge. */
export interface GleanCodeApi {
  bridge: PythonBridge;
  provider: ChatViewProvider;
}

export function activate(context: vscode.ExtensionContext): GleanCodeApi {
  const bridge = new PythonBridge(context);
  const provider = new ChatViewProvider(context, bridge);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    bridge,
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("gleanCodeBridge.focusChat", async () => {
      await vscode.commands.executeCommand("gleanCodeBridge.chatView.focus");
    }),
    vscode.commands.registerCommand("gleanCodeBridge.restartBridge", () => {
      bridge.restart();
      provider.notify("system", "Bridge restarting...");
    }),
    vscode.commands.registerCommand("gleanCodeBridge.search", async () => {
      const query = await vscode.window.showInputBox({ prompt: "Glean search", placeHolder: "query" });
      if (!query) return;
      await vscode.commands.executeCommand("gleanCodeBridge.focusChat");
      provider.dispatchSlash(`/search ${query}`);
    }),
    vscode.commands.registerCommand("gleanCodeBridge.chat", async () => {
      const msg = await vscode.window.showInputBox({ prompt: "Ask Glean Assistant", placeHolder: "message" });
      if (!msg) return;
      await vscode.commands.executeCommand("gleanCodeBridge.focusChat");
      provider.dispatchSlash(msg);
    }),
    vscode.commands.registerCommand("gleanCodeBridge.status", async () => {
      try {
        const r = await bridge.call("status", {});
        vscode.window.showInformationMessage(
          `Glean Code: mode=${r.mode}, instance=${r.instance ?? "(unset)"}, token=${r.has_api_token ? "set" : "unset"}`,
        );
      } catch (e) {
        vscode.window.showErrorMessage((e as Error).message);
      }
    }),
  );

  return { bridge, provider };
}

export function deactivate() {}
