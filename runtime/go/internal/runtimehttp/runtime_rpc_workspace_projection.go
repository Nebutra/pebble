package runtimehttp

import (
	"path/filepath"
	"strings"

	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
)

const runtimeRPCDefaultBadgeColor = "#737373"

func runtimeRPCProject(project runtimecore.Project) map[string]interface{} {
	displayName := strings.TrimSpace(project.Name)
	if displayName == "" {
		displayName = filepath.Base(filepath.Clean(project.Path))
	}
	executionHostID := "local"
	kind := "git"
	if project.Provider == "folder" {
		kind = "folder"
	}
	var connectionID interface{}
	if project.LocationKind == "ssh" && project.HostID != "" {
		executionHostID = "ssh:" + project.HostID
		connectionID = project.HostID
	}
	return map[string]interface{}{
		"id": project.ID, "path": project.Path, "displayName": displayName,
		"badgeColor": runtimeRPCDefaultBadgeColor, "addedAt": project.CreatedAt.UnixMilli(),
		"kind": kind, "connectionId": connectionID, "executionHostId": executionHostID,
		"projectGroupId": project.ProjectGroupID, "projectGroupOrder": project.ProjectGroupOrder,
		"projectHostSetupMethod": project.ProjectHostSetupMethod,
		"logicalProjectId":       project.LogicalProjectID, "worktreeBasePath": project.WorktreeBasePath,
		"gitUsername": project.GitUsername, "issueSourcePreference": project.IssueSourcePreference,
		"localWindowsRuntimePreference": project.LocalWindowsRuntimePreference,
	}
}

func runtimeRPCWorktree(worktree runtimecore.Worktree) map[string]interface{} {
	displayName := strings.TrimSpace(worktree.DisplayName)
	if displayName == "" {
		displayName = filepath.Base(filepath.Clean(worktree.Path))
	}
	createdAt := worktree.CreatedAt.UnixMilli()
	lastActivityAt := worktree.LastActivityAt
	if lastActivityAt == 0 {
		lastActivityAt = worktree.UpdatedAt.UnixMilli()
	}
	return map[string]interface{}{
		"id": worktree.ID, "instanceId": firstNonEmpty(worktree.InstanceID, worktree.ID),
		"repoId": worktree.ProjectID, "projectId": worktree.ProjectID,
		"hostId": "local", "projectHostSetupId": worktree.ProjectID,
		"path": worktree.Path, "head": "", "branch": worktree.Branch,
		"isBare": false, "isSparse": false, "isMainWorktree": false,
		"displayName": displayName, "comment": worktree.Comment,
		"linkedIssue": worktree.LinkedIssue, "linkedPR": worktree.LinkedPR,
		"linkedLinearIssue": worktree.LinkedLinearIssue,
		"isArchived":        worktree.IsArchived, "isUnread": worktree.IsUnread,
		"isPinned": worktree.IsPinned, "sortOrder": worktree.SortOrder,
		"manualOrder": worktree.ManualOrder, "lastActivityAt": lastActivityAt,
		"createdAt": createdAt, "workspaceStatus": worktree.WorkspaceStatus,
		"baseRef": worktree.Base, "lineage": worktree.Lineage,
		"sparseDirectories": worktree.SparseDirectories, "sparseBaseRef": worktree.SparseBaseRef,
		"sparsePresetId":                 worktree.SparsePresetID,
		"createdWithAgent":               worktree.CreatedWithAgent,
		"pendingFirstAgentMessageRename": worktree.PendingFirstAgentMessageRename,
		"automationProvenance":           worktree.AutomationProvenance,
	}
}

func runtimeRPCWorktreeCreateResult(worktree runtimecore.Worktree, lineage runtimecore.WorktreeLineageListResponse) map[string]interface{} {
	record := runtimeRPCWorktree(worktree)
	worktreeLineage, hasLineage := lineage.Lineage[worktree.ID]
	workspaceKey := "worktree:" + worktree.ID
	workspaceLineage, hasWorkspaceLineage := lineage.WorkspaceLineage[workspaceKey]
	children := make([]string, 0)
	for childID, candidate := range lineage.Lineage {
		if candidate.ParentWorktreeID == worktree.ID {
			children = append(children, childID)
		}
	}
	record["parentWorktreeId"] = nil
	record["childWorktreeIds"] = children
	record["lineage"] = nil
	record["workspaceLineage"] = nil
	if hasLineage {
		record["parentWorktreeId"] = worktreeLineage.ParentWorktreeID
		record["lineage"] = worktreeLineage
	}
	if hasWorkspaceLineage {
		record["workspaceLineage"] = workspaceLineage
	}
	record["git"] = map[string]interface{}{
		"path": worktree.Path, "head": "", "branch": worktree.Branch,
		"isBare": false, "isSparse": false, "isMainWorktree": false,
	}
	return map[string]interface{}{
		"worktree": record, "lineage": record["lineage"],
		"workspaceLineage": record["workspaceLineage"], "warnings": []interface{}{},
	}
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}
