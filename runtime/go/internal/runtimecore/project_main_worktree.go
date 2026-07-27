package runtimecore

import (
	"context"
	"strings"
)

func (m *Manager) CreateProjectWithMainWorktree(ctx context.Context, req CreateProjectRequest) (Project, error) {
	project, created, err := m.createProject(req)
	if err != nil {
		return Project{}, err
	}
	for _, worktree := range m.ListWorktrees(project.ID) {
		if worktreePathMatchesProject(worktree, project) {
			return project, nil
		}
	}
	branch := ""
	if project.LocationKind == "local" && project.Provider != "folder" {
		branch, _ = readGitOutput(ctx, project.Path, "branch", "--show-current")
		branch = strings.TrimSpace(branch)
	}
	_, err = m.CreateWorktree(ctx, CreateWorktreeRequest{
		ProjectID: project.ID,
		Path:      project.Path,
		Branch:    branch,
	})
	if err != nil {
		// Why: renderer navigation requires a main workspace for every project;
		// never persist a project that cannot satisfy that invariant.
		if created {
			_, _ = m.DeleteProject(project.ID)
		}
		return Project{}, err
	}
	return project, nil
}

func worktreePathMatchesProject(worktree Worktree, project Project) bool {
	return worktreePathsEqual(project, worktree.Path, project.Path)
}

func worktreePathsEqual(project Project, first, second string) bool {
	first = strings.TrimSpace(first)
	second = strings.TrimSpace(second)
	if project.LocationKind == "ssh" {
		return first == second
	}
	normalizedFirst, firstErr := normalizeLocalPath(first)
	normalizedSecond, secondErr := normalizeLocalPath(second)
	return firstErr == nil && secondErr == nil && normalizedFirst == normalizedSecond
}
