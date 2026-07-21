package providercli

import (
	"context"
	"encoding/json"
	"strings"
	"time"
)

type gitLabForkParent struct {
	Project         GitLabProjectRef
	SourceProjectID int
}

func resolveGitLabForkParent(ctx context.Context, workdir string, project GitLabProjectRef) *gitLabForkParent {
	if strings.TrimSpace(project.Path) == "" {
		return nil
	}
	// Why: fork discovery is a best-effort fallback and must not stall review
	// refresh when a self-hosted GitLab instance is unavailable.
	runCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	out, err := runCLI(
		runCtx,
		"glab",
		workdir,
		gitLabAPIArgs(project, "projects/"+encodeGitLabProjectPath(project.Path))...,
	)
	if err != nil {
		return nil
	}
	var raw struct {
		ID                int `json:"id"`
		ForkedFromProject *struct {
			Path string `json:"path_with_namespace"`
		} `json:"forked_from_project"`
	}
	if json.Unmarshal(out, &raw) != nil || raw.ID <= 0 || raw.ForkedFromProject == nil {
		return nil
	}
	parentPath := strings.TrimSpace(raw.ForkedFromProject.Path)
	if parentPath == "" || strings.EqualFold(parentPath, strings.TrimSpace(project.Path)) {
		return nil
	}
	return &gitLabForkParent{
		Project:         GitLabProjectRef{Host: project.Host, Path: parentPath},
		SourceProjectID: raw.ID,
	}
}
