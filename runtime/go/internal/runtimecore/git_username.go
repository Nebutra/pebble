package runtimecore

import (
	"context"
	"encoding/json"
	"os/exec"
	"strings"
	"time"
)

var explicitGitUsernameKeys = []string{"github.user", "user.username"}

func (m *Manager) ProjectGitUsername(projectID string) (string, error) {
	m.mu.RLock()
	project, ok := m.projects[projectID]
	m.mu.RUnlock()
	if !ok {
		return "", ErrNotFound
	}
	if project.LocationKind == "ssh" {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		output, err := m.runSshRelayWorker(ctx, project.HostID, []string{"git-username-json", "--root", project.Path})
		if err != nil {
			return "", err
		}
		var result struct {
			Username string `json:"username"`
		}
		if err := json.Unmarshal(output, &result); err != nil {
			return "", err
		}
		return normalizeGitUsername(result.Username), nil
	}
	return resolveLocalProjectGitUsername(project.Path), nil
}

func ResolveExplicitGitUsername(root string) string {
	for _, key := range explicitGitUsernameKeys {
		if username := normalizeGitUsername(runBoundedGit(root, "config", "--get", key)); username != "" {
			return username
		}
	}
	return ""
}

func resolveLocalProjectGitUsername(root string) string {
	if username := ResolveExplicitGitUsername(root); username != "" {
		return username
	}
	if !projectEffectiveRemoteIsGitHub(root) {
		return ""
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, "gh", "api", "user", "-q", ".login").Output()
	if err != nil {
		return ""
	}
	return normalizeGitUsername(string(output))
}

func projectEffectiveRemoteIsGitHub(root string) bool {
	remotes := strings.Fields(runBoundedGit(root, "remote"))
	currentBranch := strings.TrimSpace(runBoundedGit(root, "branch", "--show-current"))
	candidates := []string{}
	if currentBranch != "" {
		candidates = append(candidates, strings.TrimSpace(runBoundedGit(root, "config", "--get", "branch."+currentBranch+".remote")))
	}
	candidates = append(candidates, "origin")
	if len(remotes) == 1 {
		candidates = append(candidates, remotes[0])
	}
	seen := map[string]bool{}
	for _, remote := range candidates {
		remote = strings.TrimSpace(remote)
		if remote == "" || remote == "." || seen[remote] {
			continue
		}
		seen[remote] = true
		url := strings.ToLower(strings.TrimSpace(runBoundedGit(root, "remote", "get-url", remote)))
		if strings.HasPrefix(url, "git@github.com:") || strings.HasPrefix(url, "https://github.com/") {
			return true
		}
	}
	return false
}

func runBoundedGit(root string, args ...string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	argv := append([]string{"-C", root}, args...)
	output, err := exec.CommandContext(ctx, "git", argv...).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(output))
}

func normalizeGitUsername(value string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return ""
	}
	if before, _, found := strings.Cut(trimmed, "@"); found {
		trimmed = before
	}
	parts := strings.SplitN(trimmed, "+", 2)
	if len(parts) == 2 && parts[0] != "" {
		allDigits := true
		for _, char := range parts[0] {
			if char < '0' || char > '9' {
				allDigits = false
				break
			}
		}
		if allDigits {
			trimmed = parts[1]
		}
	}
	return strings.TrimSpace(trimmed)
}
