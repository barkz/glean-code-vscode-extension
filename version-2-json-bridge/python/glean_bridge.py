"""JSON-RPC over stdio bridge to glean_code.client.

Speaks newline-delimited JSON: one request per line, one response per line.

Request:  {"id": "<any>", "method": "<name>", "params": { ... }}
Response: {"id": "<any>", "result": { ... }}     on success
          {"id": "<any>", "error": "..."}         on failure
Notification (sent unsolicited from server -> client):
          {"event": "ready", "data": { ... }}
          {"event": "log",   "data": "..."}

This module is intentionally a thin wrapper around glean_code.client.GleanClient.
The CLI's REPL/UI/scaffold layers are not involved, so we get a stable JSON
contract to build the webview against.
"""
from __future__ import annotations

import json
import sys
import traceback
from typing import Any, Callable, Dict

import glean_code
from glean_code.client import GleanClient, GleanError
from glean_code.config import Config


def _emit(obj: Dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _log(msg: str) -> None:
    _emit({"event": "log", "data": msg})


# ---------- session state ----------

_config = Config.load()
_client = GleanClient(_config)
_chat_id: str | None = None


def _refresh() -> None:
    global _client
    _client = GleanClient(_config)


# ---------- methods ----------
# Each method takes a params dict and returns a JSON-serialisable dict.
# Errors raised here become {"error": "..."} on the wire.

def status(_: Dict[str, Any]) -> Dict[str, Any]:
    return {
        # Which glean_code answered, and from where. The extension compares this
        # against the version it bundled, so a stale or mismatched client is
        # visible instead of silently serving old behaviour.
        "client_version": getattr(glean_code, "__version__", "unknown"),
        "client_path": getattr(glean_code, "__file__", "unknown"),
        "instance": _config.instance,
        "base_url": _config.effective_base_url,
        "has_api_token": bool(_config.api_token),
        "has_indexing_token": bool(_config.indexing_token),
        "act_as": _config.act_as,
        "mode": _config.effective_mode,
        "mode_setting": _config.mode,
        "default_page_size": _config.default_page_size,
        "current_chat_id": _chat_id,
    }


def login(p: Dict[str, Any]) -> Dict[str, Any]:
    instance = (p.get("instance") or "").strip().rstrip("/")
    token = p.get("token") or ""
    if not instance or not token:
        raise ValueError("instance and token are required")

    if "://" in instance:
        scheme, rest = instance.split("://", 1)
    else:
        scheme, rest = "https", instance
    host = rest.split("/", 1)[0]
    if not host or "." not in host:
        raise ValueError(f"invalid instance host: {instance!r}")
    _config.instance = host
    _config.base_url = f"{scheme}://{host}/rest/api/v1"
    _config.api_token = str(token)
    if p.get("act_as"):
        _config.act_as = str(p["act_as"])
    _config.save()
    _refresh()
    return status({})


def logout(_: Dict[str, Any]) -> Dict[str, Any]:
    _config.api_token = None
    _config.act_as = None
    _config.save()
    _refresh()
    return status({})


def set_mode(p: Dict[str, Any]) -> Dict[str, Any]:
    mode = p.get("mode")
    if mode not in ("live", "mock", "auto"):
        raise ValueError("mode must be one of live, mock, auto")
    _config.mode = mode
    _config.save()
    return status({})


def chat(p: Dict[str, Any]) -> Dict[str, Any]:
    global _chat_id
    message = p.get("message") or ""
    if not message:
        raise ValueError("message is required")
    chat_id = p.get("chat_id") if "chat_id" in p else _chat_id
    if p.get("new"):
        chat_id = None
    resp = _client.chat(message, chat_id=chat_id, agent=p.get("agent"))
    if resp.get("chatId"):
        _chat_id = resp["chatId"]
    msgs = resp.get("messages") or []
    out = {
        "chat_id": resp.get("chatId"),
        "text": "".join(
            f.get("text", "")
            for m in msgs
            for f in (m.get("fragments") or [])
        ),
        "citations": [
            {
                "title": (c.get("sourceDocument") or {}).get("title", ""),
                "url": (c.get("sourceDocument") or {}).get("url", ""),
            }
            for m in msgs
            for c in (m.get("citations") or [])
        ],
        "raw": resp,
    }
    return out


def search(p: Dict[str, Any]) -> Dict[str, Any]:
    query = p.get("query") or ""
    if not query:
        raise ValueError("query is required")
    page_size = int(p.get("page_size") or _config.default_page_size)
    resp = _client.search(query, page_size=page_size, datasource=p.get("datasource"))
    results = []
    for r in resp.get("results") or []:
        snippets = r.get("snippets") or []
        snippet = snippets[0].get("text", "") if snippets else ""
        results.append({
            "title": r.get("title", ""),
            "url": r.get("url", ""),
            "datasource": r.get("datasource", ""),
            "snippet": snippet,
            "tracking_token": r.get("trackingToken", ""),
        })
    return {"results": results, "raw": resp}


def autocomplete(p: Dict[str, Any]) -> Dict[str, Any]:
    return {"suggestions": [
        r.get("suggestion", "")
        for r in (_client.autocomplete(p.get("query", "")).get("results") or [])
    ]}


def list_datasources(p: Dict[str, Any]) -> Dict[str, Any]:
    sample = int(p.get("sample") or 100)
    return _client.list_datasources(sample_size=sample)


def datasource_status(p: Dict[str, Any]) -> Dict[str, Any]:
    name = p.get("datasource") or ""
    if not name:
        raise ValueError("datasource is required")
    return _client.datasource_status(name)


def insights(p: Dict[str, Any]) -> Dict[str, Any]:
    return _client.insights(
        overview=bool(p.get("overview", True)),
        assistant=bool(p.get("assistant", False)),
        agents=bool(p.get("agents", False)),
        disable_per_user=bool(p.get("disable_per_user", False)),
    )


def agents_list(p: Dict[str, Any]) -> Dict[str, Any]:
    return _client.agents_search(query=p.get("query"))


def agent_run(p: Dict[str, Any]) -> Dict[str, Any]:
    agent_id = p.get("agent_id") or ""
    text = p.get("input") or ""
    if not agent_id or not text:
        raise ValueError("agent_id and input are required")
    return _client.agent_run(agent_id, text)


def tools_list(_: Dict[str, Any]) -> Dict[str, Any]:
    return _client.tools_list()


def tools_call(p: Dict[str, Any]) -> Dict[str, Any]:
    name = p.get("name") or ""
    if not name:
        raise ValueError("name is required")
    args = p.get("arguments") or {}
    return _client.tools_call(name, args)


def docs_get(p: Dict[str, Any]) -> Dict[str, Any]:
    return _client.get_documents(ids=p.get("ids") or None, urls=p.get("urls") or None)


def people_get(p: Dict[str, Any]) -> Dict[str, Any]:
    email = p.get("email") or ""
    if not email:
        raise ValueError("email is required")
    return _client.person(email)


def announcements_list(_: Dict[str, Any]) -> Dict[str, Any]:
    return _client.announcements_list()


def collections_list(_: Dict[str, Any]) -> Dict[str, Any]:
    return _client.collections_list()


def pins_list(_: Dict[str, Any]) -> Dict[str, Any]:
    return _client.pins_list()


def feedback(p: Dict[str, Any]) -> Dict[str, Any]:
    return _client.feedback(
        p.get("tracking_token") or "",
        p.get("rating") or "",
        comments=p.get("comments"),
    )


METHODS: Dict[str, Callable[[Dict[str, Any]], Dict[str, Any]]] = {
    "status": status,
    "login": login,
    "logout": logout,
    "set_mode": set_mode,
    "chat": chat,
    "search": search,
    "autocomplete": autocomplete,
    "datasources.list": list_datasources,
    "datasources.status": datasource_status,
    "insights": insights,
    "agents.list": agents_list,
    "agents.run": agent_run,
    "tools.list": tools_list,
    "tools.call": tools_call,
    "docs.get": docs_get,
    "people.get": people_get,
    "announcements.list": announcements_list,
    "collections.list": collections_list,
    "pins.list": pins_list,
    "feedback": feedback,
}


def _handle(line: str) -> None:
    line = line.strip()
    if not line:
        return
    try:
        req = json.loads(line)
    except json.JSONDecodeError as e:
        _emit({"id": None, "error": f"invalid JSON: {e}"})
        return
    rid = req.get("id")
    method = req.get("method")
    params = req.get("params") or {}
    fn = METHODS.get(method or "")
    if not fn:
        _emit({"id": rid, "error": f"unknown method: {method}"})
        return
    try:
        result = fn(params)
        _emit({"id": rid, "result": result})
    except GleanError as e:
        _emit({"id": rid, "error": f"glean: {e}"})
    except ValueError as e:
        _emit({"id": rid, "error": str(e)})
    except Exception as e:  # noqa: BLE001
        tb = traceback.format_exc(limit=4)
        _log(tb)
        _emit({"id": rid, "error": f"internal: {e}"})


def main() -> None:
    _emit({"event": "ready", "data": status({})})
    for raw in sys.stdin:
        _handle(raw)


if __name__ == "__main__":
    main()
