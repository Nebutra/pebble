package runtimecore

import (
	"context"
	"errors"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

type SourceControlChange struct {
	Path      string `json:"path"`
	Status    string `json:"status"`
	Area      string `json:"area,omitempty"`
	OldPath   string `json:"oldPath,omitempty"`
	Additions int    `json:"additions,omitempty"`
	Deletions int    `json:"deletions,omitempty"`
	// Why: unmerged rows keep `status` as a rendering fallback while the
	// kind/status pair drives the renderer's conflict UI (badges, gating).
	ConflictKind   string `json:"conflictKind,omitempty"`
	ConflictStatus string `json:"conflictStatus,omitempty"`
}

type SourceControlProjection struct {
	Kind         string                `json:"kind"`
	RepositoryID string                `json:"repositoryId"`
	WorkspaceID  string                `json:"workspaceId"`
	Provider     string                `json:"provider"`
	ReviewKind   string                `json:"reviewKind"`
	Branch       string                `json:"branch"`
	BaseBranch   string                `json:"baseBranch,omitempty"`
	Ahead        int                   `json:"ahead"`
	Behind       int                   `json:"behind"`
	SyncStatus   string                `json:"syncStatus"`
	Changes      []SourceControlChange `json:"changes"`
	// ConflictOperation labels an in-progress merge/rebase/cherry-pick so the
	// renderer can title the conflict summary without a second RPC.
	ConflictOperation string `json:"conflictOperation,omitempty"`
	// BaseStatus is relay-reported base-SHA drift for remote/SSH workspaces,
	// served through the same base-status endpoint used locally.
	BaseStatus *SourceControlBaseStatus `json:"baseStatus,omitempty"`
	UpdatedAt  time.Time                `json:"updatedAt"`
}

// SourceControlBaseStatus mirrors GitBaseStatusResult so relay workers can
// project base drift for workspaces the runtime cannot read git from directly.
type SourceControlBaseStatus struct {
	Status         string                   `json:"status"`
	Base           string                   `json:"base,omitempty"`
	Remote         string                   `json:"remote,omitempty"`
	Behind         int                      `json:"behind,omitempty"`
	RecentSubjects []string                 `json:"recentSubjects,omitempty"`
	Conflict       *GitRemoteBranchConflict `json:"conflict,omitempty"`
}

type SourceControlProjectionFilter struct {
	ProjectID   string
	WorkspaceID string
}

type UpdateSourceControlProjectionRequest struct {
	RepositoryID      string                   `json:"repositoryId"`
	WorkspaceID       string                   `json:"workspaceId"`
	Provider          string                   `json:"provider,omitempty"`
	ReviewKind        string                   `json:"reviewKind,omitempty"`
	Branch            string                   `json:"branch,omitempty"`
	BaseBranch        string                   `json:"baseBranch,omitempty"`
	Ahead             int                      `json:"ahead,omitempty"`
	Behind            int                      `json:"behind,omitempty"`
	SyncStatus        string                   `json:"syncStatus"`
	Changes           []SourceControlChange    `json:"changes,omitempty"`
	ConflictOperation string                   `json:"conflictOperation,omitempty"`
	BaseStatus        *SourceControlBaseStatus `json:"baseStatus,omitempty"`
}

func (m *Manager) mobileSourceControlProjections() []SourceControlProjection {
	return m.ListSourceControlProjections(SourceControlProjectionFilter{})
}

func (m *Manager) ListSourceControlProjections(filter SourceControlProjectionFilter) []SourceControlProjection {
	projects := m.ListProjects()
	worktrees := m.ListWorktrees("")
	worktreesByProject := make(map[string][]Worktree)
	for _, worktree := range worktrees {
		worktreesByProject[worktree.ProjectID] = append(worktreesByProject[worktree.ProjectID], worktree)
	}
	projections := make([]SourceControlProjection, 0, len(projects))
	projectID := strings.TrimSpace(filter.ProjectID)
	workspaceID := strings.TrimSpace(filter.WorkspaceID)
	for _, project := range projects {
		if projectID != "" && project.ID != projectID {
			continue
		}
		canReadGit := project.LocationKind == "" || project.LocationKind == "local"
		projectWorktrees := worktreesByProject[project.ID]
		if len(projectWorktrees) == 0 {
			if workspaceID != "" && workspaceID != project.ID {
				continue
			}
			if cached, ok := m.cachedSourceControlProjection(project.ID, project.ID); ok {
				projections = append(projections, cached)
				continue
			}
			projections = append(projections, sourceProjectionFromGitStatus(
				project.Provider,
				project.ID,
				project.ID,
				gitReadablePath(project.Path, canReadGit),
				"",
				"none",
			))
			continue
		}
		for _, worktree := range projectWorktrees {
			if workspaceID != "" && workspaceID != worktree.ID {
				continue
			}
			if cached, ok := m.cachedSourceControlProjection(project.ID, worktree.ID); ok {
				projections = append(projections, cached)
				continue
			}
			gitProjection := sourceProjectionFromGitStatus(
				project.Provider,
				project.ID,
				worktree.ID,
				gitReadablePath(worktree.Path, canReadGit),
				worktree.Branch,
				reviewKind(worktree.ReviewKind),
			)
			gitProjection.BaseBranch = strings.TrimSpace(worktree.Base)
			projections = append(projections, gitProjection)
		}
	}
	return projections
}

func (m *Manager) UpdateSourceControlProjection(req UpdateSourceControlProjectionRequest) (SourceControlProjection, error) {
	repositoryID := strings.TrimSpace(req.RepositoryID)
	workspaceID := strings.TrimSpace(req.WorkspaceID)
	if repositoryID == "" || workspaceID == "" {
		return SourceControlProjection{}, errors.New("source-control repository and workspace are required")
	}
	changes := normalizeSourceControlChanges(req.Changes)
	syncStatus := strings.TrimSpace(req.SyncStatus)
	if syncStatus == "" {
		syncStatus = "unknown"
	}
	if syncStatus == "unknown" && len(changes) > 0 {
		syncStatus = "dirty"
	}
	if !isSourceControlSyncStatus(syncStatus) {
		return SourceControlProjection{}, errors.New("invalid source-control sync status")
	}
	m.mu.Lock()
	project, ok := m.projects[repositoryID]
	if !ok {
		m.mu.Unlock()
		return SourceControlProjection{}, ErrNotFound
	}
	if workspaceID != repositoryID {
		worktree, ok := m.worktrees[workspaceID]
		if !ok || worktree.ProjectID != repositoryID {
			m.mu.Unlock()
			return SourceControlProjection{}, ErrNotFound
		}
	}
	now := time.Now().UTC()
	provider := strings.TrimSpace(req.Provider)
	if provider == "" {
		provider = project.Provider
	}
	review := strings.TrimSpace(req.ReviewKind)
	if review == "" {
		review = "none"
	}
	branch := strings.TrimSpace(req.Branch)
	if branch == "" {
		branch = "unknown"
	}
	projection := SourceControlProjection{
		Kind:              "source-control",
		RepositoryID:      repositoryID,
		WorkspaceID:       workspaceID,
		Provider:          gitProviderKind(provider),
		ReviewKind:        reviewKind(review),
		Branch:            branch,
		BaseBranch:        strings.TrimSpace(req.BaseBranch),
		Ahead:             req.Ahead,
		Behind:            req.Behind,
		SyncStatus:        syncStatus,
		Changes:           changes,
		ConflictOperation: normalizeGitConflictOperation(req.ConflictOperation),
		BaseStatus:        normalizeSourceControlBaseStatus(req.BaseStatus),
		UpdatedAt:         now,
	}
	m.sourceControlProjections[sourceControlProjectionKey(repositoryID, workspaceID)] = projection
	err := m.saveLocked()
	m.mu.Unlock()
	if err != nil {
		return SourceControlProjection{}, err
	}
	m.emit("source-control.changed", projection)
	return projection, nil
}

func (m *Manager) cachedSourceControlProjection(repositoryID string, workspaceID string) (SourceControlProjection, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	projection, ok := m.sourceControlProjections[sourceControlProjectionKey(repositoryID, workspaceID)]
	return projection, ok
}

func gitReadablePath(path string, canReadGit bool) string {
	if !canReadGit {
		return ""
	}
	return path
}

func sourceProjectionFromGitStatus(provider string, repositoryID string, workspaceID string, path string, fallbackBranch string, fallbackReviewKind string) SourceControlProjection {
	branch := strings.TrimSpace(fallbackBranch)
	if branch == "" {
		branch = "unknown"
	}
	projection := SourceControlProjection{
		Kind:         "source-control",
		RepositoryID: repositoryID,
		WorkspaceID:  workspaceID,
		Provider:     gitProviderKind(provider),
		ReviewKind:   fallbackReviewKind,
		Branch:       branch,
		SyncStatus:   "unknown",
		Changes:      []SourceControlChange{},
		UpdatedAt:    time.Now().UTC(),
	}
	if strings.TrimSpace(path) == "" {
		return projection
	}
	lines, err := readGitShortStatus(path)
	if err != nil {
		return projection
	}
	applyGitStatusLines(&projection, lines, path)
	// Why: the operation label is read from gitdir state files (cheap stats),
	// so it stays fresh even when no conflict rows survived parsing.
	projection.ConflictOperation = DetectGitConflictOperation(path)
	return projection
}

func readGitShortStatus(path string) ([]string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 750*time.Millisecond)
	defer cancel()
	output, err := exec.CommandContext(ctx, "git", "-C", path, "status", "--short", "--branch").CombinedOutput()
	if err != nil {
		return nil, err
	}
	content := strings.TrimRight(string(output), "\n")
	if content == "" {
		return nil, nil
	}
	return strings.Split(content, "\n"), nil
}

func applyGitStatusLines(projection *SourceControlProjection, lines []string, worktreePath string) {
	changes := make([]SourceControlChange, 0, len(lines))
	for _, line := range lines {
		if strings.HasPrefix(line, "## ") {
			parseGitBranchLine(projection, strings.TrimSpace(strings.TrimPrefix(line, "## ")))
			continue
		}
		if parsedChanges := parseGitChangeLine(line, worktreePath); len(parsedChanges) > 0 {
			changes = append(changes, parsedChanges...)
		}
	}
	projection.Changes = changes
	if len(changes) > 0 {
		projection.SyncStatus = "dirty"
	} else {
		projection.SyncStatus = "clean"
	}
}

func parseGitBranchLine(projection *SourceControlProjection, line string) {
	if line == "" {
		return
	}
	statusStart := strings.Index(line, " [")
	status := ""
	if statusStart >= 0 {
		status = strings.TrimSuffix(line[statusStart+2:], "]")
		line = strings.TrimSpace(line[:statusStart])
	}
	if branch, _, ok := strings.Cut(line, "..."); ok {
		projection.Branch = strings.TrimSpace(branch)
	} else if strings.HasPrefix(line, "No commits yet on ") {
		projection.Branch = strings.TrimSpace(strings.TrimPrefix(line, "No commits yet on "))
	} else {
		projection.Branch = strings.TrimSpace(line)
	}
	for _, part := range strings.Split(status, ",") {
		part = strings.TrimSpace(part)
		if strings.HasPrefix(part, "ahead ") {
			projection.Ahead = parsePositiveInt(strings.TrimPrefix(part, "ahead "))
		}
		if strings.HasPrefix(part, "behind ") {
			projection.Behind = parsePositiveInt(strings.TrimPrefix(part, "behind "))
		}
	}
	if projection.Branch == "" {
		projection.Branch = "unknown"
	}
}

func parseGitChangeLine(line string, worktreePath string) []SourceControlChange {
	if len(line) < 4 {
		return nil
	}
	statusCode := line[:2]
	oldPath, path := parseGitStatusPath(strings.TrimSpace(line[3:]))
	if path == "" {
		return nil
	}
	// Why: unmerged XY pairs (DD/AU/UD/UA/DU/AA/UU) are a single conflict row,
	// not a staged+unstaged split — check them before the per-column parse.
	if conflictKind := ParseGitConflictKind(statusCode); conflictKind != "" {
		return []SourceControlChange{{
			Path:           path,
			Status:         ConflictCompatibilityStatus(worktreePath, path, conflictKind),
			Area:           "unstaged",
			ConflictKind:   conflictKind,
			ConflictStatus: "unresolved",
		}}
	}
	if statusCode == "??" {
		return []SourceControlChange{{Path: path, Status: "untracked", Area: "untracked"}}
	}
	changes := make([]SourceControlChange, 0, 2)
	if status := gitChangeStatusCode(statusCode[0]); status != "" {
		changes = append(changes, sourceControlChangeForGitStatus(path, oldPath, status, "staged"))
	}
	if status := gitChangeStatusCode(statusCode[1]); status != "" {
		changes = append(changes, sourceControlChangeForGitStatus(path, oldPath, status, "unstaged"))
	}
	return changes
}

func parseGitStatusPath(rawPath string) (string, string) {
	if renamedFrom, renamedTo, ok := strings.Cut(rawPath, " -> "); ok {
		return strings.TrimSpace(renamedFrom), strings.TrimSpace(renamedTo)
	}
	return "", rawPath
}

func sourceControlChangeForGitStatus(path string, oldPath string, status string, area string) SourceControlChange {
	change := SourceControlChange{Path: path, Status: status, Area: area}
	if status == "renamed" && strings.TrimSpace(oldPath) != "" {
		change.OldPath = strings.TrimSpace(oldPath)
	}
	return change
}

func gitChangeStatusCode(statusCode byte) string {
	switch statusCode {
	case 'R':
		return "renamed"
	case 'A':
		return "added"
	case 'D':
		return "deleted"
	case 'M':
		return "modified"
	case 'C':
		return "copied"
	default:
		return ""
	}
}

func normalizeSourceControlChanges(changes []SourceControlChange) []SourceControlChange {
	normalized := make([]SourceControlChange, 0, len(changes))
	for _, change := range changes {
		path, err := cleanWorkspaceRelativePath(change.Path)
		if err != nil {
			continue
		}
		path = filepath.ToSlash(path)
		status := normalizeSourceControlChangeStatus(change.Status)
		if path == "" || status == "" {
			continue
		}
		area := normalizeSourceControlChangeArea(change.Area, status)
		oldPath := ""
		if change.OldPath != "" {
			if cleanedOldPath, err := cleanWorkspaceRelativePath(change.OldPath); err == nil {
				oldPath = filepath.ToSlash(cleanedOldPath)
			}
		}
		normalized = append(normalized, SourceControlChange{
			Path:           path,
			Status:         status,
			Area:           area,
			OldPath:        oldPath,
			Additions:      change.Additions,
			Deletions:      change.Deletions,
			ConflictKind:   parseGitConflictKindName(change.ConflictKind),
			ConflictStatus: normalizeSourceControlConflictStatus(change.ConflictStatus),
		})
	}
	return normalized
}

func normalizeSourceControlChangeStatus(status string) string {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "a", "add", "added":
		return "added"
	case "m", "modify", "modified":
		return "modified"
	case "d", "delete", "deleted":
		return "deleted"
	case "r", "rename", "renamed":
		return "renamed"
	case "c", "copy", "copied":
		return "copied"
	case "?", "??", "untracked":
		return "untracked"
	case "!", "ignored":
		return "ignored"
	default:
		return ""
	}
}

func normalizeSourceControlChangeArea(area string, status string) string {
	switch strings.ToLower(strings.TrimSpace(area)) {
	case "staged", "index":
		return "staged"
	case "unstaged", "working", "worktree":
		return "unstaged"
	case "untracked":
		return "untracked"
	default:
		if status == "untracked" {
			return "untracked"
		}
		return "unstaged"
	}
}

// parseGitConflictKindName validates a relay-supplied conflict kind name,
// dropping anything outside the renderer's known set.
func parseGitConflictKindName(kind string) string {
	switch strings.TrimSpace(kind) {
	case "both_modified", "both_added", "both_deleted",
		"added_by_us", "added_by_them", "deleted_by_us", "deleted_by_them":
		return strings.TrimSpace(kind)
	default:
		return ""
	}
}

func normalizeSourceControlConflictStatus(status string) string {
	switch strings.TrimSpace(status) {
	case "unresolved", "resolved_locally":
		return strings.TrimSpace(status)
	default:
		return ""
	}
}

// normalizeSourceControlBaseStatus keeps relay-reported base drift inside the
// value set GitBaseStatus produces locally; unknown inputs degrade to
// "unknown" rather than being trusted verbatim.
func normalizeSourceControlBaseStatus(baseStatus *SourceControlBaseStatus) *SourceControlBaseStatus {
	if baseStatus == nil {
		return nil
	}
	normalized := *baseStatus
	switch strings.TrimSpace(normalized.Status) {
	case "current", "drift", "base_changed":
		normalized.Status = strings.TrimSpace(normalized.Status)
	default:
		normalized.Status = "unknown"
	}
	if normalized.Behind < 0 {
		normalized.Behind = 0
	}
	subjects := make([]string, 0, len(normalized.RecentSubjects))
	for _, subject := range normalized.RecentSubjects {
		if trimmed := strings.TrimSpace(subject); trimmed != "" {
			subjects = append(subjects, trimmed)
		}
	}
	normalized.RecentSubjects = subjects
	if normalized.Conflict != nil {
		conflict := *normalized.Conflict
		conflict.Remote = strings.TrimSpace(conflict.Remote)
		conflict.BranchName = strings.TrimSpace(conflict.BranchName)
		if conflict.Remote == "" || conflict.BranchName == "" {
			normalized.Conflict = nil
		} else {
			normalized.Conflict = &conflict
		}
	}
	return &normalized
}

func isSourceControlSyncStatus(status string) bool {
	switch status {
	case "clean", "dirty", "syncing", "error", "unknown":
		return true
	default:
		return false
	}
}

func sourceControlProjectionKey(repositoryID string, workspaceID string) string {
	return strings.TrimSpace(repositoryID) + "\x00" + strings.TrimSpace(workspaceID)
}

func parsePositiveInt(value string) int {
	var result int
	for _, char := range value {
		if char < '0' || char > '9' {
			break
		}
		result = result*10 + int(char-'0')
	}
	return result
}
