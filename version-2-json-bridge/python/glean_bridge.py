"""JSON-RPC over stdio bridge to glean_code.client.

Speaks newline-delimited JSON: one request per line, one response per line.

Request:  {"id": "<any>", "method": "<name>", "params": { ... }}
Response: {"id": "<any>", "result": { ... }}     on success
          {"id": "<any>", "error": "..."}         on failure
Notification (sent unsolicited from server -> client):
          {"event": "ready", "data": { ... }}
          {"event": "log",   "data": "..."}

Requests run concurrently, so responses can arrive out of order; match them
by "id". Methods that change session state (login, logout, set_mode) are the
exception: they run in arrival order, so a request sent after `/mode mock`
is always answered in mock mode.

This module is intentionally a thin wrapper around glean_code.client.GleanClient.
The CLI's REPL/UI/scaffold layers are not involved, so we get a stable JSON
contract to build the webview against.
"""
from __future__ import annotations

import dataclasses
import json
import sys
import threading
import traceback
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable, Dict

import glean_code
from glean_code.client import GleanClient, GleanError
from glean_code import config as _config_module
from glean_code.config import Config

# Discovery can land on an older installed CLI, so don't let a missing
# MODES stop the bridge from starting at all.
MODES = getattr(_config_module, "MODES", ("auto", "live", "mock"))


_emit_lock = threading.Lock()


def _emit(obj: Dict[str, Any]) -> None:
    line = json.dumps(obj, ensure_ascii=False) + "\n"
    # Workers finish in any order; one lock keeps each response on its own line.
    with _emit_lock:
        sys.stdout.write(line)
        sys.stdout.flush()


def _log(msg: str) -> None:
    _emit({"event": "log", "data": msg})


# ---------- session state ----------

# One immutable pair, replaced as a whole, so a reader never sees a new
# config with an old client or the reverse.
_initial = Config.load()
_session = (_initial, GleanClient(_initial))
_local = threading.local()


def _cfg() -> Config:
    """The config this request runs under; see `_run`."""
    return getattr(_local, "session", _session)[0]


def _cli() -> GleanClient:
    """The client this request runs under; see `_run`."""
    return getattr(_local, "session", _session)[1]
_chat_id: str | None = None


def _apply(**changes: Any) -> None:
    """Save a changed copy of the config and switch to it.

    Copying instead of editing in place means a call already running on a
    worker thread never reads a half-applied login (new instance, old token).
    Ordered methods call this, so they always see the live session.
    """
    global _session
    new = dataclasses.replace(_session[0], **changes)
    new.save()
    _session = (new, GleanClient(new))


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
        "instance": _cfg().instance,
        "base_url": _cfg().effective_base_url,
        "has_api_token": bool(_cfg().api_token),
        "has_indexing_token": bool(_cfg().indexing_token),
        "act_as": _cfg().act_as,
        "mode": _cfg().effective_mode,
        "mode_setting": _cfg().mode,
        "default_page_size": _cfg().default_page_size,
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
    changes: Dict[str, Any] = {
        "instance": host,
        "base_url": f"{scheme}://{host}/rest/api/v1",
        "api_token": str(token),
    }
    if p.get("act_as"):
        changes["act_as"] = str(p["act_as"])
    _apply(**changes)
    return status({})


def logout(_: Dict[str, Any]) -> Dict[str, Any]:
    _apply(api_token=None, act_as=None)
    return status({})


def set_mode(p: Dict[str, Any]) -> Dict[str, Any]:
    mode = p.get("mode")
    if mode not in MODES:
        raise ValueError(f"mode must be one of {', '.join(MODES)}")
    _apply(mode=mode)
    return status({})


def chat(p: Dict[str, Any]) -> Dict[str, Any]:
    global _chat_id
    message = p.get("message") or ""
    if not message:
        raise ValueError("message is required")
    chat_id = p.get("chat_id") if "chat_id" in p else _chat_id
    if p.get("new"):
        chat_id = None
    resp = _cli().chat(message, chat_id=chat_id, agent=p.get("agent"))
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
    page_size = int(p.get("page_size") or _cfg().default_page_size)
    resp = _cli().search(query, page_size=page_size, datasource=p.get("datasource"))
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
        for r in (_cli().autocomplete(p.get("query", "")).get("results") or [])
    ]}


def list_datasources(p: Dict[str, Any]) -> Dict[str, Any]:
    sample = int(p.get("sample") or 100)
    return _cli().list_datasources(sample_size=sample)


def datasource_status(p: Dict[str, Any]) -> Dict[str, Any]:
    name = p.get("datasource") or ""
    if not name:
        raise ValueError("datasource is required")
    return _cli().datasource_status(name)


def insights(p: Dict[str, Any]) -> Dict[str, Any]:
    return _cli().insights(
        overview=bool(p.get("overview", True)),
        assistant=bool(p.get("assistant", False)),
        agents=bool(p.get("agents", False)),
        disable_per_user=bool(p.get("disable_per_user", False)),
    )


def agents_list(p: Dict[str, Any]) -> Dict[str, Any]:
    return _cli().agents_search(query=p.get("query"))


def agent_run(p: Dict[str, Any]) -> Dict[str, Any]:
    agent_id = p.get("agent_id") or ""
    text = p.get("input") or ""
    if not agent_id or not text:
        raise ValueError("agent_id and input are required")
    return _cli().agent_run(agent_id, text)


def tools_list(_: Dict[str, Any]) -> Dict[str, Any]:
    return _cli().tools_list()


def tools_call(p: Dict[str, Any]) -> Dict[str, Any]:
    name = p.get("name") or ""
    if not name:
        raise ValueError("name is required")
    args = p.get("arguments") or {}
    return _cli().tools_call(name, args)


def docs_get(p: Dict[str, Any]) -> Dict[str, Any]:
    return _cli().get_documents(ids=p.get("ids") or None, urls=p.get("urls") or None)


def people_get(p: Dict[str, Any]) -> Dict[str, Any]:
    email = p.get("email") or ""
    if not email:
        raise ValueError("email is required")
    return _cli().person(email)


def collections_list(_: Dict[str, Any]) -> Dict[str, Any]:
    return _cli().collections_list()


def pins_list(_: Dict[str, Any]) -> Dict[str, Any]:
    return _cli().pins_list()


def feedback(p: Dict[str, Any]) -> Dict[str, Any]:
    return _cli().feedback(
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
    "collections.list": collections_list,
    "pins.list": pins_list,
    "feedback": feedback,
}


# Change session state, so they run in arrival order on the reader thread.
# They only touch the local config file, never the network, so they are fast.
_ORDERED = {"login", "logout", "set_mode"}

# Enough that a few slow live calls (chat, agents.run) don't hold up the
# quick ones behind them; beyond this, requests queue.
_WORKERS = 8


def _handle(line: str, pool: ThreadPoolExecutor) -> None:
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
    if method in _ORDERED:
        _run(rid, fn, params, None)
    else:
        # Capture the session now, not when a worker gets to it: a request
        # sent before `/mode mock` must not run in mock because a worker
        # picked it up after the switch.
        pool.submit(_run, rid, fn, params, _session)


def _run(rid: Any, fn: Callable[[Dict[str, Any]], Dict[str, Any]],
         params: Dict[str, Any], session: Any) -> None:
    if session is not None:
        _local.session = session
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
    finally:
        if session is not None:
            del _local.session


def main() -> None:
    _emit({"event": "ready", "data": status({})})
    # Leaving the block waits for in-flight calls, so closing stdin still
    # delivers every response that was already asked for.
    with ThreadPoolExecutor(max_workers=_WORKERS, thread_name_prefix="glean") as pool:
        for raw in sys.stdin:
            _handle(raw, pool)


if __name__ == "__main__":
    main()
