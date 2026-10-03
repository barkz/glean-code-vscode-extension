# Glean Code VS Code extension — JSON Bridge approach (Version 2)

![The Glean Code panel](../docs/img/getting-started-dark.png)

<sub>Generated from [docs/sessions/getting-started.md](../docs/sessions/getting-started.md)
using this extension's own `media/main.css` and `media/main.js` — see
[docs/REPLAY.md](../docs/REPLAY.md).</sub>

## Install

```bash
../install.sh          # builds a .vsix and installs it into VS Code / Cursor
```

Then open the panel with **Cmd+Alt+G** (Ctrl+Alt+G on Windows/Linux). No Glean
credentials are needed to try it — without a token the CLI serves a built-in
mock corpus.

## How it works

This version skips the REPL entirely. It spawns a small Python process
(`python/glean_bridge.py`) that imports `glean_code.client.GleanClient` and
speaks newline-delimited JSON over stdio. The extension calls typed methods
and renders structured cards in the webview.

## Wire protocol

Every line in either direction is a JSON object terminated by `\n`.

**Client → bridge**

```json
{"id": "1", "method": "search", "params": {"query": "quarterly planning", "page_size": 5}}
```

**Bridge → client**

```json
{"id": "1", "result": {"results": [...], "raw": {...}}}
{"id": "1", "error": "HTTP 401 from /search: token rejected"}
{"event": "ready", "data": {"mode": "mock", "instance": null, ...}}
{"event": "log", "data": "traceback ..."}
```

Requests run concurrently, so responses can arrive out of order — match them
by `id`. `login`, `logout` and `set_mode` run in arrival order, and every other
request runs with the session that was current when it arrived, so a request
sent after `/mode mock` is always answered in mock mode.

Methods exposed (matching the REST surface in `glean_code.client`):

```
status, login, logout, set_mode,
chat, search, autocomplete,
datasources.list, datasources.status,
insights,
agents.list, agents.run,
tools.list, tools.call,
docs.get, people.get,
collections.list, pins.list,
feedback
```

You can smoke-test the bridge directly:

```bash
PYTHONPATH=/path/to/glean-code-cli python3 -u python/glean_bridge.py <<'EOF'
{"id": "1", "method": "status", "params": {}}
{"id": "2", "method": "search", "params": {"query": "quarterly planning"}}
EOF
```

## What the extension contributes

- **Side panel webview** (`Glean Code` activity-bar container).
- **Structured rendering**: chat replies are rendered as cards with the
  message body and a separate citations list. Search results render with
  clickable titles, datasource/url metadata, snippet, and per-result
  `+` / `-` feedback buttons that call the `feedback` method.
- **Live status bar** in the panel header that updates when the bridge
  reports `ready` and after each `/status`, `/login`, `/logout`, `/mode`.
- **Slash command picker** with summaries (since we don't pipe the REPL,
  the descriptions live in TypeScript and are kept in sync with the
  bridge methods).
- **Commands**:
  - `Glean Code: Focus Chat` — `cmd+alt+g` / `ctrl+alt+g`
  - `Glean Code: Search...` — `cmd+alt+s` / `ctrl+alt+s`
  - `Glean Code: Chat...`, `Glean Code: Status`, `Glean Code: Restart Bridge`

## Configuration

```jsonc
{
  // Interpreter used to run the bridge.
  "gleanCodeBridge.pythonPath": "python3",
  // Optional: skip auto-discovery and point straight at a checkout.
  "gleanCodeBridge.cliPath": "/Users/you/path/to/glean-code-cli",
  // Extra environment variables for the bridge process.
  "gleanCodeBridge.extraEnv": {}
}
```

## Build & run

```bash
npm install
npm run compile
npm test           # integration test inside a real VS Code extension host
npm run package    # -> dist/glean-code-bridge-0.1.0.vsix
```

Press **F5** to launch an Extension Development Host (`.vscode/launch.json` is
committed, so this works from a fresh clone).

`npm test` activates the extension in a real host, checks that every command is
registered, spawns `python/glean_bridge.py`, and round-trips `status`, `search`,
`chat` and an unknown method against the mock corpus.

## Finding the CLI

`PythonBridge.resolveSourceRoot()` tries, in order:

1. The `gleanCodeBridge.cliPath` setting.
2. `GLEAN_CODE_HOME`.
3. `bundled/glean-code.pyz` — the CLI zipapp `npm run package` vendors into
   the extension, so an installed `.vsix` needs no configuration.
4. Whether the configured interpreter can already `import glean_code`.
5. The zipapp `python3 install.py` installs at `~/.local/bin/glean`, or `glean`
   on `PATH` — a zipapp is a zip, so Python imports straight out of it via
   `PYTHONPATH`.
6. A `glean-code-cli` clone in or beside the workspace, or beside the extension.

After a package, `bundled/` also exists in your source tree, so F5 runs stop
at step 3 too. Set `gleanCodeBridge.cliPath` or run `npm run clean` to develop
against a working tree. If nothing matches, the panel reports what it tried
and offers to open Settings.

## Why this is nicer than scraping the REPL

- **Stable contract.** UI changes in `glean_code/ui.py` don't affect the
  webview at all — we never read its formatted output.
- **Real types.** Every result is JSON. Citations are arrays of objects,
  not pretty-printed strings we have to parse.
- **Per-result interactions.** Each search result keeps its
  `trackingToken`, so `/feedback` can fire from a button on the card.
- **Errors carry their request.** Each request has an `id`, so a failure
  in one method doesn't poison output for the next.
- **No ANSI handling.** The bridge produces no ANSI escapes.

## Bounds of this approach

- This is still a **chat / Q&A pane**, not a coding assistant. There's no
  inline completion (no `vscode.languages.registerInlineCompletionItemProvider`)
  and no agentic file editing the way Claude Code does it. Adding either
  would mean a different design — likely a separate provider that calls
  `chat` with the surrounding code as context, plus Workspace Edit
  routing for proposed changes. It's a feasible direction; out of scope
  here.
- The bridge mirrors the REST surface of `glean_code.client`, but it is
  not a full IDE assistant. If the CLI added a non-REST feature (say,
  workspace-aware ranking driven by open files), the bridge would need
  a matching method — there's no fall-through to "just run the slash
  command".

## Layout

```
version-2-json-bridge/
  package.json
  tsconfig.json
  src/
    extension.ts         activation, commands, keybindings; returns GleanCodeApi
    pythonBridge.ts      subprocess lifecycle, JSON-RPC, CLI discovery
    slashCommands.ts     pure line -> ParsedCommand parser (no vscode import)
    webviewProvider.ts   webview host; dispatches ParsedCommand
    test/index.ts        integration test, runs inside a real extension host
  python/
    glean_bridge.py      JSON-RPC server importing glean_code.client
  media/
    main.css
    main.js              renders typed cards per method
  resources/
    glean.svg
```
