package runtimecore

import (
	"context"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

const workspaceCleanupClassifierVersion = 2
const workspaceCleanupArchivedIdle = 7 * 24 * time.Hour
const workspaceCleanupIdle = 30 * 24 * time.Hour
const workspaceCleanupGitTimeout = 8 * time.Second

type WorkspaceCleanupScanRequest struct {
	WorktreeID         string   `json:"worktreeId,omitempty"`
	SkipGitWorktreeIDs []string `json:"skipGitWorktreeIds,omitempty"`
	ScanID             string   `json:"scanId,omitempty"`
}

type WorkspaceCleanupLocalProcessRequest struct {
	WorktreeID   string  `json:"worktreeId"`
	ConnectionID *string `json:"connectionId,omitempty"`
	WorktreePath string  `json:"worktreePath,omitempty"`
}

type WorkspaceCleanupLocalProcessResult struct {
	HasKillableProcesses *bool `json:"hasKillableProcesses"`
}

type WorkspaceCleanupLocalContext struct {
	TerminalTabCount       int    `json:"terminalTabCount"`
	CleanEditorTabCount    int    `json:"cleanEditorTabCount"`
	BrowserTabCount        int    `json:"browserTabCount"`
	DiffCommentCount       int    `json:"diffCommentCount"`
	NewestDiffCommentAt    *int64 `json:"newestDiffCommentAt"`
	RetainedDoneAgentCount int    `json:"retainedDoneAgentCount"`
}

type WorkspaceCleanupGitEvidence struct {
	Clean          *bool  `json:"clean"`
	UpstreamAhead  *int   `json:"upstreamAhead"`
	UpstreamBehind *int   `json:"upstreamBehind"`
	CheckedAt      *int64 `json:"checkedAt"`
}

type WorkspaceCleanupCandidate struct {
	WorktreeID        string                       `json:"worktreeId"`
	RepoID            string                       `json:"repoId"`
	RepoName          string                       `json:"repoName"`
	ConnectionID      *string                      `json:"connectionId"`
	DisplayName       string                       `json:"displayName"`
	Branch            string                       `json:"branch"`
	Path              string                       `json:"path"`
	Tier              string                       `json:"tier"`
	SelectedByDefault bool                         `json:"selectedByDefault"`
	Reasons           []string                     `json:"reasons"`
	Blockers          []string                     `json:"blockers"`
	LastActivityAt    int64                        `json:"lastActivityAt"`
	CreatedAt         *int64                       `json:"createdAt,omitempty"`
	LocalContext      WorkspaceCleanupLocalContext `json:"localContext"`
	Git               WorkspaceCleanupGitEvidence  `json:"git"`
	Fingerprint       string                       `json:"fingerprint"`
}

type WorkspaceCleanupScanError struct {
	RepoID   string `json:"repoId"`
	RepoName string `json:"repoName"`
	Message  string `json:"message"`
}

type WorkspaceCleanupScanResult struct {
	ScannedAt  int64                       `json:"scannedAt"`
	Candidates []WorkspaceCleanupCandidate `json:"candidates"`
	Errors     []WorkspaceCleanupScanError `json:"errors"`
}

type WorkspaceCleanupScanProgress struct {
	WorkspaceCleanupScanResult
	ScanID               string `json:"scanId"`
	ScannedWorktreeCount int    `json:"scannedWorktreeCount"`
	TotalWorktreeCount   int    `json:"totalWorktreeCount"`
	CandidateMode        string `json:"candidateMode,omitempty"`
}

func (m *Manager) ScanWorkspaceCleanup(parent context.Context, req WorkspaceCleanupScanRequest) WorkspaceCleanupScanResult {
	scannedAt := time.Now().UnixMilli()
	result := WorkspaceCleanupScanResult{ScannedAt: scannedAt, Candidates: []WorkspaceCleanupCandidate{}, Errors: []WorkspaceCleanupScanError{}}
	projects := m.ListProjects()
	if req.WorktreeID != "" {
		projects = filterCleanupProjectsForWorktree(projects, m.ListWorktrees(""), req.WorktreeID)
	}
	skipGit := make(map[string]bool, len(req.SkipGitWorktreeIDs))
	for _, id := range req.SkipGitWorktreeIDs {
		skipGit[id] = true
	}
	total, scanned := 0, 0
	emit := func(candidates []WorkspaceCleanupCandidate) {
		if req.ScanID == "" {
			return
		}
		m.emit("workspace-cleanup.progress", WorkspaceCleanupScanProgress{
			WorkspaceCleanupScanResult: WorkspaceCleanupScanResult{ScannedAt: scannedAt, Candidates: candidates, Errors: append([]WorkspaceCleanupScanError(nil), result.Errors...)},
			ScanID:                     req.ScanID, ScannedWorktreeCount: scanned, TotalWorktreeCount: total, CandidateMode: "append",
		})
	}
	for _, project := range projects {
		worktrees := cleanupEligibleWorktrees(project, m.ListWorktrees(project.ID), req.WorktreeID, scannedAt)
		total += len(worktrees)
		emit([]WorkspaceCleanupCandidate{})
		if project.LocationKind != "local" {
			for _, worktree := range worktrees {
				candidate := disconnectedWorkspaceCleanupCandidate(project, worktree, scannedAt)
				result.Candidates = append(result.Candidates, candidate)
				scanned++
				emit([]WorkspaceCleanupCandidate{candidate})
			}
			continue
		}
		candidates := m.scanLocalWorkspaceCleanupCandidates(parent, project, worktrees, scannedAt, skipGit, req.WorktreeID != "", func(candidate WorkspaceCleanupCandidate) {
			scanned++
			emit([]WorkspaceCleanupCandidate{candidate})
		})
		result.Candidates = append(result.Candidates, candidates...)
	}
	return result
}

func filterCleanupProjectsForWorktree(projects []Project, worktrees []Worktree, worktreeID string) []Project {
	projectID := ""
	for _, worktree := range worktrees {
		if worktree.ID == worktreeID {
			projectID = worktree.ProjectID
			break
		}
	}
	for _, project := range projects {
		if project.ID == projectID {
			return []Project{project}
		}
	}
	return []Project{}
}

func cleanupEligibleWorktrees(project Project, worktrees []Worktree, target string, scannedAt int64) []Worktree {
	if project.LocationKind != "local" && target == "" {
		// Why: broad cleanup omits disconnected SSH workspaces; focused delete
		// preflight still returns a protected row with explicit uncertainty.
		return []Worktree{}
	}
	result := make([]Worktree, 0, len(worktrees))
	for _, worktree := range worktrees {
		if target != "" {
			if worktree.ID == target {
				result = append(result, worktree)
			}
			continue
		}
		if project.Provider == "folder" || workspaceCleanupMainWorktree(project, worktree) {
			continue
		}
		if len(workspaceCleanupReasons(worktree, scannedAt)) > 0 {
			result = append(result, worktree)
		}
	}
	return result
}

func (m *Manager) scanLocalWorkspaceCleanupCandidates(parent context.Context, project Project, worktrees []Worktree, scannedAt int64, skipGit map[string]bool, forceGit bool, onCandidate func(WorkspaceCleanupCandidate)) []WorkspaceCleanupCandidate {
	results := make([]WorkspaceCleanupCandidate, len(worktrees))
	jobs := make(chan int)
	type indexedCandidate struct {
		index     int
		candidate WorkspaceCleanupCandidate
	}
	completed := make(chan indexedCandidate)
	var workers sync.WaitGroup
	count := 3
	if len(worktrees) < count {
		count = len(worktrees)
	}
	for worker := 0; worker < count; worker++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for index := range jobs {
				completed <- indexedCandidate{index: index, candidate: buildLocalWorkspaceCleanupCandidate(parent, project, worktrees[index], scannedAt, skipGit[worktrees[index].ID] && !forceGit)}
			}
		}()
	}
	go func() {
		for index := range worktrees {
			jobs <- index
		}
		close(jobs)
		workers.Wait()
		close(completed)
	}()
	for item := range completed {
		results[item.index] = item.candidate
		onCandidate(item.candidate)
	}
	return results
}

func buildLocalWorkspaceCleanupCandidate(parent context.Context, project Project, worktree Worktree, scannedAt int64, skipGit bool) WorkspaceCleanupCandidate {
	blockers := []string{}
	main := workspaceCleanupMainWorktree(project, worktree)
	if main {
		blockers = append(blockers, "main-worktree")
	}
	if project.Provider == "folder" {
		blockers = append(blockers, "folder-repo")
	}
	if worktree.IsPinned {
		blockers = append(blockers, "pinned")
	}
	evidence := WorkspaceCleanupGitEvidence{}
	head := ""
	if !skipGit && !main && project.Provider != "folder" && !worktree.IsPinned {
		evidence, blockers, head = readWorkspaceCleanupGitEvidence(parent, worktree.Path, blockers)
	}
	return finalizeWorkspaceCleanupCandidate(project, worktree, scannedAt, blockers, evidence, head)
}

func readWorkspaceCleanupGitEvidence(parent context.Context, path string, blockers []string) (WorkspaceCleanupGitEvidence, []string, string) {
	ctx, cancel := context.WithTimeout(parent, workspaceCleanupGitTimeout)
	defer cancel()
	checkedAt := time.Now().UnixMilli()
	status, err := exec.CommandContext(ctx, "git", "-C", path, "status", "--porcelain").Output()
	if err != nil {
		return WorkspaceCleanupGitEvidence{}, append(blockers, "git-status-error"), ""
	}
	clean := len(strings.TrimSpace(string(status))) == 0
	if !clean {
		blockers = append(blockers, "dirty-files")
	}
	headBytes, _ := exec.CommandContext(ctx, "git", "-C", path, "rev-parse", "HEAD").Output()
	head := strings.TrimSpace(string(headBytes))
	evidence := WorkspaceCleanupGitEvidence{Clean: &clean, CheckedAt: &checkedAt}
	aheadBehind, upstreamErr := exec.CommandContext(ctx, "git", "-C", path, "rev-list", "--left-right", "--count", "@{upstream}...HEAD").Output()
	if upstreamErr == nil {
		fields := strings.Fields(string(aheadBehind))
		if len(fields) >= 2 {
			behind, _ := strconv.Atoi(fields[0])
			ahead, _ := strconv.Atoi(fields[1])
			evidence.UpstreamAhead, evidence.UpstreamBehind = &ahead, &behind
			if ahead > 0 {
				blockers = append(blockers, "unpushed-commits")
			}
		}
	} else if clean {
		countBytes, countErr := exec.CommandContext(ctx, "git", "-C", path, "rev-list", "--count", "HEAD", "--not", "--remotes").Output()
		count, parseErr := strconv.Atoi(strings.TrimSpace(string(countBytes)))
		if countErr != nil || parseErr != nil {
			blockers = append(blockers, "unknown-base")
		} else if count > 0 {
			blockers = append(blockers, "unpushed-commits")
		}
	}
	return evidence, uniqueCleanupStrings(blockers), head
}

func disconnectedWorkspaceCleanupCandidate(project Project, worktree Worktree, scannedAt int64) WorkspaceCleanupCandidate {
	return finalizeWorkspaceCleanupCandidate(project, worktree, scannedAt, []string{"ssh-disconnected"}, WorkspaceCleanupGitEvidence{}, "")
}

func finalizeWorkspaceCleanupCandidate(project Project, worktree Worktree, scannedAt int64, blockers []string, evidence WorkspaceCleanupGitEvidence, head string) WorkspaceCleanupCandidate {
	branch := strings.TrimPrefix(worktree.Branch, "refs/heads/")
	if branch == "" {
		branch = "HEAD"
	}
	displayName := worktree.DisplayName
	if displayName == "" {
		displayName = filepath.Base(worktree.Path)
	}
	repoName := project.Name
	if repoName == "" {
		repoName = filepath.Base(project.Path)
	}
	created := worktree.CreatedAt.UnixMilli()
	candidate := WorkspaceCleanupCandidate{
		WorktreeID: worktree.ID, RepoID: project.ID, RepoName: repoName, DisplayName: displayName,
		Branch: branch, Path: worktree.Path, Reasons: workspaceCleanupReasons(worktree, scannedAt),
		Blockers: uniqueCleanupStrings(blockers), LastActivityAt: worktree.LastActivityAt, CreatedAt: &created,
		LocalContext: WorkspaceCleanupLocalContext{}, Git: evidence,
	}
	if project.LocationKind != "local" && strings.TrimSpace(project.HostID) != "" {
		connectionID := project.HostID
		candidate.ConnectionID = &connectionID
	}
	candidate.Fingerprint = workspaceCleanupFingerprint(branch, head, evidence.Clean, worktree.LastActivityAt)
	hardBlocked := len(candidate.Blockers) > 0
	if hardBlocked {
		candidate.Tier = "protected"
	} else if len(candidate.Reasons) > 0 && evidence.Clean != nil && *evidence.Clean && evidence.CheckedAt != nil {
		candidate.Tier, candidate.SelectedByDefault = "ready", true
	} else {
		candidate.Tier = "review"
	}
	return candidate
}

func workspaceCleanupMainWorktree(project Project, worktree Worktree) bool {
	projectPath, projectErr := filepath.EvalSymlinks(project.Path)
	if projectErr != nil {
		projectPath, projectErr = filepath.Abs(project.Path)
	}
	worktreePath, worktreeErr := filepath.EvalSymlinks(worktree.Path)
	if worktreeErr != nil {
		worktreePath, worktreeErr = filepath.Abs(worktree.Path)
	}
	return projectErr == nil && worktreeErr == nil && filepath.Clean(projectPath) == filepath.Clean(worktreePath)
}

func workspaceCleanupReasons(worktree Worktree, scannedAt int64) []string {
	reasons := []string{}
	idle := time.Duration(scannedAt-worktree.LastActivityAt) * time.Millisecond
	if worktree.IsArchived && idle >= workspaceCleanupArchivedIdle {
		reasons = append(reasons, "archived")
	}
	if idle >= workspaceCleanupIdle {
		reasons = append(reasons, "idle-clean")
	}
	return reasons
}

func workspaceCleanupFingerprint(branch, head string, clean *bool, lastActivityAt int64) string {
	cleanState := "unknown"
	if clean != nil && *clean {
		cleanState = "clean"
	} else if clean != nil {
		cleanState = "dirty"
	}
	return strings.Join([]string{strconv.Itoa(workspaceCleanupClassifierVersion), branch, head, cleanState, strconv.FormatInt(lastActivityAt/(24*60*60*1000), 10)}, "|")
}

func uniqueCleanupStrings(values []string) []string {
	seen := map[string]bool{}
	result := make([]string, 0, len(values))
	for _, value := range values {
		if value != "" && !seen[value] {
			seen[value] = true
			result = append(result, value)
		}
	}
	return result
}

func (m *Manager) HasWorkspaceCleanupProcesses(req WorkspaceCleanupLocalProcessRequest) WorkspaceCleanupLocalProcessResult {
	if strings.TrimSpace(req.WorktreeID) == "" {
		value := false
		return WorkspaceCleanupLocalProcessResult{HasKillableProcesses: &value}
	}
	if req.ConnectionID != nil && strings.TrimSpace(*req.ConnectionID) != "" {
		return WorkspaceCleanupLocalProcessResult{}
	}
	m.mu.RLock()
	defer m.mu.RUnlock()
	for _, session := range m.sessions {
		if session.worktreeID == req.WorktreeID {
			value := true
			return WorkspaceCleanupLocalProcessResult{HasKillableProcesses: &value}
		}
	}
	value := false
	return WorkspaceCleanupLocalProcessResult{HasKillableProcesses: &value}
}
