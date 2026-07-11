package remotehooks

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
)

var geminiEvents = []string{"BeforeAgent", "AfterAgent", "AfterTool", "BeforeTool"}
var cursorEvents = []string{"beforeSubmitPrompt", "stop", "preToolUse", "postToolUse", "postToolUseFailure", "beforeShellExecution", "beforeMCPExecution", "afterAgentResponse"}

func InstallAll(home string) []InstallStatus {
	statuses := InstallClaudeCompatible(home)
	if len(statuses) > 0 && statuses[0].State == "error" && statuses[0].ConfigPath == "" {
		return statuses
	}
	return append(statuses, installGemini(home), installCursor(home), installDroid(home), installAmp(home), installAntigravity(home), installCopilot(home), installGrok(home), installCommandCode(home), installHermes(home), installDevin(home), installKimi(home), installCodex(home))
}

func installGemini(home string) InstallStatus {
	return installNestedJSONAgent(home, nestedJSONAgent{
		name: "gemini", config: ".gemini/settings.json", script: "gemini-hook.sh",
		events: geminiEvents, timeout: 10000, stdoutJSON: true,
	})
}

type nestedJSONAgent struct {
	name       string
	config     string
	script     string
	events     []string
	timeout    int
	stdoutJSON bool
	matchers   map[string]string
}

func installNestedJSONAgent(home string, agent nestedJSONAgent) InstallStatus {
	configPath := filepath.Join(home, agent.config)
	scriptPath := filepath.Join(home, ".pebble", "agent-hooks", agent.script)
	config, err := readObject(configPath)
	if err != nil {
		return errorInstall(agent.name, configPath, err)
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
		cleaned := removeManagedDefinitions(definitions, agent.script)
		if len(cleaned) == 0 {
			delete(hooks, event)
		} else {
			hooks[event] = cleaned
		}
	}
	command := managedCommand(scriptPath)
	for _, event := range agent.events {
		definitions, _ := hooks[event].([]any)
		definition := map[string]any{"hooks": []any{map[string]any{"type": "command", "command": command, "timeout": agent.timeout}}}
		if matcher, ok := agent.matchers[event]; ok {
			definition["matcher"] = matcher
		}
		hooks[event] = append(definitions, definition)
	}
	config["hooks"] = hooks
	if err := writeAtomic(scriptPath, []byte(statusScript(agent.name, agent.stdoutJSON)), 0o700); err != nil {
		return errorInstall(agent.name, configPath, err)
	}
	return writeJSONStatus(agent.name, configPath, config)
}

func installCursor(home string) InstallStatus {
	configPath := filepath.Join(home, ".cursor", "hooks.json")
	scriptPath := filepath.Join(home, ".pebble", "agent-hooks", "cursor-hook.sh")
	config, err := readObject(configPath)
	if err != nil {
		return errorInstall("cursor", configPath, err)
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
		cleaned := removeCursorManaged(definitions)
		if len(cleaned) == 0 {
			delete(hooks, event)
		} else {
			hooks[event] = cleaned
		}
	}
	command := managedCommand(scriptPath)
	for _, event := range cursorEvents {
		definitions, _ := hooks[event].([]any)
		hooks[event] = append(definitions, map[string]any{"type": "command", "command": command, "timeout": 10})
	}
	config["hooks"] = hooks
	if _, exists := config["version"]; !exists {
		config["version"] = 1
	}
	if err := writeAtomic(scriptPath, []byte(statusScript("cursor", false)), 0o700); err != nil {
		return errorInstall("cursor", configPath, err)
	}
	return writeJSONStatus("cursor", configPath, config)
}

func installDroid(home string) InstallStatus {
	return installNestedJSONAgent(home, nestedJSONAgent{
		name: "droid", config: ".factory/settings.json", script: "droid-hook.sh", timeout: 10,
		events:   []string{"SessionStart", "UserPromptSubmit", "Stop", "SubagentStop", "PreToolUse", "PostToolUse", "PermissionRequest", "Notification"},
		matchers: map[string]string{"PreToolUse": "*", "PostToolUse": "*", "PermissionRequest": "*"},
	})
}

func installGrok(home string) InstallStatus {
	return installNestedJSONAgent(home, nestedJSONAgent{
		name: "grok", config: ".grok/hooks/pebble-status.json", script: "grok-hook.sh", timeout: 10,
		events:   []string{"SessionStart", "UserPromptSubmit", "Stop", "SessionEnd", "PreToolUse", "PostToolUse", "PostToolUseFailure", "Notification"},
		matchers: map[string]string{"PreToolUse": "*", "PostToolUse": "*", "PostToolUseFailure": "*"},
	})
}

func removeCursorManaged(definitions []any) []any {
	cleaned := removeManagedDefinitions(definitions, "cursor-hook.sh")
	output := make([]any, 0, len(cleaned))
	for _, raw := range cleaned {
		definition, _ := raw.(map[string]any)
		command, _ := definition["command"].(string)
		if !strings.Contains(command, "agent-hooks/cursor-hook.sh") {
			output = append(output, raw)
		}
	}
	return output
}

func managedCommand(scriptPath string) string {
	return fmt.Sprintf("if [ -x %s ]; then /bin/sh %s; fi", shellQuote(scriptPath), shellQuote(scriptPath))
}

func statusScript(agent string, stdoutJSON bool) string {
	prefix := ""
	if stdoutJSON {
		prefix = "printf '{}\\n'\n"
	}
	return fmt.Sprintf("#!/bin/sh\n%sif [ -n \"$PEBBLE_AGENT_HOOK_ENDPOINT\" ] && [ -r \"$PEBBLE_AGENT_HOOK_ENDPOINT\" ]; then . \"$PEBBLE_AGENT_HOOK_ENDPOINT\" 2>/dev/null || :; fi\nif [ -z \"$PEBBLE_AGENT_HOOK_PORT\" ] || [ -z \"$PEBBLE_AGENT_HOOK_TOKEN\" ] || [ -z \"$PEBBLE_PANE_KEY\" ]; then exit 0; fi\npayload=$(cat); if [ -z \"$payload\" ]; then exit 0; fi\nprintf '%%s' \"$payload\" | curl -sS -X POST \"http://127.0.0.1:${PEBBLE_AGENT_HOOK_PORT}/hook/%s\" --connect-timeout 0.5 --max-time 1.5 -H \"Content-Type: application/x-www-form-urlencoded\" -H \"X-Pebble-Agent-Hook-Token: ${PEBBLE_AGENT_HOOK_TOKEN}\" --data-urlencode \"paneKey=${PEBBLE_PANE_KEY}\" --data-urlencode \"tabId=${PEBBLE_TAB_ID}\" --data-urlencode \"launchToken=${PEBBLE_AGENT_LAUNCH_TOKEN}\" --data-urlencode \"worktreeId=${PEBBLE_WORKTREE_ID}\" --data-urlencode \"env=${PEBBLE_AGENT_HOOK_ENV}\" --data-urlencode \"version=${PEBBLE_AGENT_HOOK_VERSION}\" --data-urlencode \"payload@-\" >/dev/null 2>&1 || true\nexit 0\n", prefix, agent)
}

func writeJSONStatus(agent, configPath string, config map[string]any) InstallStatus {
	content, err := json.MarshalIndent(config, "", "  ")
	if err == nil {
		content = append(content, '\n')
		err = writeAtomic(configPath, content, 0o600)
	}
	if err != nil {
		return errorInstall(agent, configPath, err)
	}
	return InstallStatus{Agent: agent, State: "installed", ConfigPath: configPath, ManagedHooksPresent: true}
}

func errorInstall(agent, path string, err error) InstallStatus {
	return InstallStatus{Agent: agent, State: "error", ConfigPath: path, Detail: err.Error()}
}
