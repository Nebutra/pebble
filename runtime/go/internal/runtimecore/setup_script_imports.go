package runtimecore

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

type SetupScriptImportCandidate struct {
	Provider          string   `json:"provider"`
	Label             string   `json:"label"`
	Files             []string `json:"files"`
	Setup             string   `json:"setup"`
	Archive           string   `json:"archive,omitempty"`
	UnsupportedFields []string `json:"unsupportedFields"`
}

func (m *Manager) InspectProjectSetupScriptImports(_ context.Context, projectID string) ([]SetupScriptImportCandidate, error) {
	project, err := m.localGitProject(projectID)
	if err != nil {
		return nil, err
	}
	read := func(relative string) []byte {
		content, readErr := os.ReadFile(filepath.Join(project.Path, filepath.FromSlash(relative)))
		if readErr != nil {
			return nil
		}
		return content
	}
	candidates := []SetupScriptImportCandidate{}
	for _, inspect := range []func(func(string) []byte) *SetupScriptImportCandidate{
		inspectSupersetSetup, inspectConductorSetup, inspectCodexEnvironmentSetup,
		inspectCmuxSetup, inspectPackageManagerSetup,
	} {
		if candidate := inspect(read); candidate != nil {
			candidates = append(candidates, *candidate)
		}
	}
	return candidates, nil
}

func inspectSupersetSetup(read func(string) []byte) *SetupScriptImportCandidate {
	base := readJSONObject(read(".superset/config.json"))
	if base == nil {
		return nil
	}
	local := readJSONObject(read(".superset/config.local.json"))
	unsupported := presentJSONFields(base, "run", "cwd")
	files := []string{".superset/config.json"}
	if local != nil {
		files = append(files, ".superset/config.local.json")
		for _, field := range presentJSONFields(local, "run", "cwd") {
			unsupported = append(unsupported, "config.local."+field)
		}
	}
	setup := overlaySetupCommand(base["setup"], valueFromMap(local, "setup"), "setup", &unsupported)
	if setup == "" {
		return nil
	}
	collectScriptObjectFields(base["setup"], "setup", &unsupported)
	collectScriptObjectFields(base["teardown"], "teardown", &unsupported)
	return &SetupScriptImportCandidate{
		Provider: "superset", Label: "Superset", Files: files, Setup: setup,
		Archive:           overlaySetupCommand(base["teardown"], valueFromMap(local, "teardown"), "teardown", &unsupported),
		UnsupportedFields: unsupported,
	}
}

func inspectConductorSetup(read func(string) []byte) *SetupScriptImportCandidate {
	config := readJSONObject(read("conductor.json"))
	scripts, _ := config["scripts"].(map[string]interface{})
	setup := normalizedCommandValue(scripts["setup"])
	if config == nil || scripts == nil || setup == "" {
		return nil
	}
	unsupported := presentJSONFields(config, "enterpriseDataPrivacy", "runScriptMode")
	for _, field := range []string{"run", "teardown"} {
		if normalizedCommandValue(scripts[field]) != "" {
			unsupported = append(unsupported, "scripts."+field)
		}
	}
	return &SetupScriptImportCandidate{
		Provider: "conductor", Label: "Conductor", Files: []string{"conductor.json"},
		Setup: setup, Archive: normalizedCommandValue(scripts["archive"]), UnsupportedFields: unsupported,
	}
}

func inspectCmuxSetup(read func(string) []byte) *SetupScriptImportCandidate {
	for _, path := range []string{".cmux/cmux.json", "cmux.json"} {
		config := readJSONObject(read(path))
		commands, _ := config["commands"].([]interface{})
		for index, raw := range commands {
			command, _ := raw.(map[string]interface{})
			setup := normalizedCommandValue(command["command"])
			if command == nil || setup == "" || !isCmuxSetupCommand(command, setup) {
				continue
			}
			unsupported := []string{}
			supported := map[string]bool{"name": true, "title": true, "description": true, "keywords": true, "command": true}
			for field := range command {
				if !supported[field] {
					unsupported = append(unsupported, "commands."+setupImportIndex(index)+"."+field)
				}
			}
			return &SetupScriptImportCandidate{Provider: "cmux", Label: "cmux", Files: []string{path}, Setup: setup, UnsupportedFields: unsupported}
		}
	}
	return nil
}

func inspectCodexEnvironmentSetup(read func(string) []byte) *SetupScriptImportCandidate {
	const path = ".codex/environments/environment.toml"
	content := string(read(path))
	if content == "" {
		return nil
	}
	setup, cleanup, unsupported := parseCodexEnvironmentScripts(content)
	if setup == "" {
		return nil
	}
	return &SetupScriptImportCandidate{Provider: "codex", Label: "Codex environment", Files: []string{path}, Setup: setup, Archive: cleanup, UnsupportedFields: unsupported}
}

func inspectPackageManagerSetup(read func(string) []byte) *SetupScriptImportCandidate {
	packageJSON := readJSONObject(read("package.json"))
	if packageJSON == nil {
		return nil
	}
	if manager, _ := packageJSON["packageManager"].(string); manager != "" {
		for _, entry := range []struct{ Prefix, Command string }{{"pnpm@", "pnpm install"}, {"bun@", "bun install"}, {"yarn@", "yarn install"}, {"npm@", "npm install"}} {
			if strings.HasPrefix(strings.ToLower(strings.TrimSpace(manager)), entry.Prefix) {
				return packageManagerCandidate("package.json", entry.Command)
			}
		}
	}
	type lockfile struct{ Path, Family, Command string }
	lockfiles := []lockfile{{"pnpm-lock.yaml", "pnpm", "pnpm install"}, {"bun.lock", "bun", "bun install"}, {"bun.lockb", "bun", "bun install"}, {"yarn.lock", "yarn", "yarn install"}, {"package-lock.json", "npm", "npm install"}, {"npm-shrinkwrap.json", "npm", "npm install"}}
	families := map[string]bool{}
	selected := lockfile{}
	for _, entry := range lockfiles {
		if read(entry.Path) != nil {
			families[entry.Family] = true
			if selected.Path == "" {
				selected = entry
			}
		}
	}
	if len(families) > 1 {
		return nil
	}
	if selected.Path != "" {
		return packageManagerCandidate(selected.Path, selected.Command)
	}
	return packageManagerCandidate("package.json", "npm install")
}

func packageManagerCandidate(path, setup string) *SetupScriptImportCandidate {
	return &SetupScriptImportCandidate{Provider: "package-manager", Label: "package manager", Files: []string{path}, Setup: setup, UnsupportedFields: []string{}}
}

func readJSONObject(content []byte) map[string]interface{} {
	if len(content) == 0 {
		return nil
	}
	var result map[string]interface{}
	if json.Unmarshal(content, &result) != nil {
		return nil
	}
	return result
}

func normalizedCommandValue(value interface{}) string {
	if text, ok := value.(string); ok {
		return strings.TrimSpace(text)
	}
	values, _ := value.([]interface{})
	commands := []string{}
	for _, value := range values {
		if text, ok := value.(string); ok && strings.TrimSpace(text) != "" {
			commands = append(commands, strings.TrimSpace(text))
		}
	}
	return strings.Join(commands, "\n")
}

func overlaySetupCommand(base, local interface{}, key string, unsupported *[]string) string {
	baseCommand := normalizedCommandValue(base)
	if local == nil {
		return baseCommand
	}
	if command := normalizedCommandValue(local); command != "" {
		return command
	}
	record, ok := local.(map[string]interface{})
	if !ok {
		*unsupported = append(*unsupported, "config.local."+key)
		return baseCommand
	}
	for field := range record {
		if field != "before" && field != "after" {
			*unsupported = append(*unsupported, "config.local."+key+"."+field)
		}
	}
	parts := []string{normalizedCommandValue(record["before"]), baseCommand, normalizedCommandValue(record["after"])}
	return joinNonEmpty(parts)
}

func collectScriptObjectFields(value interface{}, prefix string, unsupported *[]string) {
	record, _ := value.(map[string]interface{})
	for _, field := range []string{"before", "after"} {
		if _, found := record[field]; found {
			*unsupported = append(*unsupported, prefix+"."+field)
		}
	}
}

func presentJSONFields(source map[string]interface{}, names ...string) []string {
	result := []string{}
	for _, name := range names {
		if _, found := source[name]; found {
			result = append(result, name)
		}
	}
	return result
}

func valueFromMap(source map[string]interface{}, key string) interface{} {
	if source == nil {
		return nil
	}
	return source[key]
}

func isCmuxSetupCommand(command map[string]interface{}, setup string) bool {
	labels := []string{normalizedMatchText(command["name"]), normalizedMatchText(command["title"])}
	for _, label := range labels {
		if label == "setup" || label == "project setup" || label == "workspace setup" || label == "repository setup" {
			return true
		}
	}
	keywords, _ := command["keywords"].([]interface{})
	hasKeyword := false
	for _, keyword := range keywords {
		value := normalizedMatchText(keyword)
		if value == "setup" || value == "init" || value == "initialize" || value == "install" {
			hasKeyword = true
		}
	}
	return hasKeyword && (strings.Contains(strings.Join(labels, " "), "setup") || strings.Contains(strings.ToLower(setup), "setup"))
}

func normalizedMatchText(value interface{}) string {
	text, _ := value.(string)
	return strings.Join(strings.Fields(strings.ToLower(strings.TrimSpace(text))), " ")
}

func parseCodexEnvironmentScripts(content string) (string, string, []string) {
	lines := strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n")
	section, setup, cleanup := "", "", ""
	unsupported := []string{}
	for index := 0; index < len(lines); index++ {
		line := strings.TrimSpace(lines[index])
		if strings.HasPrefix(line, "actions") && strings.Contains(line, "=") {
			unsupported = append(unsupported, "actions")
		}
		if strings.HasPrefix(line, "[") && strings.Contains(line, "]") {
			section = strings.TrimSpace(line[1:strings.Index(line, "]")])
			if section == "actions" || strings.HasPrefix(section, "actions.") {
				unsupported = append(unsupported, "["+section+"]")
			}
			continue
		}
		if (section != "setup" && section != "cleanup") || !strings.HasPrefix(line, "script") || !strings.Contains(line, "=") {
			continue
		}
		value := strings.TrimSpace(line[strings.Index(line, "=")+1:])
		parsed, end := parseTOMLScriptValue(lines, index, value)
		index = end
		if section == "setup" {
			setup = strings.TrimSpace(parsed)
		} else {
			cleanup = strings.TrimSpace(parsed)
		}
	}
	return setup, cleanup, unsupported
}

func parseTOMLScriptValue(lines []string, start int, value string) (string, int) {
	for _, delimiter := range []string{"\"\"\"", "'''"} {
		if strings.HasPrefix(value, delimiter) {
			parts := []string{}
			remainder := strings.TrimPrefix(value, delimiter)
			for index := start; index < len(lines); index++ {
				if index > start {
					remainder = lines[index]
				}
				if close := strings.Index(remainder, delimiter); close >= 0 {
					parts = append(parts, remainder[:close])
					return strings.Join(parts, "\n"), index
				}
				parts = append(parts, remainder)
			}
			return strings.TrimSpace(strings.Join(parts, "\n")), len(lines) - 1
		}
	}
	value = strings.TrimSpace(strings.SplitN(value, " #", 2)[0])
	if len(value) >= 2 && ((value[0] == '"' && value[len(value)-1] == '"') || (value[0] == '\'' && value[len(value)-1] == '\'')) {
		value = value[1 : len(value)-1]
	}
	return value, start
}

func joinNonEmpty(values []string) string {
	result := []string{}
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			result = append(result, strings.TrimSpace(value))
		}
	}
	return strings.Join(result, "\n")
}

func setupImportIndex(value int) string {
	const digits = "0123456789"
	if value == 0 {
		return "0"
	}
	result := ""
	for value > 0 {
		result = string(digits[value%10]) + result
		value /= 10
	}
	return result
}
