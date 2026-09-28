/**
 * Integration test: runs inside a real VS Code extension host.
 *
 *   code --extensionDevelopmentPath=<ext> --extensionTestsPath=<ext>/out/test/index.js
 *
 * This exercises the whole chain the screenshots can't prove on their own —
 * activation, command registration, spawning python/glean_bridge.py, and a
 * round trip through the JSON protocol — against the CLI's mock corpus.
 */
import * as vscode from "vscode";
import * as fs from "node:fs";
import type { GleanCodeApi } from "../extension";

const EXT_ID = "barkz.glean-code-bridge";

let failures = 0;
const lines: string[] = [];

/**
 * The extension host is detached from the launching terminal on macOS, so the
 * report is written to $GLEAN_TEST_OUTPUT as well as logged.
 */
function log(s: string) {
  console.log(s);
  lines.push(s);
}

function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    log(`  ok    ${name}`);
  } else {
    failures++;
    log(`  FAIL  ${name}${detail ? " — " + detail : ""}`);
  }
}

function flush() {
  const out = process.env.GLEAN_TEST_OUTPUT;
  if (out) {
    try {
      fs.writeFileSync(out, lines.join("\n") + "\n");
    } catch {
      /* best effort */
    }
  }
}

export async function run(): Promise<void> {
  try {
    await runChecks();
  } catch (e) {
    failures++;
    log(`  FAIL  threw: ${(e as Error).stack || (e as Error).message}`);
  } finally {
    flush();
  }
  if (failures > 0) throw new Error(`${failures} check(s) failed`);
}

async function runChecks(): Promise<void> {
  log("--- glean-code-bridge integration test ---");

  const ext = vscode.extensions.getExtension<GleanCodeApi>(EXT_ID);
  check("extension is present", !!ext, `no extension with id ${EXT_ID}`);
  if (!ext) return;

  const api = await ext.activate();
  check("activate() resolves", !!api);
  check("activate() exposes the bridge", !!api?.bridge);

  const commands = await vscode.commands.getCommands(true);
  for (const id of [
    "gleanCodeBridge.focusChat",
    "gleanCodeBridge.search",
    "gleanCodeBridge.chat",
    "gleanCodeBridge.status",
    "gleanCodeBridge.restartBridge",
  ]) {
    check(`command registered: ${id}`, commands.includes(id));
  }

  // Spawns python/glean_bridge.py for real and waits for the ready event.
  const status = await api.bridge.call<{ mode: string }>("status", {});
  check("bridge answers status", !!status, "no result");
  check("bridge reports a mode", typeof status?.mode === "string", JSON.stringify(status));
  log(`        mode = ${status?.mode}`);

  const search = await api.bridge.call<{ results: unknown[] }>("search", {
    query: "quarterly planning",
    page_size: 3,
  });
  check("search returns an array", Array.isArray(search?.results));
  check("search returns results", (search?.results?.length ?? 0) > 0,
        `got ${search?.results?.length ?? 0}`);
  log(`        ${search?.results?.length} result(s)`);

  const chat = await api.bridge.call<{ text: string; citations: unknown[] }>("chat", {
    message: "what is our pto policy",
  });
  check("chat returns text", typeof chat?.text === "string" && chat.text.length > 0);
  check("chat returns citations", Array.isArray(chat?.citations) && chat.citations.length > 0);

  // Unknown methods must surface as a rejection carrying the bridge's message.
  let rejected = false;
  let message = "";
  try {
    await api.bridge.call("no.such.method", {});
  } catch (e) {
    rejected = true;
    message = (e as Error).message;
  }
  check("unknown method rejects", rejected);
  check("rejection carries the reason", message.includes("unknown method"), message);

  log(`--- ${failures === 0 ? "PASS" : `FAIL (${failures})`} ---`);
}
