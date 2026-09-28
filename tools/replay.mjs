#!/usr/bin/env node
/**
 * Replay a recorded Markdown session into the real webview and screenshot it.
 *
 * The page is assembled from the extension's own media/main.css and
 * media/main.js — the same renderer the panel runs — with acquireVsCodeApi()
 * stubbed and the recorded messages fed in exactly as the extension host would
 * post them. If a card renders wrong here, it renders wrong in VS Code.
 *
 *   node tools/replay.mjs                          # every session, both themes
 *   node tools/replay.mjs --session getting-started --theme dark
 *   node tools/replay.mjs --html-only              # emit HTML, skip Chrome
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const EXT = path.join(REPO, "version-2-json-bridge");
const MEDIA = path.join(EXT, "media");

const argv = process.argv.slice(2);
const opt = (f, d) => {
  const i = argv.indexOf(f);
  if (i === -1) return d;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const only = opt("--session", null);
const themeArg = opt("--theme", "both");
// Chrome enforces a ~500px minimum window width; asking for less silently
// lays out at 500 and then crops the screenshot, which looks like a CSS bug.
const CHROME_MIN_WIDTH = 500;
const requestedWidth = Number(opt("--width", 500));
const width = Math.max(requestedWidth, CHROME_MIN_WIDTH);
if (requestedWidth < CHROME_MIN_WIDTH) {
  console.warn(
    `--width ${requestedWidth} is below Chrome's ${CHROME_MIN_WIDTH}px minimum window width; using ${CHROME_MIN_WIDTH}.`,
  );
}
const outDir = opt("--out", path.join(REPO, "docs", "img"));
const htmlOnly = argv.includes("--html-only");

const CHROME = [
  process.env.CHROME,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
].find((p) => p && fs.existsSync(p));

// ---------- VS Code theme tokens ----------
// Values lifted from the stock Dark Modern / Light Modern themes so the
// screenshots match what a user actually sees.
const THEMES = {
  dark: {
    "--vscode-sideBar-background": "#181818",
    "--vscode-foreground": "#cccccc",
    "--vscode-descriptionForeground": "#9d9d9d",
    "--vscode-panel-border": "#2b2b2b",
    "--vscode-input-background": "#313131",
    "--vscode-input-foreground": "#cccccc",
    "--vscode-button-background": "#0078d4",
    "--vscode-button-foreground": "#ffffff",
    "--vscode-button-hoverBackground": "#026ec1",
    "--vscode-textLink-foreground": "#4daafc",
    "--vscode-errorForeground": "#f85149",
  },
  light: {
    "--vscode-sideBar-background": "#f8f8f8",
    "--vscode-foreground": "#3b3b3b",
    "--vscode-descriptionForeground": "#767676",
    "--vscode-panel-border": "#e5e5e5",
    "--vscode-input-background": "#ffffff",
    "--vscode-input-foreground": "#616161",
    "--vscode-button-background": "#005fb8",
    "--vscode-button-foreground": "#ffffff",
    "--vscode-button-hoverBackground": "#0258a8",
    "--vscode-textLink-foreground": "#005fb8",
    "--vscode-errorForeground": "#e51400",
  },
};
const COMMON = {
  "--vscode-font-family":
    '-apple-system, BlinkMacSystemFont, "Segoe WPC", "Segoe UI", system-ui, sans-serif',
  "--vscode-font-size": "13px",
  "--vscode-editor-font-family": 'Menlo, Monaco, "Courier New", monospace',
};

// ---------- session parsing ----------

/**
 * A session file is Markdown first and a fixture second. We only look at
 * `## \`input\`` headings and ```glean-* fenced blocks; all other prose is
 * documentation and is ignored here.
 */
function parseSession(md) {
  const out = { meta: {}, steps: [], ready: null };

  const fm = md.match(/^---\n([\s\S]*?)\n---\n/);
  let body = md;
  if (fm) {
    for (const line of fm[1].split("\n")) {
      const m = line.match(/^([\w-]+):\s*(.*)$/);
      if (m) out.meta[m[1]] = m[2].trim();
    }
    body = md.slice(fm[0].length);
  }

  const blockRe = /```glean-([\w-]+)([^\n]*)\n([\s\S]*?)\n```/g;
  const headRe = /^##\s+`(.+)`\s*$/gm;

  const heads = [];
  let h;
  while ((h = headRe.exec(body))) heads.push({ input: h[1], at: h.index });

  let b;
  while ((b = blockRe.exec(body))) {
    const kind = b[1];
    const arg = b[2].trim();
    let payload;
    try {
      payload = JSON.parse(b[3]);
    } catch (e) {
      throw new Error(`bad JSON in glean-${kind} block: ${e.message}`);
    }
    const owner = [...heads].reverse().find((x) => x.at < b.index) || null;
    if (kind === "event" && arg === "ready") {
      out.ready = payload;
      continue;
    }
    if (kind === "call") continue; // informational: shows the wire, not rendered
    if (kind === "notify") {
      out.steps.push({ notify: { level: arg || "system", text: payload.text }, done: true });
      continue;
    }
    if (!owner) continue;
    let step = out.steps[out.steps.length - 1];
    if (!step || step.input !== owner.input || step.done) {
      step = { input: owner.input };
      out.steps.push(step);
    }
    if (kind === "clear") step.clear = true;
    else if (kind === "error") step.error = payload;
    else if (kind === "result") step.result = { method: arg || "json", payload };
    step.done = true;
  }
  return out;
}

/** The message sequence the extension host would post, in order. */
function toMessages(session) {
  const msgs = [];
  msgs.push({ kind: "slashCommands", items: [] });
  if (session.ready) msgs.push({ kind: "ready", status: session.ready });
  for (const s of session.steps) {
    if (s.notify) {
      msgs.push({ kind: "notify", level: s.notify.level, text: s.notify.text });
      continue;
    }
    msgs.push({ kind: "echo", text: s.input });
    if (s.clear) msgs.push({ kind: "clear" });
    else if (s.error) msgs.push({ kind: "result", method: "error", payload: s.error });
    else if (s.result) msgs.push({ kind: "result", method: s.result.method, payload: s.result.payload });
  }
  return msgs;
}

// ---------- page assembly ----------

function buildHtml(session, theme, lastInput) {
  const css = fs.readFileSync(path.join(MEDIA, "main.css"), "utf8");
  const js = fs.readFileSync(path.join(MEDIA, "main.js"), "utf8");
  const vars = Object.entries({ ...COMMON, ...THEMES[theme] })
    .map(([k, v]) => `  ${k}: ${v};`)
    .join("\n");
  const msgs = toMessages(session);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${session.meta.title || session.meta.session || "Glean Code"}</title>
<style>
:root {
${vars}
}
/* Harness only: let the transcript lay out at full height so the screenshot
   captures the whole session instead of a scrolled slice. Deliberately does
   NOT touch overflow-x — horizontal clipping is real panel behaviour and the
   screenshots have to show it. */
html, body { height: auto !important; min-height: 0 !important; }
#gc-history { flex: none !important; height: auto !important; }
</style>
<style>${css}</style>
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

  <script>
    // Stand in for the VS Code webview API. Outbound posts are recorded so a
    // replay can assert on them; nothing is sent anywhere.
    window.__posted = [];
    window.acquireVsCodeApi = function () {
      return {
        postMessage: function (m) { window.__posted.push(m); },
        getState: function () { return undefined; },
        setState: function () {},
      };
    };
  </script>

  <script>${js}</script>

  <script>
    // Feed the recorded host messages in the order the extension would send them.
    (function () {
      var msgs = ${JSON.stringify(msgs)};
      for (var i = 0; i < msgs.length; i++) {
        window.dispatchEvent(new MessageEvent("message", { data: msgs[i] }));
      }
      ${lastInput ? `document.getElementById("gc-input").value = ${JSON.stringify(lastInput)};` : ""}
      // Publish the laid-out height so the screenshot pass can size the window
      // exactly, with no clipping and no dead space.
      requestAnimationFrame(function () {
        var h = Math.ceil(document.documentElement.getBoundingClientRect().height);
        document.documentElement.setAttribute("data-height", String(h));
        document.title = "READY";
      });
    })();
  </script>
</body>
</html>`;
}

// ---------- chrome ----------

function chrome(args) {
  return spawnSync(CHROME, args, { encoding: "utf8", timeout: 90000 });
}

function measureHeight(htmlPath, w) {
  const r = chrome([
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    `--window-size=${w},800`,
    "--virtual-time-budget=3000",
    "--dump-dom",
    `file://${htmlPath}`,
  ]);
  const m = (r.stdout || "").match(/data-height="(\d+)"/);
  return m ? Number(m[1]) : null;
}

function screenshot(htmlPath, pngPath, w, h) {
  const r = chrome([
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--hide-scrollbars",
    "--force-device-scale-factor=2",
    `--window-size=${w},${h}`,
    "--virtual-time-budget=3000",
    `--screenshot=${pngPath}`,
    `file://${htmlPath}`,
  ]);
  if (!fs.existsSync(pngPath)) {
    throw new Error(`Chrome produced no screenshot.\n${r.stderr || ""}`);
  }
}

// ---------- run ----------

const sessDir = path.join(REPO, "docs", "sessions");
let files = fs
  .readdirSync(sessDir)
  .filter((f) => f.endsWith(".md"))
  .map((f) => path.join(sessDir, f));
if (only) files = files.filter((f) => path.basename(f, ".md") === only);
if (!files.length) {
  console.error(`No session files found${only ? ` matching "${only}"` : ""} in docs/sessions/`);
  process.exit(1);
}

const themes = themeArg === "both" ? ["dark", "light"] : [themeArg];
fs.mkdirSync(outDir, { recursive: true });
const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "glean-replay-"));

for (const file of files) {
  const name = path.basename(file, ".md");
  const session = parseSession(fs.readFileSync(file, "utf8"));
  console.log(`${name}: ${session.steps.length} step(s), mode=${session.meta.mode || "?"}`);

  for (const theme of themes) {
    const html = buildHtml(session, theme, session.steps.filter((x) => x.input).at(-1)?.input);
    const htmlPath = path.join(tmp, `${name}-${theme}.html`);
    fs.writeFileSync(htmlPath, html);
    if (htmlOnly) {
      console.log(`  ${theme}: ${htmlPath}`);
      continue;
    }
    if (!CHROME) {
      console.error("  No Chrome/Chromium found. Set $CHROME, or pass --html-only.");
      process.exit(1);
    }
    const h = measureHeight(htmlPath, width) || 1000;
    const png = path.join(outDir, `${name}-${theme}.png`);
    screenshot(htmlPath, png, width, h);
    const kb = (fs.statSync(png).size / 1024).toFixed(0);
    console.log(`  ${theme}: ${path.relative(REPO, png)}  (${width}x${h}, ${kb} KB)`);
  }
}
