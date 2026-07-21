package runtimecore

import (
	"context"
	"errors"
	"os/exec"
	"sort"
	"strings"
)

func (m *Manager) HostGitBaseRefDefault(ctx context.Context, projectID string) (GitBaseRefDefaultResult, error) {
	project, err := m.localGitProject(projectID)
	if err != nil {
		return GitBaseRefDefaultResult{}, err
	}
	remotes := hostGitLines(ctx, project.Path, "remote")
	for _, candidate := range []string{"refs/remotes/origin/HEAD", "refs/remotes/origin/main", "refs/remotes/origin/master", "refs/heads/main", "refs/heads/master"} {
		if candidate == "refs/remotes/origin/HEAD" {
			if ref := strings.TrimSpace(hostGitOutput(ctx, project.Path, "symbolic-ref", "--quiet", candidate)); ref != "" {
				value := strings.TrimPrefix(ref, "refs/remotes/")
				return GitBaseRefDefaultResult{DefaultBaseRef: &value, RemoteCount: len(remotes)}, nil
			}
			continue
		}
		if hostGitRefExists(ctx, project.Path, candidate) {
			value := strings.TrimPrefix(strings.TrimPrefix(candidate, "refs/remotes/"), "refs/heads/")
			return GitBaseRefDefaultResult{DefaultBaseRef: &value, RemoteCount: len(remotes)}, nil
		}
	}
	return GitBaseRefDefaultResult{RemoteCount: len(remotes)}, nil
}

func (m *Manager) SearchHostGitBaseRefs(ctx context.Context, projectID, query string, limit int) ([]GitBaseRefSearchResult, bool, error) {
	project, err := m.localGitProject(projectID)
	if err != nil {
		return nil, false, err
	}
	if limit <= 0 {
		limit = 50
	}
	normalizedQuery := strings.ToLower(strings.TrimSpace(query))
	lines := hostGitLines(ctx, project.Path, "for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes")
	results := make([]GitBaseRefSearchResult, 0, limit+1)
	seen := make(map[string]bool)
	for _, ref := range lines {
		if strings.HasSuffix(ref, "/HEAD") {
			continue
		}
		name := strings.TrimPrefix(strings.TrimPrefix(ref, "refs/heads/"), "refs/remotes/")
		if normalizedQuery != "" && !strings.Contains(strings.ToLower(name), normalizedQuery) {
			continue
		}
		if seen[name] {
			continue
		}
		seen[name] = true
		localName := name
		if slash := strings.IndexByte(name, '/'); strings.HasPrefix(ref, "refs/remotes/") && slash >= 0 {
			localName = name[slash+1:]
		}
		results = append(results, GitBaseRefSearchResult{RefName: name, LocalBranchName: localName})
	}
	sort.Slice(results, func(i, j int) bool { return results[i].RefName < results[j].RefName })
	truncated := len(results) > limit
	if truncated {
		results = results[:limit]
	}
	return results, truncated, nil
}

func (m *Manager) localGitProject(projectID string) (Project, error) {
	m.mu.RLock()
	project, found := m.projects[strings.TrimSpace(projectID)]
	m.mu.RUnlock()
	if !found {
		return Project{}, ErrNotFound
	}
	if project.LocationKind != "local" || project.Provider == "folder" {
		return Project{}, errors.New("project is not a local Git repository")
	}
	return project, nil
}

func hostGitLines(ctx context.Context, path string, args ...string) []string {
	output := hostGitOutput(ctx, path, args...)
	if output == "" {
		return []string{}
	}
	lines := strings.Split(output, "\n")
	result := make([]string, 0, len(lines))
	for _, line := range lines {
		if value := strings.TrimSpace(line); value != "" {
			result = append(result, value)
		}
	}
	return result
}

func hostGitOutput(ctx context.Context, path string, args ...string) string {
	commandCtx, cancel := context.WithTimeout(ctx, gitCommandTimeout)
	defer cancel()
	argv := append([]string{"-C", path}, args...)
	output, err := exec.CommandContext(commandCtx, "git", argv...).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(output))
}

func hostGitRefExists(ctx context.Context, path, ref string) bool {
	commandCtx, cancel := context.WithTimeout(ctx, gitCommandTimeout)
	defer cancel()
	return exec.CommandContext(commandCtx, "git", "-C", path, "show-ref", "--verify", "--quiet", ref).Run() == nil
}
