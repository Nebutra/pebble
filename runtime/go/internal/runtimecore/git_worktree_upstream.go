package runtimecore

import (
	"context"
	"strings"
)

// GitUpstreamPushHint is the optional client-side push target. It is only a
// name hint — git's tracking branch still wins when present.
type GitUpstreamPushHint struct {
	RemoteName string `json:"remoteName,omitempty"`
	BranchName string `json:"branchName,omitempty"`
	Branch     string `json:"branch,omitempty"`
	BaseBranch string `json:"baseBranch,omitempty"`
}

// GitUpstreamStatus is the shape git.upstreamStatus and the source-control
// poll expect. hasUpstream false means ahead/behind are placeholders.
type GitUpstreamStatus struct {
	HasUpstream             bool   `json:"hasUpstream"`
	UpstreamName            string `json:"upstreamName,omitempty"`
	Ahead                   int    `json:"ahead"`
	Behind                  int    `json:"behind"`
	HasConfiguredPushTarget bool   `json:"hasConfiguredPushTarget,omitempty"`
}

type GitWorktreeUpstreamStatusRequest struct {
	ProjectID  string              `json:"projectId"`
	WorktreeID string              `json:"worktreeId,omitempty"`
	PushTarget GitUpstreamPushHint `json:"pushTarget"`
}

func (m *Manager) GitWorktreeUpstreamStatus(ctx context.Context, req GitWorktreeUpstreamStatusRequest) (GitUpstreamStatus, error) {
	base, err := m.resolveWorkspacePath(req.ProjectID, req.WorktreeID)
	if err != nil {
		return GitUpstreamStatus{}, err
	}
	lines, err := m.leasedGitShortStatus(ctx, base)
	if err != nil {
		return GitUpstreamStatus{}, err
	}
	var projection SourceControlProjection
	applyGitStatusLines(&projection, lines, base)
	configured := gitConfiguredPushName(req.PushTarget)
	upstreamName := firstNonEmpty(
		configured,
		strings.TrimSpace(req.PushTarget.Branch),
		strings.TrimSpace(req.PushTarget.BaseBranch),
		gitUpstreamNameFromStatusLines(lines),
		strings.TrimSpace(projection.BaseBranch),
	)
	status := GitUpstreamStatus{
		HasUpstream:             upstreamName != "" || projection.Ahead > 0 || projection.Behind > 0 || configured != "",
		Ahead:                   projection.Ahead,
		Behind:                  projection.Behind,
		HasConfiguredPushTarget: configured != "",
	}
	if upstreamName != "" {
		status.UpstreamName = upstreamName
	}
	return status, nil
}

func gitConfiguredPushName(target GitUpstreamPushHint) string {
	branch := strings.TrimSpace(target.BranchName)
	remote := strings.TrimSpace(target.RemoteName)
	if remote != "" && branch != "" {
		return remote + "/" + branch
	}
	return branch
}

func gitUpstreamNameFromStatusLines(lines []string) string {
	for _, line := range lines {
		if !strings.HasPrefix(line, "## ") {
			continue
		}
		body := strings.TrimSpace(strings.TrimPrefix(line, "## "))
		if idx := strings.Index(body, " ["); idx >= 0 {
			body = strings.TrimSpace(body[:idx])
		}
		if _, upstream, ok := strings.Cut(body, "..."); ok {
			return strings.TrimSpace(upstream)
		}
	}
	return ""
}
