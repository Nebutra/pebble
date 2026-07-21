package runtimecore

import (
	"context"
	"strings"
)

func (m *Manager) CreateProjectWithMainWorktree(ctx context.Context, req CreateProjectRequest) (Project, error) {
	project, err := m.CreateProject(req)
	if err != nil {
		return Project{}, err
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
		_, _ = m.DeleteProject(project.ID)
		return Project{}, err
	}
	return project, nil
}
