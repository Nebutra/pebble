package runtimecore

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
)

const (
	defaultNestedRepoMaxDepth = 3
	defaultNestedRepoMaxRepos = 100
)

var skippedNestedRepoDirs = map[string]struct{}{
	"node_modules":  {},
	".next":         {},
	"dist":          {},
	"build":         {},
	".cache":        {},
	"vendor":        {},
	"__pycache__":   {},
	".turbo":        {},
	".parcel-cache": {},
}

var vcsMetadataDirs = map[string]struct{}{
	".git":  {},
	".svn":  {},
	".hg":   {},
	".jj":   {},
	".sl":   {},
	".repo": {},
	"CVS":   {},
}

type normalizedNestedRepoScanOptions struct {
	maxDepth  int
	maxRepos  int
	timeoutMs *int64
}

type nestedTraversalDir struct {
	path        string
	depth       int
	segments    []string
	ignoreRules []nestedIgnoreRule
}

type nestedIgnoreRule struct {
	pattern      string
	negate       bool
	basenameOnly bool
	baseSegments []string
}

type nestedRepoImportSelection struct {
	paths    []string
	rejected []string
}

type nestedFolderScope struct {
	relativePath       string
	name               string
	folderPath         string
	parentRelativePath *string
}

type nestedProjectGroupResolver struct {
	manager    *Manager
	parentPath string
	groupName  string
	mode       string
	// connectionID marks groups created for relay-only SSH imports so the
	// desktop can attribute them to the remote host.
	connectionID *string
	// relativePathForRepo abstracts local (filepath) vs remote (posix slash)
	// path math when deciding which folder scope a repo belongs to.
	relativePathForRepo func(parentPath string, repoPath string) string
	folderScopes        map[string]nestedFolderScope
	folderScopeGroups   map[string]ProjectGroup
	meaningfulScopePath map[string]struct{}
	rootGroup           *ProjectGroup
	createdGroups       []ProjectGroup
}

func (m *Manager) ListProjectGroups() []ProjectGroup {
	m.mu.RLock()
	defer m.mu.RUnlock()
	groups := make([]ProjectGroup, 0, len(m.projectGroups))
	for _, group := range m.projectGroups {
		groups = append(groups, group)
	}
	sort.Slice(groups, func(i, j int) bool {
		if groups[i].TabOrder != groups[j].TabOrder {
			return groups[i].TabOrder < groups[j].TabOrder
		}
		return groups[i].Name < groups[j].Name
	})
	return groups
}

func (m *Manager) CreateProjectGroup(req CreateProjectGroupRequest) (ProjectGroup, error) {
	name := normalizeProjectGroupName(req.Name, "Untitled group")
	parentPath, err := normalizeOptionalWorkspacePath(req.ParentPath, req.ConnectionID)
	if err != nil {
		return ProjectGroup{}, err
	}
	parentGroupID := cleanOptionalString(req.ParentGroupID)
	if parentGroupID != nil {
		m.mu.RLock()
		_, ok := m.projectGroups[*parentGroupID]
		m.mu.RUnlock()
		if !ok {
			return ProjectGroup{}, ErrNotFound
		}
	}
	createdFrom := strings.TrimSpace(req.CreatedFrom)
	if createdFrom != "manual" && createdFrom != "folder-scan" && createdFrom != "migration" {
		createdFrom = "manual"
	}
	now := time.Now().UTC().UnixMilli()
	group := ProjectGroup{
		ID:            newID("pg"),
		Name:          name,
		ParentPath:    parentPath,
		ConnectionID:  cleanOptionalString(req.ConnectionID),
		ParentGroupID: parentGroupID,
		CreatedFrom:   createdFrom,
		TabOrder:      0,
		IsCollapsed:   false,
		Color:         nil,
		CreatedAt:     now,
		UpdatedAt:     now,
	}
	m.mu.Lock()
	for _, existing := range m.projectGroups {
		if existing.TabOrder >= group.TabOrder {
			group.TabOrder = existing.TabOrder + 1
		}
	}
	m.projectGroups[group.ID] = group
	err = m.saveLocked()
	m.mu.Unlock()
	if err != nil {
		return ProjectGroup{}, err
	}
	m.emit("project-group.changed", group)
	m.emit("project.changed", map[string]interface{}{"projectGroup": group})
	return group, nil
}

func (m *Manager) UpdateProjectGroup(id string, req UpdateProjectGroupRequest) (ProjectGroup, error) {
	m.mu.Lock()
	group, ok := m.projectGroups[id]
	if !ok {
		m.mu.Unlock()
		return ProjectGroup{}, ErrNotFound
	}
	if req.Name != nil {
		group.Name = normalizeProjectGroupName(*req.Name, group.Name)
	}
	if req.IsCollapsed != nil {
		group.IsCollapsed = *req.IsCollapsed
	}
	if req.TabOrder != nil && isFiniteFloat(*req.TabOrder) {
		group.TabOrder = *req.TabOrder
	}
	if req.Color != nil {
		group.Color = decodeOptionalString(req.Color)
	}
	group.UpdatedAt = time.Now().UTC().UnixMilli()
	m.projectGroups[id] = group
	err := m.saveLocked()
	m.mu.Unlock()
	if err != nil {
		return ProjectGroup{}, err
	}
	m.emit("project-group.changed", group)
	m.emit("project.changed", map[string]interface{}{"projectGroup": group})
	return group, nil
}

func (m *Manager) DeleteProjectGroup(id string) (bool, error) {
	m.mu.Lock()
	if _, ok := m.projectGroups[id]; !ok {
		m.mu.Unlock()
		return false, nil
	}
	deletedGroupIDs := projectGroupSubtreeIDsLocked(m.projectGroups, id)
	for groupID := range deletedGroupIDs {
		delete(m.projectGroups, groupID)
	}
	for projectID, project := range m.projects {
		if project.ProjectGroupID != nil {
			if _, deleted := deletedGroupIDs[*project.ProjectGroupID]; deleted {
				project.ProjectGroupID = nil
				project.ProjectGroupOrder = nil
				project.UpdatedAt = time.Now().UTC()
				m.projects[projectID] = project
			}
		}
	}
	for workspaceID, workspace := range m.folderWorkspaces {
		if _, deleted := deletedGroupIDs[workspace.ProjectGroupID]; deleted {
			delete(m.folderWorkspaces, workspaceID)
			removeWorkspaceLineageForFolderParentLocked(m.worktrees, workspace.ID)
		}
	}
	err := m.saveLocked()
	m.mu.Unlock()
	if err != nil {
		return false, err
	}
	m.emit("project-group.changed", map[string]interface{}{"deleted": id})
	m.emit("project.changed", map[string]interface{}{"projectGroupDeleted": id})
	return true, nil
}

func (m *Manager) MoveProjectToGroup(req MoveProjectToGroupRequest) (Project, error) {
	projectID := normalizeRuntimeSelector(req.ProjectID)
	if projectID == "" {
		projectID = normalizeRuntimeSelector(req.Repo)
	}
	if projectID == "" {
		return Project{}, ErrProjectRequired
	}
	m.mu.Lock()
	project, ok := m.projects[projectID]
	if !ok {
		m.mu.Unlock()
		return Project{}, ErrNotFound
	}
	groupID := cleanOptionalString(req.GroupID)
	if groupID != nil {
		if _, ok := m.projectGroups[*groupID]; !ok {
			groupID = nil
		}
	}
	project.ProjectGroupID = groupID
	if req.Order != nil && isFiniteFloat(*req.Order) {
		order := *req.Order
		project.ProjectGroupOrder = &order
	} else {
		order := nextProjectGroupOrderLocked(m.projects, project.ID, groupID)
		project.ProjectGroupOrder = &order
	}
	project.UpdatedAt = time.Now().UTC()
	m.projects[project.ID] = project
	err := m.saveLocked()
	m.mu.Unlock()
	if err != nil {
		return Project{}, err
	}
	m.emit("project.changed", project)
	return project, nil
}

func (m *Manager) ScanNestedRepos(ctx context.Context, req NestedRepoScanRequest) (NestedRepoScanResult, error) {
	scanID := strings.TrimSpace(req.ScanID)
	var onProgress func(NestedRepoScanResult)
	if scanID != "" {
		onProgress = func(snapshot NestedRepoScanResult) {
			m.emit("project-group.scan-progress", map[string]interface{}{
				"scanId": scanID,
				"scan":   snapshot,
			})
		}
	}
	return ScanNestedReposOnHost(ctx, req, onProgress)
}

// nestedScanProgressInterval throttles directory-visit progress snapshots so a
// long walk streams liveness without flooding the event channel.
const nestedScanProgressInterval = 500 * time.Millisecond

// ScanNestedReposOnHost walks a folder for sibling git repos. Exported (not
// just a Manager method) because pebble-relay-worker runs the identical scan
// on relay-only SSH hosts and posts the result back to the runtime gateway.
// onProgress, when non-nil, receives partial snapshots: one per repo found
// (Electron's cadence) plus throttled directory-visit updates.
func ScanNestedReposOnHost(
	ctx context.Context,
	req NestedRepoScanRequest,
	onProgress func(NestedRepoScanResult),
) (NestedRepoScanResult, error) {
	startedAt := time.Now()
	options := normalizeNestedRepoScanOptions(req.Options)
	selectedPath, err := normalizeLocalPath(req.Path)
	if err != nil {
		return NestedRepoScanResult{}, err
	}
	timeoutMs := options.timeoutMsJSON()
	result := NestedRepoScanResult{
		SelectedPath:     selectedPath,
		SelectedPathKind: "non_git_folder",
		Repos:            []NestedRepoCandidate{},
		MaxDepth:         options.maxDepth,
		MaxRepos:         options.maxRepos,
		TimeoutMs:        timeoutMs,
	}
	lastProgressAt := startedAt
	emitProgress := func() {
		if onProgress == nil {
			return
		}
		lastProgressAt = time.Now()
		snapshot := result
		snapshot.Repos = append([]NestedRepoCandidate{}, result.Repos...)
		snapshot.DurationMs = time.Since(startedAt).Milliseconds()
		onProgress(snapshot)
	}
	if isGitRepoMarker(selectedPath) {
		result.SelectedPathKind = "git_repo"
		result.DurationMs = time.Since(startedAt).Milliseconds()
		return result, nil
	}
	pending := []nestedTraversalDir{{
		path:        selectedPath,
		depth:       0,
		segments:    []string{},
		ignoreRules: []nestedIgnoreRule{},
	}}
	for len(pending) > 0 {
		// Why: a dropped/cancelled HTTP request must abort the walk with the same
		// partial "stopped" result Electron's AbortSignal cancel path produces.
		if ctx.Err() != nil {
			result.Stopped = true
			break
		}
		if len(result.Repos) >= options.maxRepos {
			result.Truncated = true
			break
		}
		if options.timedOut(startedAt) {
			result.TimedOut = true
			break
		}
		current := pending[0]
		pending = pending[1:]
		if current.depth > options.maxDepth {
			continue
		}
		entries, err := os.ReadDir(current.path)
		if err != nil {
			continue
		}
		result.DirectoriesVisited++
		if onProgress != nil && time.Since(lastProgressAt) >= nestedScanProgressInterval {
			emitProgress()
		}
		currentIgnoreRules := append(
			append([]nestedIgnoreRule{}, current.ignoreRules...),
			readNestedGitignoreRules(current.path, current.segments)...,
		)
		sort.Slice(entries, func(i, j int) bool {
			return entries[i].Name() < entries[j].Name()
		})
		for _, entry := range entries {
			if ctx.Err() != nil {
				result.Stopped = true
				break
			}
			if len(result.Repos) >= options.maxRepos {
				result.Truncated = true
				break
			}
			if options.timedOut(startedAt) {
				result.TimedOut = true
				break
			}
			if !entry.IsDir() {
				continue
			}
			name := entry.Name()
			childSegments := append(append([]string{}, current.segments...), name)
			if isIgnoredByNestedRepoRules(name, childSegments, currentIgnoreRules) {
				continue
			}
			info, err := entry.Info()
			if err == nil && info.Mode()&os.ModeSymlink != 0 {
				continue
			}
			childPath := filepath.Join(current.path, name)
			childDepth := current.depth + 1
			if hasVcsMarker(childPath) {
				result.Repos = append(result.Repos, NestedRepoCandidate{
					Path:        childPath,
					DisplayName: pathBase(childPath),
					Depth:       childDepth,
				})
				emitProgress()
				continue
			}
			if current.depth < options.maxDepth {
				pending = append(pending, nestedTraversalDir{
					path:        childPath,
					depth:       childDepth,
					segments:    childSegments,
					ignoreRules: currentIgnoreRules,
				})
			}
		}
	}
	result.DurationMs = time.Since(startedAt).Milliseconds()
	return result, nil
}

func (m *Manager) ImportNestedRepos(ctx context.Context, req ProjectGroupImportNestedRequest) (ProjectGroupImportResult, error) {
	parentPath, err := normalizeLocalPath(req.ParentPath)
	if err != nil {
		return ProjectGroupImportResult{}, err
	}
	scan, err := m.ScanNestedRepos(ctx, NestedRepoScanRequest{
		Path: parentPath,
		Options: NestedRepoScanOptions{
			TimeoutMs: floatPointer(15_000),
		},
	})
	if err != nil {
		return ProjectGroupImportResult{}, err
	}
	selected := selectNestedRepoImportPaths(scan, req.ProjectPaths)
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
	groupResolver := newNestedProjectGroupResolver(m, parentPath, req.GroupName, req.Mode, selected.paths)
	importedByPath := map[string]string{}
	targetCache := map[string]string{}
	for order, repoPath := range selected.paths {
		// Why: cancellation between repos mirrors the scan's cancel-to-stopped flow;
		// remaining paths report failed instead of pretending they were imported.
		if ctx.Err() != nil {
			result.Projects = append(result.Projects, ProjectGroupImportProjectResult{
				Path:   repoPath,
				Status: "failed",
				Error:  "Import was cancelled",
			})
			continue
		}
		group, err := groupResolver.getGroupForRepo(repoPath)
		if err != nil {
			result.Projects = append(result.Projects, ProjectGroupImportProjectResult{
				Path:   repoPath,
				Status: "failed",
				Error:  err.Error(),
			})
			continue
		}
		projectResult := m.importNestedRepoPath(
			repoPath,
			group,
			float64(order),
			importedByPath,
			targetCache,
		)
		result.Projects = append(result.Projects, projectResult)
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

func (m *Manager) importNestedRepoPath(
	repoPath string,
	group *ProjectGroup,
	order float64,
	importedByPath map[string]string,
	targetCache map[string]string,
) ProjectGroupImportProjectResult {
	normalizedPath, err := normalizeLocalPath(repoPath)
	if err != nil {
		return ProjectGroupImportProjectResult{Path: repoPath, Status: "failed", Error: err.Error()}
	}
	if !isGitRepoMarker(normalizedPath) {
		return ProjectGroupImportProjectResult{
			Path:   repoPath,
			Status: "failed",
			Error:  "Not a valid git repository",
		}
	}
	importPath := resolveLocalNestedRepoImportTargetPath(normalizedPath, targetCache)
	comparisonPath := nestedRepoComparisonPath(importPath)
	if existingID := importedByPath[comparisonPath]; existingID != "" {
		return ProjectGroupImportProjectResult{
			Path:      repoPath,
			ProjectID: existingID,
			Status:    "already-known",
		}
	}
	if existing := m.findProjectByPath(importPath); existing != nil {
		if group != nil {
			moved, err := m.MoveProjectToGroup(MoveProjectToGroupRequest{
				ProjectID: existing.ID,
				GroupID:   &group.ID,
				Order:     &order,
			})
			if err == nil {
				existing = &moved
			}
		}
		importedByPath[comparisonPath] = existing.ID
		return ProjectGroupImportProjectResult{
			Path:      repoPath,
			ProjectID: existing.ID,
			Status:    "already-known",
		}
	}
	project, err := m.CreateProject(CreateProjectRequest{
		Name:         pathBase(importPath),
		Path:         importPath,
		LocationKind: "local",
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
	return ProjectGroupImportProjectResult{
		Path:      repoPath,
		ProjectID: project.ID,
		Status:    "imported",
	}
}

func normalizeNestedRepoScanOptions(raw NestedRepoScanOptions) normalizedNestedRepoScanOptions {
	return normalizedNestedRepoScanOptions{
		maxDepth:  normalizeNestedRepoBound(raw.MaxDepth, defaultNestedRepoMaxDepth, 1, 8),
		maxRepos:  normalizeNestedRepoBound(raw.MaxRepos, defaultNestedRepoMaxRepos, 1, 500),
		timeoutMs: normalizeNestedRepoTimeout(raw.TimeoutMs),
	}
}

func normalizeNestedRepoBound(value *float64, fallback int, minimum int, maximum int) int {
	if value == nil || !isFiniteFloat(*value) {
		return fallback
	}
	rounded := int(math.Floor(*value))
	if rounded < minimum {
		return minimum
	}
	if rounded > maximum {
		return maximum
	}
	return rounded
}

func normalizeNestedRepoTimeout(value *float64) *int64 {
	if value == nil || !isFiniteFloat(*value) {
		return nil
	}
	rounded := int64(math.Floor(*value))
	if rounded < 500 {
		rounded = 500
	}
	if rounded > 30_000 {
		rounded = 30_000
	}
	return &rounded
}

func (options normalizedNestedRepoScanOptions) timeoutMsJSON() *int64 {
	if options.timeoutMs == nil {
		return nil
	}
	value := *options.timeoutMs
	return &value
}

func (options normalizedNestedRepoScanOptions) timedOut(startedAt time.Time) bool {
	return options.timeoutMs != nil && time.Since(startedAt).Milliseconds() > *options.timeoutMs
}

func readNestedGitignoreRules(folderPath string, baseSegments []string) []nestedIgnoreRule {
	content, err := os.ReadFile(filepath.Join(folderPath, ".gitignore"))
	if err != nil {
		return nil
	}
	return parseNestedGitignoreRules(string(content), baseSegments)
}

func parseNestedGitignoreRules(content string, baseSegments []string) []nestedIgnoreRule {
	var rules []nestedIgnoreRule
	for _, rawLine := range strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n") {
		line := strings.TrimSpace(rawLine)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		negate := strings.HasPrefix(line, "!")
		unprefixed := line
		if negate {
			unprefixed = strings.TrimPrefix(line, "!")
		}
		anchored := strings.HasPrefix(unprefixed, "/")
		pattern := strings.Trim(unprefixed, "/")
		if pattern == "" {
			continue
		}
		rules = append(rules, nestedIgnoreRule{
			pattern:      pattern,
			negate:       negate,
			basenameOnly: !anchored && !strings.Contains(pattern, "/"),
			baseSegments: append([]string{}, baseSegments...),
		})
	}
	return rules
}

func isIgnoredByNestedRepoRules(name string, segments []string, rules []nestedIgnoreRule) bool {
	ignored := false
	for _, rule := range rules {
		if len(segments) <= len(rule.baseSegments) {
			continue
		}
		relativeSegments := segments[len(rule.baseSegments):]
		patternSegments := strings.Split(rule.pattern, "/")
		matches := false
		if rule.basenameOnly {
			for _, segment := range relativeSegments {
				if globSegmentMatches(rule.pattern, segment) {
					matches = true
					break
				}
			}
		} else {
			matches = pathSegmentsMatch(patternSegments, relativeSegments)
		}
		if matches {
			ignored = !rule.negate
		}
	}
	return ignored || shouldSkipNestedRepoDir(name, len(segments)-1)
}

func shouldSkipNestedRepoDir(name string, depth int) bool {
	if _, ok := vcsMetadataDirs[name]; ok {
		return true
	}
	if _, ok := skippedNestedRepoDirs[name]; ok {
		return true
	}
	return depth > 0 && strings.HasPrefix(name, ".")
}

func globSegmentMatches(pattern string, value string) bool {
	memo := map[[2]int]bool{}
	var match func(int, int) bool
	match = func(patternIndex int, valueIndex int) bool {
		key := [2]int{patternIndex, valueIndex}
		if result, ok := memo[key]; ok {
			return result
		}
		var result bool
		switch {
		case patternIndex == len(pattern):
			result = valueIndex == len(value)
		case pattern[patternIndex] == '*':
			result = match(patternIndex+1, valueIndex) ||
				(valueIndex < len(value) && match(patternIndex, valueIndex+1))
		case pattern[patternIndex] == '?':
			result = valueIndex < len(value) && match(patternIndex+1, valueIndex+1)
		default:
			result = valueIndex < len(value) &&
				pattern[patternIndex] == value[valueIndex] &&
				match(patternIndex+1, valueIndex+1)
		}
		memo[key] = result
		return result
	}
	return match(0, 0)
}

func pathSegmentsMatch(patternSegments []string, candidateSegments []string) bool {
	memo := map[[2]int]bool{}
	var match func(int, int) bool
	match = func(patternIndex int, candidateIndex int) bool {
		key := [2]int{patternIndex, candidateIndex}
		if result, ok := memo[key]; ok {
			return result
		}
		var result bool
		if patternIndex >= len(patternSegments) {
			result = candidateIndex >= len(candidateSegments)
		} else if patternSegments[patternIndex] == "**" {
			result = match(patternIndex+1, candidateIndex) ||
				(candidateIndex < len(candidateSegments) && match(patternIndex, candidateIndex+1))
		} else {
			result = candidateIndex < len(candidateSegments) &&
				globSegmentMatches(patternSegments[patternIndex], candidateSegments[candidateIndex]) &&
				match(patternIndex+1, candidateIndex+1)
		}
		memo[key] = result
		return result
	}
	return match(0, 0)
}

func hasVcsMarker(path string) bool {
	return isGitRepoMarker(path)
}

func isGitRepoMarker(path string) bool {
	marker, err := os.Stat(filepath.Join(path, ".git"))
	if err == nil && (marker.IsDir() || marker.Mode().IsRegular()) {
		return true
	}
	head, headErr := os.Stat(filepath.Join(path, "HEAD"))
	objects, objectsErr := os.Stat(filepath.Join(path, "objects"))
	refs, refsErr := os.Stat(filepath.Join(path, "refs"))
	return headErr == nil &&
		objectsErr == nil &&
		refsErr == nil &&
		head.Mode().IsRegular() &&
		objects.IsDir() &&
		refs.IsDir()
}

func selectNestedRepoImportPaths(
	scan NestedRepoScanResult,
	requested []string,
) nestedRepoImportSelection {
	return selectNestedRepoImportPathsByKey(scan, requested, nestedRepoComparisonPath)
}

// selectNestedRepoImportPathsByKey parametrizes the path comparison so remote
// (posix) relay scans can reuse the local selection semantics.
func selectNestedRepoImportPathsByKey(
	scan NestedRepoScanResult,
	requested []string,
	nestedRepoComparisonPath func(string) string,
) nestedRepoImportSelection {
	candidatesByPath := map[string]string{}
	for _, repo := range scan.Repos {
		candidatesByPath[nestedRepoComparisonPath(repo.Path)] = repo.Path
	}
	if len(requested) == 0 {
		selected := make([]string, 0, len(scan.Repos))
		seen := map[string]struct{}{}
		for _, repo := range scan.Repos {
			key := nestedRepoComparisonPath(repo.Path)
			if _, ok := seen[key]; ok {
				continue
			}
			seen[key] = struct{}{}
			selected = append(selected, repo.Path)
		}
		return nestedRepoImportSelection{paths: selected}
	}
	selection := nestedRepoImportSelection{}
	seen := map[string]struct{}{}
	for _, path := range requested {
		key := nestedRepoComparisonPath(path)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		if canonicalPath, ok := candidatesByPath[key]; ok {
			selection.paths = append(selection.paths, canonicalPath)
		} else {
			selection.rejected = append(selection.rejected, path)
		}
	}
	return selection
}

func (m *Manager) findProjectByPath(path string) *Project {
	comparisonPath := nestedRepoComparisonPath(path)
	m.mu.RLock()
	defer m.mu.RUnlock()
	for _, project := range m.projects {
		if nestedRepoComparisonPath(project.Path) == comparisonPath {
			copyProject := project
			return &copyProject
		}
	}
	return nil
}

func nestedRepoComparisonPath(path string) string {
	normalized := strings.TrimSpace(path)
	if normalized == "" {
		return ""
	}
	if absolute, err := normalizeLocalPath(normalized); err == nil {
		normalized = absolute
	}
	normalized = filepath.ToSlash(filepath.Clean(normalized))
	if normalized != "/" {
		normalized = strings.TrimRight(normalized, "/")
	}
	if runtime.GOOS == "windows" {
		normalized = strings.ToLower(normalized)
	}
	return normalized
}

func floatPointer(value float64) *float64 {
	return &value
}

func resolveLocalNestedRepoImportTargetPath(repoPath string, cache map[string]string) string {
	key := nestedRepoComparisonPath(repoPath)
	if cached := cache[key]; cached != "" {
		return cached
	}
	targetPath := repoPath
	worktrees := listGitWorktreeGraph(repoPath)
	selectedInGraph := false
	for _, worktree := range worktrees {
		if nestedRepoComparisonPath(worktree.path) == key {
			selectedInGraph = true
			break
		}
	}
	if selectedInGraph {
		for _, worktree := range worktrees {
			if !worktree.isBare {
				targetPath = worktree.path
				break
			}
		}
		for _, worktree := range worktrees {
			cache[nestedRepoComparisonPath(worktree.path)] = targetPath
		}
	}
	cache[key] = targetPath
	return targetPath
}

type nestedGitWorktree struct {
	path   string
	isBare bool
}

func listGitWorktreeGraph(repoPath string) []nestedGitWorktree {
	cmd := exec.Command("git", "-C", repoPath, "worktree", "list", "--porcelain")
	cmd.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1")
	output, err := cmd.Output()
	if err != nil {
		return nil
	}
	return parseGitWorktreeGraph(string(output))
}

func parseGitWorktreeGraph(output string) []nestedGitWorktree {
	var worktrees []nestedGitWorktree
	current := nestedGitWorktree{}
	hasCurrent := false
	flush := func() {
		if hasCurrent && strings.TrimSpace(current.path) != "" {
			worktrees = append(worktrees, current)
		}
		current = nestedGitWorktree{}
		hasCurrent = false
	}
	for _, rawLine := range strings.Split(strings.ReplaceAll(output, "\r\n", "\n"), "\n") {
		line := strings.TrimSpace(rawLine)
		if line == "" {
			flush()
			continue
		}
		if strings.HasPrefix(line, "worktree ") {
			flush()
			current = nestedGitWorktree{path: strings.TrimSpace(strings.TrimPrefix(line, "worktree "))}
			hasCurrent = true
			continue
		}
		if line == "bare" && hasCurrent {
			current.isBare = true
		}
	}
	flush()
	return worktrees
}

func newNestedProjectGroupResolver(
	manager *Manager,
	parentPath string,
	groupName string,
	mode string,
	repoPaths []string,
) *nestedProjectGroupResolver {
	return newNestedProjectGroupResolverWithScopes(
		manager,
		parentPath,
		groupName,
		mode,
		buildNestedFolderScopes(parentPath, repoPaths),
		nil,
		getNestedFolderRelativePathForRepo,
	)
}

func newNestedProjectGroupResolverWithScopes(
	manager *Manager,
	parentPath string,
	groupName string,
	mode string,
	scopes []nestedFolderScope,
	connectionID *string,
	relativePathForRepo func(parentPath string, repoPath string) string,
) *nestedProjectGroupResolver {
	folderScopes := make(map[string]nestedFolderScope, len(scopes))
	meaningful := make(map[string]struct{}, len(scopes))
	for _, scope := range scopes {
		folderScopes[scope.relativePath] = scope
		meaningful[scope.relativePath] = struct{}{}
	}
	return &nestedProjectGroupResolver{
		manager:             manager,
		parentPath:          parentPath,
		groupName:           strings.TrimSpace(groupName),
		mode:                strings.TrimSpace(mode),
		connectionID:        connectionID,
		relativePathForRepo: relativePathForRepo,
		folderScopes:        folderScopes,
		folderScopeGroups:   map[string]ProjectGroup{},
		meaningfulScopePath: meaningful,
	}
}

func (resolver *nestedProjectGroupResolver) getGroupForRepo(repoPath string) (*ProjectGroup, error) {
	root, err := resolver.ensureRootGroup()
	if err != nil || root == nil {
		return root, err
	}
	folderRelativePath := resolver.relativePathForRepo(resolver.parentPath, repoPath)
	if folderRelativePath == "" {
		return root, nil
	}
	scopePath := getNearestNestedScopePath(folderRelativePath, resolver.meaningfulScopePath)
	if scopePath == "" {
		return root, nil
	}
	return resolver.ensureFolderScopeGroup(scopePath)
}

func (resolver *nestedProjectGroupResolver) ensureRootGroup() (*ProjectGroup, error) {
	if resolver.mode != "group" {
		return nil, nil
	}
	if resolver.rootGroup != nil {
		return resolver.rootGroup, nil
	}
	groupName := resolver.groupName
	if groupName == "" {
		groupName = pathBase(resolver.parentPath)
	}
	parentPath := resolver.parentPath
	created, err := resolver.manager.CreateProjectGroup(CreateProjectGroupRequest{
		Name:         groupName,
		ParentPath:   &parentPath,
		ConnectionID: resolver.connectionID,
		CreatedFrom:  "folder-scan",
	})
	if err != nil {
		return nil, err
	}
	resolver.rootGroup = &created
	resolver.createdGroups = append(resolver.createdGroups, created)
	return resolver.rootGroup, nil
}

func (resolver *nestedProjectGroupResolver) ensureFolderScopeGroup(
	relativePath string,
) (*ProjectGroup, error) {
	if existing, ok := resolver.folderScopeGroups[relativePath]; ok {
		return &existing, nil
	}
	scope, ok := resolver.folderScopes[relativePath]
	if !ok {
		return resolver.ensureRootGroup()
	}
	root, err := resolver.ensureRootGroup()
	if err != nil || root == nil {
		return root, err
	}
	parentGroup := root
	if scope.parentRelativePath != nil {
		parentGroup, err = resolver.ensureFolderScopeGroup(*scope.parentRelativePath)
		if err != nil {
			return nil, err
		}
	}
	parentGroupID := parentGroup.ID
	parentPath := scope.folderPath
	created, err := resolver.manager.CreateProjectGroup(CreateProjectGroupRequest{
		Name:          scope.name,
		ParentPath:    &parentPath,
		ConnectionID:  resolver.connectionID,
		ParentGroupID: &parentGroupID,
		CreatedFrom:   "folder-scan",
	})
	if err != nil {
		return nil, err
	}
	resolver.folderScopeGroups[relativePath] = created
	resolver.createdGroups = append(resolver.createdGroups, created)
	return &created, nil
}

func (resolver *nestedProjectGroupResolver) getRootGroup() *ProjectGroup {
	return resolver.rootGroup
}

func (resolver *nestedProjectGroupResolver) getCreatedGroups() []ProjectGroup {
	return append([]ProjectGroup{}, resolver.createdGroups...)
}

func buildNestedFolderScopes(parentPath string, repoPaths []string) []nestedFolderScope {
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
		folderRelativePath := getNestedFolderRelativePathForRepo(parentPath, repoPath)
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
	for _, path := range meaningfulPaths {
		meaningfulSet[path] = struct{}{}
	}
	scopes := make([]nestedFolderScope, 0, len(meaningfulPaths))
	for _, relativePath := range meaningfulPaths {
		parentRelativePath := getNearestNestedScopePath(
			strings.Join(strings.Split(relativePath, "/")[:len(strings.Split(relativePath, "/"))-1], "/"),
			meaningfulSet,
		)
		var parent *string
		if parentRelativePath != "" {
			parent = &parentRelativePath
		}
		scopes = append(scopes, nestedFolderScope{
			relativePath:       relativePath,
			name:               relativePath,
			folderPath:         filepath.Join(parentPath, filepath.FromSlash(relativePath)),
			parentRelativePath: parent,
		})
	}
	return scopes
}

func getNestedFolderRelativePathForRepo(parentPath string, repoPath string) string {
	relativePath, err := filepath.Rel(parentPath, repoPath)
	if err != nil || relativePath == "." {
		return ""
	}
	relativePath = filepath.ToSlash(relativePath)
	if relativePath == ".." || strings.HasPrefix(relativePath, "../") {
		return ""
	}
	segments := strings.Split(normalizeNestedRelativePath(relativePath), "/")
	if len(segments) <= 1 {
		return ""
	}
	return strings.Join(segments[:len(segments)-1], "/")
}

func normalizeNestedRelativePath(value string) string {
	value = strings.ReplaceAll(value, "\\", "/")
	value = strings.Trim(value, "/")
	if value == "" {
		return ""
	}
	segments := strings.Split(value, "/")
	cleaned := make([]string, 0, len(segments))
	for _, segment := range segments {
		if segment != "" && segment != "." {
			cleaned = append(cleaned, segment)
		}
	}
	return strings.Join(cleaned, "/")
}

func getNearestNestedScopePath(relativePath string, scopePaths map[string]struct{}) string {
	segments := strings.Split(normalizeNestedRelativePath(relativePath), "/")
	for length := len(segments); length > 0; length-- {
		candidate := strings.Join(segments[:length], "/")
		if _, ok := scopePaths[candidate]; ok {
			return candidate
		}
	}
	return ""
}

func reverseProjectGroups(groups []ProjectGroup) []ProjectGroup {
	reversed := append([]ProjectGroup{}, groups...)
	for left, right := 0, len(reversed)-1; left < right; left, right = left+1, right-1 {
		reversed[left], reversed[right] = reversed[right], reversed[left]
	}
	return reversed
}

func (m *Manager) ListFolderWorkspaces() []FolderWorkspace {
	m.mu.RLock()
	defer m.mu.RUnlock()
	workspaces := make([]FolderWorkspace, 0, len(m.folderWorkspaces))
	for _, workspace := range m.folderWorkspaces {
		if _, ok := m.projectGroups[workspace.ProjectGroupID]; ok {
			workspaces = append(workspaces, workspace)
		}
	}
	sort.Slice(workspaces, func(i, j int) bool {
		if workspaces[i].SortOrder != workspaces[j].SortOrder {
			return workspaces[i].SortOrder > workspaces[j].SortOrder
		}
		return workspaces[i].Name < workspaces[j].Name
	})
	return workspaces
}

func (m *Manager) CreateFolderWorkspace(req CreateFolderWorkspaceRequest) (FolderWorkspace, error) {
	projectGroupID := strings.TrimSpace(req.ProjectGroupID)
	if projectGroupID == "" {
		return FolderWorkspace{}, errors.New("folder workspace project group is required")
	}
	m.mu.RLock()
	group, ok := m.projectGroups[projectGroupID]
	m.mu.RUnlock()
	if !ok {
		return FolderWorkspace{}, ErrNotFound
	}
	connectionID := cleanOptionalString(req.ConnectionID)
	if connectionID == nil {
		connectionID = group.ConnectionID
	}
	folderPath := strings.TrimSpace(optionalStringValue(req.FolderPath))
	if folderPath == "" {
		folderPath = optionalStringValue(group.ParentPath)
	}
	if folderPath == "" {
		return FolderWorkspace{}, ErrInvalidPath
	}
	normalizedPath, err := normalizeFolderWorkspacePath(folderPath, connectionID)
	if err != nil {
		return FolderWorkspace{}, err
	}
	status := folderWorkspacePathStatusForPath(normalizedPath, connectionID)
	if !status.Exists {
		return FolderWorkspace{}, errors.New("folder_workspace_path_" + status.Reason + ":" + normalizedPath)
	}
	now := time.Now().UTC().UnixMilli()
	workspace := FolderWorkspace{
		ID:                             newID("folder"),
		ProjectGroupID:                 projectGroupID,
		Name:                           normalizeProjectGroupName(req.Name, group.Name+" workspace"),
		FolderPath:                     normalizedPath,
		ConnectionID:                   connectionID,
		LinkedTask:                     normalizeFolderWorkspaceLinkedTask(req.LinkedTask),
		Comment:                        "",
		IsArchived:                     false,
		IsUnread:                       false,
		IsPinned:                       false,
		SortOrder:                      float64(now),
		CreatedWithAgent:               strings.TrimSpace(req.CreatedWithAgent),
		PendingFirstAgentMessageRename: req.PendingFirstAgentMessageRename && strings.TrimSpace(req.CreatedWithAgent) != "",
		LastActivityAt:                 0,
		CreatedAt:                      now,
		UpdatedAt:                      now,
	}
	m.mu.Lock()
	m.folderWorkspaces[workspace.ID] = workspace
	err = m.saveLocked()
	m.mu.Unlock()
	if err != nil {
		return FolderWorkspace{}, err
	}
	m.emit("folder-workspace.changed", workspace)
	m.emit("project.changed", map[string]interface{}{"folderWorkspace": workspace})
	return workspace, nil
}

func (m *Manager) UpdateFolderWorkspace(id string, update FolderWorkspaceUpdate) (FolderWorkspace, bool, error) {
	m.mu.Lock()
	workspace, ok := m.folderWorkspaces[id]
	if !ok {
		m.mu.Unlock()
		return FolderWorkspace{}, false, nil
	}
	if update.Name != nil {
		workspace.Name = normalizeProjectGroupName(*update.Name, workspace.Name)
	}
	if update.FolderPath != nil && strings.TrimSpace(*update.FolderPath) != "" {
		normalizedPath, err := normalizeFolderWorkspacePath(*update.FolderPath, workspace.ConnectionID)
		if err != nil {
			m.mu.Unlock()
			return FolderWorkspace{}, false, err
		}
		status := folderWorkspacePathStatusForPath(normalizedPath, workspace.ConnectionID)
		if !status.Exists {
			m.mu.Unlock()
			return FolderWorkspace{}, false, errors.New("folder_workspace_path_" + status.Reason + ":" + normalizedPath)
		}
		workspace.FolderPath = normalizedPath
	}
	if update.LinkedTask != nil {
		workspace.LinkedTask = decodeFolderWorkspaceLinkedTask(update.LinkedTask)
	}
	if update.Comment != nil {
		workspace.Comment = *update.Comment
	}
	if update.IsArchived != nil {
		workspace.IsArchived = *update.IsArchived
	}
	if update.IsUnread != nil {
		workspace.IsUnread = *update.IsUnread
	}
	if update.IsPinned != nil {
		workspace.IsPinned = *update.IsPinned
	}
	if update.SortOrder != nil && isFiniteFloat(*update.SortOrder) {
		workspace.SortOrder = *update.SortOrder
	}
	if update.ManualOrder != nil && isFiniteFloat(*update.ManualOrder) {
		order := *update.ManualOrder
		workspace.ManualOrder = &order
	}
	if update.WorkspaceStatus != nil {
		workspace.WorkspaceStatus = strings.TrimSpace(*update.WorkspaceStatus)
	}
	if update.CreatedWithAgent != nil {
		workspace.CreatedWithAgent = strings.TrimSpace(*update.CreatedWithAgent)
	}
	if update.PendingFirstAgentMessageRename != nil {
		workspace.PendingFirstAgentMessageRename = *update.PendingFirstAgentMessageRename
	}
	if update.FirstAgentMessageRenameError != nil {
		workspace.FirstAgentMessageRenameError = decodeOptionalString(update.FirstAgentMessageRenameError)
	}
	if update.LastActivityAt != nil && isFiniteFloat(*update.LastActivityAt) {
		workspace.LastActivityAt = int64(*update.LastActivityAt)
	}
	workspace.UpdatedAt = time.Now().UTC().UnixMilli()
	m.folderWorkspaces[id] = workspace
	err := m.saveLocked()
	m.mu.Unlock()
	if err != nil {
		return FolderWorkspace{}, false, err
	}
	m.emit("folder-workspace.changed", workspace)
	m.emit("project.changed", map[string]interface{}{"folderWorkspace": workspace})
	return workspace, true, nil
}

func (m *Manager) DeleteFolderWorkspace(id string) (bool, error) {
	m.mu.Lock()
	workspace, ok := m.folderWorkspaces[id]
	if !ok {
		m.mu.Unlock()
		return false, nil
	}
	delete(m.folderWorkspaces, id)
	removeWorkspaceLineageForFolderParentLocked(m.worktrees, id)
	err := m.saveLocked()
	m.mu.Unlock()
	if err != nil {
		return false, err
	}
	m.emit("folder-workspace.changed", map[string]interface{}{"deleted": workspace})
	m.emit("project.changed", map[string]interface{}{"folderWorkspaceDeleted": id})
	return true, nil
}

func (m *Manager) GetFolderWorkspacePathStatus(req FolderWorkspacePathStatusRequest) FolderWorkspacePathStatus {
	m.mu.RLock()
	defer m.mu.RUnlock()
	switch strings.TrimSpace(req.Scope) {
	case "folder-workspace":
		workspace, ok := m.folderWorkspaces[strings.TrimSpace(req.FolderWorkspaceID)]
		if !ok {
			return FolderWorkspacePathStatus{Path: "", Exists: false, Reason: "missing"}
		}
		return folderWorkspacePathStatusForPath(workspace.FolderPath, workspace.ConnectionID)
	case "project-group":
		group, ok := m.projectGroups[strings.TrimSpace(req.ProjectGroupID)]
		if !ok || group.ParentPath == nil {
			return FolderWorkspacePathStatus{Path: "", Exists: false, Reason: "missing"}
		}
		return folderWorkspacePathStatusForPath(*group.ParentPath, group.ConnectionID)
	case "path":
		return folderWorkspacePathStatusForPath(strings.TrimSpace(req.Path), cleanOptionalString(req.ConnectionID))
	default:
		return FolderWorkspacePathStatus{Path: "", Exists: false, Reason: "missing"}
	}
}

func normalizeProjectGroupName(name string, fallback string) string {
	trimmed := strings.TrimSpace(name)
	if trimmed != "" {
		return trimmed
	}
	if strings.TrimSpace(fallback) != "" {
		return strings.TrimSpace(fallback)
	}
	return "Untitled group"
}

func normalizeOptionalWorkspacePath(path *string, connectionID *string) (*string, error) {
	if path == nil || strings.TrimSpace(*path) == "" {
		return nil, nil
	}
	normalized, err := normalizeFolderWorkspacePath(*path, cleanOptionalString(connectionID))
	if err != nil {
		return nil, err
	}
	return &normalized, nil
}

func normalizeFolderWorkspacePath(path string, connectionID *string) (string, error) {
	path = strings.TrimSpace(path)
	if path == "" || !isAbsoluteForHost(path) {
		return "", ErrInvalidPath
	}
	if connectionID != nil && strings.TrimSpace(*connectionID) != "" {
		return path, nil
	}
	return normalizeLocalPath(path)
}

func folderWorkspacePathStatusForPath(path string, connectionID *string) FolderWorkspacePathStatus {
	path = strings.TrimSpace(path)
	if path == "" {
		return FolderWorkspacePathStatus{Path: path, Exists: false, Reason: "missing"}
	}
	if connectionID != nil && strings.TrimSpace(*connectionID) != "" {
		// SSH-owned folder checks must run on the remote runtime, not the desktop host.
		return FolderWorkspacePathStatus{Path: path, Exists: false, Reason: "unavailable"}
	}
	normalized, err := normalizeLocalPath(path)
	if err != nil {
		return FolderWorkspacePathStatus{Path: path, Exists: false, Reason: "missing"}
	}
	stat, err := os.Stat(normalized)
	if err != nil {
		if os.IsNotExist(err) {
			return FolderWorkspacePathStatus{Path: normalized, Exists: false, Reason: "missing"}
		}
		return FolderWorkspacePathStatus{Path: normalized, Exists: false, Reason: "unavailable"}
	}
	if !stat.IsDir() {
		return FolderWorkspacePathStatus{Path: normalized, Exists: false, Reason: "not-directory"}
	}
	return FolderWorkspacePathStatus{Path: normalized, Exists: true}
}

func cleanOptionalString(value *string) *string {
	if value == nil {
		return nil
	}
	trimmed := strings.TrimSpace(*value)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

func optionalStringValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func decodeOptionalString(raw json.RawMessage) *string {
	var value *string
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil
	}
	if value == nil {
		return nil
	}
	return cleanOptionalString(value)
}

func decodeFolderWorkspaceLinkedTask(raw json.RawMessage) *FolderWorkspaceLinkedTask {
	var value *FolderWorkspaceLinkedTask
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil
	}
	return normalizeFolderWorkspaceLinkedTask(value)
}

func normalizeFolderWorkspaceLinkedTask(value *FolderWorkspaceLinkedTask) *FolderWorkspaceLinkedTask {
	if value == nil {
		return nil
	}
	provider := strings.TrimSpace(value.Provider)
	if provider != "github" && provider != "gitlab" && provider != "linear" && provider != "jira" {
		return nil
	}
	taskType := strings.TrimSpace(value.Type)
	if taskType != "issue" && taskType != "pr" && taskType != "mr" {
		return nil
	}
	title := strings.TrimSpace(value.Title)
	url := strings.TrimSpace(value.URL)
	if !isFiniteFloat(value.Number) || title == "" || url == "" {
		return nil
	}
	return &FolderWorkspaceLinkedTask{
		Provider:         provider,
		Type:             taskType,
		Number:           value.Number,
		Title:            title,
		URL:              url,
		LinearIdentifier: strings.TrimSpace(value.LinearIdentifier),
		JiraIdentifier:   strings.TrimSpace(value.JiraIdentifier),
		RepoID:           strings.TrimSpace(value.RepoID),
	}
}

func projectGroupSubtreeIDsLocked(groups map[string]ProjectGroup, rootID string) map[string]struct{} {
	childrenByParent := make(map[string][]string)
	for _, group := range groups {
		if group.ParentGroupID != nil {
			childrenByParent[*group.ParentGroupID] = append(childrenByParent[*group.ParentGroupID], group.ID)
		}
	}
	result := map[string]struct{}{}
	pending := []string{rootID}
	for len(pending) > 0 {
		id := pending[len(pending)-1]
		pending = pending[:len(pending)-1]
		if _, ok := result[id]; ok {
			continue
		}
		result[id] = struct{}{}
		pending = append(pending, childrenByParent[id]...)
	}
	return result
}

func removeWorkspaceLineageForFolderParentLocked(worktrees map[string]Worktree, folderWorkspaceID string) {
	parentKey := "folder:" + strings.TrimSpace(folderWorkspaceID)
	for id, worktree := range worktrees {
		if worktree.WorkspaceLineage != nil && worktree.WorkspaceLineage.ParentWorkspaceKey == parentKey {
			worktree.WorkspaceLineage = nil
			worktrees[id] = worktree
		}
	}
}

func nextProjectGroupOrderLocked(projects map[string]Project, movingProjectID string, groupID *string) float64 {
	var maxOrder float64
	found := false
	for _, project := range projects {
		if project.ID == movingProjectID {
			continue
		}
		if !sameOptionalString(project.ProjectGroupID, groupID) || project.ProjectGroupOrder == nil {
			continue
		}
		if !found || *project.ProjectGroupOrder > maxOrder {
			maxOrder = *project.ProjectGroupOrder
			found = true
		}
	}
	if !found {
		return 0
	}
	return maxOrder + 1
}

func sameOptionalString(left *string, right *string) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

func normalizeRuntimeSelector(value string) string {
	value = strings.TrimSpace(value)
	return strings.TrimPrefix(value, "id:")
}

func isFiniteFloat(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0)
}
