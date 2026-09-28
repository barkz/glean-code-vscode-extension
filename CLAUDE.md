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
tools/
  record.mjs                  drive the real bridge, write docs/sessions/*.md
  replay.mjs                  render a session into the real webview, screenshot it
  test-extension.sh           run the integration test in a real extension host
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
```

## Commands

```bash
./install.sh                       # build + install v2 into VS Code and Cursor
./install.sh --version 1           # same for v1
cd version-2-json-bridge
npm install && npm run compile     # build
npm test                           # integration test in a real extension host
npm run package                    # -> dist/*.vsix
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
3. whether the configured interpreter can already `import glean_code`
4. the zipapp `python3 install.py` drops at `~/.local/bin/glean` (importable
   as a `PYTHONPATH` entry — it is a zip)
5. a `glean-code-cli` clone in or beside the workspace, or beside the extension

Only step 5 works from a source checkout, and only steps 1–4 work for an
installed `.vsix`. If you change discovery, update `install.sh`'s runtime check
and `tools/record.mjs`, which mirror this list.

## Testing

`npm test` runs `src/test/index.ts` inside a real VS Code extension host. It
covers activation, command registration, spawning the Python bridge, and round
trips for `status` / `search` / `chat` / an unknown method.

The host is detached from the terminal on macOS, so the test writes its report
to `$GLEAN_TEST_OUTPUT`; `tools/test-extension.sh` prints it and sets the exit
code. If you add checks, use `log()` so they land in the report — a bare
`console.log` goes to the detached host and is lost.

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
