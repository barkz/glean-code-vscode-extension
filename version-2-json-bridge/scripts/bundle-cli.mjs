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
 * Usage:
 *   node scripts/bundle-cli.mjs                 # auto-locate the CLI checkout
 *   node scripts/bundle-cli.mjs --cli <path>    # explicit checkout
 *   GLEAN_CODE_HOME=<path> node scripts/bundle-cli.mjs
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, copyFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = path.resolve(HERE, "..");
const OUT_DIR = path.join(EXT_ROOT, "bundled");
const OUT_PYZ = path.join(OUT_DIR, "glean-code.pyz");

const argv = process.argv.slice(2);
const flagIdx = argv.indexOf("--cli");
const explicit = flagIdx !== -1 ? argv[flagIdx + 1] : process.env.GLEAN_CODE_HOME;

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

const cli = locateCli();
const python = process.env.PYTHON || "python3";

// install.py --cli-only --prefix <tmp> writes the zipapp as <tmp>/glean.
const staging = mkdtempSync(path.join(tmpdir(), "glean-bundle-"));
try {
  const r = spawnSync(python, ["install.py", "--cli-only", "--prefix", path.join(staging, "bin")], {
    cwd: cli,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PYTHONPYCACHEPREFIX: path.join(staging, "pycache") },
  });
  if (r.status !== 0) {
    console.error("bundle-cli: the CLI installer failed.\n" + (r.stderr?.toString() || ""));
    process.exit(1);
  }

  const built = path.join(staging, "bin", "glean");
  if (!existsSync(built)) {
    console.error(`bundle-cli: expected a zipapp at ${built}, but it was not produced.`);
    process.exit(1);
  }

  mkdirSync(OUT_DIR, { recursive: true });
  copyFileSync(built, OUT_PYZ);

  const kb = Math.round(statSync(OUT_PYZ).size / 1024);
  const ver = spawnSync(python, ["-c", "import glean_code; print(glean_code.__version__)"], {
    cwd: "/",
    env: { ...process.env, PYTHONPATH: OUT_PYZ },
    encoding: "utf8",
  });
  const version = ver.status === 0 ? ver.stdout.trim() : "unknown";

  // Prove the archive is importable before we call this a success — a zipapp
  // that cannot be imported would fail at runtime instead of at build time.
  const check = spawnSync(python, ["-c", "import glean_code.client, glean_code.config"], {
    cwd: "/",
    env: { ...process.env, PYTHONPATH: OUT_PYZ },
  });
  if (check.status !== 0) {
    console.error("bundle-cli: the bundled zipapp is not importable — refusing to ship it.");
    rmSync(OUT_PYZ, { force: true });
    process.exit(1);
  }

  console.log(`bundle-cli: bundled glean_code ${version} (${kb} KB) from ${cli}`);
  console.log(`bundle-cli: -> ${path.relative(EXT_ROOT, OUT_PYZ)}`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
