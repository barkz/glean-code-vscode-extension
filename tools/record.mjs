#!/usr/bin/env node
/**
 * Record a Glean Code session to a replayable Markdown transcript.
 *
 * Drives the real python/glean_bridge.py subprocess with the real slash-command
 * parser from out/slashCommands.js, so what lands in docs/sessions/*.md is a
 * recording of the extension's actual behaviour, not a hand-written fixture.
 *
 *   node tools/record.mjs --name getting-started --title "Getting started" \
 *        '/status' '/search quarterly planning' 'what is our pto policy'
 *
 * With --from <file>, input lines are read one per line from a file instead.
 * Replay the result with tools/replay.mjs.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const EXT = path.join(REPO, "version-2-json-bridge");

const require = createRequire(import.meta.url);
const slashModule = path.join(EXT, "out", "slashCommands.js");
if (!fs.existsSync(slashModule)) {
  console.error(`Missing ${slashModule}\nRun: cd version-2-json-bridge && npm install && npm run compile`);
  process.exit(1);
}
const { parseLine, maskSecrets, mergeCatalog, SLASH_COMMANDS } = require(slashModule);

// ---------- args ----------

const argv = process.argv.slice(2);
const opt = (flag, fallback) => {
  const i = argv.indexOf(flag);
  if (i === -1) return fallback;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const name = opt("--name", "session");
const title = opt("--title", name);
const intro = opt("--intro", "");
const fromFile = opt("--from", null);
const outDir = opt("--out", path.join(REPO, "docs", "sessions"));
const cliPath = opt("--cli", null);

let lines = argv.filter((a) => !a.startsWith("--"));
if (fromFile) {
  lines = fs
    .readFileSync(fromFile, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}
if (!lines.length) {
  console.error("No input lines given. Pass them as arguments or via --from <file>.");
  process.exit(1);
}

// ---------- locate glean_code (mirrors PythonBridge.resolveSourceRoot) ----------

function isImportRoot(p) {
  if (!p) return false;
  try {
    const st = fs.statSync(p);
    if (st.isDirectory()) return fs.existsSync(path.join(p, "glean_code", "__init__.py"));
    const head = Buffer.alloc(2);
    const fd = fs.openSync(p, "r");
    try {
      fs.readSync(fd, head, 0, 2, 0);
      if (head.toString("latin1") === "PK") return true;
      if (head.toString("latin1") === "#!") return fs.readFileSync(p).includes("glean_code/");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    /* not a candidate */
  }
  return false;
}

// Same order as PythonBridge.resolveSourceRoot(): the copy bundled with the
// extension comes before anything installed on this machine, so a recording
// shows the CLI the extension actually ships — not, say, an old ~/.local/bin
// zipapp that predates the command being recorded.
function resolveSourceRoot() {
  const candidates = [
    cliPath,
    process.env.GLEAN_CODE_HOME,
    path.join(EXT, "bundled", "glean-code.pyz"),
    path.join(os.homedir(), ".local", "bin", "glean"),
    path.resolve(REPO, "..", "glean-code-cli"),
    path.resolve(REPO, "..", "..", "glean-code-cli"),
  ].filter(Boolean);
  for (const c of candidates) if (isImportRoot(c)) return c;
  return null;
}

const sourceRoot = resolveSourceRoot();
if (!sourceRoot) {
  console.error(
    "Could not find glean_code. Pass --cli <path-to-glean-code-cli>, set GLEAN_CODE_HOME,\n" +
      "or run `python3 install.py` in the glean-code-cli checkout.",
  );
  process.exit(1);
}

// ---------- bridge plumbing ----------

// Recordings are committed, so they must be reproducible and must never touch
// a live tenant. glean_code reads its mode and credentials from
// ~/.gleancode/config.json, so the bridge gets an empty HOME: no config, no
// token, mock mode — whatever your real config says.
const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "glean-record-home-"));
const env = {
  ...process.env,
  PYTHONUNBUFFERED: "1",
  PYTHONPATH: sourceRoot + (process.env.PYTHONPATH ? path.delimiter + process.env.PYTHONPATH : ""),
  HOME: isolatedHome,
  USERPROFILE: isolatedHome,
  PYTHONPYCACHEPREFIX: path.join(isolatedHome, "pycache"),
};

const proc = spawn(process.env.PYTHON || "python3", ["-u", path.join(EXT, "python", "glean_bridge.py")], {
  env,
  stdio: ["pipe", "pipe", "pipe"],
});
proc.stdout.setEncoding("utf8");
proc.stderr.setEncoding("utf8");
proc.stderr.on("data", (d) => process.stderr.write(`[bridge stderr] ${d}`));

const pending = new Map();
let readyResolve;
const ready = new Promise((r) => (readyResolve = r));
let buf = "";
let nextId = 1;

proc.stdout.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      process.stderr.write(`[bridge non-JSON] ${line}\n`);
      continue;
    }
    if (obj.event === "ready") readyResolve(obj.data);
    else if (obj.event === "log") process.stderr.write(`[bridge log] ${obj.data}\n`);
    else if (obj.id !== undefined) {
      const p = pending.get(String(obj.id));
      if (!p) continue;
      pending.delete(String(obj.id));
      p(obj);
    }
  }
});

function call(method, params) {
  const id = String(nextId++);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout calling ${method}`));
    }, 60000);
    pending.set(id, (obj) => {
      clearTimeout(timer);
      resolve(obj);
    });
    proc.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
}

// ---------- record ----------

const fence = (lang, body) => "```" + lang + "\n" + body + "\n```";
const json = (v) => JSON.stringify(v, null, 2);

const readyStatus = await ready;
console.log(`record: glean_code ${readyStatus.client_version || "?"} from ${sourceRoot}`);
if (readyStatus.mode !== "mock") {
  console.error(`record: the bridge came up in ${readyStatus.mode} mode, not mock — refusing to record.`);
  proc.kill("SIGTERM");
  process.exit(1);
}
const steps = [];

// The same catalogue the panel loads, so /help and CLI-only commands record
// exactly as the panel renders them.
const catRes = await call("commands", {});
const catalog = catRes.result ? mergeCatalog(SLASH_COMMANDS, catRes.result.commands || []) : SLASH_COMMANDS;

for (const line of lines) {
  const parsed = parseLine(line);
  if (!parsed) continue;
  // Session files are committed, so a /login token must not reach one.
  const input = maskSecrets(line);

  if (parsed.kind === "call") {
    const res = await call(parsed.method, parsed.params);
    if (parsed.method === "graph" && res.result && res.result.html) {
      // The host keeps the page and hands the card an id; so does the recording.
      const { html: _html, ...card } = res.result;
      res.result = { ...card, graph_id: "recorded" };
    }
    const params = "token" in parsed.params ? { ...parsed.params, token: "***" } : parsed.params;
    steps.push({
      input,
      call: { method: parsed.method, params },
      ...(res.error ? { error: res.error } : { result: res.result }),
      renderAs: res.error ? "error" : parsed.method,
    });
  } else if (parsed.kind === "local") {
    steps.push({ input, result: { items: catalog }, renderAs: parsed.method });
  } else if (parsed.kind === "clear") {
    steps.push({ input, clear: true });
  } else if (parsed.kind === "error") {
    const known = parsed.unknown && catalog.find((c) => c.cmd === parsed.unknown);
    if (known && known.cliOnly) {
      steps.push({ input, result: { cmd: known.cmd, summary: known.summary, line: input }, renderAs: "cliOnly" });
    } else {
      steps.push({ input, error: parsed.error, renderAs: "error", local: true });
    }
  }
}

proc.stdin.end();
proc.kill("SIGTERM");
fs.rmSync(isolatedHome, { recursive: true, force: true });

// ---------- emit markdown ----------

const parts = [];
parts.push("---");
parts.push(`session: ${name}`);
parts.push(`title: ${title}`);
parts.push("extension: version-2-json-bridge");
parts.push(`mode: ${readyStatus.mode}`);
parts.push(`cli-version: ${readyStatus.client_version || "unknown"}`);
parts.push("recorded-with: tools/record.mjs");
parts.push("---");
parts.push("");
parts.push(`# ${title}`);
parts.push("");
if (intro) {
  parts.push(intro);
  parts.push("");
}
parts.push(
  "> Recorded against the real `python/glean_bridge.py` in mock mode. " +
    "Replay it into a rendered panel with `node tools/replay.mjs`.",
);
parts.push("");
parts.push("## Bridge ready");
parts.push("");
parts.push("The panel opens and the bridge announces its state before any input.");
parts.push("");
parts.push(fence("glean-event ready", json(readyStatus)));
parts.push("");

for (const s of steps) {
  parts.push("## `" + s.input + "`");
  parts.push("");
  if (s.clear) {
    parts.push("Clears the transcript. Handled in the webview; no bridge call.");
    parts.push("");
    parts.push(fence("glean-clear", "{}"));
    parts.push("");
    continue;
  }
  if (s.call) {
    parts.push("Sent to the bridge as:");
    parts.push("");
    parts.push(fence("glean-call", json(s.call)));
    parts.push("");
  } else if (s.local) {
    parts.push("Rejected by the parser before any bridge call.");
    parts.push("");
  } else {
    parts.push("Answered by the webview itself; no bridge call.");
    parts.push("");
  }
  if (s.error !== undefined) {
    parts.push(fence("glean-error " + (s.call ? s.call.method : ""), json({ error: s.error, of: s.call?.method })));
  } else {
    parts.push(fence("glean-result " + s.renderAs, json(s.result)));
  }
  parts.push("");
}

fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, `${name}.md`);
fs.writeFileSync(outPath, parts.join("\n"));
console.log(`Recorded ${steps.length} step(s) -> ${path.relative(REPO, outPath)}`);
