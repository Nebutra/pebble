package runtimecore

import (
	"path/filepath"
	"testing"
	"time"
)

func TestReconcilePersistedProjectIdentitiesMigratesDuplicateLocalState(t *testing.T) {
	created := time.Date(2026, 7, 27, 1, 0, 0, 0, time.UTC)
	canonicalProjectID := "proj-old"
	duplicateProjectID := "proj-new"
	canonicalWorktreeID := "wt-old"
	duplicateWorktreeID := "wt-new"
	groupID := "group-1"
	repoPath := t.TempDir()
	state := persistedState{
		Projects: []Project{
			{
				ID: duplicateProjectID, Path: filepath.Join(repoPath, "."), LocationKind: "local", HostID: "local",
				LogicalProjectID: "logical-duplicate", GitUsername: "configured-user", ProjectGroupID: &groupID,
				CreatedAt: created.Add(time.Hour), UpdatedAt: created.Add(time.Hour),
			},
			{ID: canonicalProjectID, Path: repoPath, LocationKind: "local", LogicalProjectID: "logical-canonical", CreatedAt: created},
		},
		Worktrees: []Worktree{
			{ID: duplicateWorktreeID, ProjectID: duplicateProjectID, Path: repoPath, CreatedAt: created.Add(time.Hour)},
			{
				ID: canonicalWorktreeID, ProjectID: canonicalProjectID, Path: repoPath, CreatedAt: created,
				Lineage: &WorktreeLineage{WorktreeID: duplicateWorktreeID, ParentWorktreeID: duplicateWorktreeID},
				WorkspaceLineage: &WorkspaceLineage{
					ChildWorkspaceKey: "worktree:" + duplicateWorktreeID, ParentWorkspaceKey: "worktree:" + duplicateWorktreeID,
				},
			},
		},
		SparsePresets: []SparsePreset{{ID: "preset", RepoID: duplicateProjectID}},
		ProjectHostSetups: []ProjectHostSetup{{
			ID: "setup", ProjectID: "logical-duplicate", RepoID: duplicateProjectID,
		}},
		Settings: []RuntimeSetting{{
			ID: "setting", Scope: RuntimeSettingWorkspace, ProjectID: duplicateProjectID,
			WorkspaceID: duplicateWorktreeID, Key: "key",
		}},
		BrowserTabs: []BrowserTab{{
			ID: "tab", ProjectID: duplicateProjectID, WorktreeID: duplicateWorktreeID,
		}},
		SessionTabLayouts: []SessionTabLayout{
			{WorktreeID: duplicateWorktreeID, ActiveTabID: "duplicate-layout", UpdatedAt: created.Add(2 * time.Hour)},
			{WorktreeID: canonicalWorktreeID, ActiveTabID: "canonical-layout", UpdatedAt: created},
		},
	}

	if !reconcilePersistedProjectIdentities(&state) {
		t.Fatal("expected duplicate state migration")
	}
	if len(state.Projects) != 1 || state.Projects[0].ID != canonicalProjectID {
		t.Fatalf("unexpected projects: %#v", state.Projects)
	}
	if len(state.Worktrees) != 1 || state.Worktrees[0].ID != canonicalWorktreeID || state.Worktrees[0].ProjectID != canonicalProjectID {
		t.Fatalf("unexpected worktrees: %#v", state.Worktrees)
	}
	if state.SparsePresets[0].RepoID != canonicalProjectID || state.Settings[0].ProjectID != canonicalProjectID {
		t.Fatalf("project references were not migrated: %#v %#v", state.SparsePresets, state.Settings)
	}
	if state.ProjectHostSetups[0].ProjectID != "logical-canonical" || state.ProjectHostSetups[0].RepoID != canonicalProjectID {
		t.Fatalf("project host setup was not migrated: %#v", state.ProjectHostSetups)
	}
	if state.Projects[0].GitUsername != "configured-user" || state.Projects[0].ProjectGroupID == nil || *state.Projects[0].ProjectGroupID != groupID {
		t.Fatalf("duplicate project configuration was not preserved: %#v", state.Projects[0])
	}
	if state.Settings[0].WorkspaceID != canonicalWorktreeID || state.BrowserTabs[0].WorktreeID != canonicalWorktreeID {
		t.Fatalf("worktree references were not migrated: %#v %#v", state.Settings, state.BrowserTabs)
	}
	lineage := state.Worktrees[0].Lineage
	workspaceLineage := state.Worktrees[0].WorkspaceLineage
	if lineage.WorktreeID != canonicalWorktreeID || lineage.ParentWorktreeID != canonicalWorktreeID ||
		workspaceLineage.ChildWorkspaceKey != "worktree:"+canonicalWorktreeID || workspaceLineage.ParentWorkspaceKey != "worktree:"+canonicalWorktreeID {
		t.Fatalf("worktree lineage was not migrated: %#v %#v", lineage, workspaceLineage)
	}
	if len(state.SessionTabLayouts) != 1 || state.SessionTabLayouts[0].ActiveTabID != "canonical-layout" {
		t.Fatalf("canonical layout was not preserved: %#v", state.SessionTabLayouts)
	}
}

func TestReconcilePersistedProjectIdentitiesKeepsSeparateSshHosts(t *testing.T) {
	state := persistedState{Projects: []Project{
		{ID: "ssh-one", Path: "/srv/repo", LocationKind: "ssh", HostID: "host-one"},
		{ID: "ssh-two", Path: "/srv/repo", LocationKind: "ssh", HostID: "host-two"},
	}}

	if reconcilePersistedProjectIdentities(&state) {
		t.Fatal("projects on different SSH hosts must remain distinct")
	}
	if len(state.Projects) != 2 {
		t.Fatalf("unexpected projects: %#v", state.Projects)
	}
}
