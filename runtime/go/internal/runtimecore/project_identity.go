package runtimecore

import (
	"path/filepath"
	"sort"
	"strings"
)

type projectIdentity struct {
	locationKind string
	hostID       string
	path         string
}

func normalizedProjectIdentity(project Project) (projectIdentity, bool) {
	locationKind, err := normalizeProjectLocationKind(project.LocationKind, true)
	if err != nil {
		return projectIdentity{}, false
	}
	path := strings.TrimSpace(project.Path)
	hostID := strings.TrimSpace(project.HostID)
	if locationKind == "local" {
		path, err = normalizeLocalPath(path)
		if err != nil {
			return projectIdentity{}, false
		}
		// Why: persisted local projects have used both an empty host and the
		// explicit runtime host label; they represent the same filesystem owner.
		hostID = "local"
	}
	return projectIdentity{
		locationKind: locationKind,
		hostID:       hostID,
		path:         path,
	}, true
}

func (m *Manager) findProjectByIdentityLocked(identity projectIdentity) (Project, bool) {
	for _, project := range m.projects {
		existing, ok := normalizedProjectIdentity(project)
		if ok && existing == identity {
			return project, true
		}
	}
	return Project{}, false
}

func reconcilePersistedProjectIdentities(state *persistedState) bool {
	canonicalByIdentity := make(map[projectIdentity]Project)
	projectRemap := make(map[string]string)
	projectSelectorRemap := make(map[string]string)
	projects := append([]Project(nil), state.Projects...)
	sort.Slice(projects, func(i, j int) bool {
		if !projects[i].CreatedAt.Equal(projects[j].CreatedAt) {
			return projects[i].CreatedAt.Before(projects[j].CreatedAt)
		}
		return projects[i].ID < projects[j].ID
	})
	keptProjects := make([]Project, 0, len(projects))
	for _, project := range projects {
		identity, ok := normalizedProjectIdentity(project)
		if !ok {
			keptProjects = append(keptProjects, project)
			continue
		}
		if canonical, exists := canonicalByIdentity[identity]; exists {
			projectRemap[project.ID] = canonical.ID
			mergeProjectConfiguration(&canonical, project)
			duplicateSelector := logicalProjectSelector(project)
			canonicalSelector := logicalProjectSelector(canonical)
			if duplicateSelector != canonicalSelector {
				projectSelectorRemap[duplicateSelector] = canonicalSelector
			}
			canonicalByIdentity[identity] = canonical
			for index := range keptProjects {
				if keptProjects[index].ID == canonical.ID {
					keptProjects[index] = canonical
					break
				}
			}
			continue
		}
		canonicalByIdentity[identity] = project
		keptProjects = append(keptProjects, project)
	}
	if len(projectRemap) == 0 {
		return false
	}
	state.Projects = keptProjects
	remapPersistedProjectReferences(state, projectRemap, projectSelectorRemap)
	worktreeRemap := reconcilePersistedWorktrees(state)
	remapPersistedWorktreeReferences(state, worktreeRemap)
	return true
}

func logicalProjectSelector(project Project) string {
	if selector := strings.TrimSpace(project.LogicalProjectID); selector != "" {
		return selector
	}
	return "repo:" + project.ID
}

func mergeProjectConfiguration(canonical *Project, duplicate Project) {
	if canonical.Provider == "" {
		canonical.Provider = duplicate.Provider
	}
	if canonical.LogicalProjectID == "" {
		canonical.LogicalProjectID = duplicate.LogicalProjectID
	}
	if canonical.WorktreeBasePath == "" {
		canonical.WorktreeBasePath = duplicate.WorktreeBasePath
	}
	if canonical.GitUsername == "" {
		canonical.GitUsername = duplicate.GitUsername
	}
	if canonical.IssueSourcePreference == "" {
		canonical.IssueSourcePreference = duplicate.IssueSourcePreference
	}
	if canonical.ProjectHostSetupMethod == "" {
		canonical.ProjectHostSetupMethod = duplicate.ProjectHostSetupMethod
	}
	if canonical.ProjectGroupID == nil {
		canonical.ProjectGroupID = duplicate.ProjectGroupID
		canonical.ProjectGroupOrder = duplicate.ProjectGroupOrder
	}
	if canonical.LocalWindowsRuntimePreference == nil {
		canonical.LocalWindowsRuntimePreference = duplicate.LocalWindowsRuntimePreference
	}
	if duplicate.UpdatedAt.After(canonical.UpdatedAt) {
		canonical.UpdatedAt = duplicate.UpdatedAt
	}
}

func remapID(id string, replacements map[string]string) string {
	if replacement, ok := replacements[id]; ok {
		return replacement
	}
	return id
}

func remapProjectSelector(id string, replacements map[string]string, selectorReplacements map[string]string) string {
	if replacement, ok := selectorReplacements[id]; ok {
		return replacement
	}
	if replacement := remapID(id, replacements); replacement != id {
		return replacement
	}
	const repoPrefix = "repo:"
	if strings.HasPrefix(id, repoPrefix) {
		projectID := strings.TrimPrefix(id, repoPrefix)
		if replacement := remapID(projectID, replacements); replacement != projectID {
			return repoPrefix + replacement
		}
	}
	return id
}

func remapPersistedProjectReferences(
	state *persistedState,
	replacements map[string]string,
	selectorReplacements map[string]string,
) {
	for index := range state.Worktrees {
		worktree := &state.Worktrees[index]
		worktree.ProjectID = remapID(worktree.ProjectID, replacements)
		if worktree.AutomationProvenance != nil {
			worktree.AutomationProvenance.ProjectID = remapID(worktree.AutomationProvenance.ProjectID, replacements)
			worktree.AutomationProvenance.RepoID = remapID(worktree.AutomationProvenance.RepoID, replacements)
		}
	}
	for index := range state.ProjectHostSetups {
		state.ProjectHostSetups[index].ProjectID = remapProjectSelector(
			state.ProjectHostSetups[index].ProjectID,
			replacements,
			selectorReplacements,
		)
		state.ProjectHostSetups[index].RepoID = remapID(state.ProjectHostSetups[index].RepoID, replacements)
	}
	for index := range state.SparsePresets {
		state.SparsePresets[index].RepoID = remapID(state.SparsePresets[index].RepoID, replacements)
	}
	for index := range state.PreservedBranchCleanup {
		state.PreservedBranchCleanup[index].ProjectID = remapID(state.PreservedBranchCleanup[index].ProjectID, replacements)
	}
	for index := range state.AgentRuns {
		state.AgentRuns[index].ProjectID = remapID(state.AgentRuns[index].ProjectID, replacements)
	}
	for index := range state.ExternalWorkItems {
		state.ExternalWorkItems[index].ProjectID = remapID(state.ExternalWorkItems[index].ProjectID, replacements)
		state.ExternalWorkItems[index].RepositoryID = remapID(state.ExternalWorkItems[index].RepositoryID, replacements)
	}
	for index := range state.SourceControl {
		state.SourceControl[index].RepositoryID = remapID(state.SourceControl[index].RepositoryID, replacements)
	}
	for index := range state.RemoteFileTrees {
		state.RemoteFileTrees[index].ProjectID = remapID(state.RemoteFileTrees[index].ProjectID, replacements)
	}
	for index := range state.RemoteFileContents {
		state.RemoteFileContents[index].ProjectID = remapID(state.RemoteFileContents[index].ProjectID, replacements)
	}
	for index := range state.Settings {
		state.Settings[index].ProjectID = remapID(state.Settings[index].ProjectID, replacements)
	}
	for index := range state.BrowserTabs {
		state.BrowserTabs[index].ProjectID = remapID(state.BrowserTabs[index].ProjectID, replacements)
	}
	for index := range state.EmulatorSessions {
		state.EmulatorSessions[index].ProjectID = remapID(state.EmulatorSessions[index].ProjectID, replacements)
	}
	for index := range state.FolderWorkspaces {
		if state.FolderWorkspaces[index].LinkedTask != nil {
			state.FolderWorkspaces[index].LinkedTask.RepoID = remapID(state.FolderWorkspaces[index].LinkedTask.RepoID, replacements)
		}
	}
}

func reconcilePersistedWorktrees(state *persistedState) map[string]string {
	type worktreeIdentity struct {
		projectID string
		path      string
	}
	projectByID := make(map[string]Project, len(state.Projects))
	for _, project := range state.Projects {
		projectByID[project.ID] = project
	}
	worktrees := append([]Worktree(nil), state.Worktrees...)
	sort.Slice(worktrees, func(i, j int) bool {
		if !worktrees[i].CreatedAt.Equal(worktrees[j].CreatedAt) {
			return worktrees[i].CreatedAt.Before(worktrees[j].CreatedAt)
		}
		return worktrees[i].ID < worktrees[j].ID
	})
	canonicalByIdentity := make(map[worktreeIdentity]Worktree)
	replacements := make(map[string]string)
	kept := make([]Worktree, 0, len(worktrees))
	for _, worktree := range worktrees {
		path := strings.TrimSpace(worktree.Path)
		project, ok := projectByID[worktree.ProjectID]
		if ok && project.LocationKind != "ssh" {
			if normalized, err := normalizeLocalPath(path); err == nil {
				path = filepath.Clean(normalized)
			}
		}
		identity := worktreeIdentity{projectID: worktree.ProjectID, path: path}
		if canonical, exists := canonicalByIdentity[identity]; exists {
			replacements[worktree.ID] = canonical.ID
			continue
		}
		canonicalByIdentity[identity] = worktree
		kept = append(kept, worktree)
	}
	state.Worktrees = kept
	return replacements
}

func remapPersistedWorktreeReferences(state *persistedState, replacements map[string]string) {
	if len(replacements) == 0 {
		return
	}
	for index := range state.Worktrees {
		worktree := &state.Worktrees[index]
		if worktree.Lineage != nil {
			worktree.Lineage.WorktreeID = remapID(worktree.Lineage.WorktreeID, replacements)
			worktree.Lineage.ParentWorktreeID = remapID(worktree.Lineage.ParentWorktreeID, replacements)
		}
		if worktree.WorkspaceLineage != nil {
			worktree.WorkspaceLineage.ChildWorkspaceKey = remapWorktreeWorkspaceKey(worktree.WorkspaceLineage.ChildWorkspaceKey, replacements)
			worktree.WorkspaceLineage.ParentWorkspaceKey = remapWorktreeWorkspaceKey(worktree.WorkspaceLineage.ParentWorkspaceKey, replacements)
		}
	}
	for index := range state.PreservedBranchCleanup {
		state.PreservedBranchCleanup[index].WorktreeID = remapID(state.PreservedBranchCleanup[index].WorktreeID, replacements)
	}
	for index := range state.AgentRuns {
		state.AgentRuns[index].WorktreeID = remapID(state.AgentRuns[index].WorktreeID, replacements)
	}
	for index := range state.ExternalWorkItems {
		state.ExternalWorkItems[index].WorkspaceID = remapID(state.ExternalWorkItems[index].WorkspaceID, replacements)
	}
	for index := range state.SourceControl {
		state.SourceControl[index].WorkspaceID = remapID(state.SourceControl[index].WorkspaceID, replacements)
	}
	for index := range state.RemoteFileTrees {
		state.RemoteFileTrees[index].WorktreeID = remapID(state.RemoteFileTrees[index].WorktreeID, replacements)
	}
	for index := range state.RemoteFileContents {
		state.RemoteFileContents[index].WorktreeID = remapID(state.RemoteFileContents[index].WorktreeID, replacements)
	}
	for index := range state.Settings {
		state.Settings[index].WorkspaceID = remapID(state.Settings[index].WorkspaceID, replacements)
	}
	for index := range state.BrowserTabs {
		state.BrowserTabs[index].WorktreeID = remapID(state.BrowserTabs[index].WorktreeID, replacements)
	}
	for index := range state.EmulatorSessions {
		state.EmulatorSessions[index].WorktreeID = remapID(state.EmulatorSessions[index].WorktreeID, replacements)
	}
	layouts := make(map[string]SessionTabLayout, len(state.SessionTabLayouts))
	for _, layout := range state.SessionTabLayouts {
		originalWorktreeID := layout.WorktreeID
		layout.WorktreeID = remapID(originalWorktreeID, replacements)
		if _, ok := layouts[layout.WorktreeID]; !ok {
			layouts[layout.WorktreeID] = layout
			continue
		}
		if originalWorktreeID == layout.WorktreeID {
			layouts[layout.WorktreeID] = layout
		}
	}
	state.SessionTabLayouts = state.SessionTabLayouts[:0]
	for _, layout := range layouts {
		state.SessionTabLayouts = append(state.SessionTabLayouts, layout)
	}
}

func remapWorktreeWorkspaceKey(key string, replacements map[string]string) string {
	const worktreePrefix = "worktree:"
	if !strings.HasPrefix(key, worktreePrefix) {
		return key
	}
	worktreeID := strings.TrimPrefix(key, worktreePrefix)
	return worktreePrefix + remapID(worktreeID, replacements)
}
