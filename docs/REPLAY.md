# Session recording and replay

A session file is a Markdown transcript of a Glean Code panel that is also a
fixture. You read it like documentation; `tools/replay.mjs` executes it.

The point is that screenshots stop being screenshots. They are a build output
of the extension's own renderer, regenerated from a recording whenever the UI
changes — so an image in the README can't quietly drift from what the code does.

```
tools/record.mjs ──▶ docs/sessions/*.md ──▶ tools/replay.mjs ──▶ docs/img/*.png
   drives the real          readable            renders with the real
   Python bridge          + replayable        media/main.css + main.js
```

## Recording

`tools/record.mjs` spawns the real `python/glean_bridge.py`, parses each input
line with the real `parseLine()` from `out/slashCommands.js`, sends the
resulting call, and writes down what came back. Nothing is hand-written, so a
recording is evidence of behaviour rather than a description of it.

```bash
cd version-2-json-bridge && npm install && npm run compile && cd ..

node tools/record.mjs \
  --name getting-started \
  --title "Getting started" \
  --intro "Optional paragraph placed under the heading." \
  '/status' \
  '/search quarterly planning --page-size 3' \
  'what is our pto policy'
```

| Flag | Meaning |
| --- | --- |
| `--name` | output filename, `docs/sessions/<name>.md` |
| `--title` | `# heading` and frontmatter title |
| `--intro` | paragraph inserted under the heading |
| `--from <file>` | read input lines from a file, one per line, `#` comments |
| `--cli <path>` | glean-code-cli checkout, if auto-discovery misses |
| `--out <dir>` | output directory |

Recording always runs in **mock mode**, so a recording never touches a live
tenant and the same inputs produce the same outputs.

## Replaying

```bash
node tools/replay.mjs                                   # all sessions, both themes
node tools/replay.mjs --session getting-started --theme dark
node tools/replay.mjs --html-only                       # emit HTML, skip Chrome
```

The replayer builds a page from the extension's own `media/main.css` and
`media/main.js`, stubs `acquireVsCodeApi()`, and dispatches the recorded
messages in the order the extension host would post them. **If a card renders
wrong in the screenshot, it renders wrong in VS Code** — it is the same code.

VS Code theme tokens (`--vscode-*`) are supplied from the stock Dark Modern and
Light Modern palettes.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--session <name>` | all | one session by filename stem |
| `--theme dark\|light\|both` | `both` | which palette |
| `--width <px>` | `500` | panel width; clamped to Chrome's 500px minimum |
| `--out <dir>` | `docs/img` | where PNGs land |
| `--html-only` | off | write the HTML and stop, for debugging |

## File format

Frontmatter, then prose, then fenced blocks. Everything outside a `glean-*`
fence is documentation and is ignored by the replayer.

````markdown
---
session: getting-started
title: Getting started
extension: version-2-json-bridge
mode: mock
recorded-with: tools/record.mjs
---

# Getting started

Any prose you like here.

```glean-event ready
{ "mode": "mock", "instance": null }
```

## `/search quarterly planning`

Prose about this step is optional.

```glean-call
{ "method": "search", "params": { "query": "quarterly planning" } }
```

```glean-result search
{ "results": [ { "title": "...", "url": "...", "tracking_token": "..." } ] }
```
````

### Blocks

| Fence | Effect on replay |
| --- | --- |
| `glean-event ready` | seeds the status bar; the bridge's opening state |
| `glean-call` | **not rendered** — documents the wire for the reader |
| `glean-result <method>` | rendered by `<method>`'s card renderer |
| `glean-error <method>` | rendered as an error line |
| `glean-notify <level>` | host notice (`system` or `stderr`), not tied to an input |
| `glean-clear` | clears the transcript, as `/clear` does |

A `## \`...\`` heading is the line the user typed; it is echoed into the panel
and the blocks under it are that step's response. `glean-notify` needs no
heading — it models something the host says on its own, such as the bridge
failing to start.

The `<method>` argument selects the renderer, so it must match what
`dispatchResult()` in `media/main.js` understands (`chat`, `search`, `status`,
`login`, `logout`, `set_mode`, `help`, `error`). Anything else falls through to
the pretty-printed JSON card, which is also what the panel does.

## Hand-authoring

Recording can't produce every state — you can't record the CLI being missing
without removing the CLI. Those sessions are written by hand and say so in
`recorded-with:`. [`cli-not-found.md`](sessions/cli-not-found.md) is one, and it
doubles as a regression test for a bug where that exact message crashed the
renderer instead of displaying.

## Regenerating

```bash
node tools/replay.mjs
```

Re-run after any change to `media/main.css` or `media/main.js` and commit the
PNGs alongside the change, so the images in the docs always match the code that
produced them.
