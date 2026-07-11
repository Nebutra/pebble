package remotehooks

import (
	"path/filepath"
)

type antigravityEvent struct {
	name string
	tool bool
}

var antigravityEvents = []antigravityEvent{{"PreInvocation", false}, {"PostInvocation", false}, {"Stop", false}, {"PostToolUse", true}}
var copilotEvents = []string{"SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "subagentStart", "SubagentStop", "PreCompact", "Stop", "ErrorOccurred", "PermissionRequest", "Notification"}

func installAntigravity(home string) InstallStatus {
	configPath := filepath.Join(home, ".gemini", "config", "hooks.json")
	scriptPath := filepath.Join(home, ".pebble", "agent-hooks", "antigravity-hook.sh")
	config, err := readObject(configPath)
	if err != nil {
		return errorInstall("antigravity", configPath, err)
	}
	bundle, _ := config["pebble-status"].(map[string]any)
	if bundle == nil {
		bundle = make(map[string]any)
	}
	for event, raw := range bundle {
		definitions, ok := raw.([]any)
		if !ok {
			continue
		}
		cleaned := removeDirectAndNestedManaged(definitions, "antigravity-hook.sh")
		if len(cleaned) == 0 {
			delete(bundle, event)
		} else {
			bundle[event] = cleaned
		}
	}
	for _, event := range antigravityEvents {
		definitions, _ := bundle[event.name].([]any)
		command := managedCommandWithEnv(scriptPath, "PEBBLE_ANTIGRAVITY_EVENT", event.name)
		if event.tool {
			bundle[event.name] = append(definitions, map[string]any{"matcher": "*", "hooks": []any{map[string]any{"type": "command", "command": command, "timeout": 10}}})
		} else {
			bundle[event.name] = append(definitions, map[string]any{"type": "command", "command": command, "timeout": 10})
		}
	}
	config["pebble-status"] = bundle
	if err := writeAtomic(scriptPath, []byte(antigravityScript), 0o700); err != nil {
		return errorInstall("antigravity", configPath, err)
	}
	return writeJSONStatus("antigravity", configPath, config)
}

func installCopilot(home string) InstallStatus {
	configPath := filepath.Join(home, ".copilot", "hooks", "pebble.json")
	scriptPath := filepath.Join(home, ".pebble", "agent-hooks", "copilot-hook.sh")
	config, err := readObject(configPath)
	if err != nil {
		return errorInstall("copilot", configPath, err)
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
		cleaned := removeDirectAndNestedManaged(definitions, "copilot-hook.sh")
		if len(cleaned) == 0 {
			delete(hooks, event)
		} else {
			hooks[event] = cleaned
		}
	}
	for _, event := range copilotEvents {
		definitions, _ := hooks[event].([]any)
		hooks[event] = append(definitions, map[string]any{"type": "command", "bash": managedCommandWithEnv(scriptPath, "PEBBLE_COPILOT_HOOK_EVENT", event), "timeoutSec": 5})
	}
	config["version"] = 1
	delete(config, "disableAllHooks")
	config["hooks"] = hooks
	if err := writeAtomic(scriptPath, []byte(copilotScript), 0o700); err != nil {
		return errorInstall("copilot", configPath, err)
	}
	return writeJSONStatus("copilot", configPath, config)
}

func managedCommandWithEnv(scriptPath, key, value string) string {
	return "if [ -x " + shellQuote(scriptPath) + " ]; then " + key + "=" + shellQuote(value) + " /bin/sh " + shellQuote(scriptPath) + "; fi"
}

func removeDirectAndNestedManaged(definitions []any, script string) []any {
	cleaned := removeManagedDefinitions(definitions, script)
	output := make([]any, 0, len(cleaned))
	for _, raw := range cleaned {
		definition, _ := raw.(map[string]any)
		managed := false
		for _, key := range []string{"command", "bash", "powershell"} {
			if command, _ := definition[key].(string); command != "" && containsManagedScript(command, script) {
				managed = true
			}
		}
		if !managed {
			output = append(output, raw)
		}
	}
	return output
}

func containsManagedScript(command, script string) bool {
	return len(command) > 0 && filepath.Base(script) != "" && contains(command, "agent-hooks/"+script)
}

func contains(value, needle string) bool {
	for index := 0; index+len(needle) <= len(value); index++ {
		if value[index:index+len(needle)] == needle {
			return true
		}
	}
	return false
}

const antigravityScript = `#!/bin/sh
case "$PEBBLE_ANTIGRAVITY_EVENT" in Stop) printf '{"decision":""}\n' ;; *) printf '{}\n' ;; esac
if [ -n "$PEBBLE_AGENT_HOOK_ENDPOINT" ] && [ -r "$PEBBLE_AGENT_HOOK_ENDPOINT" ]; then . "$PEBBLE_AGENT_HOOK_ENDPOINT" 2>/dev/null || :; fi
if [ -z "$PEBBLE_AGENT_HOOK_PORT" ] || [ -z "$PEBBLE_AGENT_HOOK_TOKEN" ] || [ -z "$PEBBLE_PANE_KEY" ]; then exit 0; fi
payload=$(cat); if [ -z "$payload" ]; then payload='{}'; fi
printf '%s' "$payload" | curl -sS -X POST "http://127.0.0.1:${PEBBLE_AGENT_HOOK_PORT}/hook/antigravity" --connect-timeout 0.5 --max-time 1.5 -H "Content-Type: application/x-www-form-urlencoded" -H "X-Pebble-Agent-Hook-Token: ${PEBBLE_AGENT_HOOK_TOKEN}" --data-urlencode "paneKey=${PEBBLE_PANE_KEY}" --data-urlencode "tabId=${PEBBLE_TAB_ID}" --data-urlencode "launchToken=${PEBBLE_AGENT_LAUNCH_TOKEN}" --data-urlencode "worktreeId=${PEBBLE_WORKTREE_ID}" --data-urlencode "env=${PEBBLE_AGENT_HOOK_ENV}" --data-urlencode "version=${PEBBLE_AGENT_HOOK_VERSION}" --data-urlencode "hook_event_name=${PEBBLE_ANTIGRAVITY_EVENT}" --data-urlencode "payload@-" >/dev/null 2>&1 || true
exit 0
`

const copilotScript = `#!/bin/sh
printf '{}\n'
if [ -n "$PEBBLE_AGENT_HOOK_ENDPOINT" ] && [ -r "$PEBBLE_AGENT_HOOK_ENDPOINT" ]; then . "$PEBBLE_AGENT_HOOK_ENDPOINT" 2>/dev/null || :; fi
if [ -z "$PEBBLE_AGENT_HOOK_PORT" ] || [ -z "$PEBBLE_AGENT_HOOK_TOKEN" ] || [ -z "$PEBBLE_PANE_KEY" ]; then exit 0; fi
payload=$(cat); if [ -z "$payload" ]; then exit 0; fi
printf '%s' "$payload" | curl -sS -X POST "http://127.0.0.1:${PEBBLE_AGENT_HOOK_PORT}/hook/copilot" --connect-timeout 0.5 --max-time 1.5 -H "Content-Type: application/x-www-form-urlencoded" -H "X-Pebble-Agent-Hook-Token: ${PEBBLE_AGENT_HOOK_TOKEN}" --data-urlencode "paneKey=${PEBBLE_PANE_KEY}" --data-urlencode "tabId=${PEBBLE_TAB_ID}" --data-urlencode "launchToken=${PEBBLE_AGENT_LAUNCH_TOKEN}" --data-urlencode "worktreeId=${PEBBLE_WORKTREE_ID}" --data-urlencode "hookEventName=${PEBBLE_COPILOT_HOOK_EVENT}" --data-urlencode "env=${PEBBLE_AGENT_HOOK_ENV}" --data-urlencode "version=${PEBBLE_AGENT_HOOK_VERSION}" --data-urlencode "payload@-" >/dev/null 2>&1 || true
exit 0
`
