# Roadmap

Scope decided 2026-10-03: **ship the extension, not an IDE.**

A branded VSCodium build was considered and declined. VSCodium's build is
entirely environment-driven (`APP_NAME`, `BINARY_NAME`, `ORG_NAME`) and its
`product.json` is a merge overlay rather than a patch, so a rebrand is
configuration rather than a source fork — cheaper than it looks. It was still
declined, because the cost that matters is not the build: it is owning signed
binaries for three platforms, an update channel, and tracking VSCodium releases
indefinitely. Users already have an editor. Meeting them in it is the better
trade.

Consequence: this project needs no VSCodium checkout, no patch set, and no code
signing. A `.vsix` is platform-neutral.

---

## Where this stands

Feature work is not the constraint. Distribution is.

| | |
| --- | --- |
| Extension | webview + JSON-RPC bridge to the bundled CLI zipapp |
| Version | `0.2.<PR>`, matching the CLI repo's scheme |
| CI | version check, bridge, test matrix, v1 compile check |
| Tag `v*` | builds the `.vsix`, verifies it against the tag, creates a release |
| Install today | `curl … get.sh | bash`, or sideload a `.vsix` from releases |

That last row is the gap. Everything below is ordered by how much it moves it.

---

## 1. Registry publishing

**Open VSX first.** It is what VSCodium, Cursor and other non-Microsoft builds
read, and it has no corporate gate.

The `publish` job now has the step. It supports two credentials and skips with a
notice when neither is configured, so a release tag never fails for want of one:

- **PAT** — sign in at <https://open-vsx.org>, accept the Eclipse Publisher
  Agreement, `npx ovsx create-namespace barkz`, then add the token as the
  `OVSX_TOKEN` repository secret.
- **Trusted publishing** — configure this repository as a trusted publisher for
  the `barkz` namespace, then set the `OVSX_TRUSTED` repository variable to
  `true`. No long-lived secret to rotate; preferred once set up.

Both need a one-time account action that CI cannot perform.

**VS Code Marketplace second.** Much wider reach, but it needs an Azure DevOps
PAT and a verified publisher. Worth adding after Open VSX proves the pipeline,
not instead of it.

**Done when** someone who has never cloned this repository can install the
extension in one step.

## 2. The Python prerequisite

The real adoption cliff. Bundling the zipapp removed the need for a *source
checkout*, not for an *interpreter*. A machine with no `python3` gets a resolver
error, however well worded.

- Detect at activation and give a platform-specific next step. macOS ships 3.9,
  so most Macs are fine; Windows is the exposed group.
- State the floor prominently in the marketplace README — the first thing anyone
  reads, and not the same audience as this repository's README.
- Decide explicitly whether Windows is in scope. If it is, this item matters more
  than anything else on this page.

## 3. A shareable profile

Currently at zero, and it is the other half of the chosen scope. A
`.code-profile` export bundling settings, keybindings and this extension as a
recommendation delivers the "Glean experience" without owning an editor. An
afternoon's work.

## 4. Retire `version-1-repl`

Prototype one, superseded by the JSON bridge, still consuming a CI job. Two
implementations mean two things to keep compiling for one shipped product.
Archive it to a tag or branch and drop it from `main`; the README's comparison
table can stay as history.

---

## Known wrinkle: two version sequences

Both repositories use `0.2.<PR>`, but pull request numbers are per-repository, so
the extension's `0.2.5` and the CLI's `0.2.41` are unrelated numbers that look
related. Harmless, confusing in a support conversation. Release notes name the
bundled CLI release explicitly, which is the thing that actually matters.

## Known wrinkle: the bundle lags the CLI

`bundled/glean-code.pyz` refreshes only when the extension is packaged, so
between packages it silently falls behind the CLI. `bundled/cli-version.json`
records what shipped and the bridge reports what it loaded, so a mismatch warns
at activation rather than passing unnoticed — but nothing yet *refreshes* it when
the CLI tags a release. Either automate that, or keep relying on the warning.
