/**
 * Prepare the CLI's /graph HTML page for a VS Code webview tab.
 *
 * glean_code.graph.render_html returns a self-contained page (inline style
 * and script, no network). A webview runs it as-is only under a CSP that
 * allows that script, so every <script> gets a nonce and a strict CSP is
 * injected: no network, no eval, and no `javascript:` URLs from document
 * content. Pure — no vscode import — so the integration test can check it.
 */
export function prepareGraphHtml(html: string, nonce: string, cspSource: string): string {
  const csp = [
    `default-src 'none'`,
    `style-src ${cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `img-src ${cspSource} data:`,
  ].join("; ");
  const meta = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
  const withNonce = html.replace(/<script(?=[\s>])/g, `<script nonce="${nonce}"`);
  // The CSP must come before anything it governs, so it goes first in <head>.
  return /<head[^>]*>/i.test(withNonce)
    ? withNonce.replace(/<head[^>]*>/i, (m) => m + meta)
    : meta + withNonce;
}
