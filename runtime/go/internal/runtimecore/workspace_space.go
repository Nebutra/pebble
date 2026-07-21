package runtimecore

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"time"
)

const workspaceSpaceTopItemLimit = 20

type WorkspaceSpaceItem struct {
	Name      string `json:"name"`
	Path      string `json:"path"`
	Kind      string `json:"kind"`
	SizeBytes int64  `json:"sizeBytes"`
}
type WorkspaceSpaceWorktree struct {
	WorktreeID               string               `json:"worktreeId"`
	RepoID                   string               `json:"repoId"`
	RepoDisplayName          string               `json:"repoDisplayName"`
	RepoPath                 string               `json:"repoPath"`
	DisplayName              string               `json:"displayName"`
	Path                     string               `json:"path"`
	Branch                   string               `json:"branch"`
	IsMainWorktree           bool                 `json:"isMainWorktree"`
	IsRemote                 bool                 `json:"isRemote"`
	IsSparse                 bool                 `json:"isSparse"`
	CanDelete                bool                 `json:"canDelete"`
	LastActivityAt           int64                `json:"lastActivityAt"`
	Status                   string               `json:"status"`
	Error                    *string              `json:"error"`
	ScannedAt                int64                `json:"scannedAt"`
	SizeBytes                int64                `json:"sizeBytes"`
	ReclaimableBytes         int64                `json:"reclaimableBytes"`
	SkippedEntryCount        int                  `json:"skippedEntryCount"`
	TopLevelItems            []WorkspaceSpaceItem `json:"topLevelItems"`
	OmittedTopLevelItemCount int                  `json:"omittedTopLevelItemCount"`
	OmittedTopLevelSizeBytes int64                `json:"omittedTopLevelSizeBytes"`
}
type WorkspaceSpaceRepoSummary struct {
	RepoID                   string  `json:"repoId"`
	DisplayName              string  `json:"displayName"`
	Path                     string  `json:"path"`
	IsRemote                 bool    `json:"isRemote"`
	WorktreeCount            int     `json:"worktreeCount"`
	ScannedWorktreeCount     int     `json:"scannedWorktreeCount"`
	UnavailableWorktreeCount int     `json:"unavailableWorktreeCount"`
	TotalSizeBytes           int64   `json:"totalSizeBytes"`
	ReclaimableBytes         int64   `json:"reclaimableBytes"`
	Error                    *string `json:"error"`
}
type WorkspaceSpaceAnalysis struct {
	ScannedAt                int64                       `json:"scannedAt"`
	TotalSizeBytes           int64                       `json:"totalSizeBytes"`
	ReclaimableBytes         int64                       `json:"reclaimableBytes"`
	WorktreeCount            int                         `json:"worktreeCount"`
	ScannedWorktreeCount     int                         `json:"scannedWorktreeCount"`
	UnavailableWorktreeCount int                         `json:"unavailableWorktreeCount"`
	Repos                    []WorkspaceSpaceRepoSummary `json:"repos"`
	Worktrees                []WorkspaceSpaceWorktree    `json:"worktrees"`
}
type WorkspaceSpaceAnalyzeResult struct {
	OK        bool                    `json:"ok"`
	Analysis  *WorkspaceSpaceAnalysis `json:"analysis,omitempty"`
	Cancelled bool                    `json:"cancelled,omitempty"`
}
type WorkspaceSpaceScanProgress struct {
	ScanID                     string  `json:"scanId"`
	State                      string  `json:"state"`
	StartedAt                  int64   `json:"startedAt"`
	UpdatedAt                  int64   `json:"updatedAt"`
	TotalRepoCount             int     `json:"totalRepoCount"`
	ScannedRepoCount           int     `json:"scannedRepoCount"`
	TotalWorktreeCount         int     `json:"totalWorktreeCount"`
	ScannedWorktreeCount       int     `json:"scannedWorktreeCount"`
	CurrentRepoDisplayName     *string `json:"currentRepoDisplayName"`
	CurrentWorktreeDisplayName *string `json:"currentWorktreeDisplayName"`
}

func (m *Manager) AnalyzeWorkspaceSpace(parent context.Context) WorkspaceSpaceAnalyzeResult {
	ctx, cancel := context.WithCancel(parent)
	m.workspaceSpaceMu.Lock()
	if m.workspaceSpaceCancel != nil {
		m.workspaceSpaceMu.Unlock()
		cancel()
		return WorkspaceSpaceAnalyzeResult{Cancelled: true}
	}
	m.workspaceSpaceCancel = cancel
	m.workspaceSpaceMu.Unlock()
	defer func() {
		m.workspaceSpaceMu.Lock()
		m.workspaceSpaceCancel = nil
		m.workspaceSpaceMu.Unlock()
		cancel()
	}()

	projects := m.ListProjects()
	scanID := newID("space")
	startedAt := time.Now().UnixMilli()
	totalWorktrees := 0
	for _, project := range projects {
		totalWorktrees += len(workspaceSpaceProjectWorktrees(project, m.ListWorktrees(project.ID)))
	}
	progress := WorkspaceSpaceScanProgress{ScanID: scanID, State: "running", StartedAt: startedAt, UpdatedAt: startedAt, TotalRepoCount: len(projects), TotalWorktreeCount: totalWorktrees}
	m.emit("workspace-space.progress", progress)
	rows := make([]WorkspaceSpaceWorktree, 0)
	for projectIndex, project := range projects {
		projectRows := workspaceSpaceProjectWorktrees(project, m.ListWorktrees(project.ID))
		for index, worktree := range projectRows {
			if ctx.Err() != nil {
				return WorkspaceSpaceAnalyzeResult{Cancelled: true}
			}
			progress.CurrentRepoDisplayName = stringPointer(project.Name)
			progress.CurrentWorktreeDisplayName = stringPointer(worktree.DisplayName)
			progress.UpdatedAt = time.Now().UnixMilli()
			m.emit("workspace-space.progress", progress)
			rows = append(rows, scanWorkspaceSpaceWorktree(ctx, project, worktree, index == 0))
			progress.ScannedWorktreeCount++
		}
		progress.ScannedRepoCount = projectIndex + 1
	}
	progress.CurrentRepoDisplayName = nil
	progress.CurrentWorktreeDisplayName = nil
	progress.UpdatedAt = time.Now().UnixMilli()
	m.emit("workspace-space.progress", progress)
	analysis := summarizeWorkspaceSpace(projects, rows)
	return WorkspaceSpaceAnalyzeResult{OK: true, Analysis: &analysis}
}

func stringPointer(value string) *string {
	if value == "" {
		return nil
	}
	copy := value
	return &copy
}

func (m *Manager) CancelWorkspaceSpaceAnalysis() bool {
	m.workspaceSpaceMu.Lock()
	defer m.workspaceSpaceMu.Unlock()
	if m.workspaceSpaceCancel == nil {
		return false
	}
	m.workspaceSpaceCancel()
	return true
}

func workspaceSpaceProjectWorktrees(project Project, worktrees []Worktree) []Worktree {
	mainPath := filepath.Clean(project.Path)
	rows := []Worktree{{ID: project.ID, ProjectID: project.ID, Path: project.Path, DisplayName: project.Name}}
	for _, worktree := range worktrees {
		// Why: older stores can contain the repository root as a worktree record;
		// counting it again would inflate both disk usage and progress totals.
		if filepath.Clean(worktree.Path) == mainPath {
			continue
		}
		rows = append(rows, worktree)
	}
	return rows
}

func scanWorkspaceSpaceWorktree(ctx context.Context, project Project, worktree Worktree, main bool) WorkspaceSpaceWorktree {
	now := time.Now().UnixMilli()
	row := WorkspaceSpaceWorktree{WorktreeID: worktree.ID, RepoID: project.ID, RepoDisplayName: project.Name, RepoPath: project.Path, DisplayName: worktree.DisplayName, Path: worktree.Path, Branch: worktree.Branch, IsMainWorktree: main, IsRemote: project.LocationKind == "ssh", CanDelete: !main, LastActivityAt: worktree.LastActivityAt, Status: "ok", ScannedAt: now, TopLevelItems: []WorkspaceSpaceItem{}}
	if row.DisplayName == "" {
		row.DisplayName = filepath.Base(worktree.Path)
	}
	if row.IsRemote {
		message := "Remote workspace space analysis requires the SSH relay scanner."
		row.Status = "unavailable"
		row.Error = &message
		return row
	}
	entries, err := os.ReadDir(worktree.Path)
	if err != nil {
		message := err.Error()
		row.Status = workspaceSpaceErrorStatus(err)
		row.Error = &message
		return row
	}
	items := make([]WorkspaceSpaceItem, 0, len(entries))
	for _, entry := range entries {
		if ctx.Err() != nil {
			break
		}
		itemPath := filepath.Join(worktree.Path, entry.Name())
		size, skipped := workspaceSpacePathSize(ctx, itemPath)
		row.SkippedEntryCount += skipped
		kind := "file"
		if entry.IsDir() {
			kind = "directory"
		} else if entry.Type()&fs.ModeSymlink != 0 {
			kind = "symlink"
		}
		items = append(items, WorkspaceSpaceItem{Name: entry.Name(), Path: itemPath, Kind: kind, SizeBytes: size})
		row.SizeBytes += size
	}
	sort.Slice(items, func(i, j int) bool { return items[i].SizeBytes > items[j].SizeBytes })
	if len(items) > workspaceSpaceTopItemLimit {
		for _, item := range items[workspaceSpaceTopItemLimit:] {
			row.OmittedTopLevelSizeBytes += item.SizeBytes
		}
		row.OmittedTopLevelItemCount = len(items) - workspaceSpaceTopItemLimit
		items = items[:workspaceSpaceTopItemLimit]
	}
	row.TopLevelItems = items
	if !main {
		row.ReclaimableBytes = row.SizeBytes
	}
	return row
}

func workspaceSpacePathSize(ctx context.Context, root string) (int64, int) {
	var size int64
	skipped := 0
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err != nil {
			skipped++
			if entry != nil && entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if entry.Type()&fs.ModeSymlink != 0 {
			if info, e := entry.Info(); e == nil {
				size += info.Size()
			}
			return nil
		}
		if !entry.IsDir() {
			if info, e := entry.Info(); e == nil {
				size += info.Size()
			} else {
				skipped++
			}
		}
		return nil
	})
	if err != nil && !errors.Is(err, context.Canceled) {
		skipped++
	}
	return size, skipped
}

func workspaceSpaceErrorStatus(err error) string {
	if errors.Is(err, fs.ErrNotExist) {
		return "missing"
	}
	if errors.Is(err, fs.ErrPermission) {
		return "permission-denied"
	}
	return "error"
}
func summarizeWorkspaceSpace(projects []Project, rows []WorkspaceSpaceWorktree) WorkspaceSpaceAnalysis {
	result := WorkspaceSpaceAnalysis{ScannedAt: time.Now().UnixMilli(), WorktreeCount: len(rows), Worktrees: rows, Repos: []WorkspaceSpaceRepoSummary{}}
	for _, project := range projects {
		summary := WorkspaceSpaceRepoSummary{RepoID: project.ID, DisplayName: project.Name, Path: project.Path, IsRemote: project.LocationKind == "ssh"}
		for _, row := range rows {
			if row.RepoID != project.ID {
				continue
			}
			summary.WorktreeCount++
			if row.Status == "ok" {
				summary.ScannedWorktreeCount++
				summary.TotalSizeBytes += row.SizeBytes
				summary.ReclaimableBytes += row.ReclaimableBytes
			} else {
				summary.UnavailableWorktreeCount++
			}
		}
		result.Repos = append(result.Repos, summary)
		result.ScannedWorktreeCount += summary.ScannedWorktreeCount
		result.UnavailableWorktreeCount += summary.UnavailableWorktreeCount
		result.TotalSizeBytes += summary.TotalSizeBytes
		result.ReclaimableBytes += summary.ReclaimableBytes
	}
	return result
}
