package remotehooks

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

var codexEvents = []struct {
	name  string
	label string
}{{"SessionStart", "session_start"}, {"UserPromptSubmit", "user_prompt_submit"}, {"PreToolUse", "pre_tool_use"}, {"PermissionRequest", "permission_request"}, {"PostToolUse", "post_tool_use"}, {"Stop", "stop"}}

type codexTrustEntry struct {
	key  string
	hash string
}

func installCodex(home string) InstallStatus {
	configPath := filepath.Join(home, ".codex", "hooks.json")
	tomlPath := filepath.Join(home, ".codex", "config.toml")
	scriptPath := filepath.Join(home, ".pebble", "agent-hooks", "codex-hook.sh")
	config, err := readObject(configPath)
	if err != nil {
		return errorInstall("codex", configPath, fmt.Errorf("could not parse remote Codex hooks.json: %w", err))
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
		cleaned := removeManagedDefinitions(definitions, "codex-hook.sh")
		if len(cleaned) == 0 {
			delete(hooks, event)
		} else {
			hooks[event] = cleaned
		}
	}
	command := managedCommand(scriptPath)
	trust := make([]codexTrustEntry, 0, len(codexEvents))
	for _, event := range codexEvents {
		definitions, _ := hooks[event.name].([]any)
		groupIndex := len(definitions)
		hooks[event.name] = append(definitions, map[string]any{"hooks": []any{map[string]any{"type": "command", "command": command, "timeout": 10}}})
		key := fmt.Sprintf("%s:%s:%d:0", configPath, event.label, groupIndex)
		trust = append(trust, codexTrustEntry{key: key, hash: codexTrustedHash(event.label, command)})
	}
	config["hooks"] = hooks
	if err := writeAtomic(scriptPath, []byte(statusScript("codex", false)), 0o700); err != nil {
		return errorInstall("codex", configPath, err)
	}
	if status := writeJSONStatus("codex", configPath, config); status.State != "installed" {
		return status
	}
	toml, err := os.ReadFile(tomlPath)
	if os.IsNotExist(err) {
		toml = nil
	} else if err != nil {
		return codexTrustError(configPath, err)
	}
	next := string(toml)
	for _, entry := range trust {
		next = upsertCodexTrustBlock(next, entry)
	}
	if err := writeAtomic(tomlPath, []byte(next), 0o600); err != nil {
		return codexTrustError(configPath, err)
	}
	return InstallStatus{Agent: "codex", State: "installed", ConfigPath: configPath, ManagedHooksPresent: true}
}

func codexTrustError(configPath string, err error) InstallStatus {
	return InstallStatus{Agent: "codex", State: "error", ConfigPath: configPath, ManagedHooksPresent: true, Detail: fmt.Sprintf("Hooks installed but trust entries could not be written: %v. Run /hooks in Codex on the remote host to approve.", err)}
}

func codexTrustedHash(eventLabel, command string) string {
	identity := map[string]any{
		"event_name": eventLabel,
		"hooks":      []any{map[string]any{"type": "command", "command": command, "timeout": 10, "async": false}},
	}
	serialized, _ := json.Marshal(identity)
	digest := sha256.Sum256(serialized)
	return "sha256:" + hex.EncodeToString(digest[:])
}

func upsertCodexTrustBlock(content string, entry codexTrustEntry) string {
	escapedKey := strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(entry.key)
	header := `[hooks.state."` + escapedKey + `"]`
	start, end := findTomlBlock(content, header)
	enabled := true
	if start >= 0 {
		block := content[start:end]
		enabled = !regexp.MustCompile(`(?m)^\s*enabled\s*=\s*false\s*(?:#.*)?$`).MatchString(block)
		content = content[:start] + content[end:]
	}
	block := fmt.Sprintf("%s\nenabled = %t\ntrusted_hash = \"%s\"\n", header, enabled, entry.hash)
	content = strings.TrimRight(content, "\r\n")
	if content == "" {
		return block
	}
	return content + "\n\n" + block
}

func findTomlBlock(content, header string) (int, int) {
	search := 0
	for search < len(content) {
		lineEnd := strings.IndexByte(content[search:], '\n')
		if lineEnd < 0 {
			lineEnd = len(content) - search
		}
		line := strings.TrimSpace(strings.TrimSuffix(content[search:search+lineEnd], "\r"))
		if line == header {
			end := search + lineEnd
			if end < len(content) {
				end++
			}
			for end < len(content) {
				nextEnd := strings.IndexByte(content[end:], '\n')
				if nextEnd < 0 {
					nextEnd = len(content) - end
				}
				next := strings.TrimSpace(strings.TrimSuffix(content[end:end+nextEnd], "\r"))
				if strings.HasPrefix(next, "[") {
					break
				}
				end += nextEnd
				if end < len(content) {
					end++
				}
			}
			return search, end
		}
		search += lineEnd
		if search < len(content) {
			search++
		}
	}
	return -1, -1
}
