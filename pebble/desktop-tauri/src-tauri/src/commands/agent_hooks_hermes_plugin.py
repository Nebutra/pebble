# Managed by Pebble. Do not edit; changes may be overwritten.
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any, Callable, Optional

EVENTS = ("on_session_start", "pre_llm_call", "post_llm_call", "pre_tool_call", "post_tool_call", "pre_approval_request", "post_approval_response", "on_session_end", "on_session_finalize", "on_session_reset")
MAX_JSONABLE_DEPTH = 5
MAX_JSONABLE_ITEMS = 50
MAX_JSONABLE_NODES = 500
MAX_JSONABLE_STRING = 8192
TRUNCATED = "...[truncated]"
SELECTED_KEYS = {
    "on_session_start": ("session_id", "model", "platform"),
    "pre_llm_call": ("session_id", "user_message", "is_first_turn", "model", "platform", "sender_id"),
    "post_llm_call": ("session_id", "user_message", "assistant_response", "model", "platform"),
    "pre_tool_call": ("session_id", "task_id", "tool_call_id", "tool_name", "args"),
    "post_tool_call": ("session_id", "task_id", "tool_call_id", "tool_name", "args", "result", "duration_ms"),
    "pre_approval_request": ("command", "description", "pattern_key", "pattern_keys", "session_key", "surface"),
    "post_approval_response": ("command", "description", "pattern_key", "pattern_keys", "session_key", "surface", "choice"),
    "on_session_end": ("session_id",),
    "on_session_finalize": ("session_id", "platform"),
    "on_session_reset": ("session_id", "platform"),
}


def _truncate_string(value: str) -> str:
    return value if len(value) <= MAX_JSONABLE_STRING else value[:MAX_JSONABLE_STRING] + TRUNCATED


def _jsonable(value: Any, depth: int = 0, budget: Optional[list[int]] = None) -> Any:
    if budget is None:
        budget = [MAX_JSONABLE_NODES]
    if budget[0] <= 0:
        return TRUNCATED
    budget[0] -= 1
    if depth > MAX_JSONABLE_DEPTH:
        return _truncate_string(repr(value))
    if value is None or isinstance(value, (int, float, bool)):
        return value
    if isinstance(value, str):
        return _truncate_string(value)
    if isinstance(value, dict):
        out = {}
        for index, (key, child) in enumerate(value.items()):
            if index >= MAX_JSONABLE_ITEMS:
                out[TRUNCATED] = True
                break
            out[_truncate_string(str(key))] = _jsonable(child, depth + 1, budget)
        return out
    if isinstance(value, (list, tuple, set)):
        out = []
        for index, child in enumerate(value):
            if index >= MAX_JSONABLE_ITEMS:
                out.append(TRUNCATED)
                break
            out.append(_jsonable(child, depth + 1, budget))
        return out
    return _truncate_string(repr(value))


def _endpoint_env() -> dict[str, str]:
    env = dict(os.environ)
    endpoint = env.get("PEBBLE_AGENT_HOOK_ENDPOINT", "")
    if endpoint and os.path.isfile(endpoint):
        try:
            with open(endpoint, "r", encoding="utf-8") as handle:
                for raw in handle:
                    line = raw.strip()
                    if not line or line.startswith("#"):
                        continue
                    if line.startswith("set "):
                        line = line[4:]
                    key, separator, value = line.partition("=")
                    if separator and key:
                        env[key] = value
        except OSError:
            pass
    return env


def _post_to_pebble(payload: dict[str, Any]) -> None:
    env = _endpoint_env()
    port, token, pane_key = (env.get("PEBBLE_AGENT_HOOK_PORT", ""), env.get("PEBBLE_AGENT_HOOK_TOKEN", ""), env.get("PEBBLE_PANE_KEY", ""))
    if not port or not token or not pane_key:
        return
    body = {"paneKey": pane_key, "launchToken": env.get("PEBBLE_AGENT_LAUNCH_TOKEN", ""), "tabId": env.get("PEBBLE_TAB_ID", ""), "worktreeId": env.get("PEBBLE_WORKTREE_ID", ""), "env": env.get("PEBBLE_AGENT_HOOK_ENV", ""), "version": env.get("PEBBLE_AGENT_HOOK_VERSION", ""), "payload": payload}
    request = urllib.request.Request(f"http://127.0.0.1:{port}/hook/hermes", data=json.dumps(body, separators=(",", ":")).encode("utf-8"), method="POST", headers={"Content-Type": "application/json", "X-Pebble-Agent-Hook-Token": token})
    try:
        with urllib.request.urlopen(request, timeout=0.75):
            pass
    except (OSError, urllib.error.URLError):
        return


def _payload_for_event(event_name: str, kwargs: dict[str, Any]) -> dict[str, Any]:
    payload = {"hook_event_name": event_name, "cwd": os.getcwd()}
    for key in SELECTED_KEYS.get(event_name, ()):
        if key in kwargs:
            payload[key] = _jsonable(kwargs[key])
    if "user_message" in payload:
        payload["prompt"] = payload["user_message"]
    if "assistant_response" in payload:
        payload["last_assistant_message"] = payload["assistant_response"]
    if "args" in payload:
        payload["tool_input"] = payload["args"]
    if event_name in {"pre_approval_request", "post_approval_response"}:
        payload["tool_name"] = "approval"
        payload["tool_input"] = {"command": payload.get("command", ""), "description": payload.get("description", "")}
    return payload


def _make_hook(event_name: str) -> Callable[..., None]:
    def _hook(**kwargs: Any) -> None:
        _post_to_pebble(_payload_for_event(event_name, kwargs))
    return _hook


def register(ctx: Any) -> None:
    for event_name in EVENTS:
        ctx.register_hook(event_name, _make_hook(event_name))
