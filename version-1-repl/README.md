# Glean Code VS Code extension — REPL approach (Version 1)

This is the **scrape-the-REPL** version: it spawns `python3 -m glean_code` as
a child process, pipes stdin/stdout/stderr between the child and the webview,
and renders a chat-style sidebar.

The approach is intentionally close to what the prompt describes so the
trade-offs are visible. See [../README.md](../README.md) for the architectural
comparison with the JSON-bridge version.

> **This is the reference implementation, not the recommended one.** It works
> and is maintained, but it reads the CLI's formatted output, so it breaks when
> that formatting changes. New work goes into
> [version-2-json-bridge](../version-2-json-bridge/).

## Install

```bash
../install.sh --version 1
```

Builds a `.vsix` and installs it into every VS Code and Cursor on your `PATH`.
Open the panel with **Cmd+Alt+G** (Ctrl+Alt+G on Windows/Linux). No Glean
credentials are needed — without a token the CLI serves a built-in mock corpus.

## What this extension contributes

- **Side panel webview** in its own activity-bar container (`Glean Code` icon).
- **Chat input** with Enter-to-send, multi-line on Shift+Enter, history navigation with ArrowUp/Down.
- **Slash command picker**: type `/` and a horizontal palette appears, filtered as you type. Tab/Shift+Tab cycle, click accepts, Esc dismisses.
- **Message history** with stdout/stderr coloring, URL linkification (click opens in default browser), right-click-to-copy.
- **Output channel** (`Glean Code (REPL)`) for raw process logs.
- **Commands** registered with VS Code:
  - `Glean Code: Focus Chat` — `cmd+alt+g` / `ctrl+alt+g`
  - `Glean Code: Run Slash Command...` — `cmd+alt+/` / `ctrl+alt+/`
  - `Glean Code: Search...`, `Glean Code: Chat...`, `Glean Code: Restart REPL`

## How it talks to the CLI

`src/replManager.ts` spawns the REPL with these knobs:

- `stdio: ['pipe', 'pipe', 'pipe']` — no PTY, so `sys.stdin.isatty()` in
  `cli.py` returns false and the REPL takes the **non-interactive** path: it
  reads each newline-terminated line from stdin and dispatches it.
- `TERM=dumb`, `NO_COLOR=1` — discourages ANSI from `glean_code/ui.py`.
- `PYTHONUNBUFFERED=1` — flush per-line so we don't see 4 KiB-aligned chunks.
- `PYTHONPATH=<cliPath>` so `python3 -m glean_code` works from anywhere.

Whatever ANSI does come through is stripped at the boundary by a regex
(`stripAnsi`) before reaching the webview.

## Configuration

```jsonc
// user/workspace settings
{
  "gleanCode.pythonPath": "python3",
  // Absolute path to the glean-code-cli project root (the dir containing glean_code/).
  // If empty, the extension looks at ../glean-code-cli relative to the extension folder.
  "gleanCode.cliPath": "/Users/you/path/to/glean-code-cli",
  "gleanCode.extraEnv": {}
}
```

## Build & run

```bash
npm install
npm run compile        # tsc -> out/
npm run package        # -> dist/glean-code-repl-0.1.0.vsix
```

Press **F5** on this folder to launch an Extension Development Host
(`.vscode/launch.json` is committed, so this works from a fresh clone).

## Finding the CLI

`ReplManager.resolveSourceRoot()` tries, in order:

1. The `gleanCode.cliPath` setting.
2. `GLEAN_CODE_HOME`.
3. Whether the configured interpreter can already `import glean_code`.
4. The zipapp `python3 install.py` installs at `~/.local/bin/glean`.
5. A `glean-code-cli` clone in or beside the workspace, or beside the extension.

Only step 5 works from a source checkout, and only steps 1–4 work once the
extension is installed as a `.vsix`. If nothing matches, the panel reports what
it tried and offers to open Settings. This mirrors
`PythonBridge.resolveSourceRoot()` in version 2 — keep the two in step.

## Known limitations of this approach (and what was done about them)

The CLI is built for a human at a TTY. Some of that does not translate cleanly:

| CLI feature | What happens here | Mitigation |
| --- | --- | --- |
| Tab completion (`completion.py`) | Lives in GNU readline inside the REPL. Disabled because we run without a TTY. | The webview keeps its own slash-command list and filters as you type, so Tab/Shift-Tab work in the panel. The list lives in `webviewProvider.ts` and must be kept in sync with `commands.HANDLERS`. |
| ANSI colors | `ui.style()` emits SGR escapes everywhere. | We set `NO_COLOR=1` and additionally strip any escape that does come through. The result is plain text — color cues from the REPL are lost. |
| Live status bar | `cli.py` prints it before each prompt only in interactive mode. | Not emitted in our non-interactive mode, so we don't see it at all. A polished UI would parse `/status` output, but that's exactly the brittle scraping the prompt warned about. |
| Banner / prompt echo | Printed once at startup, then before each prompt. | The non-interactive branch skips the prompt loop, so we only see the startup banner. |
| `/clear` (`\033[2J\033[H`) | The CLI emits a screen clear. | Stripped by ANSI cleanup. The webview ignores it rather than wiping the chat log. |
| `/scaffold` interactive prompts | Calls `input()` mid-handler. | Works because we keep stdin open between commands, but the user has to know to type the directory on its own line. A polished UI would use `vscode.window.showInputBox`. |
| Errors that print to stderr | Captured separately. | Rendered with the error styling in the webview. |

**Bottom line.** This works, but you are scraping terminal output. Anything
the CLI changes about its `print()` calls — column widths, table separators,
timestamps — can break the visual layer. If you need a stable contract,
see Version 2.

## Layout

```
version-1-repl/
  package.json           VS Code extension manifest
  tsconfig.json
  src/
    extension.ts         activation, commands, keybindings
    replManager.ts       child_process + ANSI stripping
    webviewProvider.ts   WebviewView, message routing, HTML host
  media/
    main.css             styles using vscode-* css variables
    main.js              webview UI logic
  resources/
    glean.svg            sidebar icon
```
