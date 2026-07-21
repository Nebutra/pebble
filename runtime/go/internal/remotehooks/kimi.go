package remotehooks

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const kimiBlockStart = "# >>> pebble-managed-kimi-hooks (managed by Pebble; do not edit) >>>"
const kimiBlockEnd = "# <<< pebble-managed-kimi-hooks <<<"

var kimiEvents = []string{"UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest", "Stop", "StopFailure"}

func installKimi(home string) InstallStatus {
	configPath := filepath.Join(home, ".kimi-code", "config.toml")
	scriptPath := filepath.Join(home, ".pebble", "agent-hooks", "kimi-hook.sh")
	content, err := os.ReadFile(configPath)
	if os.IsNotExist(err) {
		content = nil
	} else if err != nil {
		return errorInstall("kimi", configPath, err)
	}
	next := applyKimiBlock(string(content), managedCommand(scriptPath))
	if err := writeAtomic(scriptPath, []byte(statusScript("kimi", false)), 0o700); err != nil {
		return errorInstall("kimi", configPath, err)
	}
	if len(content) > 0 && string(content) != next {
		if err := writeAtomic(configPath+".bak", content, 0o600); err != nil {
			return errorInstall("kimi", configPath, err)
		}
	}
	if err := writeAtomic(configPath, []byte(next), 0o600); err != nil {
		return errorInstall("kimi", configPath, err)
	}
	return InstallStatus{Agent: "kimi", State: "installed", ConfigPath: configPath, ManagedHooksPresent: true}
}

func applyKimiBlock(content, command string) string {
	without := removeKimiBlock(content)
	without = strings.TrimRight(without, " \t\r\n")
	block := buildKimiBlock(command)
	if without == "" {
		return block + "\n"
	}
	return without + "\n\n" + block + "\n"
}

func removeKimiBlock(content string) string {
	for {
		start := strings.Index(content, kimiBlockStart)
		if start < 0 {
			return content
		}
		for start > 0 && content[start-1] == '\n' {
			start--
		}
		endOffset := strings.Index(content[start:], kimiBlockEnd)
		if endOffset < 0 {
			return content[:start]
		}
		end := start + endOffset + len(kimiBlockEnd)
		for end < len(content) && content[end] != '\n' {
			end++
		}
		content = content[:start] + content[end:]
	}
}

func buildKimiBlock(command string) string {
	command = strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", `\n`, "\r", `\r`, "\t", `\t`).Replace(command)
	lines := []string{kimiBlockStart}
	for _, event := range kimiEvents {
		lines = append(lines, "[[hooks]]", fmt.Sprintf(`event = "%s"`, event), fmt.Sprintf(`command = "%s"`, command), "timeout = 10")
	}
	return strings.Join(append(lines, kimiBlockEnd), "\n")
}
