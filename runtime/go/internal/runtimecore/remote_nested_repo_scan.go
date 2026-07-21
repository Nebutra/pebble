package runtimecore

import (
	"errors"
	"path"
	"sort"
	"strings"
	"time"
)

// Relay-only SSH nested-repo discovery follows the relay push pattern:
// pebble-relay-worker runs ScanNestedReposOnHost on the remote host and posts
// snapshots here. Desktop callers without a paired runtime environment read
// this cache (and import from it) instead of a hard relay-required failure.

// ErrRemoteNestedScanRequired is returned when an import is requested for a
// host/path pair that has no relay-posted scan to validate candidates against.
var ErrRemoteNestedScanRequired = errors.New("remote nested scan has not been posted for this host and path")

var (
	ErrRemoteNestedScanIDRequired = errors.New("remote nested import requires a scan id")
	ErrRemoteNestedScanMismatch   = errors.New("remote nested scan id does not match the completed scan")
	ErrRemoteNestedScanIncomplete = errors.New("remote nested scan is still in progress")
)

type RemoteNestedRepoScan struct {
	HostID string `json:"hostId"`
	ScanID string `json:"scanId,omitempty"`
	Path   string `json:"path"`
	// Partial marks throttled mid-walk snapshots; the final post clears it.
	Partial   bool                 `json:"partial"`
	Scan      NestedRepoScanResult `json:"scan"`
	UpdatedAt time.Time            `json:"updatedAt"`
}

type UpdateRemoteNestedRepoScanRequest struct {
	HostID  string               `json:"hostId"`
	ScanID  string               `json:"scanId,omitempty"`
	Path    string               `json:"path"`
	Partial bool                 `json:"partial,omitempty"`
	Scan    NestedRepoScanResult `json:"scan"`
}

type ImportRemoteNestedReposRequest struct {
	HostID       string   `json:"hostId"`
	ScanID       string   `json:"scanId"`
	ParentPath   string   `json:"parentPath"`
	GroupName    string   `json:"groupName,omitempty"`
	ProjectPaths []string `json:"projectPaths,omitempty"`
	Mode         string   `json:"mode,omitempty"`
}

// UpdateRemoteNestedRepoScan stores a relay-posted scan snapshot. The cache is
// in-memory only: a scan is a point-in-time view of the remote filesystem, so
// persisting it across runtime restarts would present stale data as current.
func (m *Manager) UpdateRemoteNestedRepoScan(req UpdateRemoteNestedRepoScanRequest) (RemoteNestedRepoScan, error) {
	hostID := strings.TrimSpace(req.HostID)
	scanPath := strings.TrimSpace(req.Path)
	if hostID == "" {
		return RemoteNestedRepoScan{}, errors.New("host id is required")
	}
	if scanPath == "" {
		return RemoteNestedRepoScan{}, ErrInvalidPath
	}
	record := RemoteNestedRepoScan{
		HostID:    hostID,
		ScanID:    strings.TrimSpace(req.ScanID),
		Path:      scanPath,
		Partial:   req.Partial,
		Scan:      req.Scan,
		UpdatedAt: time.Now().UTC(),
	}
	if record.Scan.Repos == nil {
		record.Scan.Repos = []NestedRepoCandidate{}
	}
	m.mu.Lock()
	m.remoteNestedRepoScans[remoteNestedRepoScanKey(hostID, scanPath)] = record
	m.mu.Unlock()
	m.emit("remote-nested-scans.changed", record)
	// Relay partials reuse the streaming scan-progress topic so the desktop's
	// progress listeners work identically for local and relay-only scans.
	if record.ScanID != "" {
		m.emit("project-group.scan-progress", map[string]interface{}{
			"scanId": record.ScanID,
			"scan":   record.Scan,
		})
	}
	return record, nil
}

func (m *Manager) RemoteNestedRepoScanForHost(hostID string, scanPath string) (RemoteNestedRepoScan, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	record, ok := m.remoteNestedRepoScans[remoteNestedRepoScanKey(strings.TrimSpace(hostID), strings.TrimSpace(scanPath))]
	return record, ok
}

// ImportRemoteNestedRepos imports repos discovered by a relay-posted scan as
// SSH projects. The relay already verified the git markers on the host, so no
// local filesystem or git checks run here; candidate paths must come from the
// cached scan so a caller cannot import arbitrary remote paths.
func (m *Manager) ImportRemoteNestedRepos(req ImportRemoteNestedReposRequest) (ProjectGroupImportResult, error) {
	hostID := strings.TrimSpace(req.HostID)
	if hostID == "" {
		return ProjectGroupImportResult{}, errors.New("host id is required")
	}
	parentPath := strings.TrimSpace(req.ParentPath)
	if parentPath == "" || !strings.HasPrefix(parentPath, "/") {
		// Relay hosts are SSH remotes, so parent paths are posix-absolute.
		return ProjectGroupImportResult{}, ErrInvalidPath
	}
	scanID := strings.TrimSpace(req.ScanID)
	if scanID == "" {
		return ProjectGroupImportResult{}, ErrRemoteNestedScanIDRequired
	}
	cached, ok := m.RemoteNestedRepoScanForHost(hostID, parentPath)
	if !ok {
		return ProjectGroupImportResult{}, ErrRemoteNestedScanRequired
	}
	// Why: the renderer imports the exact completed snapshot the user reviewed;
	// a newer scan or an in-flight partial must not silently change that set.
	if cached.ScanID != scanID {
		return ProjectGroupImportResult{}, ErrRemoteNestedScanMismatch
	}
	if cached.Partial {
		return ProjectGroupImportResult{}, ErrRemoteNestedScanIncomplete
	}
	selected := selectNestedRepoImportPathsByKey(cached.Scan, req.ProjectPaths, remoteNestedRepoComparisonPath)
	result := ProjectGroupImportResult{
		Projects: make([]ProjectGroupImportProjectResult, 0, len(selected.paths)+len(selected.rejected)),
	}
	for _, rejectedPath := range selected.rejected {
		result.Projects = append(result.Projects, ProjectGroupImportProjectResult{
			Path:   rejectedPath,
			Status: "failed",
			Error:  "Repository was not found in the nested repo scan result",
		})
	}
	connectionID := hostID
	groupResolver := newNestedProjectGroupResolverWithScopes(
		m,
		parentPath,
		req.GroupName,
		req.Mode,
		buildRemoteNestedFolderScopes(parentPath, selected.paths),
		&connectionID,
		getRemoteNestedFolderRelativePathForRepo,
	)
	importedByPath := map[string]string{}
	for order, repoPath := range selected.paths {
		group, err := groupResolver.getGroupForRepo(repoPath)
		if err != nil {
			result.Projects = append(result.Projects, ProjectGroupImportProjectResult{
				Path:   repoPath,
				Status: "failed",
				Error:  err.Error(),
			})
			continue
		}
		result.Projects = append(
			result.Projects,
			m.importRemoteNestedRepoPath(hostID, repoPath, group, float64(order), importedByPath),
		)
	}
	for _, project := range result.Projects {
		switch project.Status {
		case "imported":
			result.ImportedCount++
		case "already-known":
			result.AlreadyKnownCount++
		case "failed":
			result.FailedCount++
		}
	}
	if result.ImportedCount+result.AlreadyKnownCount == 0 {
		for _, group := range reverseProjectGroups(groupResolver.getCreatedGroups()) {
			_, _ = m.DeleteProjectGroup(group.ID)
		}
	} else {
		result.Group = groupResolver.getRootGroup()
	}
	return result, nil
}

func (m *Manager) importRemoteNestedRepoPath(
	hostID string,
	repoPath string,
	group *ProjectGroup,
	order float64,
	importedByPath map[string]string,
) ProjectGroupImportProjectResult {
	comparisonPath := remoteNestedRepoComparisonPath(repoPath)
	if existingID := importedByPath[comparisonPath]; existingID != "" {
		return ProjectGroupImportProjectResult{Path: repoPath, ProjectID: existingID, Status: "already-known"}
	}
	if existing := m.findRemoteProjectByPath(hostID, comparisonPath); existing != nil {
		if group != nil {
			if moved, err := m.MoveProjectToGroup(MoveProjectToGroupRequest{
				ProjectID: existing.ID,
				GroupID:   &group.ID,
				Order:     &order,
			}); err == nil {
				existing = &moved
			}
		}
		importedByPath[comparisonPath] = existing.ID
		return ProjectGroupImportProjectResult{Path: repoPath, ProjectID: existing.ID, Status: "already-known"}
	}
	// Note: local imports redirect bare-worktree selections to a working tree
	// via `git worktree list`; that needs git on the remote host, so relay
	// imports keep the scanned path as-is.
	project, err := m.CreateProject(CreateProjectRequest{
		Name:         path.Base(strings.TrimRight(repoPath, "/")),
		Path:         repoPath,
		LocationKind: "ssh",
		HostID:       hostID,
		Provider:     "git",
	})
	if err != nil {
		return ProjectGroupImportProjectResult{Path: repoPath, Status: "failed", Error: err.Error()}
	}
	if group != nil {
		if moved, err := m.MoveProjectToGroup(MoveProjectToGroupRequest{
			ProjectID: project.ID,
			GroupID:   &group.ID,
			Order:     &order,
		}); err == nil {
			project = moved
		}
	}
	importedByPath[comparisonPath] = project.ID
	return ProjectGroupImportProjectResult{Path: repoPath, ProjectID: project.ID, Status: "imported"}
}

func (m *Manager) findRemoteProjectByPath(hostID string, comparisonPath string) *Project {
	m.mu.RLock()
	defer m.mu.RUnlock()
	for _, project := range m.projects {
		if project.LocationKind != "local" &&
			strings.TrimSpace(project.HostID) == hostID &&
			remoteNestedRepoComparisonPath(project.Path) == comparisonPath {
			copyProject := project
			return &copyProject
		}
	}
	return nil
}

func remoteNestedRepoScanKey(hostID string, scanPath string) string {
	return hostID + "\x00" + remoteNestedRepoComparisonPath(scanPath)
}

// remoteNestedRepoComparisonPath normalizes posix remote paths without the
// local-filesystem handling of nestedRepoComparisonPath, which would mangle
// posix paths when the desktop runs on Windows.
func remoteNestedRepoComparisonPath(value string) string {
	normalized := strings.ReplaceAll(strings.TrimSpace(value), "\\", "/")
	if normalized == "" {
		return ""
	}
	normalized = path.Clean(normalized)
	if normalized != "/" {
		normalized = strings.TrimRight(normalized, "/")
	}
	return normalized
}

// buildRemoteNestedFolderScopes mirrors buildNestedFolderScopes using posix
// path math, since relay scan results always come from an SSH host.
func buildRemoteNestedFolderScopes(parentPath string, repoPaths []string) []nestedFolderScope {
	type folderStats struct {
		directRepoCount int
		totalRepoCount  int
	}
	statsByPath := map[string]*folderStats{}
	note := func(relativePath string, direct bool) {
		normalized := normalizeNestedRelativePath(relativePath)
		stats := statsByPath[normalized]
		if stats == nil {
			stats = &folderStats{}
			statsByPath[normalized] = stats
		}
		if direct {
			stats.directRepoCount++
		} else {
			stats.totalRepoCount++
		}
	}
	for _, repoPath := range repoPaths {
		folderRelativePath := getRemoteNestedFolderRelativePathForRepo(parentPath, repoPath)
		if folderRelativePath == "" {
			continue
		}
		note(folderRelativePath, true)
		segments := strings.Split(folderRelativePath, "/")
		for length := 1; length <= len(segments); length++ {
			note(strings.Join(segments[:length], "/"), false)
		}
	}
	meaningfulPaths := make([]string, 0, len(statsByPath))
	for relativePath, stats := range statsByPath {
		if relativePath == "" {
			continue
		}
		if stats.directRepoCount >= 2 ||
			(stats.directRepoCount > 0 && stats.totalRepoCount > stats.directRepoCount) {
			meaningfulPaths = append(meaningfulPaths, relativePath)
		}
	}
	sort.Slice(meaningfulPaths, func(i, j int) bool {
		leftDepth := len(strings.Split(meaningfulPaths[i], "/"))
		rightDepth := len(strings.Split(meaningfulPaths[j], "/"))
		if leftDepth != rightDepth {
			return leftDepth < rightDepth
		}
		return meaningfulPaths[i] < meaningfulPaths[j]
	})
	meaningfulSet := map[string]struct{}{}
	for _, scopePath := range meaningfulPaths {
		meaningfulSet[scopePath] = struct{}{}
	}
	scopes := make([]nestedFolderScope, 0, len(meaningfulPaths))
	for _, relativePath := range meaningfulPaths {
		segments := strings.Split(relativePath, "/")
		parentRelativePath := getNearestNestedScopePath(strings.Join(segments[:len(segments)-1], "/"), meaningfulSet)
		var parent *string
		if parentRelativePath != "" {
			parent = &parentRelativePath
		}
		scopes = append(scopes, nestedFolderScope{
			relativePath:       relativePath,
			name:               relativePath,
			folderPath:         strings.TrimRight(parentPath, "/") + "/" + relativePath,
			parentRelativePath: parent,
		})
	}
	return scopes
}

func getRemoteNestedFolderRelativePathForRepo(parentPath string, repoPath string) string {
	parent := remoteNestedRepoComparisonPath(parentPath)
	repo := remoteNestedRepoComparisonPath(repoPath)
	if parent == "" || repo == "" || repo == parent {
		return ""
	}
	prefix := parent
	if prefix != "/" {
		prefix += "/"
	}
	if !strings.HasPrefix(repo, prefix) {
		return ""
	}
	segments := strings.Split(normalizeNestedRelativePath(strings.TrimPrefix(repo, prefix)), "/")
	if len(segments) <= 1 {
		return ""
	}
	return strings.Join(segments[:len(segments)-1], "/")
}
