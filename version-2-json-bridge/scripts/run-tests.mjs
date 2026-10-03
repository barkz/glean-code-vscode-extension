#!/usr/bin/env node
/**
 * Run the integration test in a VS Code that @vscode/test-electron downloads,
 * so it works on a CI runner with no editor installed.
 *
 *   node scripts/run-tests.mjs                     # latest stable VS Code
 *   VSCODE_VERSION=1.85.0 node scripts/run-tests.mjs   # the engines.vscode floor
 *
 * On Linux this needs a display: run it under `xvfb-run -a`.
 * Locally, ../tools/test-extension.sh does the same against your installed `code`.
 *
 * The extension host is detached from this process, so src/test/index.ts
 * writes its report to $GLEAN_TEST_OUTPUT; this prints it and sets the exit code.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runTests } from "@vscode/test-electron";

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Run from VS Code's integrated terminal, this process inherits
// ELECTRON_RUN_AS_NODE=1 and the parent's VSCODE_* IPC variables. The first
// makes the downloaded VS Code start as plain Node ("bad option" for every
// flag); the rest point it at the wrong instance. The test VS Code needs none.
for (const k of Object.keys(process.env)) {
  if (k === "ELECTRON_RUN_AS_NODE" || k.startsWith("VSCODE_")) delete process.env[k];
}
const scratch = mkdtempSync(path.join(tmpdir(), "glean-test-"));
const report = path.join(scratch, "report.txt");

let code = 1;
try {
  await runTests({
    version: process.env.VSCODE_VERSION || "stable",
    extensionDevelopmentPath: EXT,
    extensionTestsPath: path.join(EXT, "out", "test", "index.js"),
    extensionTestsEnv: { GLEAN_TEST_OUTPUT: report },
    launchArgs: [
      "--disable-extensions",
      "--disable-workspace-trust",
      `--user-data-dir=${path.join(scratch, "user-data")}`,
    ],
  });
  code = 0;
} catch (e) {
  console.error(`run-tests: ${e instanceof Error ? e.message : e}`);
}

let text = "";
try {
  text = readFileSync(report, "utf8");
} catch {
  console.error("run-tests: the extension host produced no report — it likely failed to start.");
  code = 1;
}
process.stdout.write(text);
if (!text.includes("--- PASS ---")) code = 1;

rmSync(scratch, { recursive: true, force: true });
process.exit(code);
