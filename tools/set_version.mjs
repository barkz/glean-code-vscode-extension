#!/usr/bin/env node
/**
 * Set the extension version to 0.2.<pr>, the scheme glean-code-cli uses too.
 *
 * The patch component is the number of the pull request that introduces the
 * change, so a .vsix is traceable straight back to a PR. That number only
 * exists once the PR is open, so the bump happens inside the PR and the
 * `version` job in .github/workflows/release.yml enforces it.
 *
 *   node tools/set_version.mjs 7     # -> 0.2.7
 *   node tools/set_version.mjs       # infer from the open PR via gh
 *
 * Only version-2-json-bridge is released; version-1-repl keeps its own version.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERIES = "0.2";
const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "version-2-json-bridge");

function current() {
  return JSON.parse(readFileSync(path.join(EXT, "package.json"), "utf8")).version;
}

function inferPr() {
  const r = spawnSync("gh", ["pr", "view", "--json", "number", "-q", ".number"], {
    cwd: EXT,
    encoding: "utf8",
    timeout: 30000,
  });
  if (r.error) die("gh is unavailable — pass the PR number explicitly");
  const pr = (r.stdout || "").trim();
  if (r.status !== 0 || !pr) die("no open PR for this branch — open one first, or pass the number");
  return pr;
}

function die(msg) {
  console.error(`set_version: ${msg}`);
  process.exit(1);
}

const pr = process.argv[2] ?? inferPr();
if (!/^[1-9]\d*$/.test(pr)) die(`PR number must be a positive integer, got "${pr}"`);

const want = `${SERIES}.${pr}`;
const have = current();
if (have === want) {
  console.log(`version is already ${want}`);
  process.exit(0);
}

// npm version keeps package.json and package-lock.json in step.
const r = spawnSync("npm", ["version", want, "--no-git-tag-version", "--allow-same-version"], {
  cwd: EXT,
  stdio: ["ignore", "ignore", "inherit"],
});
if (r.status !== 0) die("npm version failed");
console.log(`version ${have} -> ${want}`);
