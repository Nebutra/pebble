package runtimecore

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestApplyGitStatusLinesParsesBranchAndChanges(t *testing.T) {
	projection := SourceControlProjection{
		Branch:     "fallback",
		SyncStatus: "clean",
	}
	applyGitStatusLines(&projection, []string{
		"## feature...origin/feature [ahead 2, behind 1]",
		" M src/app.ts",
		"?? docs/new.md",
		"R  old.txt -> new.txt",
		"D  deleted.go",
		"M  staged.ts",
		"MM both.ts",
		"AM added-modified.ts",
	})
	if projection.Branch != "feature" {
		t.Fatalf("expected feature branch, got %q", projection.Branch)
	}
	if projection.Ahead != 2 || projection.Behind != 1 {
		t.Fatalf("expected ahead 2 behind 1, got ahead %d behind %d", projection.Ahead, projection.Behind)
	}
	if projection.SyncStatus != "dirty" {
		t.Fatalf("expected dirty sync status, got %q", projection.SyncStatus)
	}
	expected := []SourceControlChange{
		{Path: "src/app.ts", Status: "modified", Area: "unstaged"},
		{Path: "docs/new.md", Status: "untracked", Area: "untracked"},
		{Path: "new.txt", Status: "renamed", Area: "staged", OldPath: "old.txt"},
		{Path: "deleted.go", Status: "deleted", Area: "staged"},
		{Path: "staged.ts", Status: "modified", Area: "staged"},
		{Path: "both.ts", Status: "modified", Area: "staged"},
		{Path: "both.ts", Status: "modified", Area: "unstaged"},
		{Path: "added-modified.ts", Status: "added", Area: "staged"},
		{Path: "added-modified.ts", Status: "modified", Area: "unstaged"},
	}
	if len(projection.Changes) != len(expected) {
		t.Fatalf("expected %d changes, got %#v", len(expected), projection.Changes)
	}
	for index, want := range expected {
		if projection.Changes[index] != want {
			t.Fatalf("change %d mismatch: want %#v got %#v", index, want, projection.Changes[index])
		}
	}
}

func TestApplyGitStatusLinesParsesNoCommitsBranch(t *testing.T) {
	projection := SourceControlProjection{Branch: "fallback"}
	applyGitStatusLines(&projection, []string{"## No commits yet on main"})
	if projection.Branch != "main" {
		t.Fatalf("expected main branch, got %q", projection.Branch)
	}
	if projection.SyncStatus != "clean" {
		t.Fatalf("expected clean sync status, got %q", projection.SyncStatus)
	}
}

func TestSourceProjectionFromGitStatusReadsRepository(t *testing.T) {
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
	if err := os.WriteFile(filepath.Join(repo, "new.txt"), []byte("new\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	projection := sourceProjectionFromGitStatus("github", "repo", "workspace", repo, "fallback", "change")
	if projection.Branch == "" || projection.Branch == "fallback" {
		t.Fatalf("expected branch from git status, got %q", projection.Branch)
	}
	if projection.SyncStatus != "dirty" {
		t.Fatalf("expected dirty git projection, got %q", projection.SyncStatus)
	}
	assertProjectionChange(t, projection.Changes, "README.md", "modified")
	assertProjectionChange(t, projection.Changes, "new.txt", "untracked")
}

func TestSourceProjectionFromGitStatusUnknownWhenUnreadable(t *testing.T) {
	projection := sourceProjectionFromGitStatus("gitlab", "repo", "workspace", "", "feature", "merge-request")
	if projection.SyncStatus != "unknown" {
		t.Fatalf("expected unknown sync status, got %q", projection.SyncStatus)
	}
	if projection.Branch != "feature" || projection.Provider != "gitlab" || projection.ReviewKind != "merge-request" {
		t.Fatalf("unexpected fallback projection: %#v", projection)
	}
}

func TestGitProviderKindKeepsProviderNeutralValues(t *testing.T) {
	cases := map[string]string{
		"azuredevops": "azure-devops",
		"azure":       "azure-devops",
		"generic":     "generic",
		"":            "git",
	}
	for input, want := range cases {
		if got := gitProviderKind(input); got != want {
			t.Fatalf("gitProviderKind(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestUpdateSourceControlProjectionOverridesRemoteUnknown(t *testing.T) {
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	project, err := manager.CreateProject(CreateProjectRequest{
		Name:         "remote",
		Path:         "/remote/repo",
		LocationKind: "ssh",
		HostID:       "host-1",
		Provider:     "gitlab",
	})
	if err != nil {
		t.Fatal(err)
	}
	before := manager.ListSourceControlProjections(SourceControlProjectionFilter{ProjectID: project.ID})
	if len(before) != 1 || before[0].SyncStatus != "unknown" {
		t.Fatalf("expected initial remote projection to be unknown, got %#v", before)
	}

	updated, err := manager.UpdateSourceControlProjection(UpdateSourceControlProjectionRequest{
		RepositoryID: project.ID,
		WorkspaceID:  project.ID,
		Provider:     "gitlab",
		ReviewKind:   "merge-request",
		Branch:       "feature",
		BaseBranch:   "main",
		Ahead:        2,
		Changes: []SourceControlChange{
			{Path: " README.md ", Status: "M", Area: "staged"},
			{Path: "", Status: "modified"},
			{Path: "skip.bin", Status: "unknown"},
			{Path: "../outside.txt", Status: "modified"},
			{Path: filepath.Join(t.TempDir(), "outside.txt"), Status: "modified"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if updated.SyncStatus != "dirty" || updated.Branch != "feature" {
		t.Fatalf("unexpected updated projection: %#v", updated)
	}

	after := manager.ListSourceControlProjections(SourceControlProjectionFilter{ProjectID: project.ID})
	if len(after) != 1 || after[0].SyncStatus != "dirty" || len(after[0].Changes) != 1 {
		t.Fatalf("expected cached remote projection, got %#v", after)
	}
	assertProjectionChange(t, after[0].Changes, "README.md", "modified")
	if after[0].Changes[0].Area != "staged" {
		t.Fatalf("expected staged remote projection change, got %#v", after[0].Changes[0])
	}
}

func TestUpdateSourceControlProjectionRejectsForeignWorkspace(t *testing.T) {
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
	foreignWorktree, err := manager.CreateWorktree(context.Background(), CreateWorktreeRequest{
		ProjectID: secondProject.ID,
		Path:      t.TempDir(),
	})
	if err != nil {
		t.Fatal(err)
	}

	_, err = manager.UpdateSourceControlProjection(UpdateSourceControlProjectionRequest{
		RepositoryID: firstProject.ID,
		WorkspaceID:  foreignWorktree.ID,
		Branch:       "feature",
		SyncStatus:   "clean",
	})
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected foreign workspace to be rejected, got %v", err)
	}
}

func runGitCommand(t *testing.T, path string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", path}, args...)...)
	cmd.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1")
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v failed: %v\n%s", args, err, output)
	}
}

func assertProjectionChange(t *testing.T, changes []SourceControlChange, path string, status string) {
	t.Helper()
	for _, change := range changes {
		if change.Path == path && change.Status == status {
			return
		}
	}
	t.Fatalf("expected %s change for %s, got %#v", status, path, changes)
}
