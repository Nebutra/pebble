package remotehooks

import (
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

type windowsNestedAgent struct {
	name       string
	config     string
	script     string
	events     []string
	timeout    int
	stdoutJSON bool
	matchers   map[string]string
	command    func(string) string
}

func installAllWindows(home string) []InstallStatus {
	home = strings.TrimSpace(home)
	if home == "" || !filepath.IsAbs(home) {
		statuses := make([]InstallStatus, 0, 14)
		for _, agent := range windowsAgentNames() {
			statuses = append(statuses, InstallStatus{Agent: agent, State: "error", Detail: "remote home must be absolute"})
		}
		return statuses
	}
	return []InstallStatus{
		installWindowsNested(home, windowsNestedAgent{name: "claude", config: `.claude/settings.json`, script: "claude-hook.cmd", events: claudeEvents, timeout: 10}),
		installWindowsNested(home, windowsNestedAgent{name: "openclaude", config: `.openclaude/settings.json`, script: "openclaude-hook.cmd", events: claudeEvents, timeout: 10}),
		installWindowsNested(home, windowsNestedAgent{name: "gemini", config: `.gemini/settings.json`, script: "gemini-hook.cmd", events: geminiEvents, timeout: 10000, stdoutJSON: true}),
		installWindowsCursor(home),
		installWindowsNested(home, windowsNestedAgent{name: "droid", config: `.factory/settings.json`, script: "droid-hook.cmd", events: []string{"SessionStart", "UserPromptSubmit", "Stop", "SubagentStop", "PreToolUse", "PostToolUse", "PermissionRequest", "Notification"}, timeout: 10, matchers: map[string]string{"PreToolUse": "*", "PostToolUse": "*", "PermissionRequest": "*"}}),
		installAmp(home),
		installWindowsAntigravity(home),
		installWindowsCopilot(home),
		installWindowsNested(home, windowsNestedAgent{name: "grok", config: `.grok/hooks/pebble-status.json`, script: "grok-hook.cmd", events: []string{"SessionStart", "UserPromptSubmit", "Stop", "SessionEnd", "PreToolUse", "PostToolUse", "PostToolUseFailure", "Notification"}, timeout: 10, matchers: map[string]string{"PreToolUse": "*", "PostToolUse": "*", "PostToolUseFailure": "*"}}),
		installWindowsCommandCode(home),
		installHermes(home),
		installWindowsDevin(home),
		installWindowsKimi(home),
		installWindowsCodex(home),
	}
}

func windowsAgentNames() []string {
	return []string{"claude", "openclaude", "gemini", "cursor", "droid", "amp", "antigravity", "copilot", "grok", "command-code", "hermes", "devin", "kimi", "codex"}
}

func installWindowsNested(home string, agent windowsNestedAgent) InstallStatus {
	configPath := filepath.Join(home, filepath.FromSlash(agent.config))
	scriptPath := filepath.Join(home, ".pebble", "agent-hooks", agent.script)
	config, err := readObject(configPath)
	if err != nil {
		return errorInstall(agent.name, configPath, err)
	}
	hooks, _ := config["hooks"].(map[string]any)
	if hooks == nil {
		hooks = make(map[string]any)
	}
	removeWindowsManagedHooks(hooks, agent.script)
	command := windowsPowerShellCmdLauncher(scriptPath)
	if agent.command != nil {
		command = agent.command(scriptPath)
	}
	for _, event := range agent.events {
		definitions, _ := hooks[event].([]any)
		definition := map[string]any{"hooks": []any{map[string]any{"type": "command", "command": command, "timeout": agent.timeout}}}
		if matcher, ok := agent.matchers[event]; ok {
			definition["matcher"] = matcher
		}
		hooks[event] = append(definitions, definition)
	}
	config["hooks"] = hooks
	if err := writeAtomic(scriptPath, []byte(windowsStatusCmd(agent.name, agent.stdoutJSON)), 0o600); err != nil {
		return errorInstall(agent.name, configPath, err)
	}
	return writeJSONStatus(agent.name, configPath, config)
}

func installWindowsCursor(home string) InstallStatus {
	configPath := filepath.Join(home, ".cursor", "hooks.json")
	scriptPath := filepath.Join(home, ".pebble", "agent-hooks", "cursor-hook.cmd")
	config, err := readObject(configPath)
	if err != nil {
		return errorInstall("cursor", configPath, err)
	}
	hooks, _ := config["hooks"].(map[string]any)
	if hooks == nil {
		hooks = make(map[string]any)
	}
	removeWindowsManagedHooks(hooks, "cursor-hook.cmd")
	command := windowsPowerShellCmdLauncher(scriptPath)
	for _, event := range cursorEvents {
		definitions, _ := hooks[event].([]any)
		hooks[event] = append(definitions, map[string]any{"type": "command", "command": command, "timeout": 10})
	}
	config["hooks"] = hooks
	if _, exists := config["version"]; !exists {
		config["version"] = 1
	}
	if err := writeAtomic(scriptPath, []byte(windowsStatusCmd("cursor", false)), 0o600); err != nil {
		return errorInstall("cursor", configPath, err)
	}
	return writeJSONStatus("cursor", configPath, config)
}

func installWindowsCommandCode(home string) InstallStatus {
	return installWindowsNested(home, windowsNestedAgent{
		name: "command-code", config: `.commandcode/settings.json`, script: "command-code-hook.cmd", timeout: 10,
		events:   []string{"PreToolUse", "PostToolUse", "Stop"},
		matchers: map[string]string{"PreToolUse": ".*", "PostToolUse": ".*"},
		command:  windowsCmdLauncher,
	})
}

func installWindowsDevin(home string) InstallStatus {
	configPath := filepath.Join(home, "AppData", "Roaming", "devin", "config.json")
	scriptPath := filepath.Join(home, ".pebble", "agent-hooks", "devin-hook.cmd")
	config, err := readDevinConfig(configPath)
	if err != nil {
		return errorInstall("devin", configPath, fmt.Errorf("could not parse remote Devin config.json: %w", err))
	}
	hooks, _ := config["hooks"].(map[string]any)
	if hooks == nil {
		hooks = make(map[string]any)
	}
	removeWindowsManagedHooks(hooks, "devin-hook.cmd")
	command := windowsCmdLauncher(scriptPath)
	for _, event := range devinEvents {
		definitions, _ := hooks[event].([]any)
		hooks[event] = append(definitions, map[string]any{"hooks": []any{map[string]any{"type": "command", "command": command}}})
	}
	config["hooks"] = hooks
	if err := writeAtomic(scriptPath, []byte(windowsStatusCmd("devin", false)), 0o600); err != nil {
		return errorInstall("devin", configPath, err)
	}
	status := writeJSONStatus("devin", configPath, config)
	if status.State == "installed" && claudeImportEnabled(config["read_config_from"]) {
		status.Detail = "Devin read_config_from.claude is enabled; imported Claude hooks may fire alongside Devin hooks."
	}
	return status
}

func installWindowsAntigravity(home string) InstallStatus {
	configPath := filepath.Join(home, ".gemini", "config", "hooks.json")
	corePath := filepath.Join(home, ".pebble", "agent-hooks", "antigravity-hook.cmd")
	config, err := readObject(configPath)
	if err != nil {
		return errorInstall("antigravity", configPath, err)
	}
	bundle, _ := config["pebble-status"].(map[string]any)
	if bundle == nil {
		bundle = make(map[string]any)
	}
	for _, name := range append([]string{"antigravity-hook.cmd", "antigravity-hook.sh"}, windowsAntigravityWrapperNames()...) {
		removeWindowsManagedHooks(bundle, name)
	}
	for _, event := range antigravityEvents {
		wrapper := filepath.Join(filepath.Dir(corePath), windowsAntigravityWrapper(event.name))
		if err := writeAtomic(wrapper, []byte(windowsAntigravityWrapperCmd(event.name)), 0o600); err != nil {
			return errorInstall("antigravity", configPath, err)
		}
		definitions, _ := bundle[event.name].([]any)
		if event.tool {
			bundle[event.name] = append(definitions, map[string]any{"matcher": "*", "hooks": []any{map[string]any{"type": "command", "command": wrapper, "timeout": 10}}})
		} else {
			bundle[event.name] = append(definitions, map[string]any{"type": "command", "command": wrapper, "timeout": 10})
		}
	}
	config["pebble-status"] = bundle
	if err := writeAtomic(corePath, []byte(windowsAntigravityCoreCmd()), 0o600); err != nil {
		return errorInstall("antigravity", configPath, err)
	}
	return writeJSONStatus("antigravity", configPath, config)
}

func installWindowsCopilot(home string) InstallStatus {
	configPath := filepath.Join(home, ".copilot", "hooks", "pebble.json")
	scriptPath := filepath.Join(home, ".pebble", "agent-hooks", "copilot-hook.ps1")
	config, err := readObject(configPath)
	if err != nil {
		return errorInstall("copilot", configPath, err)
	}
	hooks, _ := config["hooks"].(map[string]any)
	if hooks == nil {
		hooks = make(map[string]any)
	}
	removeWindowsManagedHooks(hooks, "copilot-hook.ps1")
	for _, event := range copilotEvents {
		definitions, _ := hooks[event].([]any)
		command := fmt.Sprintf("$env:PEBBLE_COPILOT_HOOK_EVENT = '%s'; powershell.exe -NoProfile -ExecutionPolicy Bypass -File %s", event, quotePowerShellLiteral(scriptPath))
		hooks[event] = append(definitions, map[string]any{"type": "command", "powershell": command, "timeoutSec": 5})
	}
	config["version"] = 1
	delete(config, "disableAllHooks")
	config["hooks"] = hooks
	if err := writeAtomic(scriptPath, []byte(windowsCopilotPowerShell()), 0o600); err != nil {
		return errorInstall("copilot", configPath, err)
	}
	return writeJSONStatus("copilot", configPath, config)
}

func installWindowsKimi(home string) InstallStatus {
	configPath := filepath.Join(home, ".kimi-code", "config.toml")
	scriptPath := filepath.Join(home, ".pebble", "agent-hooks", "kimi-hook.sh")
	content, err := os.ReadFile(configPath)
	if os.IsNotExist(err) {
		content = nil
	} else if err != nil {
		return errorInstall("kimi", configPath, err)
	}
	// Kimi documents KIMI_SHELL_PATH/Git Bash on Windows, so its payload remains
	// the same POSIX script rather than an unverified PowerShell translation.
	command := managedCommand(strings.ReplaceAll(scriptPath, `\`, "/"))
	next := applyKimiBlock(string(content), command)
	if err := writeAtomic(scriptPath, []byte(statusScript("kimi", false)), 0o600); err != nil {
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

func installWindowsCodex(home string) InstallStatus {
	status := installWindowsNested(home, windowsNestedAgent{name: "codex", config: `.codex/hooks.json`, script: "codex-hook.cmd", events: eventNames(codexEvents), timeout: 10, command: windowsCmdLauncher})
	if status.State != "installed" {
		return status
	}
	// Codex trust hashes include the exact Windows command, so reuse its normal
	// installer trust writer rather than claiming trust from POSIX identities.
	configPath := filepath.Join(home, ".codex", "hooks.json")
	tomlPath := filepath.Join(home, ".codex", "config.toml")
	command := windowsCmdLauncher(filepath.Join(home, ".pebble", "agent-hooks", "codex-hook.cmd"))
	content, err := os.ReadFile(tomlPath)
	if os.IsNotExist(err) {
		content = nil
	} else if err != nil {
		return codexTrustError(configPath, err)
	}
	next := string(content)
	config, err := readObject(configPath)
	if err != nil {
		return codexTrustError(configPath, err)
	}
	hooks, _ := config["hooks"].(map[string]any)
	for _, event := range codexEvents {
		index := managedHookGroupIndex(hooks[event.name], command)
		if index < 0 {
			return codexTrustError(configPath, fmt.Errorf("managed %s hook was not persisted", event.name))
		}
		key := fmt.Sprintf("%s:%s:%d:0", configPath, event.label, index)
		next = upsertCodexTrustBlock(next, codexTrustEntry{key: key, hash: codexTrustedHash(event.label, command)})
	}
	if err := writeAtomic(tomlPath, []byte(next), 0o600); err != nil {
		return codexTrustError(configPath, err)
	}
	return status
}

func managedHookGroupIndex(raw any, command string) int {
	definitions, _ := raw.([]any)
	for index, rawDefinition := range definitions {
		definition, _ := rawDefinition.(map[string]any)
		handlers, _ := definition["hooks"].([]any)
		for _, rawHandler := range handlers {
			handler, _ := rawHandler.(map[string]any)
			if handler["command"] == command {
				return index
			}
		}
	}
	return -1
}

func eventNames(events []struct{ name, label string }) []string {
	result := make([]string, 0, len(events))
	for _, event := range events {
		result = append(result, event.name)
	}
	return result
}

func removeWindowsManagedHooks(hooks map[string]any, script string) {
	for event, raw := range hooks {
		definitions, ok := raw.([]any)
		if !ok {
			continue
		}
		cleaned := removeDirectAndNestedManaged(definitions, script)
		if len(cleaned) == 0 {
			delete(hooks, event)
		} else {
			hooks[event] = cleaned
		}
	}
}

func windowsPowerShellCmdLauncher(path string) string {
	script := "& " + quotePowerShellLiteral(path)
	encoded := base64.StdEncoding.EncodeToString(encodeWindowsUTF16LE(script))
	systemRoot := strings.TrimSpace(os.Getenv("SystemRoot"))
	if systemRoot == "" {
		systemRoot = `C:\Windows`
	}
	// Claude-compatible hooks may execute under Git Bash on Windows; forward
	// slashes preserve the absolute PowerShell path without cmd expansion.
	powerShell := strings.ReplaceAll(filepath.Join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), `\`, "/")
	return powerShell + ` -NoProfile -ExecutionPolicy Bypass -EncodedCommand ` + encoded
}

func windowsCmdLauncher(path string) string {
	return `cmd /d /s /c ""` + strings.ReplaceAll(path, `"`, `""`) + `""`
}

func quotePowerShellLiteral(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}

func encodeWindowsUTF16LE(value string) []byte {
	result := make([]byte, 0, len(value)*2)
	for _, point := range []rune(value) {
		if point <= 0xffff {
			result = append(result, byte(point), byte(point>>8))
			continue
		}
		point -= 0x10000
		high, low := rune(0xd800+(point>>10)), rune(0xdc00+(point&0x3ff))
		result = append(result, byte(high), byte(high>>8), byte(low), byte(low>>8))
	}
	return result
}

func windowsStatusCmd(agent string, stdoutJSON bool) string {
	lines := []string{"@echo off", "setlocal"}
	if stdoutJSON {
		lines = append(lines, "echo {}")
	}
	lines = append(lines,
		`if defined PEBBLE_AGENT_HOOK_ENDPOINT if exist "%PEBBLE_AGENT_HOOK_ENDPOINT%" call "%PEBBLE_AGENT_HOOK_ENDPOINT%" 2>nul`,
		`if "%PEBBLE_AGENT_HOOK_PORT%"=="" exit /b 0`,
		`if "%PEBBLE_AGENT_HOOK_TOKEN%"=="" exit /b 0`,
		`if "%PEBBLE_PANE_KEY%"=="" exit /b 0`,
		`curl.exe -sS -X POST "http://127.0.0.1:%PEBBLE_AGENT_HOOK_PORT%/hook/`+agent+`" --connect-timeout 0.5 --max-time 1.5 -H "Content-Type: application/x-www-form-urlencoded" -H "X-Pebble-Agent-Hook-Token: %PEBBLE_AGENT_HOOK_TOKEN%" --data-urlencode "paneKey=%PEBBLE_PANE_KEY%" --data-urlencode "tabId=%PEBBLE_TAB_ID%" --data-urlencode "launchToken=%PEBBLE_AGENT_LAUNCH_TOKEN%" --data-urlencode "worktreeId=%PEBBLE_WORKTREE_ID%" --data-urlencode "env=%PEBBLE_AGENT_HOOK_ENV%" --data-urlencode "version=%PEBBLE_AGENT_HOOK_VERSION%" --data-urlencode "payload@-" >nul 2>&1`,
		"exit /b 0", "")
	return strings.Join(lines, "\r\n")
}

func windowsAntigravityWrapperNames() []string {
	return []string{"antigravity-pre-invocation.cmd", "antigravity-post-invocation.cmd", "antigravity-stop.cmd", "antigravity-post-tool-use.cmd"}
}

func windowsAntigravityWrapper(event string) string {
	return map[string]string{"PreInvocation": "antigravity-pre-invocation.cmd", "PostInvocation": "antigravity-post-invocation.cmd", "Stop": "antigravity-stop.cmd", "PostToolUse": "antigravity-post-tool-use.cmd"}[event]
}

func windowsAntigravityWrapperCmd(event string) string {
	return strings.Join([]string{"@echo off", "setlocal", `set "PEBBLE_ANTIGRAVITY_EVENT=` + event + `"`, `call "%~dp0antigravity-hook.cmd"`, "exit /b 0", ""}, "\r\n")
}

func windowsAntigravityCoreCmd() string {
	post := strings.Replace(windowsStatusCmd("antigravity", false), `--data-urlencode "payload@-"`, `--data-urlencode "hook_event_name=%PEBBLE_ANTIGRAVITY_EVENT%" --data-urlencode "payload@-"`, 1)
	return strings.Join([]string{"@echo off", "setlocal", `if /I "%PEBBLE_ANTIGRAVITY_EVENT%"=="Stop" (echo {"decision":""}) else (echo {})`, post, ""}, "\r\n")
}

func windowsCopilotPowerShell() string {
	return strings.Join([]string{
		"Write-Output '{}'",
		`if ($env:PEBBLE_AGENT_HOOK_ENDPOINT -and (Test-Path -LiteralPath $env:PEBBLE_AGENT_HOOK_ENDPOINT)) { Get-Content -LiteralPath $env:PEBBLE_AGENT_HOOK_ENDPOINT | ForEach-Object { if ($_ -match '^set ([A-Za-z0-9_]+)=(.*)$') { [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process') } } }`,
		`if (-not $env:PEBBLE_AGENT_HOOK_PORT -or -not $env:PEBBLE_AGENT_HOOK_TOKEN -or -not $env:PEBBLE_PANE_KEY) { exit 0 }`,
		`$inputData=[Console]::In.ReadToEnd(); if ([string]::IsNullOrWhiteSpace($inputData)) { exit 0 }`,
		`try { $payload=$inputData|ConvertFrom-Json; $body=@{paneKey=$env:PEBBLE_PANE_KEY;launchToken=$env:PEBBLE_AGENT_LAUNCH_TOKEN;tabId=$env:PEBBLE_TAB_ID;worktreeId=$env:PEBBLE_WORKTREE_ID;hookEventName=$env:PEBBLE_COPILOT_HOOK_EVENT;env=$env:PEBBLE_AGENT_HOOK_ENV;version=$env:PEBBLE_AGENT_HOOK_VERSION;payload=$payload}|ConvertTo-Json -Depth 100; Invoke-WebRequest -UseBasicParsing -Method Post -Uri ('http://127.0.0.1:'+$env:PEBBLE_AGENT_HOOK_PORT+'/hook/copilot') -Headers @{'Content-Type'='application/json';'X-Pebble-Agent-Hook-Token'=$env:PEBBLE_AGENT_HOOK_TOKEN} -Body $body -TimeoutSec 2|Out-Null } catch {}`,
		"exit 0", "",
	}, "\r\n")
}
