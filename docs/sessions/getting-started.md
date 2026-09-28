---
session: getting-started
title: Getting started
extension: version-2-json-bridge
mode: mock
recorded-with: tools/record.mjs
---

# Getting started

A first run of the Glean Code panel with no credentials configured. The bridge falls back to mock mode, so every answer below is served from the CLI's built-in Acme corpus — reproducible, and safe to put in docs.

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

## `/status`

Sent to the bridge as:

```glean-call
{
  "method": "status",
  "params": {}
}
```

```glean-result status
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

## `/search quarterly planning --page-size 3`

Sent to the bridge as:

```glean-call
{
  "method": "search",
  "params": {
    "query": "quarterly planning",
    "page_size": 3
  }
}
```

```glean-result search
{
  "results": [
    {
      "title": "Kickoff thread: Q4 FY26 quarterly planning",
      "url": "https://acme.slack.com/archives/C02PLAN9K/p1719483920",
      "datasource": "slack",
      "snippet": "Kicking off Q4 FY26 planning. Drafts go in the tracker by Friday, and please link the RFC rather than pasting it inline. …",
      "tracking_token": "tok_doc_plan_slack"
    },
    {
      "title": "How We Run Quarterly Planning (RFC → Commit → Review)",
      "url": "https://acme.atlassian.net/wiki/spaces/ENG/pages/482910/How+We+Run+Quarterly+Planning",
      "datasource": "confluence",
      "snippet": "Quarterly planning at Acme runs in three phases. In RFC, teams write a one-page proposal describing the problem, the bet, and what gets dropped to make room. …",
      "tracking_token": "tok_doc_plan_process"
    },
    {
      "title": "Quarterly Planning Tracker — All Teams (Q4 FY26)",
      "url": "https://docs.google.com/spreadsheets/d/1Tr4ckQpLanW7bXz/edit#gid=0",
      "datasource": "gdrive",
      "snippet": "One row per committed objective across the eleven product and platform teams. Columns cover owner, key result, engineer-weeks, dependency, confidence, and status. …",
      "tracking_token": "tok_doc_plan_tracker"
    }
  ],
  "raw": {
    "results": [
      {
        "id": "doc_plan_slack",
        "title": "Kickoff thread: Q4 FY26 quarterly planning",
        "url": "https://acme.slack.com/archives/C02PLAN9K/p1719483920",
        "datasource": "slack",
        "snippets": [
          {
            "text": "Kicking off Q4 FY26 planning. Drafts go in the tracker by Friday, and please link the RFC rather than pasting it inline. …"
          }
        ],
        "trackingToken": "tok_doc_plan_slack",
        "metadata": {
          "datasource": "slack",
          "documentType": "Message",
          "container": "#planning",
          "updateTime": 1787198352,
          "updatedAgo": "updated 6 days ago",
          "author": {
            "name": "Marcus Webb",
            "email": "marcus.webb@acme.com"
          }
        }
      },
      {
        "id": "doc_plan_process",
        "title": "How We Run Quarterly Planning (RFC → Commit → Review)",
        "url": "https://acme.atlassian.net/wiki/spaces/ENG/pages/482910/How+We+Run+Quarterly+Planning",
        "datasource": "confluence",
        "snippets": [
          {
            "text": "Quarterly planning at Acme runs in three phases. In RFC, teams write a one-page proposal describing the problem, the bet, and what gets dropped to make room. …"
          }
        ],
        "trackingToken": "tok_doc_plan_process",
        "metadata": {
          "datasource": "confluence",
          "documentType": "Page",
          "container": "ENG space",
          "updateTime": 1785729552,
          "updatedAgo": "updated 23 days ago",
          "author": {
            "name": "Priya Raman",
            "email": "priya.raman@acme.com"
          }
        }
      },
      {
        "id": "doc_plan_tracker",
        "title": "Quarterly Planning Tracker — All Teams (Q4 FY26)",
        "url": "https://docs.google.com/spreadsheets/d/1Tr4ckQpLanW7bXz/edit#gid=0",
        "datasource": "gdrive",
        "snippets": [
          {
            "text": "One row per committed objective across the eleven product and platform teams. Columns cover owner, key result, engineer-weeks, dependency, confidence, and status. …"
          }
        ],
        "trackingToken": "tok_doc_plan_tracker",
        "metadata": {
          "datasource": "gdrive",
          "documentType": "Spreadsheet",
          "container": "Planning / Trackers",
          "updateTime": 1787630352,
          "updatedAgo": "updated yesterday",
          "author": {
            "name": "Marcus Webb",
            "email": "marcus.webb@acme.com"
          }
        }
      }
    ]
  }
}
```

## `what is our pto policy`

Sent to the bridge as:

```glean-call
{
  "method": "chat",
  "params": {
    "message": "what is our pto policy"
  }
}
```

```glean-result chat
{
  "chat_id": "chat_08f84abf",
  "text": "[mock] You asked: what is our pto policy\n\nDrawing on 3 documents from the Acme index (PTO and Leave Policy (FY26), Travel and Expense Policy, Data Retention Standard v3), here is a simulated answer. Configure a real token with /login — or sign in with /auth login — to hit live Glean.",
  "citations": [
    {
      "title": "PTO and Leave Policy (FY26)",
      "url": "https://docs.google.com/document/d/1PtOpOl1cYaCm3Nq/edit"
    },
    {
      "title": "Travel and Expense Policy",
      "url": "https://docs.google.com/document/d/1TrVeXp3NsPl9Cy/edit"
    },
    {
      "title": "Data Retention Standard v3",
      "url": "https://docs.google.com/document/d/1DaTaRt3Nsh0Nq2/edit"
    }
  ],
  "raw": {
    "chatId": "chat_08f84abf",
    "messages": [
      {
        "author": "GLEAN_AI",
        "messageType": "CONTENT",
        "fragments": [
          {
            "text": "[mock] You asked: what is our pto policy\n\nDrawing on 3 documents from the Acme index (PTO and Leave Policy (FY26), Travel and Expense Policy, Data Retention Standard v3), here is a simulated answer. Configure a real token with /login — or sign in with /auth login — to hit live Glean."
          }
        ],
        "citations": [
          {
            "sourceDocument": {
              "id": "doc_pto",
              "title": "PTO and Leave Policy (FY26)",
              "url": "https://docs.google.com/document/d/1PtOpOl1cYaCm3Nq/edit",
              "datasource": "gdrive"
            }
          },
          {
            "sourceDocument": {
              "id": "doc_expense_policy",
              "title": "Travel and Expense Policy",
              "url": "https://docs.google.com/document/d/1TrVeXp3NsPl9Cy/edit",
              "datasource": "gdrive"
            }
          },
          {
            "sourceDocument": {
              "id": "doc_retention",
              "title": "Data Retention Standard v3",
              "url": "https://docs.google.com/document/d/1DaTaRt3Nsh0Nq2/edit",
              "datasource": "gdrive"
            }
          }
        ]
      }
    ]
  }
}
```

## `/datasources.list`

Sent to the bridge as:

```glean-call
{
  "method": "datasources.list",
  "params": {}
}
```

```glean-result datasources.list
{
  "datasources": [
    {
      "name": "gdrive",
      "count": 1840
    },
    {
      "name": "confluence",
      "count": 920
    },
    {
      "name": "slack",
      "count": 611
    },
    {
      "name": "jira",
      "count": 430
    },
    {
      "name": "github",
      "count": 268
    }
  ]
}
```

## `/search`

Rejected by the parser before any bridge call.

```glean-error 
{
  "error": "Usage: /search <query>"
}
```

## `/nonsense`

Rejected by the parser before any bridge call.

```glean-error 
{
  "error": "Unknown command: /nonsense. Try /help."
}
```
