package remotehooks

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/tailscale/hujson"
)

var devinEvents = []string{"SessionStart", "UserPromptSubmit", "Stop", "PostCompaction", "SessionEnd", "PreToolUse", "PostToolUse", "PermissionRequest"}

func installDevin(home string) InstallStatus {
	configPath := filepath.Join(home, ".config", "devin", "config.json")
	scriptPath := filepath.Join(home, ".pebble", "agent-hooks", "devin-hook.sh")
	config, err := readDevinConfig(configPath)
	if err != nil {
		return errorInstall("devin", configPath, fmt.Errorf("could not parse remote Devin config.json: %w", err))
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
		cleaned := removeManagedDefinitions(definitions, "devin-hook.sh")
		if len(cleaned) == 0 {
			delete(hooks, event)
		} else {
			hooks[event] = cleaned
		}
	}
	command := managedCommand(scriptPath)
	for _, event := range devinEvents {
		definitions, _ := hooks[event].([]any)
		// Devin treats an omitted matcher as all; Claude's wildcard is invalid here.
		hooks[event] = append(definitions, map[string]any{"hooks": []any{map[string]any{"type": "command", "command": command}}})
	}
	config["hooks"] = hooks
	content, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return errorInstall("devin", configPath, err)
	}
	content = append(content, '\n')
	if err := writeAtomic(scriptPath, []byte(statusScript("devin", false)), 0o700); err != nil {
		return errorInstall("devin", configPath, err)
	}
	if err := writeAtomic(configPath, content, 0o600); err != nil {
		return errorInstall("devin", configPath, err)
	}
	status := InstallStatus{Agent: "devin", State: "installed", ConfigPath: configPath, ManagedHooksPresent: true}
	if claudeImportEnabled(config["read_config_from"]) {
		status.Detail = "Devin read_config_from.claude is enabled; imported Claude hooks may fire alongside Devin hooks."
	}
	return status
}

func readDevinConfig(path string) (map[string]any, error) {
	content, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return make(map[string]any), nil
	}
	if err != nil {
		return nil, err
	}
	standard, err := hujson.Standardize(content)
	if err != nil {
		return nil, err
	}
	config := make(map[string]any)
	if err := json.Unmarshal(standard, &config); err != nil {
		return nil, err
	}
	return config, nil
}

func claudeImportEnabled(raw any) bool {
	if raw == nil {
		return true
	}
	if enabled, ok := raw.(bool); ok {
		return enabled
	}
	if values, ok := raw.([]any); ok {
		for _, value := range values {
			if value == "claude" {
				return true
			}
		}
		return false
	}
	if value, ok := raw.(map[string]any); ok {
		enabled, exists := value["claude"].(bool)
		return !exists || enabled
	}
	return false
}
