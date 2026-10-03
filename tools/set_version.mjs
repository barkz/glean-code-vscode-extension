#!/usr/bin/env node
/**
 * Set the extension version to 0.2.<pr>, the scheme glean-code-cli uses too.
 *
 * The patch component is the number of the pull request that introduces the
 * change, so a .vsix is traceable straight back to a PR. The `version` job in
 * .github/workflows/release.yml enforces it.
 *
 *   node tools/set_version.mjs 7     # -> 0.2.7
 *   node tools/set_version.mjs       # this branch's open PR, or the number
 *                                    # the next one will get
 *
 * Run it before opening the PR: issues and PRs share one counter, so the next
 * PR is the newest issue-or-PR number plus one, and the first CI run passes
 * instead of failing the version job. If an issue is opened in between, the
 * version job says so and a second run (now finding the open PR) fixes it.
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

function gh(args) {
  const r = spawnSync("gh", args, { cwd: EXT, encoding: "utf8", timeout: 30000 });
  if (r.error) die("gh is unavailable — pass the PR number explicitly");
  return r.status === 0 ? (r.stdout || "").trim() : "";
}

/** This branch's open PR, else the number the next issue or PR will get. */
function inferPr() {
  const open = gh(["pr", "view", "--json", "number,state", "-q", 'select(.state == "OPEN") | .number']);
  if (open) {
    console.log(`using this branch's PR #${open}`);
    return open;
  }
  // The issues endpoint lists PRs too, newest first. Discussions would share
  // the counter as well; they are off for this repo.
  const latest = gh(["api", "repos/{owner}/{repo}/issues?state=all&per_page=1", "-q", ".[0].number"]);
  const next = String((Number(latest) || 0) + 1);
  console.log(`no open PR for this branch — the next PR will be #${next}`);
  return next;
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
