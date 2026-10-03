#!/usr/bin/env node
/**
 * Vendor the Glean Code CLI into this extension as a single-file zipapp.
 *
 * The extension imports `glean_code` from the bundled archive, so a published
 * .vsix carries the exact client version its JSON contract was written against
 * and needs no path configuration on the user's machine.
 *
 * The zipapp is built by the CLI's own installer rather than re-implementing
 * the staging rules here, so exclusions (__pycache__, .DS_Store) stay in one
 * place.
 *
 * Two sources:
 *
 *   - A glean-code-cli checkout (local development). Builds the zipapp with
 *     the checkout's own install.py.
 *   - A published glean-code-cli GitHub Release (CI and releases). Downloads
 *     that release's glean-code.pyz, so every build of a tag bundles the same
 *     CLI. The pinned tag lives in cli-release.txt.
 *
 * Usage:
 *   node scripts/bundle-cli.mjs                       # auto-locate the CLI checkout
 *   node scripts/bundle-cli.mjs --cli <path>          # explicit checkout
 *   GLEAN_CODE_HOME=<path> node scripts/bundle-cli.mjs
 *   node scripts/bundle-cli.mjs --release             # the tag pinned in cli-release.txt
 *   node scripts/bundle-cli.mjs --release v0.2.41     # an explicit release tag
 *   GLEAN_CLI_RELEASE=pinned|<tag> npm run package    # same, via vscode:prepublish
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, copyFileSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = path.resolve(HERE, "..");
const OUT_DIR = path.join(EXT_ROOT, "bundled");
const OUT_PYZ = path.join(OUT_DIR, "glean-code.pyz");
const PIN_FILE = path.join(EXT_ROOT, "cli-release.txt");
const CLI_REPO = "barkz/glean-code-cli";

const argv = process.argv.slice(2);
const flagIdx = argv.indexOf("--cli");
const explicit = flagIdx !== -1 ? argv[flagIdx + 1] : process.env.GLEAN_CODE_HOME;

/** The release tag to bundle, or null to build from a checkout. */
function requestedRelease() {
  const i = argv.indexOf("--release");
  let tag = null;
  if (i !== -1) {
    const next = argv[i + 1];
    tag = next && !next.startsWith("--") ? next : "pinned";
  } else if (process.env.GLEAN_CLI_RELEASE) {
    tag = process.env.GLEAN_CLI_RELEASE.trim();
  }
  if (tag === "pinned") {
    tag = readFileSync(PIN_FILE, "utf8").trim();
    if (!tag) fail(`${path.relative(EXT_ROOT, PIN_FILE)} is empty.`);
  }
  if (tag && !/^v\d+\.\d+\.\d+$/.test(tag)) {
    fail(`release tag must look like v0.2.41, got "${tag}".`);
  }
  return tag;
}

function fail(msg) {
  console.error(`bundle-cli: ${msg}`);
  process.exit(1);
}

function isCliCheckout(dir) {
  return (
    !!dir &&
    existsSync(path.join(dir, "install.py")) &&
    existsSync(path.join(dir, "glean_code", "__init__.py"))
  );
}

function locateCli() {
  // An explicit checkout is an instruction, not a hint: if it is wrong, fail
  // loudly rather than quietly bundling a different tree than the one asked for.
  if (explicit) {
    if (isCliCheckout(explicit)) return explicit;
    const via = flagIdx !== -1 ? "--cli" : "GLEAN_CODE_HOME";
    console.error(
      `bundle-cli: ${via} is set to "${explicit}", but that is not a glean-code-cli ` +
        `checkout (needs install.py and glean_code/__init__.py).\n` +
        `Refusing to fall back to auto-discovery — fix the path or unset it.`,
    );
    process.exit(1);
  }

  const candidates = [
    path.resolve(EXT_ROOT, "..", "..", "glean-code-cli"),
    path.resolve(EXT_ROOT, "..", "..", "..", "glean-code-cli"),
    path.resolve(EXT_ROOT, "..", "glean-code-cli"),
  ];

  for (const c of candidates) if (isCliCheckout(c)) return c;

  console.error(
    "bundle-cli: could not find a glean-code-cli checkout.\n" +
      "Tried:\n  - " +
      candidates.join("\n  - ") +
      "\n\nPass one explicitly:  node scripts/bundle-cli.mjs --cli /path/to/glean-code-cli",
  );
  process.exit(1);
}

const python = process.env.PYTHON || "python3";
const release = requestedRelease();
const staging = mkdtempSync(path.join(tmpdir(), "glean-bundle-"));

/** Download a published release's zipapp. Returns its local path. */
async function fromRelease(tag) {
  const url = `https://github.com/${CLI_REPO}/releases/download/${tag}/glean-code.pyz`;
  const res = await fetch(url);   // follows GitHub's redirect to the asset host
  if (!res.ok) fail(`could not download ${url} (HTTP ${res.status}). Is ${tag} a published CLI release?`);
  const out = path.join(staging, "glean-code.pyz");
  writeFileSync(out, Buffer.from(await res.arrayBuffer()));
  return { built: out, source: `${CLI_REPO}@${tag}` };
}

/** Build the zipapp from a checkout with the CLI's own installer. */
function fromCheckout() {
  const cli = locateCli();
  // install.py --cli-only --prefix <tmp> writes the zipapp as <tmp>/glean.
  const r = spawnSync(python, ["install.py", "--cli-only", "--prefix", path.join(staging, "bin")], {
    cwd: cli,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PYTHONPYCACHEPREFIX: path.join(staging, "pycache") },
  });
  if (r.status !== 0) fail("the CLI installer failed.\n" + (r.stderr?.toString() || ""));
  const built = path.join(staging, "bin", "glean");
  if (!existsSync(built)) fail(`expected a zipapp at ${built}, but it was not produced.`);
  return { built, source: cli };
}

try {
  const { built, source } = release ? await fromRelease(release) : fromCheckout();

  mkdirSync(OUT_DIR, { recursive: true });
  copyFileSync(built, OUT_PYZ);

  const kb = Math.round(statSync(OUT_PYZ).size / 1024);
  const ver = spawnSync(python, ["-c", "import glean_code; print(glean_code.__version__)"], {
    cwd: "/",
    env: { ...process.env, PYTHONPATH: OUT_PYZ, PYTHONDONTWRITEBYTECODE: "1" },
    encoding: "utf8",
  });
  const version = ver.status === 0 ? ver.stdout.trim() : "unknown";
  if (version === "unknown") {
    rmSync(OUT_PYZ, { force: true });
    fail("could not read glean_code.__version__ from the bundle.");
  }

  // A release asset whose version disagrees with its tag is not what was
  // pinned, whatever the download said.
  if (release && version !== release.replace(/^v/, "")) {
    rmSync(OUT_PYZ, { force: true });
    fail(`${release} contains glean_code ${version}, not ${release.replace(/^v/, "")} — refusing to ship it.`);
  }

  // Prove the archive is importable before we call this a success — a zipapp
  // that cannot be imported would fail at runtime instead of at build time.
  const check = spawnSync(python, ["-c", "import glean_code.client, glean_code.config"], {
    cwd: "/",
    env: { ...process.env, PYTHONPATH: OUT_PYZ, PYTHONDONTWRITEBYTECODE: "1" },
  });
  if (check.status !== 0) {
    rmSync(OUT_PYZ, { force: true });
    fail("the bundled zipapp is not importable — refusing to ship it.");
  }

  // Stamp what was shipped. The extension reads this at activation and compares
  // it against the version the bridge actually loads, so a stale bundle or a
  // stray cliPath override is reported rather than silently serving old code.
  const stamp = path.join(OUT_DIR, "cli-version.json");
  writeFileSync(
    stamp,
    JSON.stringify({ version, bundledAt: new Date().toISOString(), source }, null, 2) + "\n",
  );

  console.log(`bundle-cli: bundled glean_code ${version} (${kb} KB) from ${source}`);
  console.log(`bundle-cli: -> ${path.relative(EXT_ROOT, OUT_PYZ)}`);
  console.log(`bundle-cli: -> ${path.relative(EXT_ROOT, stamp)} (version ${version})`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
