---
session: cli-not-found
title: When the CLI can't be found
extension: version-2-json-bridge
mode: n/a
recorded-with: hand-authored
---

# When the CLI can't be found

The most common first-run failure: the extension is installed but the
`glean_code` package isn't anywhere it can reach. This session is hand-authored
rather than recorded, because reproducing it means removing the CLI.

It is also a regression test. Before the fix in `media/main.js`, a second
`renderError` declaration shadowed the first, so this exact message — the one a
new user most needs to read — threw `TypeError: Cannot read properties of
undefined (reading 'error')` and rendered nothing at all.

```glean-notify stderr
{
  "text": "Could not find the glean_code package. Tried:\n  - python3 -c \"import glean_code\"\n  - installed `glean` zipapp on PATH or in ~/.local/bin\n  - a glean-code-cli clone in or beside the workspace"
}
```

## `/status`

With no bridge running, the request fails fast rather than hanging until the
60-second timeout.

```glean-error status
{
  "error": "bridge exited before ready (code 1)",
  "of": "status"
}
```
