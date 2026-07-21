package remotehooks

import "path/filepath"

func installCommandCode(home string) InstallStatus {
	configPath := filepath.Join(home, ".commandcode", "settings.json")
	scriptPath := filepath.Join(home, ".pebble", "agent-hooks", "command-code-hook.sh")
	config, err := readObject(configPath)
	if err != nil {
		return errorInstall("command-code", configPath, err)
	}
	hooks, _ := config["hooks"].(map[string]any)
	if hooks == nil {
		hooks = make(map[string]any)
	}
	for event, raw := range hooks {
		definitions, ok := raw.([]any)
		if !ok {
			continue
		}
		cleaned := removeManagedDefinitions(definitions, "command-code-hook.sh")
		if len(cleaned) == 0 {
			delete(hooks, event)
		} else {
			hooks[event] = cleaned
		}
	}
	command := managedCommand(scriptPath)
	for _, event := range []struct {
		name    string
		matcher bool
	}{{"PreToolUse", true}, {"PostToolUse", true}, {"Stop", false}} {
		definitions, _ := hooks[event.name].([]any)
		definition := map[string]any{"hooks": []any{map[string]any{"type": "command", "command": command, "timeout": 10}}}
		if event.matcher {
			definition["matcher"] = ".*"
		}
		hooks[event.name] = append(definitions, definition)
	}
	config["hooks"] = hooks
	if err := writeAtomic(scriptPath, []byte(commandCodeScript), 0o700); err != nil {
		return errorInstall("command-code", configPath, err)
	}
	return writeJSONStatus("command-code", configPath, config)
}

const commandCodeScript = `#!/bin/sh
__pebble_read_ancestor_var() {
  name="$1"; pid="${PPID:-}"
  while [ -n "$pid" ] && [ "$pid" != "0" ] && [ "$pid" != "1" ]; do
    value=""
    if [ -r "/proc/$pid/environ" ]; then value=$(tr "\000" "\n" < "/proc/$pid/environ" 2>/dev/null | sed -n "s/^${name}=//p" | head -n 1); fi
    if [ -z "$value" ]; then value=$(ps eww -p "$pid" -o command= 2>/dev/null | tr " " "\n" | sed -n "s/^${name}=//p" | head -n 1); fi
    if [ -n "$value" ]; then printf '%s\n' "$value"; return 0; fi
    pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d " ")
  done
  return 1
}
__pebble_fill_from_ancestor() {
  name="$1"; eval "current=\${$name:-}"; [ -z "$current" ] || return 0
  value=$(__pebble_read_ancestor_var "$name") || return 0
  [ -n "$value" ] && export "$name=$value"
}
__pebble_endpoint_value() { sed -n "s/^$1=//p" "$2" 2>/dev/null | head -n 1; }
__pebble_fill_from_endpoint_file() {
  endpoint="$1"; [ -r "$endpoint" ] || return 0
  endpoint_port=$(__pebble_endpoint_value PEBBLE_AGENT_HOOK_PORT "$endpoint")
  if [ -n "${PEBBLE_AGENT_HOOK_PORT:-}" ] && [ -n "$endpoint_port" ] && [ "$endpoint_port" != "$PEBBLE_AGENT_HOOK_PORT" ]; then return 0; fi
  for suffix in AGENT_HOOK_PORT AGENT_HOOK_TOKEN AGENT_HOOK_ENV AGENT_HOOK_VERSION; do
    eval "current=\${PEBBLE_$suffix:-}"; [ -z "$current" ] || continue
    value=$(__pebble_endpoint_value "PEBBLE_$suffix" "$endpoint"); [ -n "$value" ] && export "PEBBLE_$suffix=$value"
  done
}
for name in PEBBLE_AGENT_HOOK_ENDPOINT PEBBLE_AGENT_HOOK_PORT PEBBLE_AGENT_HOOK_TOKEN PEBBLE_AGENT_HOOK_ENV PEBBLE_AGENT_HOOK_VERSION PEBBLE_PANE_KEY PEBBLE_TAB_ID PEBBLE_WORKTREE_ID PEBBLE_AGENT_LAUNCH_TOKEN; do __pebble_fill_from_ancestor "$name"; done
if [ -n "${PEBBLE_AGENT_HOOK_ENDPOINT:-}" ] && [ -r "$PEBBLE_AGENT_HOOK_ENDPOINT" ]; then __pebble_fill_from_endpoint_file "$PEBBLE_AGENT_HOOK_ENDPOINT"; fi
if [ -z "${PEBBLE_AGENT_HOOK_TOKEN:-}" ] && [ -n "${PEBBLE_AGENT_HOOK_PORT:-}" ]; then
  # Command Code strips TOKEN-like variables, so locate the matching endpoint by the surviving port.
  for endpoint in "$HOME/Library/Application Support/pebble-dev/agent-hooks"/*/endpoint.env "$HOME/Library/Application Support/pebble-dev/agent-hooks/endpoint.env" "${XDG_CONFIG_HOME:-$HOME/.config}/pebble-dev/agent-hooks"/*/endpoint.env "${XDG_CONFIG_HOME:-$HOME/.config}/pebble-dev/agent-hooks/endpoint.env" "$HOME/Library/Application Support/pebble/agent-hooks/endpoint.env" "${XDG_CONFIG_HOME:-$HOME/.config}/pebble/agent-hooks/endpoint.env"; do
    [ -r "$endpoint" ] || continue; endpoint_port=$(__pebble_endpoint_value PEBBLE_AGENT_HOOK_PORT "$endpoint")
    if [ "$endpoint_port" = "$PEBBLE_AGENT_HOOK_PORT" ]; then __pebble_fill_from_endpoint_file "$endpoint"; break; fi
  done
fi
if [ -z "${PEBBLE_AGENT_HOOK_PORT:-}" ] || [ -z "${PEBBLE_AGENT_HOOK_TOKEN:-}" ] || [ -z "${PEBBLE_PANE_KEY:-}" ]; then exit 0; fi
payload=$(cat); [ -n "$payload" ] || exit 0
printf '%s' "$payload" | curl -sS -X POST "http://127.0.0.1:${PEBBLE_AGENT_HOOK_PORT}/hook/command-code" --connect-timeout 0.5 --max-time 1.5 -H "Content-Type: application/x-www-form-urlencoded" -H "X-Pebble-Agent-Hook-Token: ${PEBBLE_AGENT_HOOK_TOKEN}" --data-urlencode "paneKey=${PEBBLE_PANE_KEY}" --data-urlencode "tabId=${PEBBLE_TAB_ID}" --data-urlencode "launchToken=${PEBBLE_AGENT_LAUNCH_TOKEN}" --data-urlencode "worktreeId=${PEBBLE_WORKTREE_ID}" --data-urlencode "env=${PEBBLE_AGENT_HOOK_ENV}" --data-urlencode "version=${PEBBLE_AGENT_HOOK_VERSION}" --data-urlencode "payload@-" >/dev/null 2>&1 || true
exit 0
`
