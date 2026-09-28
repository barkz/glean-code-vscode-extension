---
session: agents-and-people
title: Agents, people and tools
extension: version-2-json-bridge
mode: mock
recorded-with: tools/record.mjs
---

# Agents, people and tools

Commands that fall through to the default JSON card because they have no bespoke renderer yet — this is what 'add a bridge method and get something usable for free' looks like.

> Recorded against the real `python/glean_bridge.py` in mock mode. Replay it into a rendered panel with `node tools/replay.mjs`.

## Bridge ready

The panel opens and the bridge announces its state before any input.

```glean-event ready
{
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

## `/agents.list`

Sent to the bridge as:

```glean-call
{
  "method": "agents.list",
  "params": {}
}
```

```glean-result agents.list
{
  "agents": [
    {
      "id": "agt_research",
      "name": "Research Agent",
      "description": "Deep research across company knowledge."
    },
    {
      "id": "agt_sales",
      "name": "Sales Assistant",
      "description": "Summarises accounts and prepares call notes."
    }
  ]
}
```

## `/people.get marcus.webb@acme.com`

Sent to the bridge as:

```glean-call
{
  "method": "people.get",
  "params": {
    "email": "marcus.webb@acme.com"
  }
}
```

```glean-result people.get
{
  "name": "Marcus Webb",
  "email": "marcus.webb@acme.com",
  "title": "Group Product Manager",
  "department": "Product"
}
```

## `/tools.list`

Sent to the bridge as:

```glean-call
{
  "method": "tools.list",
  "params": {}
}
```

```glean-result tools.list
{
  "tools": [
    {
      "name": "search",
      "description": "Search the company index."
    },
    {
      "name": "create_doc",
      "description": "Create a new document."
    }
  ]
}
```

## `/help`

Answered by the webview itself; no bridge call.

```glean-result help
{
  "items": [
    {
      "cmd": "/help",
      "summary": "Show available commands"
    },
    {
      "cmd": "/status",
      "summary": "Show connection state and mode"
    },
    {
      "cmd": "/login",
      "summary": "Login: /login --instance <host> --token <tok>"
    },
    {
      "cmd": "/logout",
      "summary": "Clear stored credentials"
    },
    {
      "cmd": "/mode",
      "summary": "Set mode: /mode <live|mock|auto>"
    },
    {
      "cmd": "/chat",
      "summary": "Chat with Glean: /chat <message>"
    },
    {
      "cmd": "/search",
      "summary": "Search the index: /search <query>",
      "example": "/search quarterly planning"
    },
    {
      "cmd": "/autocomplete",
      "summary": "Autocomplete suggestions"
    },
    {
      "cmd": "/datasources.list",
      "summary": "List visible datasources"
    },
    {
      "cmd": "/datasources.status",
      "summary": "Datasource status: /datasources.status <name>"
    },
    {
      "cmd": "/insights",
      "summary": "Insights summary"
    },
    {
      "cmd": "/agents.list",
      "summary": "List agents"
    },
    {
      "cmd": "/agents.run",
      "summary": "Run an agent: /agents.run <agent-id> <input>"
    },
    {
      "cmd": "/tools.list",
      "summary": "List tools"
    },
    {
      "cmd": "/tools.call",
      "summary": "Call a tool: /tools.call <name> <json-args>"
    },
    {
      "cmd": "/docs.get",
      "summary": "Fetch documents: /docs.get --id <id>"
    },
    {
      "cmd": "/people.get",
      "summary": "Get a person: /people.get <email>"
    },
    {
      "cmd": "/announcements.list",
      "summary": "List announcements"
    },
    {
      "cmd": "/collections.list",
      "summary": "List collections"
    },
    {
      "cmd": "/pins.list",
      "summary": "List pinned results"
    },
    {
      "cmd": "/clear",
      "summary": "Clear the chat"
    }
  ]
}
```
