package runtimecore

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

const maxAgentTrustWorkspacePathBytes = 32 * 1024

type AgentTrustRequest struct {
	Preset        string `json:"preset"`
	WorkspacePath string `json:"workspacePath"`
}

func (m *Manager) MarkAgentWorkspaceTrusted(request AgentTrustRequest) error {
	workspace, err := validatedAgentTrustWorkspace(request.WorkspacePath)
	if err != nil {
		return err
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return errors.New("could not resolve user home directory")
	}
	switch strings.TrimSpace(request.Preset) {
	case "cursor":
		return markCursorWorkspaceTrusted(home, workspace)
	case "copilot":
		return markCopilotWorkspaceTrusted(home, workspace)
	case "codex":
		if err := markCodexWorkspaceTrusted(filepath.Join(home, ".codex", "config.toml"), workspace); err != nil {
			return err
		}
		managedHome := filepath.Join(filepath.Dir(m.store.path), "codex-runtime-home", "home")
		return markCodexWorkspaceTrusted(filepath.Join(managedHome, "config.toml"), workspace)
	default:
		return errors.New("unsupported agent trust preset")
	}
}

func validatedAgentTrustWorkspace(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > maxAgentTrustWorkspacePathBytes || strings.ContainsAny(value, "\x00\r\n") || !filepath.IsAbs(value) {
		return "", errors.New("invalid agent trust workspace path")
	}
	if canonical, err := filepath.EvalSymlinks(value); err == nil {
		return canonical, nil
	}
	return filepath.Clean(value), nil
}

func markCursorWorkspaceTrusted(home, workspace string) error {
	slug := strings.TrimLeft(workspace, `/\`)
	slug = regexp.MustCompile(`[\\/:*?"<>|]+`).ReplaceAllString(slug, "-")
	if slug == "" {
		return nil
	}
	target := filepath.Join(home, ".cursor", "projects", slug, ".workspace-trusted")
	if _, err := os.Stat(target); err == nil {
		return nil
	}
	payload, _ := json.MarshalIndent(map[string]string{
		"trustedAt": time.Now().UTC().Format(time.RFC3339Nano), "workspacePath": workspace,
	}, "", "  ")
	return writeAgentTrustFile(target, append(payload, '\n'))
}

func markCopilotWorkspaceTrusted(home, workspace string) error {
	target := filepath.Join(home, ".copilot", "config.json")
	config := map[string]any{}
	if bytes, err := os.ReadFile(target); err == nil {
		if err := json.Unmarshal(bytes, &config); err != nil {
			return errors.New("Copilot config.json is invalid; refusing to overwrite it")
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	folders, ok := config["trustedFolders"].([]any)
	if config["trustedFolders"] != nil && !ok {
		return errors.New("Copilot trustedFolders must be an array")
	}
	for _, entry := range folders {
		if entry == workspace {
			return nil
		}
	}
	config["trustedFolders"] = append(folders, workspace)
	payload, _ := json.MarshalIndent(config, "", "  ")
	return writeAgentTrustFile(target, append(payload, '\n'))
}

func markCodexWorkspaceTrusted(target, workspace string) error {
	existingBytes, err := os.ReadFile(target)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	existing := string(existingBytes)
	escaped := strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(workspace)
	header := fmt.Sprintf(`[projects."%s"]`, escaped)
	headerPattern := regexp.MustCompile(`(?m)^[ \t]*\[projects[ \t]*\.[ \t]*"` + regexp.QuoteMeta(escaped) + `"[ \t]*\][ \t]*(?:#.*)?$`)
	updated := existing
	if location := headerPattern.FindStringIndex(existing); location != nil {
		blockEnd := len(existing)
		if offset := strings.Index(existing[location[1]:], "\n["); offset >= 0 {
			blockEnd = location[1] + offset + 1
		}
		block := existing[location[1]:blockEnd]
		trustPattern := regexp.MustCompile(`(?m)^[ \t]*trust_level[ \t]*=[ \t]*(?:"(?:trusted|untrusted)"|'(?:trusted|untrusted)')[ \t]*(?:#.*)?$`)
		if trustPattern.MatchString(block) {
			block = trustPattern.ReplaceAllString(block, `trust_level = "trusted"`)
			updated = existing[:location[1]] + block + existing[blockEnd:]
		} else {
			updated = existing[:location[1]] + "\ntrust_level = \"trusted\"" + existing[location[1]:]
		}
	} else {
		separator := "\n\n"
		if existing == "" || strings.HasSuffix(existing, "\n\n") {
			separator = ""
		} else if strings.HasSuffix(existing, "\n") {
			separator = "\n"
		}
		updated = existing + separator + header + "\ntrust_level = \"trusted\"\n"
	}
	if updated == existing {
		return nil
	}
	return writeAgentTrustFile(target, []byte(updated))
}

func writeAgentTrustFile(target string, payload []byte) error {
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(target), ".agent-trust-*.tmp")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return err
	}
	if _, err := temporary.Write(payload); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return replaceRemoteWorkspaceFile(temporaryPath, target)
}
