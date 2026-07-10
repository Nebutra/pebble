package runtimecore

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestProjectPersistence(t *testing.T) {
	dir := t.TempDir()
	manager, err := NewManager(dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	project, err := manager.CreateProject(CreateProjectRequest{Name: "repo", Path: dir})
	if err != nil {
		t.Fatal(err)
	}
	reloaded, err := NewManager(dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	projects := reloaded.ListProjects()
	if len(projects) != 1 {
		t.Fatalf("expected 1 project, got %d", len(projects))
	}
	if projects[0].ID != project.ID {
		t.Fatalf("expected project %s, got %s", project.ID, projects[0].ID)
	}
}

func TestProjectGroupsAndFolderWorkspacesPersist(t *testing.T) {
	storeDir := t.TempDir()
	folderPath := t.TempDir()
	manager, err := NewManager(storeDir, nil)
	if err != nil {
		t.Fatal(err)
	}
	group, err := manager.CreateProjectGroup(CreateProjectGroupRequest{
		Name:        " Platform ",
		ParentPath:  &folderPath,
		CreatedFrom: "manual",
	})
	if err != nil {
		t.Fatal(err)
	}
	if group.Name != "Platform" || group.ParentPath == nil || *group.ParentPath != folderPath {
		t.Fatalf("unexpected project group: %#v", group)
	}
	status := manager.GetFolderWorkspacePathStatus(FolderWorkspacePathStatusRequest{
		Scope:          "project-group",
		ProjectGroupID: group.ID,
	})
	if !status.Exists || status.Path != folderPath {
		t.Fatalf("expected usable folder path, got %#v", status)
	}
	workspace, err := manager.CreateFolderWorkspace(CreateFolderWorkspaceRequest{
		ProjectGroupID: group.ID,
		Name:           " Feature Area ",
		LinkedTask: &FolderWorkspaceLinkedTask{
			Provider: "github",
			Type:     "issue",
			Number:   7,
			Title:    "Build it",
			URL:      "https://example.test/7",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if workspace.Name != "Feature Area" || workspace.FolderPath != folderPath || workspace.LinkedTask == nil {
		t.Fatalf("unexpected folder workspace: %#v", workspace)
	}
	comment := "ready"
	pinned := true
	manualOrder := 42.0
	updated, ok, err := manager.UpdateFolderWorkspace(workspace.ID, FolderWorkspaceUpdate{
		Comment:     &comment,
		IsPinned:    &pinned,
		ManualOrder: &manualOrder,
		LinkedTask:  json.RawMessage(`null`),
	})
	if err != nil {
		t.Fatal(err)
	}
	if !ok || updated.Comment != comment || !updated.IsPinned || updated.ManualOrder == nil || updated.LinkedTask != nil {
		t.Fatalf("unexpected folder workspace update: %#v", updated)
	}
	project, err := manager.CreateProject(CreateProjectRequest{Name: "repo", Path: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	moved, err := manager.MoveProjectToGroup(MoveProjectToGroupRequest{
		ProjectID: project.ID,
		GroupID:   &group.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if moved.ProjectGroupID == nil || *moved.ProjectGroupID != group.ID || moved.ProjectGroupOrder == nil {
		t.Fatalf("expected project group metadata on project: %#v", moved)
	}
	reopened, err := NewManager(storeDir, nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := reopened.ListProjectGroups(); len(got) != 1 || got[0].ID != group.ID {
		t.Fatalf("expected persisted project group, got %#v", got)
	}
	if got := reopened.ListFolderWorkspaces(); len(got) != 1 || got[0].Comment != comment {
		t.Fatalf("expected persisted folder workspace, got %#v", got)
	}
	reloadedProjects := reopened.ListProjects()
	if len(reloadedProjects) != 1 || reloadedProjects[0].ProjectGroupID == nil {
		t.Fatalf("expected persisted project group membership, got %#v", reloadedProjects)
	}
}

func TestNestedRepoScanAndImport(t *testing.T) {
	parentPath := t.TempDir()
	apiPath := filepath.Join(parentPath, "services", "api")
	webPath := filepath.Join(parentPath, "services", "web")
	cliPath := filepath.Join(parentPath, "tools", "cli")
	ignoredPath := filepath.Join(parentPath, "ignored-by-rule", "repo")
	nodeModulesPath := filepath.Join(parentPath, "node_modules", "ignored")
	createGitMarker(t, apiPath)
	createGitMarker(t, webPath)
	createGitMarker(t, cliPath)
	createGitMarker(t, ignoredPath)
	createGitMarker(t, nodeModulesPath)
	if err := os.WriteFile(filepath.Join(parentPath, ".gitignore"), []byte("ignored-by-rule\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	scan, err := manager.ScanNestedRepos(context.Background(), NestedRepoScanRequest{
		Path:    parentPath,
		Options: NestedRepoScanOptions{MaxDepth: floatPointer(4)},
	})
	if err != nil {
		t.Fatal(err)
	}
	scannedPaths := map[string]struct{}{}
	for _, repo := range scan.Repos {
		scannedPaths[repo.Path] = struct{}{}
	}
	for _, path := range []string{apiPath, webPath, cliPath} {
		if _, ok := scannedPaths[path]; !ok {
			t.Fatalf("expected scan to include %s, got %#v", path, scan.Repos)
		}
	}
	for _, path := range []string{ignoredPath, nodeModulesPath} {
		if _, ok := scannedPaths[path]; ok {
			t.Fatalf("expected scan to skip %s, got %#v", path, scan.Repos)
		}
	}
	result, err := manager.ImportNestedRepos(context.Background(), ProjectGroupImportNestedRequest{
		ParentPath:   parentPath,
		GroupName:    "Platform",
		ProjectPaths: []string{apiPath, webPath, cliPath},
		Mode:         "group",
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Group == nil || result.Group.Name != "Platform" {
		t.Fatalf("expected root group, got %#v", result.Group)
	}
	if result.ImportedCount != 3 || result.AlreadyKnownCount != 0 || result.FailedCount != 0 {
		t.Fatalf("unexpected import result: %#v", result)
	}
	groups := manager.ListProjectGroups()
	if len(groups) != 2 {
		t.Fatalf("expected root and services groups, got %#v", groups)
	}
	var servicesGroup *ProjectGroup
	for index := range groups {
		if groups[index].Name == "services" {
			servicesGroup = &groups[index]
		}
	}
	if servicesGroup == nil || servicesGroup.ParentGroupID == nil || *servicesGroup.ParentGroupID != result.Group.ID {
		t.Fatalf("expected services subgroup under root, got %#v", groups)
	}
	projects := manager.ListProjects()
	if len(projects) != 3 {
		t.Fatalf("expected imported projects, got %#v", projects)
	}
	secondResult, err := manager.ImportNestedRepos(context.Background(), ProjectGroupImportNestedRequest{
		ParentPath:   parentPath,
		ProjectPaths: []string{apiPath, webPath, cliPath},
		Mode:         "separate",
	})
	if err != nil {
		t.Fatal(err)
	}
	if secondResult.ImportedCount != 0 || secondResult.AlreadyKnownCount != 3 || secondResult.FailedCount != 0 {
		t.Fatalf("expected already-known on second import, got %#v", secondResult)
	}
}

func createGitMarker(t *testing.T, repoPath string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(repoPath, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
}

func TestProjectUpdateDeleteRemovesWorktrees(t *testing.T) {
	dir := t.TempDir()
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	project, err := manager.CreateProject(CreateProjectRequest{Name: "repo", Path: dir})
	if err != nil {
		t.Fatal(err)
	}
	updated, err := manager.UpdateProject(project.ID, UpdateProjectRequest{Name: "renamed"})
	if err != nil {
		t.Fatal(err)
	}
	if updated.Name != "renamed" {
		t.Fatalf("project was not updated: %#v", updated)
	}
	worktree, err := manager.CreateWorktree(context.Background(), CreateWorktreeRequest{
		ProjectID: project.ID,
		Path:      t.TempDir(),
		Branch:    "feature",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.DeleteWorktree(context.Background(), worktree.ID, DeleteWorktreeRequest{}); err != nil {
		t.Fatal(err)
	}
	if got := manager.ListWorktrees(project.ID); len(got) != 0 {
		t.Fatalf("worktree was not deleted: %#v", got)
	}
	worktree, err = manager.CreateWorktree(context.Background(), CreateWorktreeRequest{
		ProjectID: project.ID,
		Path:      t.TempDir(),
		Branch:    "feature-2",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.DeleteProject(project.ID); err != nil {
		t.Fatal(err)
	}
	if got := manager.ListProjects(); len(got) != 0 {
		t.Fatalf("project was not deleted: %#v", got)
	}
	if got := manager.ListWorktrees(""); len(got) != 0 || worktree.ID == "" {
		t.Fatalf("project delete should remove worktrees: %#v", got)
	}
}

func TestDeleteWorktreeCanExecuteGitRemove(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git executable is not available")
	}
	repo := t.TempDir()
	runGitCommand(t, repo, "init")
	runGitCommand(t, repo, "config", "user.email", "dev@example.test")
	runGitCommand(t, repo, "config", "user.name", "Dev")
	if err := os.WriteFile(filepath.Join(repo, "README.md"), []byte("one\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	runGitCommand(t, repo, "add", "README.md")
	runGitCommand(t, repo, "commit", "-m", "init")

	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	project, err := manager.CreateProject(CreateProjectRequest{Name: "repo", Path: repo})
	if err != nil {
		t.Fatal(err)
	}
	worktreePath := filepath.Join(t.TempDir(), "feature-worktree")
	worktree, err := manager.CreateWorktree(context.Background(), CreateWorktreeRequest{
		ProjectID:  project.ID,
		Path:       worktreePath,
		Branch:     "feature/git-remove",
		Base:       "HEAD",
		ExecuteGit: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(worktreePath); err != nil {
		t.Fatalf("expected git worktree directory to exist: %v", err)
	}
	deleted, err := manager.DeleteWorktree(context.Background(), worktree.ID, DeleteWorktreeRequest{
		ExecuteGit: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(worktreePath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("expected git worktree directory to be removed, got %v", err)
	}
	if got := manager.ListWorktrees(project.ID); len(got) != 0 {
		t.Fatalf("worktree record was not deleted: %#v", got)
	}
	// The branch had no unmerged work (created off HEAD), so it is safe-deleted
	// and nothing is preserved.
	if deleted.PreservedBranch != nil {
		t.Fatalf("expected no preserved branch, got %#v", deleted.PreservedBranch)
	}
	branches := gitBranchNames(t, repo)
	if slices.Contains(branches, "feature/git-remove") {
		t.Fatalf("expected merged branch to be deleted, branches=%v", branches)
	}
}

func gitBranchNames(t *testing.T, repo string) []string {
	t.Helper()
	cmd := exec.Command("git", "-C", repo, "for-each-ref", "--format=%(refname:short)", "refs/heads")
	cmd.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1")
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git for-each-ref failed: %v\n%s", err, output)
	}
	var names []string
	for _, line := range strings.Split(strings.TrimSpace(string(output)), "\n") {
		if trimmed := strings.TrimSpace(line); trimmed != "" {
			names = append(names, trimmed)
		}
	}
	return names
}

func newGitBackedProject(t *testing.T) (*Manager, Project, string) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git executable is not available")
	}
	repo := t.TempDir()
	runGitCommand(t, repo, "init")
	runGitCommand(t, repo, "config", "user.email", "dev@example.test")
	runGitCommand(t, repo, "config", "user.name", "Dev")
	if err := os.WriteFile(filepath.Join(repo, "README.md"), []byte("one\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	runGitCommand(t, repo, "add", "README.md")
	runGitCommand(t, repo, "commit", "-m", "init")
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	project, err := manager.CreateProject(CreateProjectRequest{Name: "repo", Path: repo})
	if err != nil {
		t.Fatal(err)
	}
	return manager, project, repo
}

func TestDeleteWorktreePreservesBranchWithUnmergedCommits(t *testing.T) {
	manager, project, repo := newGitBackedProject(t)
	worktreePath := filepath.Join(t.TempDir(), "feature-worktree")
	worktree, err := manager.CreateWorktree(context.Background(), CreateWorktreeRequest{
		ProjectID:  project.ID,
		Path:       worktreePath,
		Branch:     "feature/unmerged",
		Base:       "HEAD",
		ExecuteGit: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	// Add a commit only on the feature branch so `git branch -d` refuses to drop it.
	if err := os.WriteFile(filepath.Join(worktreePath, "work.txt"), []byte("wip\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	runGitCommand(t, worktreePath, "add", "work.txt")
	runGitCommand(t, worktreePath, "commit", "-m", "wip")

	deleted, err := manager.DeleteWorktree(context.Background(), worktree.ID, DeleteWorktreeRequest{
		ExecuteGit: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if deleted.PreservedBranch == nil {
		t.Fatal("expected the unmerged branch to be preserved")
	}
	if deleted.PreservedBranch.BranchName != "feature/unmerged" {
		t.Fatalf("unexpected preserved branch: %#v", deleted.PreservedBranch)
	}
	if deleted.PreservedBranch.Head == "" {
		t.Fatal("expected preserved branch head to be captured")
	}
	if branches := gitBranchNames(t, repo); !slices.Contains(branches, "feature/unmerged") {
		t.Fatalf("preserved branch should still exist, branches=%v", branches)
	}

	// Force-delete the preserved branch with the captured head.
	result, err := manager.ForceDeletePreservedBranch(context.Background(), ForceDeletePreservedBranchRequest{
		ProjectID:    project.ID,
		BranchName:   deleted.PreservedBranch.BranchName,
		ExpectedHead: deleted.PreservedBranch.Head,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Deleted {
		t.Fatal("expected force delete to report deleted")
	}
	if branches := gitBranchNames(t, repo); slices.Contains(branches, "feature/unmerged") {
		t.Fatalf("preserved branch should be gone after force delete, branches=%v", branches)
	}
}

func TestForceDeletePreservedBranchRejectsMissingBranch(t *testing.T) {
	manager, project, _ := newGitBackedProject(t)
	_, err := manager.ForceDeletePreservedBranch(context.Background(), ForceDeletePreservedBranchRequest{
		ProjectID:  project.ID,
		BranchName: "does/not/exist",
	})
	if !errors.Is(err, ErrBranchNotFound) {
		t.Fatalf("expected ErrBranchNotFound, got %v", err)
	}
}

func TestForceDeletePreservedBranchRejectsStaleHead(t *testing.T) {
	manager, project, repo := newGitBackedProject(t)
	runGitCommand(t, repo, "branch", "keep/me")
	_, err := manager.ForceDeletePreservedBranch(context.Background(), ForceDeletePreservedBranchRequest{
		ProjectID:    project.ID,
		BranchName:   "keep/me",
		ExpectedHead: "1111111111111111111111111111111111111111",
	})
	if err == nil {
		t.Fatal("expected stale-head force delete to be rejected")
	}
	if branches := gitBranchNames(t, repo); !slices.Contains(branches, "keep/me") {
		t.Fatalf("branch must survive a rejected stale-head delete, branches=%v", branches)
	}
}

func TestProjectSortOrderPersists(t *testing.T) {
	dir := t.TempDir()
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	first, err := manager.CreateProject(CreateProjectRequest{Name: "first", Path: dir})
	if err != nil {
		t.Fatal(err)
	}
	second, err := manager.CreateProject(CreateProjectRequest{Name: "second", Path: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	if err := manager.PersistProjectSortOrder([]string{second.ID, first.ID}); err != nil {
		t.Fatal(err)
	}
	projects := manager.ListProjects()
	if len(projects) != 2 || projects[0].ID != second.ID || projects[1].ID != first.ID {
		t.Fatalf("project order was not persisted: %#v", projects)
	}
}

func TestWorktreeLineageSetListAndClear(t *testing.T) {
	dir := t.TempDir()
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	project, err := manager.CreateProject(CreateProjectRequest{Name: "repo", Path: dir})
	if err != nil {
		t.Fatal(err)
	}
	parent, err := manager.CreateWorktree(context.Background(), CreateWorktreeRequest{
		ProjectID: project.ID,
		Path:      t.TempDir(),
		Branch:    "parent",
	})
	if err != nil {
		t.Fatal(err)
	}
	child, err := manager.CreateWorktree(context.Background(), CreateWorktreeRequest{
		ProjectID: project.ID,
		Path:      t.TempDir(),
		Branch:    "child",
	})
	if err != nil {
		t.Fatal(err)
	}
	updated, err := manager.UpdateWorktree(child.ID, UpdateWorktreeRequest{
		ParentWorktreeID: parent.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if updated.Lineage == nil || updated.Lineage.ParentWorktreeID != parent.ID {
		t.Fatalf("lineage was not stored: %#v", updated.Lineage)
	}
	lineage := manager.ListWorktreeLineage()
	if got := lineage.Lineage[child.ID]; got.ParentWorktreeID != parent.ID {
		t.Fatalf("lineage list missed child: %#v", lineage)
	}
	if got := lineage.WorkspaceLineage["worktree:"+child.ID]; got.ParentWorkspaceKey != "worktree:"+parent.ID {
		t.Fatalf("workspace lineage list missed child: %#v", lineage.WorkspaceLineage)
	}
	if _, err := manager.UpdateWorktree(parent.ID, UpdateWorktreeRequest{
		ParentWorktreeID: child.ID,
	}); err == nil {
		t.Fatal("expected lineage cycle to be rejected")
	}
	cleared, err := manager.UpdateWorktree(child.ID, UpdateWorktreeRequest{NoParent: true})
	if err != nil {
		t.Fatal(err)
	}
	if cleared.Lineage != nil {
		t.Fatalf("lineage was not cleared: %#v", cleared.Lineage)
	}
	if got := manager.ListWorktreeLineage(); len(got.Lineage) != 0 || len(got.WorkspaceLineage) != 0 {
		t.Fatalf("expected no lineage after clear, got %#v", got)
	}
	updated, err = manager.UpdateWorktree(child.ID, UpdateWorktreeRequest{
		ParentWorkspace: "folder:folder-1",
		Origin:          "cli",
		Capture: WorktreeLineageCapture{
			Source:     "explicit-cli-flag",
			Confidence: "explicit",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if updated.Lineage != nil {
		t.Fatalf("folder parent should not create worktree lineage: %#v", updated.Lineage)
	}
	if updated.WorkspaceLineage == nil || updated.WorkspaceLineage.ParentWorkspaceKey != "folder:folder-1" {
		t.Fatalf("workspace lineage was not stored: %#v", updated.WorkspaceLineage)
	}
	if got := manager.ListWorktreeLineage(); len(got.Lineage) != 0 || got.WorkspaceLineage["worktree:"+child.ID].ParentWorkspaceKey != "folder:folder-1" {
		t.Fatalf("folder workspace lineage list mismatch: %#v", got)
	}
}

func TestWorktreeMetadataAndSortOrderPersist(t *testing.T) {
	dir := t.TempDir()
	storeDir := t.TempDir()
	manager, err := NewManager(storeDir, nil)
	if err != nil {
		t.Fatal(err)
	}
	project, err := manager.CreateProject(CreateProjectRequest{Name: "repo", Path: dir})
	if err != nil {
		t.Fatal(err)
	}
	first, err := manager.CreateWorktree(context.Background(), CreateWorktreeRequest{
		ProjectID: project.ID,
		Path:      t.TempDir(),
		Branch:    "first",
	})
	if err != nil {
		t.Fatal(err)
	}
	second, err := manager.CreateWorktree(context.Background(), CreateWorktreeRequest{
		ProjectID: project.ID,
		Path:      t.TempDir(),
		Branch:    "second",
	})
	if err != nil {
		t.Fatal(err)
	}
	displayName := "Readable name"
	comment := "keep this note"
	manualOrder := int64(42)
	linkedIssue := json.RawMessage("101")
	linkedPR := json.RawMessage("202")
	linkedLinearIssue := json.RawMessage(`"ENG-303"`)
	updated, err := manager.UpdateWorktree(first.ID, UpdateWorktreeRequest{
		DisplayName:       &displayName,
		Comment:           &comment,
		ManualOrder:       &manualOrder,
		LinkedIssue:       &linkedIssue,
		LinkedPR:          &linkedPR,
		LinkedLinearIssue: &linkedLinearIssue,
	})
	if err != nil {
		t.Fatal(err)
	}
	if updated.DisplayName != displayName || updated.Comment != comment || updated.ManualOrder == nil || *updated.ManualOrder != manualOrder {
		t.Fatalf("metadata was not stored: %#v", updated)
	}
	if updated.LinkedIssue == nil || *updated.LinkedIssue != 101 ||
		updated.LinkedPR == nil || *updated.LinkedPR != 202 ||
		updated.LinkedLinearIssue == nil || *updated.LinkedLinearIssue != "ENG-303" {
		t.Fatalf("linked references were not stored: %#v", updated)
	}
	// An explicit null clears the link; an absent field leaves it untouched.
	clear := json.RawMessage("null")
	cleared, err := manager.UpdateWorktree(first.ID, UpdateWorktreeRequest{LinkedIssue: &clear})
	if err != nil {
		t.Fatal(err)
	}
	if cleared.LinkedIssue != nil {
		t.Fatalf("expected linkedIssue cleared: %#v", cleared)
	}
	if cleared.LinkedPR == nil || *cleared.LinkedPR != 202 {
		t.Fatalf("expected linkedPR untouched by absent field: %#v", cleared)
	}
	if err := manager.PersistWorktreeSortOrder([]string{second.ID, first.ID}); err != nil {
		t.Fatal(err)
	}
	worktrees := manager.ListWorktrees(project.ID)
	byID := map[string]Worktree{}
	for _, worktree := range worktrees {
		byID[worktree.ID] = worktree
	}
	if byID[second.ID].SortOrder <= byID[first.ID].SortOrder {
		t.Fatalf("expected second to have higher sort order: %#v", byID)
	}
	// Reopening the store must recover the persisted link references.
	reopened, err := NewManager(storeDir, nil)
	if err != nil {
		t.Fatal(err)
	}
	reloaded := map[string]Worktree{}
	for _, worktree := range reopened.ListWorktrees(project.ID) {
		reloaded[worktree.ID] = worktree
	}
	got := reloaded[first.ID]
	if got.LinkedIssue != nil {
		t.Fatalf("expected cleared linkedIssue to persist as nil: %#v", got)
	}
	if got.LinkedPR == nil || *got.LinkedPR != 202 {
		t.Fatalf("expected linkedPR to persist across reload: %#v", got)
	}
	if got.LinkedLinearIssue == nil || *got.LinkedLinearIssue != "ENG-303" {
		t.Fatalf("expected linkedLinearIssue to persist across reload: %#v", got)
	}
}

func TestProjectLocationKindValidation(t *testing.T) {
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.CreateProject(CreateProjectRequest{Name: "repo", Path: t.TempDir(), LocationKind: "sssh"}); err == nil {
		t.Fatal("expected invalid project location kind to be rejected")
	}
	if _, err := manager.CreateProject(CreateProjectRequest{Name: "repo", Path: "/repo", LocationKind: "ssh"}); err == nil {
		t.Fatal("expected ssh project without host id to be rejected")
	}
	project, err := manager.CreateProject(CreateProjectRequest{Name: "repo", Path: "/repo", LocationKind: "ssh", HostID: "host-1"})
	if err != nil {
		t.Fatal(err)
	}
	if project.LocationKind != "ssh" {
		t.Fatalf("expected ssh project, got %#v", project)
	}
	if _, err := manager.UpdateProject(project.ID, UpdateProjectRequest{LocationKind: "remote-ish"}); err == nil {
		t.Fatal("expected invalid project location update to be rejected")
	}
	localProject, err := manager.CreateProject(CreateProjectRequest{Name: "local", Path: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.UpdateProject(localProject.ID, UpdateProjectRequest{LocationKind: "ssh"}); err == nil {
		t.Fatal("expected local to ssh update without host id to be rejected")
	}
	updated, err := manager.UpdateProject(localProject.ID, UpdateProjectRequest{LocationKind: "ssh", HostID: "host-2"})
	if err != nil {
		t.Fatal(err)
	}
	if updated.LocationKind != "ssh" || updated.HostID != "host-2" {
		t.Fatalf("expected ssh project update with host id, got %#v", updated)
	}
}

func TestTaskPersistence(t *testing.T) {
	dir := t.TempDir()
	manager, err := NewManager(dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	task, err := manager.CreateTask(CreateTaskRequest{Title: "port orchestration"})
	if err != nil {
		t.Fatal(err)
	}
	if task.Status != TaskReady {
		t.Fatalf("expected ready task, got %s", task.Status)
	}
	reloaded, err := NewManager(dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	tasks := reloaded.ListTasks()
	if len(tasks) != 1 || tasks[0].ID != task.ID {
		t.Fatalf("task was not persisted: %#v", tasks)
	}
}

func TestMessagesAndDispatchesPersist(t *testing.T) {
	dir := t.TempDir()
	manager, err := NewManager(dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	task, err := manager.CreateTask(CreateTaskRequest{Title: "dispatch worker"})
	if err != nil {
		t.Fatal(err)
	}
	message, err := manager.SendMessage(SendMessageRequest{
		From:    "coordinator",
		To:      "worker",
		Subject: "start",
		Type:    MessageDispatch,
	})
	if err != nil {
		t.Fatal(err)
	}
	reply, err := manager.ReplyMessage(message.ID, SendMessageRequest{Body: "ack"})
	if err != nil {
		t.Fatal(err)
	}
	if reply.ThreadID != message.ThreadID {
		t.Fatalf("reply should preserve thread id")
	}
	dispatch, err := manager.DispatchTask(DispatchTaskRequest{
		TaskID:   task.ID,
		Assignee: "worker",
		Inject:   true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if dispatch.Status != DispatchInjected || dispatch.Preamble == "" {
		t.Fatalf("expected injected dispatch with preamble: %#v", dispatch)
	}
	dispatch, err = manager.UpdateDispatch(dispatch.ID, UpdateDispatchRequest{Status: DispatchCompleted})
	if err != nil {
		t.Fatal(err)
	}
	if dispatch.Status != DispatchCompleted {
		t.Fatalf("dispatch was not completed: %#v", dispatch)
	}

	reloaded, err := NewManager(dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := reloaded.ListMessages("", false); len(got) != 2 {
		t.Fatalf("expected 2 messages, got %#v", got)
	}
	if got := reloaded.ListDispatches(task.ID); len(got) != 1 || got[0].ID != dispatch.ID {
		t.Fatalf("dispatch was not persisted: %#v", got)
	}
	tasks := reloaded.ListTasks()
	if len(tasks) != 1 || tasks[0].Status != TaskCompleted {
		t.Fatalf("task dispatch status was not persisted: %#v", tasks)
	}
}

func TestAutomationTriggerCreatesTaskAndPersistsRun(t *testing.T) {
	dir := t.TempDir()
	manager, err := NewManager(dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	automation, err := manager.CreateAutomation(CreateAutomationRequest{
		Name:    "nightly task",
		Enabled: true,
		Schedule: AutomationSchedule{
			Kind: AutomationScheduleManual,
		},
		Action: AutomationAction{
			Kind: AutomationActionCreateTask,
			Payload: map[string]interface{}{
				"title": "sync workspace",
				"body":  "check remote state",
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	run, err := manager.TriggerAutomation(context.Background(), automation.ID, TriggerAutomationRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if run.Status != AutomationRunCompleted || run.TaskID == "" {
		t.Fatalf("automation did not create a completed task run: %#v", run)
	}
	tasks := manager.ListTasks()
	if len(tasks) != 1 || tasks[0].Title != "sync workspace" {
		t.Fatalf("automation task was not created: %#v", tasks)
	}

	reloaded, err := NewManager(dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := reloaded.ListAutomations(); len(got) != 1 || got[0].ID != automation.ID {
		t.Fatalf("automation was not persisted: %#v", got)
	}
	if got := reloaded.ListAutomationRuns(automation.ID); len(got) != 1 || got[0].ID != run.ID {
		t.Fatalf("automation run was not persisted: %#v", got)
	}
}

func TestEvaluateScheduledAutomationsAdvancesNextRun(t *testing.T) {
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	automation, err := manager.CreateAutomation(CreateAutomationRequest{
		Name:    "interval task",
		Enabled: true,
		Schedule: AutomationSchedule{
			Kind:            AutomationScheduleInterval,
			IntervalSeconds: 60,
		},
		Action: AutomationAction{
			Kind: AutomationActionCreateTask,
			Payload: map[string]interface{}{
				"title": "interval work",
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if automation.NextRunAt == nil {
		t.Fatal("interval automation should set nextRunAt")
	}
	runs, err := manager.EvaluateScheduledAutomations(context.Background(), automation.NextRunAt.Add(-time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if len(runs) != 0 {
		t.Fatalf("automation should not run before nextRunAt: %#v", runs)
	}

	dueAt := automation.NextRunAt.Add(time.Second)
	runs, err = manager.EvaluateScheduledAutomations(context.Background(), dueAt)
	if err != nil {
		t.Fatal(err)
	}
	if len(runs) != 1 || runs[0].Status != AutomationRunCompleted {
		t.Fatalf("expected one completed scheduled run, got %#v", runs)
	}
	updated := manager.ListAutomations()[0]
	if updated.NextRunAt == nil || !updated.NextRunAt.After(dueAt) {
		t.Fatalf("next run was not advanced past evaluate time: %#v", updated.NextRunAt)
	}
}

func TestAutomationRejectsUnsupportedSchedules(t *testing.T) {
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	_, err = manager.CreateAutomation(CreateAutomationRequest{
		Name: "cron task",
		Schedule: AutomationSchedule{
			Kind: AutomationScheduleCron,
			Cron: "* * * * *",
		},
		Action: AutomationAction{
			Kind: AutomationActionCreateTask,
			Payload: map[string]interface{}{
				"title": "cron work",
			},
		},
	})
	if err == nil {
		t.Fatal("expected unsupported cron schedule to be rejected")
	}
}

func TestAutomationRruleComputesDailyNextOccurrence(t *testing.T) {
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	// dtstart must be in the future: nextRunAt is computed relative to real time.Now() at
	// creation, so a past dtstart would correctly roll forward past its first occurrence.
	dtstart := time.Now().UTC().Add(24 * time.Hour).Truncate(time.Second)
	automation, err := manager.CreateAutomation(CreateAutomationRequest{
		Name:    "daily standup reminder",
		Enabled: true,
		Schedule: AutomationSchedule{
			Kind:    AutomationScheduleRrule,
			Rrule:   "FREQ=DAILY",
			DtStart: &dtstart,
		},
		Action: AutomationAction{
			Kind: AutomationActionCreateTask,
			Payload: map[string]interface{}{
				"title": "reminder",
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if automation.NextRunAt == nil {
		t.Fatal("rrule automation should set nextRunAt")
	}
	// First occurrence should be dtstart itself, since no run has fired yet.
	if !automation.NextRunAt.Equal(dtstart) {
		t.Fatalf("expected first occurrence to equal dtstart, got %v", automation.NextRunAt)
	}
}

func TestAutomationRruleComputesWeeklyNextOccurrence(t *testing.T) {
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	// Find the next future Monday 09:00 UTC so dtstart is guaranteed ahead of time.Now().
	dtstart := nextWeekdayAt(t, time.Monday, 9, 0)
	automation, err := manager.CreateAutomation(CreateAutomationRequest{
		Name:    "MWF sync",
		Enabled: true,
		Schedule: AutomationSchedule{
			Kind:    AutomationScheduleRrule,
			Rrule:   "FREQ=WEEKLY;BYDAY=MO,WE,FR",
			DtStart: &dtstart,
		},
		Action: AutomationAction{
			Kind: AutomationActionCreateTask,
			Payload: map[string]interface{}{
				"title": "sync",
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if automation.NextRunAt == nil || !automation.NextRunAt.Equal(dtstart) {
		t.Fatalf("expected first occurrence to equal dtstart (Monday), got %v", automation.NextRunAt)
	}

	// Evaluate strictly before the Monday occurrence: it should not be due yet.
	beforeMonday := dtstart.Add(-time.Minute)
	runs, err := manager.EvaluateScheduledAutomations(context.Background(), beforeMonday)
	if err != nil {
		t.Fatal(err)
	}
	if len(runs) != 0 {
		t.Fatalf("automation should not be due before Monday's occurrence: %#v", runs)
	}
	updated := manager.ListAutomations()[0]
	if updated.NextRunAt == nil || !updated.NextRunAt.Equal(dtstart) {
		t.Fatalf("nextRunAt should still be Monday's occurrence until it fires, got %v", updated.NextRunAt)
	}

	// Evaluating at/after Monday's occurrence fires it and advances to Wednesday.
	runs, err = manager.EvaluateScheduledAutomations(context.Background(), dtstart)
	if err != nil {
		t.Fatal(err)
	}
	if len(runs) != 1 || runs[0].Status != AutomationRunCompleted {
		t.Fatalf("expected Monday occurrence to dispatch, got %#v", runs)
	}
	updated = manager.ListAutomations()[0]
	wednesday := dtstart.Add(48 * time.Hour)
	if updated.NextRunAt == nil || !updated.NextRunAt.Equal(wednesday) {
		t.Fatalf("expected next occurrence to advance to Wednesday, got %v", updated.NextRunAt)
	}

	// Evaluating at Wednesday's occurrence fires it and advances to Friday.
	runs, err = manager.EvaluateScheduledAutomations(context.Background(), wednesday)
	if err != nil {
		t.Fatal(err)
	}
	if len(runs) != 1 || runs[0].Status != AutomationRunCompleted {
		t.Fatalf("expected Wednesday occurrence to dispatch, got %#v", runs)
	}
	updated = manager.ListAutomations()[0]
	friday := dtstart.Add(4 * 24 * time.Hour)
	if updated.NextRunAt == nil || !updated.NextRunAt.Equal(friday) {
		t.Fatalf("expected next occurrence to advance to Friday, got %v", updated.NextRunAt)
	}
}

// nextWeekdayAt returns the next future occurrence of the given weekday/time so RRULE tests can
// use a dtstart guaranteed ahead of time.Now(), since nextAutomationRunAt anchors to real time.
func nextWeekdayAt(t *testing.T, weekday time.Weekday, hour, minute int) time.Time {
	t.Helper()
	now := time.Now().UTC()
	candidate := time.Date(now.Year(), now.Month(), now.Day(), hour, minute, 0, 0, time.UTC)
	for candidate.Weekday() != weekday || !candidate.After(now) {
		candidate = candidate.Add(24 * time.Hour)
	}
	return candidate
}

func TestAutomationRruleRejectsUnsupportedFrequency(t *testing.T) {
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	_, err = manager.CreateAutomation(CreateAutomationRequest{
		Name: "yearly task",
		Schedule: AutomationSchedule{
			Kind:  AutomationScheduleRrule,
			Rrule: "FREQ=YEARLY",
		},
		Action: AutomationAction{
			Kind: AutomationActionCreateTask,
			Payload: map[string]interface{}{
				"title": "yearly work",
			},
		},
	})
	if err == nil {
		t.Fatal("expected unsupported rrule frequency to be rejected")
	}
}

func TestAutomationRruleRespectsUntilAndCount(t *testing.T) {
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	dtstart := time.Now().UTC().Add(24 * time.Hour).Truncate(time.Second)
	automation, err := manager.CreateAutomation(CreateAutomationRequest{
		Name:    "two-day-only",
		Enabled: true,
		Schedule: AutomationSchedule{
			Kind:    AutomationScheduleRrule,
			Rrule:   "FREQ=DAILY;COUNT=2",
			DtStart: &dtstart,
		},
		Action: AutomationAction{
			Kind: AutomationActionCreateTask,
			Payload: map[string]interface{}{
				"title": "limited work",
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	// Fire the first occurrence (dtstart).
	runs, err := manager.EvaluateScheduledAutomations(context.Background(), dtstart)
	if err != nil {
		t.Fatal(err)
	}
	if len(runs) != 1 {
		t.Fatalf("expected first occurrence to dispatch, got %#v", runs)
	}
	secondDay := dtstart.Add(24 * time.Hour)
	updated := manager.ListAutomations()[0]
	if updated.NextRunAt == nil || !updated.NextRunAt.Equal(secondDay) {
		t.Fatalf("expected second occurrence to be scheduled, got %v", updated.NextRunAt)
	}

	// Fire the second (last, COUNT=2) occurrence.
	runs, err = manager.EvaluateScheduledAutomations(context.Background(), secondDay)
	if err != nil {
		t.Fatal(err)
	}
	if len(runs) != 1 {
		t.Fatalf("expected second occurrence to dispatch, got %#v", runs)
	}
	updated = manager.ListAutomations()[0]
	if updated.NextRunAt != nil {
		t.Fatalf("expected no further occurrences after COUNT is exhausted, got %v", updated.NextRunAt)
	}

	// Evaluating well past the exhausted schedule should not error or produce runs.
	runs, err = manager.EvaluateScheduledAutomations(context.Background(), secondDay.Add(48*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if len(runs) != 0 {
		t.Fatalf("expected no runs once rrule is exhausted, got %#v", runs)
	}
	if automation.ID != updated.ID {
		t.Fatalf("automation identity changed unexpectedly")
	}
}

func TestExternalWorkItemsUpsertLinkAndPersist(t *testing.T) {
	dir := t.TempDir()
	manager, err := NewManager(dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	item, err := manager.UpsertExternalWorkItem(UpsertExternalWorkItemRequest{
		Provider:   "linear",
		ExternalID: "ORC-123",
		Title:      "Port task integration",
		Status:     ExternalWorkItemOpen,
		CreateTask: true,
		Metadata: map[string]interface{}{
			"priority": "high",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if item.Kind != ExternalWorkItemTicket || item.TaskID == "" {
		t.Fatalf("external task was not linked to an internal task: %#v", item)
	}
	if got := manager.ListTasks(); len(got) != 1 || got[0].Title != item.Title {
		t.Fatalf("linked task was not created: %#v", got)
	}
	item, err = manager.UpsertExternalWorkItem(UpsertExternalWorkItemRequest{
		Provider:   "linear",
		ExternalID: "ORC-123",
		Title:      "Port task integration",
		Status:     ExternalWorkItemInProgress,
		TaskID:     item.TaskID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if item.Status != ExternalWorkItemInProgress {
		t.Fatalf("external work item was not updated: %#v", item)
	}

	review, err := manager.UpsertExternalWorkItem(UpsertExternalWorkItemRequest{
		Provider:     "gitlab",
		ExternalID:   "mr-42",
		Title:        "Rewrite runtime contract",
		Status:       ExternalWorkItemOpen,
		RepositoryID: "repo_1",
		WorkspaceID:  "wt_1",
		ReviewKind:   "merge_request",
	})
	if err != nil {
		t.Fatal(err)
	}
	if review.Kind != ExternalWorkItemReview {
		t.Fatalf("git provider item should default to review kind: %#v", review)
	}
	if review.ReviewKind != "merge-request" {
		t.Fatalf("git provider review kind was not normalized: %#v", review)
	}
	review, err = manager.UpdateExternalWorkItem(review.ID, UpdateExternalWorkItemRequest{ReviewKind: "pr"})
	if err != nil {
		t.Fatal(err)
	}
	if review.ReviewKind != "pull-request" {
		t.Fatalf("updated review kind was not normalized: %#v", review)
	}
	filtered := manager.ListExternalWorkItems(ExternalWorkItemFilter{Provider: "gitlab", RepositoryID: "repo_1"})
	if len(filtered) != 1 || filtered[0].ID != review.ID {
		t.Fatalf("external review filter failed: %#v", filtered)
	}

	reloaded, err := NewManager(dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := reloaded.ListExternalWorkItems(ExternalWorkItemFilter{}); len(got) != 2 {
		t.Fatalf("external work items were not persisted: %#v", got)
	}
}

func TestFileServiceReadsWritesAndBlocksEscapes(t *testing.T) {
	dir := t.TempDir()
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	project, err := manager.CreateProject(CreateProjectRequest{Name: "repo", Path: dir})
	if err != nil {
		t.Fatal(err)
	}
	content, err := manager.WriteFile(WriteFileRequest{
		ProjectID:  project.ID,
		Path:       "docs/notes.txt",
		Content:    "hello files\n",
		CreateDirs: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if content.Path != "docs/notes.txt" || content.Content != "hello files\n" {
		t.Fatalf("unexpected written content: %#v", content)
	}
	entries, err := manager.ListFiles(ListFilesRequest{ProjectID: project.ID, MaxDepth: 2})
	if err != nil {
		t.Fatal(err)
	}
	var found bool
	for _, entry := range entries {
		if entry.Path == "docs/notes.txt" && entry.Kind == FileEntryFile {
			found = true
		}
	}
	if !found {
		t.Fatalf("written file was not listed: %#v", entries)
	}
	read, err := manager.ReadFile(ReadFileRequest{ProjectID: project.ID, Path: "docs/notes.txt"})
	if err != nil {
		t.Fatal(err)
	}
	if read.Content != "hello files\n" {
		t.Fatalf("unexpected read content: %#v", read)
	}
	if err := manager.CreateFile(FileMutationRequest{ProjectID: project.ID, Path: "docs/new.txt"}); err != nil {
		t.Fatal(err)
	}
	if err := manager.CreateDirectory(FileMutationRequest{ProjectID: project.ID, Path: "docs/nested"}); err != nil {
		t.Fatal(err)
	}
	if stat, err := manager.StatFile(ReadFileRequest{ProjectID: project.ID, Path: "docs"}); err != nil || !stat.IsDirectory {
		t.Fatalf("expected docs directory stat, got %#v err=%v", stat, err)
	}
	if err := manager.RenamePath(FileRenameRequest{
		ProjectID: project.ID,
		OldPath:   "docs/new.txt",
		NewPath:   "docs/renamed.txt",
	}); err != nil {
		t.Fatal(err)
	}
	if err := manager.CopyPath(FileRenameRequest{
		ProjectID:       project.ID,
		SourcePath:      "docs/renamed.txt",
		DestinationPath: "docs/copied.txt",
	}); err != nil {
		t.Fatal(err)
	}
	listed, err := manager.ListAllFiles(ListAllFilesRequest{ProjectID: project.ID})
	if err != nil {
		t.Fatal(err)
	}
	if listed.TotalCount < 3 {
		t.Fatalf("expected created files in list-all result: %#v", listed)
	}
	search, err := manager.SearchFiles(FileSearchRequest{ProjectID: project.ID, Query: "hello"})
	if err != nil {
		t.Fatal(err)
	}
	if search.TotalMatches != 1 || len(search.Files) != 1 {
		t.Fatalf("unexpected search result: %#v", search)
	}
	if err := manager.DeletePath(FileMutationRequest{ProjectID: project.ID, Path: "docs/copied.txt"}); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.WriteFile(WriteFileRequest{
		ProjectID: project.ID,
		Path:      "large.txt",
		Content:   strings.Repeat("x", int(maxFileReadLimitBytes)+1),
	}); err == nil {
		t.Fatal("expected oversized write to be rejected")
	}
	if _, err := manager.ReadFile(ReadFileRequest{ProjectID: project.ID, Path: "../outside.txt"}); !errors.Is(err, ErrInvalidPath) {
		t.Fatalf("expected invalid path, got %v", err)
	}
}

func TestFileServiceBlocksSymlinkEscapes(t *testing.T) {
	dir := t.TempDir()
	outsideDir := t.TempDir()
	outsideFile := filepath.Join(outsideDir, "outside.txt")
	if err := os.WriteFile(outsideFile, []byte("outside\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outsideFile, filepath.Join(dir, "outside-link.txt")); err != nil {
		t.Skipf("symlinks are not available: %v", err)
	}
	if err := os.Symlink(outsideDir, filepath.Join(dir, "outside-dir")); err != nil {
		t.Skipf("directory symlinks are not available: %v", err)
	}
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	project, err := manager.CreateProject(CreateProjectRequest{Name: "repo", Path: dir})
	if err != nil {
		t.Fatal(err)
	}

	if _, err := manager.ReadFile(ReadFileRequest{ProjectID: project.ID, Path: "outside-link.txt"}); !errors.Is(err, ErrInvalidPath) {
		t.Fatalf("expected symlink read escape to be rejected, got %v", err)
	}
	if _, err := manager.WriteFile(WriteFileRequest{ProjectID: project.ID, Path: "outside-link.txt", Content: "changed\n"}); !errors.Is(err, ErrInvalidPath) {
		t.Fatalf("expected symlink write escape to be rejected, got %v", err)
	}
	content, err := os.ReadFile(outsideFile)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "outside\n" {
		t.Fatalf("outside file was modified through symlink: %q", string(content))
	}
	if _, err := manager.WriteFile(WriteFileRequest{
		ProjectID:  project.ID,
		Path:       "outside-dir/created.txt",
		Content:    "created\n",
		CreateDirs: true,
	}); !errors.Is(err, ErrInvalidPath) {
		t.Fatalf("expected symlink parent escape to be rejected, got %v", err)
	}
	if _, err := os.Stat(filepath.Join(outsideDir, "created.txt")); !os.IsNotExist(err) {
		t.Fatalf("outside file should not have been created, got %v", err)
	}
}

func TestFileServiceRequiresRelayForRemoteProjects(t *testing.T) {
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	project, err := manager.CreateProject(CreateProjectRequest{
		Name:         "remote",
		Path:         "/repo",
		LocationKind: "ssh",
		HostID:       "host-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = manager.ListFiles(ListFilesRequest{ProjectID: project.ID})
	if !errors.Is(err, ErrRemoteNeedsRelay) {
		t.Fatalf("expected relay-required error, got %v", err)
	}
}

func TestRemoteFileSnapshotsBackRemoteFileReads(t *testing.T) {
	dir := t.TempDir()
	manager, err := NewManager(dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	project, err := manager.CreateProject(CreateProjectRequest{
		Name:         "remote",
		Path:         "/repo",
		LocationKind: "ssh",
		HostID:       "host-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	tree, err := manager.UpdateRemoteFileTree(UpdateRemoteFileTreeRequest{
		ProjectID: project.ID,
		Entries: []FileEntry{
			{Path: "README.md", Name: "README.md", Kind: FileEntryFile, Size: 12},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(tree.Entries) != 1 || tree.Entries[0].Path != "README.md" {
		t.Fatalf("unexpected remote tree snapshot: %#v", tree)
	}
	content, err := manager.UpdateRemoteFileContent(UpdateRemoteFileContentRequest{
		ProjectID: project.ID,
		Path:      "README.md",
		Content:   "remote readme",
	})
	if err != nil {
		t.Fatal(err)
	}
	if content.Content.Content != "remote readme" {
		t.Fatalf("unexpected remote content snapshot: %#v", content)
	}
	entries, err := manager.ListFiles(ListFilesRequest{ProjectID: project.ID})
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Path != "README.md" {
		t.Fatalf("cached remote tree was not returned: %#v", entries)
	}
	read, err := manager.ReadFile(ReadFileRequest{ProjectID: project.ID, Path: "README.md"})
	if err != nil {
		t.Fatal(err)
	}
	if read.Content != "remote readme" {
		t.Fatalf("cached remote content was not returned: %#v", read)
	}
	if _, err := manager.ReadFile(ReadFileRequest{ProjectID: project.ID, Path: "README.md", MaxBytes: 4}); err == nil {
		t.Fatal("expected cached remote content to honor read limit")
	}
	if _, err := manager.UpdateRemoteFileContent(UpdateRemoteFileContentRequest{
		ProjectID: project.ID,
		Path:      "large.txt",
		Content:   strings.Repeat("x", int(maxFileReadLimitBytes)+1),
	}); err == nil {
		t.Fatal("expected oversized remote content snapshot to be rejected")
	}

	reloaded, err := NewManager(dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	read, err = reloaded.ReadFile(ReadFileRequest{ProjectID: project.ID, Path: "README.md"})
	if err != nil {
		t.Fatal(err)
	}
	if read.Content != "remote readme" {
		t.Fatalf("remote content snapshot was not persisted: %#v", read)
	}
}

func TestReleasePlanGateAndPersistence(t *testing.T) {
	dir := t.TempDir()
	manager, err := NewManager(dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	plan, err := manager.CreateReleasePlan(CreateReleasePlanRequest{Version: "1.2.3"})
	if err != nil {
		t.Fatal(err)
	}
	blocked, err := manager.PublishReleasePlan(plan.ID, PublishReleasePlanRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if blocked.Status != ReleasePlanBlocked || blocked.BlockedReason == "" {
		t.Fatalf("incomplete release should be blocked: %#v", blocked)
	}
	for _, required := range plan.RequiredArtifacts {
		updated, err := manager.UpsertReleaseArtifact(plan.ID, UpsertReleaseArtifactRequest{
			Platform: required.Platform,
			Kind:     required.Kind,
			Name:     required.Name,
			URI:      "file://" + required.Platform + "/" + required.Name,
		})
		if err != nil {
			t.Fatal(err)
		}
		plan = updated
	}
	for _, check := range plan.Checks {
		updated, err := manager.UpdateReleaseCheck(plan.ID, UpdateReleaseCheckRequest{
			Name:   check.Name,
			Status: ReleaseCheckPassed,
		})
		if err != nil {
			t.Fatal(err)
		}
		plan = updated
	}
	published, err := manager.PublishReleasePlan(plan.ID, PublishReleasePlanRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if published.Status != ReleasePlanPublished || published.PublishedAt == nil {
		t.Fatalf("release was not published: %#v", published)
	}

	reloaded, err := NewManager(dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := reloaded.ListReleasePlans(); len(got) != 1 || got[0].ID != plan.ID {
		t.Fatalf("release plan was not persisted: %#v", got)
	}
}

func TestReleaseUpdateManifestReportsReadiness(t *testing.T) {
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	plan, err := manager.CreateReleasePlan(CreateReleasePlanRequest{
		Version: "2.0.0",
		Channel: "beta",
		RequiredArtifacts: []ReleaseRequiredArtifact{{
			Platform: "linux",
			Kind:     "package",
			Name:     "deb",
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := manager.GetReleaseUpdateManifest(plan.ID)
	if err != nil {
		t.Fatal(err)
	}
	if manifest.Ready || !strings.Contains(manifest.BlockedReason, "missing artifact linux:package:deb") {
		t.Fatalf("expected missing artifact manifest state, got %#v", manifest)
	}
	validSHA256 := strings.Repeat("a", 64)
	plan, err = manager.UpsertReleaseArtifact(plan.ID, UpsertReleaseArtifactRequest{
		Platform: "linux",
		Kind:     "package",
		Name:     "deb",
		URI:      "file://release/pebble.deb",
		SHA256:   validSHA256,
		Size:     42,
		Signed:   true,
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, check := range plan.Checks {
		plan, err = manager.UpdateReleaseCheck(plan.ID, UpdateReleaseCheckRequest{
			Name:   check.Name,
			Status: ReleaseCheckPassed,
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	manifest, err = manager.GetReleaseUpdateManifest(plan.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !manifest.Ready || manifest.BlockedReason != "" {
		t.Fatalf("expected ready manifest, got %#v", manifest)
	}
	if manifest.ReleaseID != plan.ID || manifest.Version != "2.0.0" || manifest.Channel != "beta" {
		t.Fatalf("unexpected manifest identity: %#v", manifest)
	}
	if len(manifest.Artifacts) != 1 || manifest.Artifacts[0].SHA256 != validSHA256 || manifest.Artifacts[0].Size != 42 {
		t.Fatalf("unexpected manifest artifacts: %#v", manifest.Artifacts)
	}
	if len(manifest.Checks) != len(plan.Checks) {
		t.Fatalf("expected manifest checks, got %#v", manifest.Checks)
	}
}

func TestReleaseRequiredArtifactUpdateRecomputesReadiness(t *testing.T) {
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	plan, err := manager.CreateReleasePlan(CreateReleasePlanRequest{
		Version: "3.0.0",
		RequiredArtifacts: []ReleaseRequiredArtifact{{
			Platform: "linux",
			Kind:     "package",
			Name:     "deb",
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	plan, err = manager.UpsertReleaseArtifact(plan.ID, UpsertReleaseArtifactRequest{
		Platform: "linux",
		Kind:     "package",
		Name:     "deb",
		URI:      "file://release/pebble.deb",
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, check := range plan.Checks {
		plan, err = manager.UpdateReleaseCheck(plan.ID, UpdateReleaseCheckRequest{
			Name:   check.Name,
			Status: ReleaseCheckPassed,
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	if plan.Status != ReleasePlanReady {
		t.Fatalf("expected ready release before requirement update, got %#v", plan)
	}
	updated, err := manager.UpdateReleasePlan(plan.ID, UpdateReleasePlanRequest{
		RequiredArtifacts: []ReleaseRequiredArtifact{
			{Platform: "linux", Kind: "package", Name: "deb"},
			{Platform: "macos", Kind: "appArchive", Name: "dmg"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if updated.Status != ReleasePlanBlocked || !strings.Contains(updated.BlockedReason, "missing artifact macos:appArchive:dmg") {
		t.Fatalf("expected recomputed blocked release, got %#v", updated)
	}
}

func TestReleaseRequiredArtifactsDefaultNameAndRejectEmptyUpdate(t *testing.T) {
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	plan, err := manager.CreateReleasePlan(CreateReleasePlanRequest{
		Version: "3.1.0",
		RequiredArtifacts: []ReleaseRequiredArtifact{{
			Platform: "linux",
			Kind:     "package",
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.RequiredArtifacts) != 1 || plan.RequiredArtifacts[0].Name != "package" {
		t.Fatalf("expected required artifact name to default to kind, got %#v", plan.RequiredArtifacts)
	}
	plan, err = manager.UpsertReleaseArtifact(plan.ID, UpsertReleaseArtifactRequest{
		Platform: "linux",
		Kind:     "package",
		URI:      "file://release/pebble.deb",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !releaseHasArtifact(plan.Artifacts, plan.RequiredArtifacts[0]) {
		t.Fatalf("defaulted artifact name did not match uploaded artifact: %#v", plan)
	}
	if _, err := manager.UpdateReleasePlan(plan.ID, UpdateReleasePlanRequest{
		RequiredArtifacts: []ReleaseRequiredArtifact{{Platform: "", Kind: ""}},
	}); err == nil {
		t.Fatal("expected empty normalized required artifacts update to be rejected")
	}
}

func TestReleaseArtifactValidationRejectsInvalidPlatformSizeAndDigest(t *testing.T) {
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.CreateReleasePlan(CreateReleasePlanRequest{
		Version: "3.2.0",
		RequiredArtifacts: []ReleaseRequiredArtifact{{
			Platform: "web",
			Kind:     "package",
		}},
	}); err == nil || !strings.Contains(err.Error(), "generic, linux, macos, or windows") {
		t.Fatalf("expected unsupported required artifact platform rejection, got %v", err)
	}
	plan, err := manager.CreateReleasePlan(CreateReleasePlanRequest{Version: "3.2.0"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.UpsertReleaseArtifact(plan.ID, UpsertReleaseArtifactRequest{
		Platform: "web",
		Kind:     "package",
		URI:      "file://release/pebble.web",
	}); err == nil || !strings.Contains(err.Error(), "generic, linux, macos, or windows") {
		t.Fatalf("expected unsupported artifact platform rejection, got %v", err)
	}
	if _, err := manager.UpsertReleaseArtifact(plan.ID, UpsertReleaseArtifactRequest{
		Platform: "linux",
		Kind:     "package",
		URI:      "file://release/pebble.deb",
		Size:     -1,
	}); err == nil || !strings.Contains(err.Error(), "non-negative") {
		t.Fatalf("expected negative artifact size rejection, got %v", err)
	}
	if _, err := manager.UpsertReleaseArtifact(plan.ID, UpsertReleaseArtifactRequest{
		Platform: "linux",
		Kind:     "package",
		URI:      "file://release/pebble.deb",
		SHA256:   "abc123",
	}); err == nil || !strings.Contains(err.Error(), "64-character hex") {
		t.Fatalf("expected invalid artifact sha rejection, got %v", err)
	}
}

func TestReleasePlanDefaultsIncludeMobileBuildChecks(t *testing.T) {
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	plan, err := manager.CreateReleasePlan(CreateReleasePlanRequest{Version: "3.3.0"})
	if err != nil {
		t.Fatal(err)
	}
	checks := make(map[string]ReleaseCheckStatus)
	for _, check := range plan.Checks {
		checks[check.Name] = check.Status
	}
	for _, name := range []string{"ios-mobile-build", "android-mobile-build", "mobile-relay-crypto-native"} {
		if checks[name] != ReleaseCheckPending {
			t.Fatalf("expected pending default release check %q, got %#v", name, checks)
		}
	}
}

func TestPublishedReleaseStatusSurvivesArtifactAndCheckUpdates(t *testing.T) {
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	plan, err := manager.CreateReleasePlan(CreateReleasePlanRequest{
		Version: "3.2.0",
		RequiredArtifacts: []ReleaseRequiredArtifact{{
			Platform: "linux",
			Kind:     "package",
			Name:     "deb",
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	plan, err = manager.UpsertReleaseArtifact(plan.ID, UpsertReleaseArtifactRequest{
		Platform: "linux",
		Kind:     "package",
		Name:     "deb",
		URI:      "file://release/pebble.deb",
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, check := range plan.Checks {
		plan, err = manager.UpdateReleaseCheck(plan.ID, UpdateReleaseCheckRequest{
			Name:   check.Name,
			Status: ReleaseCheckPassed,
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	plan, err = manager.PublishReleasePlan(plan.ID, PublishReleasePlanRequest{})
	if err != nil {
		t.Fatal(err)
	}
	plan, err = manager.UpsertReleaseArtifact(plan.ID, UpsertReleaseArtifactRequest{
		Platform: "linux",
		Kind:     "package",
		Name:     "deb",
		URI:      "file://release/pebble-v2.deb",
	})
	if err != nil {
		t.Fatal(err)
	}
	if plan.Status != ReleasePlanPublished {
		t.Fatalf("published release status changed after artifact update: %#v", plan)
	}
	plan, err = manager.UpdateReleaseCheck(plan.ID, UpdateReleaseCheckRequest{
		Name:   "post-publish-smoke",
		Status: ReleaseCheckFailed,
	})
	if err != nil {
		t.Fatal(err)
	}
	if plan.Status != ReleasePlanPublished {
		t.Fatalf("published release status changed after check update: %#v", plan)
	}
}

func TestReleaseUpdateRejectsComputedStatuses(t *testing.T) {
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	plan, err := manager.CreateReleasePlan(CreateReleasePlanRequest{Version: "4.0.0"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.UpdateReleasePlan(plan.ID, UpdateReleasePlanRequest{Status: ReleasePlanReady}); err == nil {
		t.Fatal("expected ready status update to be rejected")
	}
	if _, err := manager.UpdateReleasePlan(plan.ID, UpdateReleasePlanRequest{Status: ReleasePlanPublished}); err == nil {
		t.Fatal("expected published status update to be rejected")
	}
}

func TestSettingsAndKeybindingsPersist(t *testing.T) {
	dir := t.TempDir()
	manager, err := NewManager(dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	setting, err := manager.SetRuntimeSetting(SetRuntimeSettingRequest{
		Scope: RuntimeSettingGlobal,
		Key:   "workbench.density",
		Value: map[string]interface{}{"value": "compact"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if setting.Value["value"] != "compact" {
		t.Fatalf("unexpected setting: %#v", setting)
	}
	enabled := true
	keybinding, err := manager.SetKeybinding(SetKeybindingRequest{
		Command:     "command.palette",
		Accelerator: "CmdOrCtrl+Shift+P",
		Platform:    "all",
		Context:     "workbench",
		Enabled:     &enabled,
	})
	if err != nil {
		t.Fatal(err)
	}
	if keybinding.Platform != "" || !keybinding.Enabled {
		t.Fatalf("unexpected keybinding: %#v", keybinding)
	}

	reloaded, err := NewManager(dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := reloaded.ListRuntimeSettings(RuntimeSettingFilter{Key: "workbench.density"}); len(got) != 1 {
		t.Fatalf("setting was not persisted: %#v", got)
	}
	if got := reloaded.ListKeybindings(KeybindingFilter{Context: "workbench"}); len(got) != 1 {
		t.Fatalf("keybinding was not persisted: %#v", got)
	}
}

func TestAgentProfileAndRun(t *testing.T) {
	dir := t.TempDir()
	manager, err := NewManager(dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	project, err := manager.CreateProject(CreateProjectRequest{Name: "repo", Path: dir})
	if err != nil {
		t.Fatal(err)
	}
	profile, err := manager.CreateAgentProfile(CreateAgentProfileRequest{
		Name:                "echo-agent",
		Kind:                "echo",
		Command:             testEchoCommand(),
		PromptInjectionMode: PromptNone,
	})
	if err != nil {
		t.Fatal(err)
	}
	run, err := manager.StartAgentRun(context.Background(), StartAgentRunRequest{
		ProfileID: profile.ID,
		ProjectID: project.ID,
		Prompt:    "ignored",
	})
	if err != nil {
		t.Fatal(err)
	}
	if run.SessionID == "" {
		t.Fatal("agent run did not create a session")
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		runs := manager.ListAgentRuns()
		if len(runs) == 1 && runs[0].Status == AgentRunExited {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	tail, err := manager.TailSession(run.SessionID, 10)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, chunk := range tail.Chunks {
		// Why: PTY-backed sessions emit CRLF line endings; accept both framings.
		if strings.TrimRight(chunk.Content, "\r\n") == "pebble" {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected agent command output, got %#v", tail.Chunks)
	}
	reloaded, err := NewManager(dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := reloaded.ListAgentProfiles(); len(got) != 1 || got[0].ID != profile.ID {
		t.Fatalf("agent profile was not persisted: %#v", got)
	}
	if got := reloaded.ListAgentRuns(); len(got) != 1 || got[0].ID != run.ID {
		t.Fatalf("agent run was not persisted: %#v", got)
	}
}

func TestAgentProfileUpdateDeleteAndRunStop(t *testing.T) {
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	project, err := manager.CreateProject(CreateProjectRequest{Name: "repo", Path: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	profile, err := manager.CreateAgentProfile(CreateAgentProfileRequest{
		Name:                "sleeper",
		Kind:                "shell",
		Command:             testSleepCommand(),
		PromptInjectionMode: PromptNone,
	})
	if err != nil {
		t.Fatal(err)
	}
	profile, err = manager.UpdateAgentProfile(profile.ID, UpdateAgentProfileRequest{Name: "renamed"})
	if err != nil {
		t.Fatal(err)
	}
	if profile.Name != "renamed" {
		t.Fatalf("agent profile was not updated: %#v", profile)
	}
	run, err := manager.StartAgentRun(context.Background(), StartAgentRunRequest{
		ProfileID: profile.ID,
		ProjectID: project.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	run, err = manager.StopAgentRun(run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if run.Status != AgentRunStopped {
		t.Fatalf("agent run was not stopped: %#v", run)
	}
	if _, err := manager.DeleteAgentProfile(profile.ID); err != nil {
		t.Fatal(err)
	}
	if got := manager.ListAgentProfiles(); len(got) != 0 {
		t.Fatalf("agent profile was not deleted: %#v", got)
	}
}

func TestBrowserComputerAndEmulatorState(t *testing.T) {
	dir := t.TempDir()
	manager, err := NewManager(dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	profile, err := manager.CreateBrowserProfile(CreateBrowserProfileRequest{
		Name:       "Default",
		Persistent: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	tab, err := manager.CreateBrowserTab(CreateBrowserTabRequest{
		ProfileID: profile.ID,
		Title:     "Docs",
		URL:       "https://example.test",
	})
	if err != nil {
		t.Fatal(err)
	}
	capturedAt := time.Now().UTC()
	tab, err = manager.UpdateBrowserTab(tab.ID, UpdateBrowserTabRequest{
		Status:               BrowserTabReady,
		ScreenshotURI:        "file:///tmp/tab.png",
		ScreenshotCapturedAt: &capturedAt,
	})
	if err != nil {
		t.Fatal(err)
	}
	if tab.Status != BrowserTabReady {
		t.Fatalf("browser tab did not update: %#v", tab)
	}
	if tab.ScreenshotURI == "" || tab.ScreenshotCapturedAt == nil {
		t.Fatalf("browser screenshot was not recorded: %#v", tab)
	}
	browserAction, err := manager.QueueBrowserCommand(tab.ID, BrowserCommandRequest{Command: "reload"})
	if err != nil {
		t.Fatal(err)
	}
	if browserAction.Kind != "browser.reload" || browserAction.Target != tab.ID {
		t.Fatalf("browser command did not queue a tab-targeted action: %#v", browserAction)
	}
	if browserAction.Payload["tabId"] != tab.ID || browserAction.Payload["command"] != "reload" {
		t.Fatalf("browser command payload did not include tab context: %#v", browserAction.Payload)
	}
	gotoAction, err := manager.QueueBrowserCommand(tab.ID, BrowserCommandRequest{
		Command: "goto",
		Payload: map[string]interface{}{"url": "https://pebble.example"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if gotoAction.Kind != "browser.goto" || gotoAction.Target != tab.ID {
		t.Fatalf("browser goto did not queue a tab-targeted action: %#v", gotoAction)
	}
	if gotoAction.Payload["url"] != "https://pebble.example" ||
		gotoAction.Payload["tabId"] != tab.ID ||
		gotoAction.Payload["command"] != "goto" {
		t.Fatalf("browser goto payload did not include command context: %#v", gotoAction.Payload)
	}
	permission, err := manager.SetBrowserPermission(SetBrowserPermissionRequest{
		ProfileID: profile.ID,
		Origin:    "https://example.test",
		Name:      "camera",
		State:     BrowserPermissionGranted,
	})
	if err != nil {
		t.Fatal(err)
	}
	if permission.State != BrowserPermissionGranted {
		t.Fatalf("browser permission did not update: %#v", permission)
	}
	download, err := manager.CreateBrowserDownload(CreateBrowserDownloadRequest{
		TabID:    tab.ID,
		URL:      "https://example.test/archive.zip",
		Filename: "archive.zip",
		Status:   BrowserDownloadInProgress,
	})
	if err != nil {
		t.Fatal(err)
	}
	downloadAction, err := manager.QueueBrowserDownload(download.ID)
	if err != nil {
		t.Fatal(err)
	}
	if downloadAction.Kind != "browser.download" || downloadAction.Target != download.ID {
		t.Fatalf("browser download did not queue a download-targeted action: %#v", downloadAction)
	}
	if downloadAction.Payload["downloadId"] != download.ID ||
		downloadAction.Payload["tabId"] != tab.ID ||
		downloadAction.Payload["url"] != download.URL ||
		downloadAction.Payload["command"] != "download" {
		t.Fatalf("browser download action payload lost download context: %#v", downloadAction.Payload)
	}
	received := int64(100)
	download, err = manager.UpdateBrowserDownload(download.ID, UpdateBrowserDownloadRequest{
		Status:        BrowserDownloadCompleted,
		BytesReceived: &received,
		Path:          "/tmp/archive.zip",
	})
	if err != nil {
		t.Fatal(err)
	}
	if download.Status != BrowserDownloadCompleted || download.BytesReceived != 100 {
		t.Fatalf("browser download did not update: %#v", download)
	}
	downloadTabID := tab.ID
	if _, err := manager.DeleteBrowserTab(tab.ID); err != nil {
		t.Fatal(err)
	}
	if got := manager.ListBrowserTabs(); len(got) != 0 {
		t.Fatalf("browser tab was not deleted: %#v", got)
	}
	tab, err = manager.CreateBrowserTab(CreateBrowserTabRequest{
		Title: "Docs",
		URL:   "https://example.test",
	})
	if err != nil {
		t.Fatal(err)
	}
	tab, err = manager.UpdateBrowserTab(tab.ID, UpdateBrowserTabRequest{Status: BrowserTabReady})
	if err != nil {
		t.Fatal(err)
	}
	action, err := manager.CreateComputerAction(CreateComputerActionRequest{
		Kind:   "click",
		Target: "main-window",
		Payload: map[string]interface{}{
			"x": float64(10),
			"y": float64(20),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	action, err = manager.UpdateComputerAction(action.ID, UpdateComputerActionRequest{
		Status: ComputerActionCompleted,
		Result: map[string]interface{}{"ok": true},
	})
	if err != nil {
		t.Fatal(err)
	}
	if action.Status != ComputerActionCompleted {
		t.Fatalf("computer action did not update: %#v", action)
	}
	device, err := manager.RegisterEmulatorDevice(RegisterEmulatorDeviceRequest{
		Name:     "Pixel",
		Platform: "android",
	})
	if err != nil {
		t.Fatal(err)
	}
	session, err := manager.AttachEmulator(AttachEmulatorRequest{DeviceID: device.ID})
	if err != nil {
		t.Fatal(err)
	}
	if !session.Active {
		t.Fatalf("emulator session should be active: %#v", session)
	}
	emulatorAction, err := manager.QueueEmulatorCommand(session.ID, EmulatorCommandRequest{
		Command: "tap",
		Payload: map[string]interface{}{"x": float64(20), "y": float64(40)},
	})
	if err != nil {
		t.Fatal(err)
	}
	if emulatorAction.Kind != "emulator.tap" || emulatorAction.Target != session.ID {
		t.Fatalf("emulator command did not queue a session-targeted action: %#v", emulatorAction)
	}
	if emulatorAction.Payload["sessionId"] != session.ID || emulatorAction.Payload["deviceId"] != device.ID {
		t.Fatalf("emulator action payload lost session context: %#v", emulatorAction.Payload)
	}

	reloaded, err := NewManager(dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := reloaded.ListBrowserTabs(); len(got) != 1 || got[0].Status != BrowserTabReady {
		t.Fatalf("browser tab was not persisted: %#v", got)
	}
	if got := reloaded.ListBrowserProfiles(); len(got) != 1 || got[0].ID != profile.ID {
		t.Fatalf("browser profile was not persisted: %#v", got)
	}
	if got := reloaded.ListBrowserPermissions(profile.ID, "https://example.test"); len(got) != 1 || got[0].Name != "camera" {
		t.Fatalf("browser permission was not persisted: %#v", got)
	}
	if got := reloaded.ListBrowserDownloads(downloadTabID); len(got) != 1 || got[0].Status != BrowserDownloadCompleted {
		t.Fatalf("browser download was not persisted: %#v", got)
	}
	actions := reloaded.ListComputerActions("", "")
	if len(actions) != 5 {
		t.Fatalf("computer actions were not persisted: %#v", actions)
	}
	var completedClick bool
	for _, current := range actions {
		if current.ID == action.ID && current.Status == ComputerActionCompleted {
			completedClick = true
		}
	}
	if !completedClick {
		t.Fatalf("computer action was not persisted: %#v", actions)
	}
	if got := reloaded.ListEmulatorSessions(); len(got) != 1 || !got[0].Active {
		t.Fatalf("emulator session was not persisted: %#v", got)
	}
}

func TestQueueBrowserCommandRejectsUnknownTabsAndCommands(t *testing.T) {
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	tab, err := manager.CreateBrowserTab(CreateBrowserTabRequest{URL: "https://example.test"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.QueueBrowserCommand(tab.ID, BrowserCommandRequest{Command: "print"}); err == nil {
		t.Fatal("expected unsupported browser command error")
	}
	if _, err := manager.QueueBrowserCommand("missing", BrowserCommandRequest{Command: "reload"}); err == nil {
		t.Fatal("expected missing tab error")
	}
}

func TestBrowserProfileDeleteClearsReferences(t *testing.T) {
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	profile, err := manager.CreateBrowserProfile(CreateBrowserProfileRequest{
		Name:       "Isolated",
		Persistent: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	tab, err := manager.CreateBrowserTab(CreateBrowserTabRequest{
		ProfileID: profile.ID,
		Title:     "Docs",
		URL:       "https://example.test",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.SetBrowserPermission(SetBrowserPermissionRequest{
		ProfileID: profile.ID,
		Origin:    "https://example.test",
		Name:      "camera",
		State:     BrowserPermissionGranted,
	}); err != nil {
		t.Fatal(err)
	}

	deleted, err := manager.DeleteBrowserProfile(profile.ID)
	if err != nil {
		t.Fatal(err)
	}
	if deleted.ID != profile.ID {
		t.Fatalf("unexpected deleted profile: %#v", deleted)
	}
	if got := manager.ListBrowserProfiles(); len(got) != 0 {
		t.Fatalf("browser profile was not deleted: %#v", got)
	}
	if got := manager.ListBrowserPermissions(profile.ID, ""); len(got) != 0 {
		t.Fatalf("profile permissions were not deleted: %#v", got)
	}
	tabs := manager.ListBrowserTabs()
	if len(tabs) != 1 || tabs[0].ID != tab.ID || tabs[0].ProfileID != "" {
		t.Fatalf("browser tab did not fall back to the default profile: %#v", tabs)
	}
}

func TestBrowserDownloadRejectsInvalidProgress(t *testing.T) {
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.CreateBrowserDownload(CreateBrowserDownloadRequest{
		URL:           "https://example.test/archive.zip",
		BytesReceived: -1,
	}); err == nil || !strings.Contains(err.Error(), "non-negative") {
		t.Fatalf("expected negative progress rejection, got %v", err)
	}
	if _, err := manager.CreateBrowserDownload(CreateBrowserDownloadRequest{
		URL:           "https://example.test/archive.zip",
		BytesReceived: 10,
		TotalBytes:    5,
	}); err == nil || !strings.Contains(err.Error(), "cannot exceed") {
		t.Fatalf("expected over-total progress rejection, got %v", err)
	}
	download, err := manager.CreateBrowserDownload(CreateBrowserDownloadRequest{
		URL:           "https://example.test/archive.zip",
		BytesReceived: 5,
		TotalBytes:    10,
	})
	if err != nil {
		t.Fatal(err)
	}
	total := int64(4)
	if _, err := manager.UpdateBrowserDownload(download.ID, UpdateBrowserDownloadRequest{
		TotalBytes: &total,
	}); err == nil || !strings.Contains(err.Error(), "cannot exceed") {
		t.Fatalf("expected invalid update progress rejection, got %v", err)
	}
}

func TestQueueEmulatorCommandRejectsInactiveSessionsAndUnknownCommands(t *testing.T) {
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	device, err := manager.RegisterEmulatorDevice(RegisterEmulatorDeviceRequest{
		Name:     "Pixel",
		Platform: "android",
	})
	if err != nil {
		t.Fatal(err)
	}
	session, err := manager.AttachEmulator(AttachEmulatorRequest{DeviceID: device.ID})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.QueueEmulatorCommand(session.ID, EmulatorCommandRequest{Command: "factoryReset"}); err == nil {
		t.Fatal("expected unsupported emulator command error")
	}
	if _, err := manager.DetachEmulatorSession(session.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.QueueEmulatorCommand(session.ID, EmulatorCommandRequest{Command: "tap"}); err == nil {
		t.Fatal("expected inactive emulator session error")
	}
}

func TestComputerActionClaimMarksQueuedActionsRunning(t *testing.T) {
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	first, err := manager.CreateComputerAction(CreateComputerActionRequest{Kind: "browser.reload"})
	if err != nil {
		t.Fatal(err)
	}
	second, err := manager.CreateComputerAction(CreateComputerActionRequest{Kind: "browser.stop"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.CreateComputerAction(CreateComputerActionRequest{Kind: "keyboard.type"}); err != nil {
		t.Fatal(err)
	}

	claimed, err := manager.ClaimComputerActions(ClaimComputerActionsRequest{
		KindPrefix: "browser.",
		Limit:      1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(claimed) != 1 || claimed[0].ID != first.ID || claimed[0].Status != ComputerActionRunning {
		t.Fatalf("unexpected claimed actions: %#v", claimed)
	}
	queuedBrowser := manager.ListComputerActions(ComputerActionQueued, "browser.")
	if len(queuedBrowser) != 1 || queuedBrowser[0].ID != second.ID {
		t.Fatalf("expected only second browser action queued, got %#v", queuedBrowser)
	}
	running := manager.ListComputerActions(ComputerActionRunning, "browser.")
	if len(running) != 1 || running[0].ID != first.ID {
		t.Fatalf("expected first browser action running, got %#v", running)
	}
}

func TestEmulatorDeviceUpdateAndDetach(t *testing.T) {
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	device, err := manager.RegisterEmulatorDevice(RegisterEmulatorDeviceRequest{
		Name:     "Pixel",
		Platform: "android",
	})
	if err != nil {
		t.Fatal(err)
	}
	device, err = manager.UpdateEmulatorDevice(device.ID, UpdateEmulatorDeviceRequest{
		Runtime: "adb",
		Status:  EmulatorDeviceError,
		Error:   "offline",
	})
	if err != nil {
		t.Fatal(err)
	}
	if device.Runtime != "adb" || device.Status != EmulatorDeviceError || device.Error != "offline" {
		t.Fatalf("unexpected updated device: %#v", device)
	}
	session, err := manager.AttachEmulator(AttachEmulatorRequest{DeviceID: device.ID})
	if err != nil {
		t.Fatal(err)
	}
	session, err = manager.DetachEmulatorSession(session.ID)
	if err != nil {
		t.Fatal(err)
	}
	if session.Active {
		t.Fatalf("detached session should be inactive: %#v", session)
	}
}

func TestEmulatorDeviceRejectsUnsupportedPlatform(t *testing.T) {
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.RegisterEmulatorDevice(RegisterEmulatorDeviceRequest{
		Name:     "Web emulator",
		Platform: "web",
	}); err == nil || !strings.Contains(err.Error(), "ios or android") {
		t.Fatalf("expected unsupported emulator platform rejection, got %v", err)
	}
	if _, err := manager.RegisterEmulatorDevice(RegisterEmulatorDeviceRequest{
		Name:     "iPhone",
		Platform: "ios",
	}); err != nil {
		t.Fatal(err)
	}
}

func TestNativeProviderRegistrationUpdatesSubsystemStatus(t *testing.T) {
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	provider, err := manager.RegisterNativeProvider(RegisterNativeProviderRequest{
		Subsystem:    "browser",
		Name:         "tauri-webview",
		Capabilities: []string{"tabs", "screenshots", "tabs"},
		Message:      "ready",
	})
	if err != nil {
		t.Fatal(err)
	}
	if provider.ID != "browser:tauri-webview" {
		t.Fatalf("unexpected provider id: %#v", provider)
	}
	status := manager.SubsystemStatus("browser")
	if status.Status != "ready" || !status.Configured || len(status.Capabilities) != 2 {
		t.Fatalf("unexpected browser subsystem status: %#v", status)
	}
	if _, err := manager.RegisterNativeProvider(RegisterNativeProviderRequest{
		Subsystem: "emulator",
		Name:      "simctl",
		Status:    "degraded",
		Message:   "booting slowly",
	}); err != nil {
		t.Fatal(err)
	}
	emulatorStatus := manager.SubsystemStatus("emulator")
	if emulatorStatus.Status != "degraded" || !emulatorStatus.Configured {
		t.Fatalf("unexpected degraded emulator status: %#v", emulatorStatus)
	}
	if _, err := manager.RegisterNativeProvider(RegisterNativeProviderRequest{
		Subsystem: "computer",
		Name:      "accessibility",
		Status:    "error",
		Message:   "permission denied",
	}); err != nil {
		t.Fatal(err)
	}
	computerStatus := manager.SubsystemStatus("computer")
	if computerStatus.Status != "error" || computerStatus.Configured {
		t.Fatalf("unexpected error computer status: %#v", computerStatus)
	}
	if _, err := manager.RegisterNativeProvider(RegisterNativeProviderRequest{
		Subsystem: "browser",
		Name:      "bad-provider",
		Status:    "maybe",
	}); err == nil {
		t.Fatal("expected invalid provider status to be rejected")
	}
	if _, err := manager.RegisterNativeProvider(RegisterNativeProviderRequest{
		Subsystem: "source-control",
		Name:      "git",
		Status:    "ready",
	}); err == nil {
		t.Fatal("expected invalid provider subsystem to be rejected")
	}
	if _, err := manager.RegisterNativeProvider(RegisterNativeProviderRequest{
		ID:        "computer:accessibility",
		Subsystem: "browser",
		Name:      "tauri-webview",
		Status:    "ready",
	}); err == nil {
		t.Fatal("expected provider id from different subsystem to be rejected")
	}
}

func TestNativeProviderStaleRegistrationsDoNotReportReady(t *testing.T) {
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	provider, err := manager.RegisterNativeProvider(RegisterNativeProviderRequest{
		Subsystem: "browser",
		Name:      "tauri-webview",
		Status:    "ready",
	})
	if err != nil {
		t.Fatal(err)
	}
	provider.LastSeenAt = time.Now().UTC().Add(-nativeProviderLivenessTTL - time.Second)
	manager.mu.Lock()
	manager.nativeProviders[provider.ID] = provider
	manager.mu.Unlock()

	if providers := manager.ListNativeProviders("browser"); len(providers) != 0 {
		t.Fatalf("expected stale provider to be hidden, got %#v", providers)
	}
	if status := manager.SubsystemStatus("browser"); status.Status != "missing" || status.Configured {
		t.Fatalf("stale provider should not configure subsystem: %#v", status)
	}
}

func TestNativeProviderStaleStateIsNotRestored(t *testing.T) {
	dir := t.TempDir()
	store, err := newFileStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.save(persistedState{
		NativeProviders: []NativeProviderRegistration{
			{
				ID:         "browser:old",
				Subsystem:  "browser",
				Name:       "old",
				Status:     "ready",
				LastSeenAt: time.Now().UTC().Add(-nativeProviderLivenessTTL - time.Second),
			},
		},
	}); err != nil {
		t.Fatal(err)
	}
	manager, err := NewManager(dir, nil)
	if err != nil {
		t.Fatal(err)
	}

	if providers := manager.ListNativeProviders(""); len(providers) != 0 {
		t.Fatalf("expected stale provider state to be dropped, got %#v", providers)
	}
}

func TestMobileRelayPairingAndProjection(t *testing.T) {
	dir := t.TempDir()
	manager, err := NewManager(dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	code, err := manager.CreateMobileRelayPairingCode(CreateMobileRelayPairingCodeRequest{
		Endpoint:      "ws://127.0.0.1:17777/v1/mobile-relay",
		WorkspaceName: "repo",
		TTLSeconds:    60,
	})
	if err != nil {
		t.Fatal(err)
	}
	status := manager.MobileRelayStatus()
	if !status.Configured || status.ActivePairingCodes != 1 {
		t.Fatalf("unexpected mobile relay status: %#v", status)
	}
	if !slices.Contains(status.Capabilities, "browser-download-projection") ||
		!slices.Contains(status.Capabilities, "computer-action-projection") {
		t.Fatalf("mobile relay status missing projection capabilities: %#v", status.Capabilities)
	}
	record, err := manager.PairMobileRelayDevice(PairMobileRelayDeviceRequest{
		PairingCode: code.Code,
		Device: MobileRelayDeviceIdentity{
			DeviceID:   "device-1",
			DeviceName: "Phone",
			Platform:   "ios",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if record.PairingSecretRef == "" || record.RelayID != status.RelayID {
		t.Fatalf("unexpected pairing record: %#v", record)
	}
	repoDir := t.TempDir()
	project, err := manager.CreateProject(CreateProjectRequest{
		Name:     "repo",
		Path:     repoDir,
		Provider: "gitlab",
	})
	if err != nil {
		t.Fatal(err)
	}
	tab, err := manager.CreateBrowserTab(CreateBrowserTabRequest{
		ProjectID: project.ID,
		Title:     "Docs",
		URL:       "https://example.test",
	})
	if err != nil {
		t.Fatal(err)
	}
	mobileCapturedAt := time.Now().UTC()
	if _, err := manager.UpdateBrowserTab(tab.ID, UpdateBrowserTabRequest{
		Status:               BrowserTabReady,
		ScreenshotURI:        "file:///tmp/mobile-tab.png",
		ScreenshotCapturedAt: &mobileCapturedAt,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.SetBrowserPermission(SetBrowserPermissionRequest{
		Origin: "https://example.test",
		Name:   "clipboard",
		State:  BrowserPermissionDenied,
	}); err != nil {
		t.Fatal(err)
	}
	download, err := manager.CreateBrowserDownload(CreateBrowserDownloadRequest{
		TabID:         tab.ID,
		URL:           "https://example.test/archive.zip",
		Filename:      "archive.zip",
		Status:        BrowserDownloadInProgress,
		BytesReceived: 120,
		TotalBytes:    512,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repoDir, "README.md"), []byte("mobile files\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	automation, err := manager.CreateAutomation(CreateAutomationRequest{
		Name:    "Nightly check",
		Enabled: true,
		Schedule: AutomationSchedule{
			Kind: AutomationScheduleInterval, IntervalSeconds: 3600,
		},
		Action: AutomationAction{Kind: AutomationActionSendMessage},
	})
	if err != nil {
		t.Fatal(err)
	}
	externalItem, err := manager.UpsertExternalWorkItem(UpsertExternalWorkItemRequest{
		Provider:     "gitlab",
		Kind:         ExternalWorkItemReview,
		ExternalID:   "mr-7",
		Title:        "Rewrite relay",
		Status:       ExternalWorkItemInProgress,
		RepositoryID: "repo-1",
		WorkspaceID:  project.ID,
		ReviewKind:   "merge-request",
	})
	if err != nil {
		t.Fatal(err)
	}
	release, err := manager.CreateReleasePlan(CreateReleasePlanRequest{Version: "1.2.3", Channel: "beta"})
	if err != nil {
		t.Fatal(err)
	}
	provider, err := manager.RegisterNativeProvider(RegisterNativeProviderRequest{
		Subsystem:    "browser",
		Name:         "tauri-webview",
		Status:       "ready",
		Capabilities: []string{"tabs"},
	})
	if err != nil {
		t.Fatal(err)
	}
	action, err := manager.CreateComputerAction(CreateComputerActionRequest{
		Kind:   "browser.reload",
		Target: tab.ID,
		Payload: map[string]interface{}{
			"command": "reload",
			"tabId":   tab.ID,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	emulatorDevice, err := manager.RegisterEmulatorDevice(RegisterEmulatorDeviceRequest{
		Name:     "Pixel",
		Platform: "android",
		Runtime:  "adb",
	})
	if err != nil {
		t.Fatal(err)
	}
	emulatorSession, err := manager.AttachEmulator(AttachEmulatorRequest{
		DeviceID:  emulatorDevice.ID,
		ProjectID: project.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	setting, err := manager.SetRuntimeSetting(SetRuntimeSettingRequest{
		Key:   "editor.fontSize",
		Value: map[string]interface{}{"value": 14},
	})
	if err != nil {
		t.Fatal(err)
	}
	keybinding, err := manager.SetKeybinding(SetKeybindingRequest{
		Command:     "workbench.save",
		Accelerator: "CmdOrCtrl+S",
		Context:     "workbench",
	})
	if err != nil {
		t.Fatal(err)
	}
	task, err := manager.CreateTask(CreateTaskRequest{Title: "Wire mobile orchestration", Assignee: "codex"})
	if err != nil {
		t.Fatal(err)
	}
	message, err := manager.SendMessage(SendMessageRequest{
		To:      "codex",
		Subject: "Mobile orchestration",
		Type:    MessageDispatch,
	})
	if err != nil {
		t.Fatal(err)
	}
	dispatch, err := manager.DispatchTask(DispatchTaskRequest{
		TaskID:   task.ID,
		Assignee: "codex",
	})
	if err != nil {
		t.Fatal(err)
	}
	snapshot := manager.MobileRelaySnapshot([]ProjectionKind{ProjectionSourceControl, ProjectionBrowser}, 20)
	if len(snapshot.SourceControl) != 1 || snapshot.SourceControl[0].Provider != "gitlab" {
		t.Fatalf("unexpected source projection: %#v", snapshot.SourceControl)
	}
	if len(snapshot.Browser) != 1 || snapshot.Browser[0].Status != "ready" {
		t.Fatalf("unexpected browser projection: %#v", snapshot.Browser)
	}
	if len(snapshot.Browser[0].Permissions) != 1 || snapshot.Browser[0].Permissions[0].State != "denied" {
		t.Fatalf("unexpected browser permissions: %#v", snapshot.Browser[0].Permissions)
	}
	if snapshot.Browser[0].Screenshot == nil || snapshot.Browser[0].Screenshot.URI != "file:///tmp/mobile-tab.png" {
		t.Fatalf("unexpected browser screenshot: %#v", snapshot.Browser[0].Screenshot)
	}
	if len(snapshot.BrowserDownloads) != 1 || snapshot.BrowserDownloads[0].DownloadID != download.ID {
		t.Fatalf("unexpected browser download projection: %#v", snapshot.BrowserDownloads)
	}
	browserEvent, ok := manager.MobileRelayEvent(RuntimeEvent{Topic: "browser.changed", Timestamp: time.Now().UTC()}, []ProjectionKind{ProjectionBrowser})
	if !ok {
		t.Fatal("expected browser.changed to produce mobile projection event")
	}
	if payload, ok := browserEvent.Payload.(map[string]interface{}); !ok || len(payload["browserDownloads"].([]BrowserDownloadProjection)) != 1 {
		t.Fatalf("unexpected browser event payload: %#v", browserEvent.Payload)
	}
	fileSnapshot := manager.MobileRelaySnapshot([]ProjectionKind{ProjectionFiles}, 20)
	if len(fileSnapshot.Files) != 1 || fileSnapshot.Files[0].Path != "README.md" {
		t.Fatalf("unexpected file projection: %#v", fileSnapshot.Files)
	}
	fileEvent, ok := manager.MobileRelayEvent(RuntimeEvent{Topic: "file.changed", Timestamp: time.Now().UTC()}, []ProjectionKind{ProjectionFiles})
	if !ok {
		t.Fatal("expected file.changed to produce mobile projection event")
	}
	if payload, ok := fileEvent.Payload.(map[string]interface{}); !ok || len(payload["files"].([]FileProjection)) != 1 {
		t.Fatalf("unexpected file event payload: %#v", fileEvent.Payload)
	}
	operationsSnapshot := manager.MobileRelaySnapshot([]ProjectionKind{
		ProjectionAutomations,
		ProjectionExternalTasks,
		ProjectionReleases,
		ProjectionProviders,
		ProjectionComputer,
		ProjectionEmulator,
		ProjectionSettings,
	}, 20)
	if len(operationsSnapshot.Automations) != 1 || operationsSnapshot.Automations[0].AutomationID != automation.ID {
		t.Fatalf("unexpected automation projection: %#v", operationsSnapshot.Automations)
	}
	if len(operationsSnapshot.ExternalTasks) != 1 || operationsSnapshot.ExternalTasks[0].ItemID != externalItem.ID {
		t.Fatalf("unexpected external task projection: %#v", operationsSnapshot.ExternalTasks)
	}
	if len(operationsSnapshot.Releases) != 1 || operationsSnapshot.Releases[0].ReleaseID != release.ID {
		t.Fatalf("unexpected release projection: %#v", operationsSnapshot.Releases)
	}
	if operationsSnapshot.Releases[0].Ready || operationsSnapshot.Releases[0].BlockedReason == "" {
		t.Fatalf("expected release projection readiness state, got %#v", operationsSnapshot.Releases[0])
	}
	if len(operationsSnapshot.Providers) != 1 || operationsSnapshot.Providers[0].ProviderID != provider.ID {
		t.Fatalf("unexpected provider projection: %#v", operationsSnapshot.Providers)
	}
	if len(operationsSnapshot.ComputerActions) != 1 || operationsSnapshot.ComputerActions[0].ActionID != action.ID {
		t.Fatalf("unexpected computer action projection: %#v", operationsSnapshot.ComputerActions)
	}
	if len(operationsSnapshot.EmulatorDevices) != 1 || operationsSnapshot.EmulatorDevices[0].DeviceID != emulatorDevice.ID {
		t.Fatalf("unexpected emulator device projection: %#v", operationsSnapshot.EmulatorDevices)
	}
	if len(operationsSnapshot.EmulatorSessions) != 1 || operationsSnapshot.EmulatorSessions[0].SessionID != emulatorSession.ID {
		t.Fatalf("unexpected emulator session projection: %#v", operationsSnapshot.EmulatorSessions)
	}
	if len(operationsSnapshot.Settings) != 1 || operationsSnapshot.Settings[0].SettingID != setting.ID {
		t.Fatalf("unexpected setting projection: %#v", operationsSnapshot.Settings)
	}
	if len(operationsSnapshot.Keybindings) != 1 || operationsSnapshot.Keybindings[0].KeybindingID != keybinding.ID {
		t.Fatalf("unexpected keybinding projection: %#v", operationsSnapshot.Keybindings)
	}
	releaseEvent, ok := manager.MobileRelayEvent(RuntimeEvent{Topic: "release.changed", Timestamp: time.Now().UTC()}, []ProjectionKind{ProjectionReleases})
	if !ok {
		t.Fatal("expected release.changed to produce mobile projection event")
	}
	if payload, ok := releaseEvent.Payload.(map[string]interface{}); !ok || len(payload["releases"].([]ReleaseProjection)) != 1 {
		t.Fatalf("unexpected release event payload: %#v", releaseEvent.Payload)
	}
	orchestrationSnapshot := manager.MobileRelaySnapshot([]ProjectionKind{ProjectionOrchestration}, 20)
	if len(orchestrationSnapshot.Tasks) != 1 || orchestrationSnapshot.Tasks[0].TaskID != task.ID {
		t.Fatalf("unexpected task projection: %#v", orchestrationSnapshot.Tasks)
	}
	if len(orchestrationSnapshot.Messages) != 1 || orchestrationSnapshot.Messages[0].MessageID != message.ID {
		t.Fatalf("unexpected message projection: %#v", orchestrationSnapshot.Messages)
	}
	if len(orchestrationSnapshot.Dispatches) != 1 || orchestrationSnapshot.Dispatches[0].DispatchID != dispatch.ID {
		t.Fatalf("unexpected dispatch projection: %#v", orchestrationSnapshot.Dispatches)
	}
	orchestrationEvent, ok := manager.MobileRelayEvent(RuntimeEvent{Topic: "orchestration.changed", Timestamp: time.Now().UTC()}, []ProjectionKind{ProjectionOrchestration})
	if !ok {
		t.Fatal("expected orchestration.changed to produce mobile projection event")
	}
	if payload, ok := orchestrationEvent.Payload.(map[string]interface{}); !ok || len(payload["tasks"].([]TaskProjection)) != 1 {
		t.Fatalf("unexpected orchestration event payload: %#v", orchestrationEvent.Payload)
	}
	providerEvent, ok := manager.MobileRelayEvent(RuntimeEvent{Topic: "provider.changed", Timestamp: time.Now().UTC()}, []ProjectionKind{ProjectionProviders})
	if !ok {
		t.Fatal("expected provider.changed to produce mobile projection event")
	}
	if payload, ok := providerEvent.Payload.(map[string]interface{}); !ok || len(payload["providers"].([]ProviderProjection)) != 1 {
		t.Fatalf("unexpected provider event payload: %#v", providerEvent.Payload)
	}
	computerEvent, ok := manager.MobileRelayEvent(RuntimeEvent{Topic: "computer.changed", Timestamp: time.Now().UTC()}, []ProjectionKind{ProjectionComputer})
	if !ok {
		t.Fatal("expected computer.changed to produce mobile projection event")
	}
	if payload, ok := computerEvent.Payload.(map[string]interface{}); !ok || len(payload["computerActions"].([]ComputerActionProjection)) != 1 {
		t.Fatalf("unexpected computer event payload: %#v", computerEvent.Payload)
	}
	emulatorEvent, ok := manager.MobileRelayEvent(RuntimeEvent{Topic: "emulator.changed", Timestamp: time.Now().UTC()}, []ProjectionKind{ProjectionEmulator})
	if !ok {
		t.Fatal("expected emulator.changed to produce mobile projection event")
	}
	if payload, ok := emulatorEvent.Payload.(map[string]interface{}); !ok || len(payload["emulatorDevices"].([]EmulatorDeviceProjection)) != 1 {
		t.Fatalf("unexpected emulator event payload: %#v", emulatorEvent.Payload)
	}
	settingsEvent, ok := manager.MobileRelayEvent(RuntimeEvent{Topic: "settings.changed", Timestamp: time.Now().UTC()}, []ProjectionKind{ProjectionSettings})
	if !ok {
		t.Fatal("expected settings.changed to produce mobile projection event")
	}
	if payload, ok := settingsEvent.Payload.(map[string]interface{}); !ok || len(payload["settings"].([]SettingProjection)) != 1 {
		t.Fatalf("unexpected settings event payload: %#v", settingsEvent.Payload)
	}

	reloaded, err := NewManager(dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := reloaded.ListMobileRelayPairings(); len(got) != 1 || got[0].DeviceID != "device-1" {
		t.Fatalf("mobile relay pairing was not persisted: %#v", got)
	}
	if reloaded.MobileRelayStatus().RelayID != status.RelayID {
		t.Fatalf("relay id was not persisted")
	}
}

func TestMobileRelayPairingSecretMustMatch(t *testing.T) {
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	code, err := manager.CreateMobileRelayPairingCode(CreateMobileRelayPairingCodeRequest{
		Endpoint:   "ws://127.0.0.1:17777/v1/mobile-relay",
		TTLSeconds: 60,
	})
	if err != nil {
		t.Fatal(err)
	}
	record, err := manager.PairMobileRelayDevice(PairMobileRelayDeviceRequest{
		PairingCode: code.Code,
		Device: MobileRelayDeviceIdentity{
			DeviceID:   "device-1",
			DeviceName: "Phone",
			Platform:   "ios",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := manager.TouchMobileRelayPairing(record.DeviceID, record.PairingSecretRef+"x"); ok {
		t.Fatal("expected wrong pairing secret to be rejected")
	}
	if _, ok := manager.TouchMobileRelayPairing(record.DeviceID, record.PairingSecretRef); !ok {
		t.Fatal("expected exact pairing secret to be accepted")
	}
}

func TestGitDiffReadsUnstagedPatch(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git executable is not available")
	}
	repo := t.TempDir()
	runGitCommand(t, repo, "init")
	runGitCommand(t, repo, "config", "user.email", "dev@example.test")
	runGitCommand(t, repo, "config", "user.name", "Dev")
	if err := os.WriteFile(filepath.Join(repo, "README.md"), []byte("one\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	runGitCommand(t, repo, "add", "README.md")
	runGitCommand(t, repo, "commit", "-m", "init")
	if err := os.WriteFile(filepath.Join(repo, "README.md"), []byte("two\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	project, err := manager.CreateProject(CreateProjectRequest{Name: "repo", Path: repo})
	if err != nil {
		t.Fatal(err)
	}
	diff, err := manager.GitDiff(context.Background(), project.ID, "README.md", false)
	if err != nil {
		t.Fatal(err)
	}
	if diff.FilePath != "README.md" || diff.Cached {
		t.Fatalf("unexpected diff metadata: %#v", diff)
	}
	if !strings.Contains(diff.Patch, "-one") || !strings.Contains(diff.Patch, "+two") {
		t.Fatalf("diff patch did not contain file changes:\n%s", diff.Patch)
	}
	contentDiff, err := manager.GitFileDiff(context.Background(), GitFileDiffRequest{
		ProjectID: project.ID,
		FilePath:  "README.md",
	})
	if err != nil {
		t.Fatal(err)
	}
	if contentDiff.Kind != "text" ||
		contentDiff.OriginalContent != "one\n" ||
		contentDiff.ModifiedContent != "two\n" {
		t.Fatalf("unexpected content diff: %#v", contentDiff)
	}
	if _, err := manager.MutateGit(context.Background(), GitMutationRequest{
		ProjectID: project.ID,
		Operation: "stage",
		FilePath:  "README.md",
	}); err != nil {
		t.Fatal(err)
	}
	commit, err := manager.MutateGit(context.Background(), GitMutationRequest{
		ProjectID: project.ID,
		Operation: "commit",
		Message:   "update readme",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !commit.Success {
		t.Fatalf("expected commit to succeed: %#v", commit)
	}
	compare, err := manager.GitBranchCompare(context.Background(), GitBranchCompareRequest{
		ProjectID: project.ID,
		BaseRef:   "HEAD~1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if compare.Summary.Status != "ready" ||
		compare.Summary.ChangedFiles != 1 ||
		len(compare.Entries) != 1 ||
		compare.Entries[0].Path != "README.md" {
		t.Fatalf("unexpected branch compare: %#v", compare)
	}
	refDiff, err := manager.GitRefFileDiff(context.Background(), GitRefFileDiffRequest{
		ProjectID: project.ID,
		LeftRef:   "HEAD~1",
		RightRef:  "HEAD",
		FilePath:  "README.md",
	})
	if err != nil {
		t.Fatal(err)
	}
	if refDiff.Kind != "text" ||
		refDiff.OriginalContent != "one\n" ||
		refDiff.ModifiedContent != "two\n" {
		t.Fatalf("unexpected ref file diff: %#v", refDiff)
	}
	commitCompare, err := manager.GitCommitCompare(context.Background(), GitCommitCompareRequest{
		ProjectID: project.ID,
		CommitID:  "HEAD",
	})
	if err != nil {
		t.Fatal(err)
	}
	if commitCompare.Summary.Status != "ready" ||
		commitCompare.Summary.ChangedFiles != 1 ||
		len(commitCompare.Entries) != 1 ||
		commitCompare.Entries[0].Path != "README.md" {
		t.Fatalf("unexpected commit compare: %#v", commitCompare)
	}
	history, err := manager.GitHistory(context.Background(), GitHistoryRequest{
		ProjectID: project.ID,
		Limit:     10,
		BaseRef:   "HEAD~1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(history.Items) != 2 ||
		history.CurrentRef == nil ||
		history.BaseRef == nil ||
		!history.HasOutgoingChanges {
		t.Fatalf("unexpected history: %#v", history)
	}
	if err := os.WriteFile(filepath.Join(repo, "README.md"), []byte("three\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.MutateGit(context.Background(), GitMutationRequest{
		ProjectID: project.ID,
		Operation: "discard",
		FilePath:  "README.md",
	}); err != nil {
		t.Fatal(err)
	}
	afterDiscard, err := os.ReadFile(filepath.Join(repo, "README.md"))
	if err != nil {
		t.Fatal(err)
	}
	if string(afterDiscard) != "two\n" {
		t.Fatalf("discard did not restore committed content: %q", string(afterDiscard))
	}
}

func TestGitDiffRejectsEscapingPathspec(t *testing.T) {
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	project, err := manager.CreateProject(CreateProjectRequest{Name: "repo", Path: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.GitDiff(context.Background(), project.ID, "../outside.txt", false); !errors.Is(err, ErrInvalidPath) {
		t.Fatalf("expected relative path escape to be rejected, got %v", err)
	}
	if _, err := manager.GitDiff(context.Background(), project.ID, filepath.Join(t.TempDir(), "outside.txt"), false); !errors.Is(err, ErrInvalidPath) {
		t.Fatalf("expected absolute path escape to be rejected, got %v", err)
	}
}

func TestSessionRunsCommand(t *testing.T) {
	dir := t.TempDir()
	manager, err := NewManager(dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	project, err := manager.CreateProject(CreateProjectRequest{Name: "repo", Path: dir})
	if err != nil {
		t.Fatal(err)
	}
	session, err := manager.StartSession(context.Background(), StartSessionRequest{
		ProjectID: project.ID,
		Command:   testEchoCommand(),
	})
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		current := manager.ListSessions()[0]
		if current.Status == SessionExited {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	tail, err := manager.TailSession(session.ID, 10)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, chunk := range tail.Chunks {
		if strings.Contains(chunk.Content, "pebble") {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected command output, got %#v", tail.Chunks)
	}
}

func TestResizeSessionUpdatesLiveSessionSize(t *testing.T) {
	dir := t.TempDir()
	manager, err := NewManager(dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	project, err := manager.CreateProject(CreateProjectRequest{Name: "repo", Path: dir})
	if err != nil {
		t.Fatal(err)
	}
	session, err := manager.StartSession(context.Background(), StartSessionRequest{
		ProjectID: project.ID,
		Command:   testSleepCommand(),
		Cols:      80,
		Rows:      24,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		_, _ = manager.StopSession(session.ID)
	}()

	resized, err := manager.ResizeSession(session.ID, SessionResizeRequest{Cols: 132, Rows: 43})
	if err != nil {
		t.Fatal(err)
	}
	if resized.Cols != 132 || resized.Rows != 43 {
		t.Fatalf("expected resized snapshot, got cols=%d rows=%d", resized.Cols, resized.Rows)
	}
	current := manager.ListSessions()[0]
	if current.Cols != 132 || current.Rows != 43 {
		t.Fatalf("expected listed session size to update, got cols=%d rows=%d", current.Cols, current.Rows)
	}
}

func TestClearSessionBufferDropsTail(t *testing.T) {
	dir := t.TempDir()
	manager, err := NewManager(dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	project, err := manager.CreateProject(CreateProjectRequest{Name: "repo", Path: dir})
	if err != nil {
		t.Fatal(err)
	}
	session, err := manager.StartSession(context.Background(), StartSessionRequest{
		ProjectID: project.ID,
		Command:   testEchoCommand(),
	})
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		current := manager.ListSessions()[0]
		if current.Status == SessionExited {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if tail, err := manager.TailSession(session.ID, 10); err != nil || len(tail.Chunks) == 0 {
		t.Fatalf("expected output before clear, tail=%#v err=%v", tail, err)
	}
	cleared, err := manager.ClearSessionBuffer(session.ID)
	if err != nil {
		t.Fatal(err)
	}
	if cleared.OutputChunks != 0 {
		t.Fatalf("expected cleared snapshot to report 0 chunks, got %d", cleared.OutputChunks)
	}
	tail, err := manager.TailSession(session.ID, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(tail.Chunks) != 0 {
		t.Fatalf("expected cleared tail, got %#v", tail.Chunks)
	}
}

func TestSessionRejectsCwdOutsideWorkspace(t *testing.T) {
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	project, err := manager.CreateProject(CreateProjectRequest{Name: "repo", Path: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.StartSession(context.Background(), StartSessionRequest{
		ProjectID: project.ID,
		Cwd:       t.TempDir(),
		Command:   testEchoCommand(),
	}); !errors.Is(err, ErrInvalidPath) {
		t.Fatalf("expected cwd outside workspace to be rejected, got %v", err)
	}
}

func TestSessionRejectsWorktreeFromDifferentProject(t *testing.T) {
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	firstProject, err := manager.CreateProject(CreateProjectRequest{Name: "one", Path: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	secondProject, err := manager.CreateProject(CreateProjectRequest{Name: "two", Path: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	otherWorktree, err := manager.CreateWorktree(context.Background(), CreateWorktreeRequest{
		ProjectID: secondProject.ID,
		Path:      t.TempDir(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.StartSession(context.Background(), StartSessionRequest{
		ProjectID:  firstProject.ID,
		WorktreeID: otherWorktree.ID,
		Command:    testEchoCommand(),
	}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected cross-project worktree to be rejected, got %v", err)
	}
}
