---
session: graph
title: Knowledge graph
extension: version-2-json-bridge
mode: mock
cli-version: 0.2.41
recorded-with: tools/record.mjs
---

# Knowledge graph

> Recorded against the real `python/glean_bridge.py` in mock mode. Replay it into a rendered panel with `node tools/replay.mjs`.

## Bridge ready

The panel opens and the bridge announces its state before any input.

```glean-event ready
{
  "client_version": "0.2.41",
  "client_path": "/Users/barkz/Downloads/barkz_github/glean-code-vscode-extension/version-2-json-bridge/bundled/glean-code.pyz/glean_code/__init__.py",
  "instance": null,
  "base_url": null,
  "has_api_token": false,
  "has_indexing_token": false,
  "act_as": null,
  "mode": "mock",
  "mode_setting": "auto",
  "default_page_size": 10,
  "current_chat_id": null
}
```

## `/graph checkout incident`

Sent to the bridge as:

```glean-call
{
  "method": "graph",
  "params": {
    "query": "checkout incident"
  }
}
```

```glean-result graph
{
  "query": "checkout incident",
  "source": "mock corpus",
  "local_index": false,
  "summary": {
    "nodes": 22,
    "edges": 42,
    "by_kind": {
      "doc": 10,
      "person": 3,
      "source": 4,
      "container": 5
    },
    "edge_kinds": {
      "authored_by": 10,
      "in_source": 10,
      "in_container": 10,
      "shares_term": 12
    },
    "hubs": [
      {
        "label": "Postmortem: Checkout Latency Incident (INC-1183)",
        "kind": "doc",
        "degree": 9
      },
      {
        "label": "INC-1183 — Elevated 5xx on checkout API",
        "kind": "doc",
        "degree": 7
      },
      {
        "label": "Incident Severity Levels and Comms Templates",
        "kind": "doc",
        "degree": 7
      },
      {
        "label": "Sam Iyer",
        "kind": "person",
        "degree": 7
      },
      {
        "label": "Customer QBR — Northwind Retail",
        "kind": "doc",
        "degree": 6
      },
      {
        "label": "Follow-up: retry budget change is live",
        "kind": "doc",
        "degree": 5
      }
    ],
    "clusters": [
      {
        "size": 22,
        "anchor": "Postmortem: Checkout Latency Incident (INC-1183)",
        "anchor_kind": "doc"
      }
    ],
    "strongest": [
      {
        "a": "War room thread: checkout 5xx spike",
        "b": "Postmortem: Checkout Latency Incident (INC-1183)",
        "score": 3.912,
        "why": "charge, minutes., checkout"
      },
      {
        "a": "INC-1183 — Elevated 5xx on checkout API",
        "b": "Follow-up: retry budget change is live",
        "score": 3.612,
        "why": "inc-1183, pool, retry"
      },
      {
        "a": "On-Call Runbook — Payments Service",
        "b": "Incident Severity Levels and Comms Templates",
        "score": 3.507,
        "why": "commander, service, incident"
      },
      {
        "a": "INC-1183 — Elevated 5xx on checkout API",
        "b": "Postmortem: Checkout Latency Incident (INC-1183)",
        "score": 3.101,
        "why": "inc-1183, pool, checkout"
      }
    ]
  },
  "graph_id": "recorded"
}
```

## `/flow show`

Answered by the webview itself; no bridge call.

```glean-result cliOnly
{
  "cmd": "/flow",
  "summary": "Map what you have investigated: captured chats, their sources, and what connects.",
  "line": "/flow show"
}
```
