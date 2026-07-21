package remotehooks

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

var claudeEvents = []string{"UserPromptSubmit", "Stop", "StopFailure", "PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest"}

type InstallStatus struct {
	Agent               string `json:"agent"`
	State               string `json:"state"`
	ConfigPath          string `json:"configPath"`
	ManagedHooksPresent bool   `json:"managedHooksPresent"`
	Detail              string `json:"detail,omitempty"`
}

type compatibleAgent struct {
	name      string
	configDir string
	script    string
}

var compatibleAgents = []compatibleAgent{
	{name: "claude", configDir: ".claude", script: "claude-hook.sh"},
	{name: "openclaude", configDir: ".openclaude", script: "openclaude-hook.sh"},
}

func InstallClaudeCompatible(home string) []InstallStatus {
	home = strings.TrimSpace(home)
	if home == "" || !filepath.IsAbs(home) {
		return []InstallStatus{{Agent: "claude", State: "error", Detail: "remote home must be absolute"}, {Agent: "openclaude", State: "error", Detail: "remote home must be absolute"}}
	}
	statuses := make([]InstallStatus, 0, len(compatibleAgents))
	for _, agent := range compatibleAgents {
		statuses = append(statuses, installCompatible(home, agent))
	}
	return statuses
}

func installCompatible(home string, agent compatibleAgent) InstallStatus {
	configPath := filepath.Join(home, agent.configDir, "settings.json")
	scriptPath := filepath.Join(home, ".pebble", "agent-hooks", agent.script)
	config, err := readObject(configPath)
	if err != nil {
		return InstallStatus{Agent: agent.name, State: "error", ConfigPath: configPath, Detail: err.Error()}
	}
	hooks, _ := config["hooks"].(map[string]any)
	if hooks == nil {
		hooks = make(map[string]any)
	}
	command := fmt.Sprintf("if [ -x %s ]; then /bin/sh %s; fi", shellQuote(scriptPath), shellQuote(scriptPath))
	for event, raw := range hooks {
		definitions, ok := raw.([]any)
		if !ok {
			continue
		}
		cleaned := removeManagedDefinitions(definitions, agent.script)
		if len(cleaned) == 0 {
			delete(hooks, event)
		} else {
			hooks[event] = cleaned
		}
	}
	for _, event := range claudeEvents {
		definitions, _ := hooks[event].([]any)
		hooks[event] = append(definitions, map[string]any{"hooks": []any{map[string]any{"type": "command", "command": command, "timeout": 10}}})
	}
	config["hooks"] = hooks
	// Why: remote settings are published only after the executable exists.
	if err := writeAtomic(scriptPath, []byte(hookScript(agent.name)), 0o700); err != nil {
		return InstallStatus{Agent: agent.name, State: "error", ConfigPath: configPath, Detail: err.Error()}
	}
	content, err := json.MarshalIndent(config, "", "  ")
	if err == nil {
		content = append(content, '\n')
		err = writeAtomic(configPath, content, 0o600)
	}
	if err != nil {
		return InstallStatus{Agent: agent.name, State: "error", ConfigPath: configPath, ManagedHooksPresent: true, Detail: err.Error()}
	}
	return InstallStatus{Agent: agent.name, State: "installed", ConfigPath: configPath, ManagedHooksPresent: true}
}

func readObject(path string) (map[string]any, error) {
	content, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return make(map[string]any), nil
	}
	if err != nil {
		return nil, err
	}
	var value map[string]any
	if err := json.Unmarshal(content, &value); err != nil {
		return nil, err
	}
	return value, nil
}

func removeManagedDefinitions(definitions []any, script string) []any {
	cleaned := make([]any, 0, len(definitions))
	for _, raw := range definitions {
		definition, ok := raw.(map[string]any)
		if !ok {
			cleaned = append(cleaned, raw)
			continue
		}
		handlers, _ := definition["hooks"].([]any)
		nextHandlers := make([]any, 0, len(handlers))
		for _, handlerRaw := range handlers {
			handler, _ := handlerRaw.(map[string]any)
			command, _ := handler["command"].(string)
			if !strings.Contains(command, "agent-hooks/"+script) {
				nextHandlers = append(nextHandlers, handlerRaw)
			}
		}
		if len(nextHandlers) > 0 || len(handlers) == 0 {
			copy := make(map[string]any, len(definition))
			for key, value := range definition {
				copy[key] = value
			}
			copy["hooks"] = nextHandlers
			cleaned = append(cleaned, copy)
		}
	}
	return cleaned
}

func writeAtomic(path string, content []byte, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".pebble-hook-*.tmp")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if _, err = temporary.Write(content); err == nil {
		err = temporary.Chmod(mode)
	}
	if closeErr := temporary.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return replaceAtomicFile(temporaryPath, path)
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}

func hookScript(agent string) string {
	return fmt.Sprintf(`#!/bin/sh
if [ -n "$PEBBLE_AGENT_HOOK_ENDPOINT" ] && [ -r "$PEBBLE_AGENT_HOOK_ENDPOINT" ]; then . "$PEBBLE_AGENT_HOOK_ENDPOINT" 2>/dev/null || :; fi
if [ -z "$PEBBLE_AGENT_HOOK_PORT" ] || [ -z "$PEBBLE_AGENT_HOOK_TOKEN" ] || [ -z "$PEBBLE_PANE_KEY" ]; then exit 0; fi
payload=$(cat); if [ -z "$payload" ]; then exit 0; fi
printf '%%s' "$payload" | curl -sS -X POST "http://127.0.0.1:${PEBBLE_AGENT_HOOK_PORT}/hook/%s" --connect-timeout 0.5 --max-time 1.5 -H "Content-Type: application/x-www-form-urlencoded" -H "X-Pebble-Agent-Hook-Token: ${PEBBLE_AGENT_HOOK_TOKEN}" --data-urlencode "paneKey=${PEBBLE_PANE_KEY}" --data-urlencode "tabId=${PEBBLE_TAB_ID}" --data-urlencode "launchToken=${PEBBLE_AGENT_LAUNCH_TOKEN}" --data-urlencode "worktreeId=${PEBBLE_WORKTREE_ID}" --data-urlencode "env=${PEBBLE_AGENT_HOOK_ENV}" --data-urlencode "version=${PEBBLE_AGENT_HOOK_VERSION}" --data-urlencode "payload@-" >/dev/null 2>&1 || true
exit 0
`, agent)
}
