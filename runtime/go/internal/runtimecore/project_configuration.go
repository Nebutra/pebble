package runtimecore

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"gopkg.in/yaml.v3"
)

type ProjectHooksCheckResult struct {
	Status        string                 `json:"status"`
	HasHooks      bool                   `json:"hasHooks"`
	Hooks         map[string]interface{} `json:"hooks"`
	MayNeedUpdate bool                   `json:"mayNeedUpdate"`
}

type ProjectIssueCommandResult struct {
	Status           string  `json:"status"`
	LocalContent     *string `json:"localContent"`
	SharedContent    *string `json:"sharedContent"`
	EffectiveContent *string `json:"effectiveContent"`
	LocalFilePath    string  `json:"localFilePath"`
	Source           string  `json:"source"`
}

func (m *Manager) CheckProjectHooks(_ context.Context, projectID string) (ProjectHooksCheckResult, error) {
	project, err := m.localGitProject(projectID)
	if err != nil {
		return ProjectHooksCheckResult{}, err
	}
	content, err := os.ReadFile(filepath.Join(project.Path, "pebble.yaml"))
	if errors.Is(err, os.ErrNotExist) {
		return ProjectHooksCheckResult{Status: "ok"}, nil
	}
	if err != nil {
		return ProjectHooksCheckResult{}, err
	}
	hooks := parseProjectHooksYAML(content)
	return ProjectHooksCheckResult{
		Status: "ok", HasHooks: true, Hooks: hooks,
		MayNeedUpdate: hooks == nil && projectYAMLHasUnknownTopLevelKey(string(content)),
	}, nil
}

func (m *Manager) ReadProjectIssueCommand(_ context.Context, projectID string) (ProjectIssueCommandResult, error) {
	project, err := m.localGitProject(projectID)
	if err != nil {
		return ProjectIssueCommandResult{}, err
	}
	filePath := filepath.Join(project.Path, ".pebble", "issue-command")
	local := readTrimmedProjectFile(filePath)
	shared := readSharedProjectIssueCommand(filepath.Join(project.Path, "pebble.yaml"))
	effective, source := shared, "shared"
	if local != nil {
		effective, source = local, "local"
	} else if shared == nil {
		source = "none"
	}
	return ProjectIssueCommandResult{
		Status: "ok", LocalContent: local, SharedContent: shared, EffectiveContent: effective,
		LocalFilePath: filePath, Source: source,
	}, nil
}

func (m *Manager) WriteProjectIssueCommand(_ context.Context, projectID, content string) error {
	project, err := m.localGitProject(projectID)
	if err != nil {
		return err
	}
	directory := filepath.Join(project.Path, ".pebble")
	filePath := filepath.Join(directory, "issue-command")
	trimmed := strings.TrimSpace(content)
	if trimmed == "" {
		if err := os.Remove(filePath); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		return nil
	}
	if err := os.MkdirAll(directory, 0o755); err != nil {
		return err
	}
	if err := ensureProjectPrivateDirectoryIgnored(project.Path); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(directory, ".issue-command-*")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if _, err = temporary.WriteString(trimmed + "\n"); err == nil {
		err = temporary.Chmod(0o600)
	}
	if closeErr := temporary.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return os.Rename(temporaryPath, filePath)
}

func parseProjectHooksYAML(content []byte) map[string]interface{} {
	var raw map[string]interface{}
	if yaml.Unmarshal(content, &raw) != nil || raw == nil {
		return nil
	}
	hooks := map[string]interface{}{"scripts": map[string]string{}}
	hasValue := false
	if scripts, ok := raw["scripts"].(map[string]interface{}); ok {
		normalized := map[string]string{}
		for _, key := range []string{"setup", "archive"} {
			if value := trimmedProjectString(scripts[key]); value != "" {
				normalized[key] = value
				hasValue = true
			}
		}
		hooks["scripts"] = normalized
	}
	if value := trimmedProjectString(raw["issueCommand"]); value != "" {
		hooks["issueCommand"] = value
		hasValue = true
	}
	for _, key := range []string{"defaultTabs", "environmentRecipes"} {
		if values, ok := raw[key].([]interface{}); ok && len(values) > 0 {
			hooks[key] = values
			hasValue = true
		}
	}
	if !hasValue {
		return nil
	}
	return hooks
}

var projectYAMLTopLevelKey = regexp.MustCompile(`(?m)^([A-Za-z][A-Za-z0-9_-]*):(?:\s|$)`)

func projectYAMLHasUnknownTopLevelKey(content string) bool {
	recognized := map[string]bool{"scripts": true, "issueCommand": true, "defaultTabs": true, "environmentRecipes": true}
	for _, match := range projectYAMLTopLevelKey.FindAllStringSubmatch(content, -1) {
		if !recognized[match[1]] {
			return true
		}
	}
	return false
}

func readSharedProjectIssueCommand(path string) *string {
	content, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	hooks := parseProjectHooksYAML(content)
	if hooks == nil {
		return nil
	}
	value, _ := hooks["issueCommand"].(string)
	return projectStringPointer(value)
}

func readTrimmedProjectFile(path string) *string {
	content, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	return projectStringPointer(string(content))
}

func projectStringPointer(value string) *string {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	return &value
}

func trimmedProjectString(value interface{}) string {
	text, _ := value.(string)
	return strings.TrimSpace(text)
}

func ensureProjectPrivateDirectoryIgnored(projectPath string) error {
	ignorePath := filepath.Join(projectPath, ".gitignore")
	content, err := os.ReadFile(ignorePath)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	for _, line := range strings.Split(string(content), "\n") {
		if strings.TrimSpace(line) == ".pebble/" || strings.TrimSpace(line) == ".pebble" {
			return nil
		}
	}
	prefix := ""
	if len(content) > 0 && content[len(content)-1] != '\n' {
		prefix = "\n"
	}
	file, err := os.OpenFile(ignorePath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer file.Close()
	_, err = file.WriteString(prefix + ".pebble/\n")
	return err
}
