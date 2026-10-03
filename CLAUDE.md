# CLAUDE.md

Guidance for Claude Code (and anyone else) working in this repository.

## What this repo is

Two VS Code extensions that put a Glean assistant panel in the sidebar. They
solve the same problem two ways against the same `glean-code-cli` project:

| | `version-1-repl/` | `version-2-json-bridge/` |
| --- | --- | --- |
| Python process | `python3 -m glean_code` (the full REPL) | `python/glean_bridge.py` |
| Wire format | raw stdout, ANSI-stripped | newline-delimited JSON |
| Rendering | one scrollback pane | structured cards per method |
| Breaks when the CLI's output formatting changes | yes | no |

**`version-2-json-bridge` is the one to work on.** v1 is kept as a working
reference for the scrape-the-REPL approach; fix it if it breaks, but new
features go in v2.

## Layout

```
install.sh                    build + install a .vsix into VS Code / Cursor
.github/workflows/release.yml CI on every PR/push; a v* tag publishes a GitHub Release
tools/
  record.mjs                  drive the real bridge, write docs/sessions/*.md
  replay.mjs                  render a session into the real webview, screenshot it
  test-extension.sh           run the integration test in a real extension host
  set_version.mjs             set the extension version to 0.2.<PR>
docs/
  REPLAY.md                   the session file format
  sessions/*.md               recorded sessions (readable + replayable)
  img/*.png                   screenshots generated from those sessions
version-2-json-bridge/
  src/
    extension.ts              activation, commands, keybindings; returns GleanCodeApi
    pythonBridge.ts           subprocess lifecycle + JSON-RPC + CLI discovery
    slashCommands.ts          pure parser: line -> ParsedCommand (no vscode import)
    webviewProvider.ts        webview host; dispatches ParsedCommand
    test/index.ts             integration test (runs inside VS Code)
  python/glean_bridge.py      JSON-RPC server importing glean_code.client
  media/main.{css,js}         the panel renderer
  scripts/bundle-cli.mjs      vendor the CLI zipapp into bundled/ (checkout or release)
  scripts/run-tests.mjs       integration test in a downloaded VS Code (what CI runs)
  cli-release.txt             the glean-code-cli release tag a release bundles
```

## Commands

```bash
./install.sh                       # build + install v2 into VS Code and Cursor
./install.sh --version 1           # same for v1
cd version-2-json-bridge
npm install && npm run compile     # build
npm test                           # integration test in your installed `code`
npm run test:ci                    # same, in a downloaded VS Code (VSCODE_VERSION=1.85.0 for the floor)
npm run package                    # -> dist/*.vsix, bundling the CLI from your checkout
GLEAN_CLI_RELEASE=pinned npm run package   # bundling the pinned CLI release, as CI does
node ../tools/replay.mjs           # regenerate docs/img/*.png from docs/sessions
```

F5 in either extension folder launches an Extension Development Host
(`.vscode/launch.json` is committed).

## How the pieces fit

```
webview (media/main.js)
    │  postMessage {type:"send", line}
    ▼
ChatViewProvider.handleLine
    │  parseLine(line) -> ParsedCommand      <- slashCommands.ts, pure
    ▼
PythonBridge.call(method, params)
    │  {"id","method","params"}\n  over stdin
    ▼
python/glean_bridge.py  -> glean_code.client.GleanClient -> Glean REST API
    │  {"id","result"}\n  or  {"id","error"}\n
    ▼
webview renders a card per method
```

## Conventions that matter

- **Bridge calls run concurrently.** `glean_bridge.py` answers on a thread
  pool, so responses arrive out of order and are matched by `id`. `login`,
  `logout` and `set_mode` are the exception: they run in arrival order and
  swap in a new config rather than editing it, and every other request runs
  with the config that was current when it arrived. A new method that changes
  session state must go in `_ORDERED` and use `_apply`; everything else reads
  state through `_cfg()` / `_cli()`, never the module globals.
- **Links open only if they are http(s).** URLs come from indexed content;
  route any new "open this" action through `isWebLink`.
- **Secrets are masked before display.** Anything that echoes, stores or
  records a typed line goes through `maskSecrets` first.

- **`slashCommands.ts` must not import `vscode`.** It runs in the extension
  host, in `tools/record.mjs` under plain Node, and in the integration test.
  Keep it pure — parsing returns a description of work, it never performs I/O.
- **The JSON contract is the contract.** Never parse the CLI's formatted
  output in v2; that is v1's job and v1's fragility. To add a command: add a
  method to `METHODS` in `glean_bridge.py`, a case in `parseLine`, and a
  renderer in `main.js` if the default JSON card isn't good enough.
- **Adding a bridge method requires all three edits.** A method with no
  `parseLine` case is unreachable; a `parseLine` case with no bridge method
  produces `unknown method: x` at runtime.
- **The panel is narrow.** Anything rendering a URL, doc id or token needs
  `overflow-wrap: anywhere` or it overflows a 260px sidebar.
- **Don't declare two functions with the same name in `main.js`.** It is one
  IIFE scope with no bundler and no linter, so the later declaration silently
  wins. This already caused one bug where the bridge-failure message crashed
  the renderer instead of displaying.
- **Mock mode is the test fixture.** With no credentials `glean_code` serves a
  built-in Acme corpus. Recordings and tests rely on it, so they never touch a
  live tenant.

## Finding the CLI

`PythonBridge.resolveSourceRoot()` tries, in order:

1. `gleanCodeBridge.cliPath` setting
2. `GLEAN_CODE_HOME`
3. `bundled/glean-code.pyz` inside the extension — the CLI zipapp that
   `scripts/bundle-cli.mjs` vendors on every `npm run package`
4. whether the configured interpreter can already `import glean_code`
5. the zipapp `python3 install.py` drops at `~/.local/bin/glean`, or a `glean`
   on `PATH` (importable as a `PYTHONPATH` entry — it is a zip)
6. a `glean-code-cli` clone in or beside the workspace, or beside the extension

An installed `.vsix` always stops at step 3, so it runs the client version its
JSON contract was built against; `bundled/cli-version.json` records which, and
the extension warns at activation if the loaded client differs.

**Gotcha when developing:** `bundled/` survives a package, so after any
`npm run package` an F5 run also stops at step 3 and serves the *packaged*
CLI, not your working tree. Set `gleanCodeBridge.cliPath` to your checkout, or
`npm run clean`, to develop against live CLI changes.

v1 (`replManager.ts`) has the same list without step 3. If you change
discovery, update `install.sh`'s runtime check and `tools/record.mjs`, which
mirror parts of this list.

## Testing

`npm test` runs `src/test/index.ts` inside a real VS Code extension host. It
covers activation, command registration, spawning the Python bridge, round
trips through the JSON protocol, the parser, secret masking, link filtering,
concurrent calls and restart.

`npm run test:ci` runs the same file in a VS Code that `@vscode/test-electron`
downloads into `.vscode-test/`; CI runs it on stable and on the `engines.vscode`
floor (1.85.0) under `xvfb-run`. It clears `ELECTRON_RUN_AS_NODE` and
`VSCODE_*` first, so it also works from VS Code's own terminal.

The host is detached from the terminal on macOS, so the test writes its report
to `$GLEAN_TEST_OUTPUT`; `tools/test-extension.sh` prints it and sets the exit
code. If you add checks, use `log()` so they land in the report — a bare
`console.log` goes to the detached host and is lost.

## Versioning and releases

Only `version-2-json-bridge` is released. Its version is `0.2.<PR>`, the same
scheme as glean-code-cli: the patch component is the pull request number, so a
`.vsix` maps to exactly one PR. Set it before opening the PR, so the first CI
run passes:

```bash
node tools/set_version.mjs          # this branch's open PR, else the next PR number
node tools/set_version.mjs 7        # or set it explicitly
```

With no open PR it predicts the number (newest issue-or-PR + 1). The `version`
job in `release.yml` fails a PR whose `package.json` (or `package-lock.json`)
version does not match its number — if an issue was opened in between, run the
script again on the branch and it uses the real PR number.

A release bundles the glean-code-cli release pinned in
`version-2-json-bridge/cli-release.txt`, downloaded from that release's
`glean-code.pyz`; `bundle-cli.mjs` refuses an asset whose `__version__`
disagrees with the tag. Moving to a newer CLI is a one-line PR to that file.

Tags are the release marker. Pushing `v<version>` runs the `publish` job, which
refuses a tag that disagrees with `package.json`, takes the `.vsix` the
`package` job built and tested, and creates a GitHub Release with it attached:

```bash
git tag -a v0.2.7 -m "Glean Code extension v0.2.7" && git push origin v0.2.7
```

## Screenshots

Screenshots are generated, not taken by hand. `tools/replay.mjs` renders
`docs/sessions/*.md` using the extension's own `media/main.css` and
`media/main.js`, so a rendering bug shows up in the images. See
[docs/REPLAY.md](docs/REPLAY.md).

Regenerate after any change to `media/`:

```bash
node tools/replay.mjs
```

Chrome enforces a ~500px minimum window width; `--width` below that is clamped,
otherwise the page lays out at 500 and the screenshot is cropped, which looks
like a CSS bug but isn't.

## Out of scope

This is a chat/search panel, not a coding assistant. There is no inline
completion provider and no agentic file editing. Adding either means a
different design (an inline completion provider calling `chat` with surrounding
code, plus WorkspaceEdit routing) — don't bolt it onto the webview.
