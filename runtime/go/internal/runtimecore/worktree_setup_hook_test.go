package runtimecore

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func setupMarkerHookScript() string {
	if runtime.GOOS == "windows" {
		return "echo %PEBBLE_WORKTREE_PATH%> \"%PEBBLE_ROOT_PATH%\\setup-ran.txt\""
	}
	return `printf '%s' "$PEBBLE_WORKTREE_PATH" > "$PEBBLE_ROOT_PATH/setup-ran.txt"`
}

// The setup script is read from the new worktree, so the hook has to be
// committed before the checkout rather than just written to the repo root.
func commitPebbleYamlSetupHook(t *testing.T, repo string, script string) {
	t.Helper()
	content := "scripts:\n  setup: '" + strings.ReplaceAll(script, "'", "''") + "'\n"
	if err := os.WriteFile(filepath.Join(repo, "pebble.yaml"), []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	runGitCommand(t, repo, "add", "pebble.yaml")
	runGitCommand(t, repo, "commit", "-m", "setup hook")
}

func createWorktreeOverRest(t *testing.T, manager *Manager, project Project, decision string) (Worktree, string) {
	t.Helper()
	worktree, warning, err := manager.CreateWorktreeWithSetupHook(context.Background(), CreateWorktreeRequest{
		ProjectID:     project.ID,
		Path:          filepath.Join(t.TempDir(), "setup-worktree"),
		Branch:        "feature/setup-hook",
		Base:          "HEAD",
		ExecuteGit:    true,
		SetupDecision: decision,
	})
	if err != nil {
		t.Fatalf("CreateWorktreeWithSetupHook failed: %v", err)
	}
	return worktree, warning
}

func readSetupMarker(t *testing.T, repo string) (string, bool) {
	t.Helper()
	marker, err := os.ReadFile(filepath.Join(repo, "setup-ran.txt"))
	if errors.Is(err, os.ErrNotExist) {
		return "", false
	}
	if err != nil {
		t.Fatal(err)
	}
	return strings.TrimSpace(string(marker)), true
}

func TestRestWorktreeCreateRunsTheSetupHookWhenAskedTo(t *testing.T) {
	manager, project, repo := newGitBackedProject(t)
	commitPebbleYamlSetupHook(t, repo, setupMarkerHookScript())

	worktree, warning := createWorktreeOverRest(t, manager, project, "run")

	if warning != "" {
		t.Fatalf("expected no warning, got %q", warning)
	}
	marker, ok := readSetupMarker(t, repo)
	if !ok {
		t.Fatal("setup hook did not run")
	}
	if marker != worktree.Path {
		t.Fatalf("PEBBLE_WORKTREE_PATH = %q, want %q", marker, worktree.Path)
	}
}

func TestRestWorktreeCreateWarnsWhenASetupHookWasPassedOver(t *testing.T) {
	manager, project, repo := newGitBackedProject(t)
	commitPebbleYamlSetupHook(t, repo, setupMarkerHookScript())

	_, warning := createWorktreeOverRest(t, manager, project, "")

	if warning != worktreeSetupHookSkippedWarning {
		t.Fatalf("warning = %q, want %q", warning, worktreeSetupHookSkippedWarning)
	}
	if _, ok := readSetupMarker(t, repo); ok {
		t.Fatal("setup hook ran without an opt-in")
	}
}

func TestRestWorktreeCreateStaysSilentWhenTheSetupHookIsDeclined(t *testing.T) {
	manager, project, repo := newGitBackedProject(t)
	commitPebbleYamlSetupHook(t, repo, setupMarkerHookScript())

	_, warning := createWorktreeOverRest(t, manager, project, "skip")

	if warning != "" {
		t.Fatalf("expected no warning for a declined hook, got %q", warning)
	}
	if _, ok := readSetupMarker(t, repo); ok {
		t.Fatal("setup hook ran after being declined")
	}
}

func TestRestWorktreeCreateIsSilentWhenTheRepoHasNoSetupHook(t *testing.T) {
	manager, project, _ := newGitBackedProject(t)

	if _, warning := createWorktreeOverRest(t, manager, project, ""); warning != "" {
		t.Fatalf("expected no warning without a hook, got %q", warning)
	}
}

func TestSetupHookFailureIsReportedAsAWarning(t *testing.T) {
	manager, project, _ := newGitBackedProject(t)
	commitPebbleYamlSetupHook(t, project.Path, "echo dependencies-are-broken && exit 3")

	worktree, warning := createWorktreeOverRest(t, manager, project, "run")

	if !strings.Contains(warning, "setup hook failed") {
		t.Fatalf("warning = %q, want it to report the hook failure", warning)
	}
	if !strings.Contains(warning, "dependencies-are-broken") {
		t.Fatalf("warning = %q, want it to carry the hook output", warning)
	}
	// A failed setup script must not undo the worktree; the caller decides.
	if _, err := os.Stat(worktree.Path); err != nil {
		t.Fatalf("expected the worktree to survive a failed setup hook: %v", err)
	}
}

func TestSetupHookDoesNotRunAgainForAnExistingWorktree(t *testing.T) {
	manager, project, repo := newGitBackedProject(t)
	commitPebbleYamlSetupHook(t, repo, setupMarkerHookScript())
	worktree, _ := createWorktreeOverRest(t, manager, project, "run")
	if err := os.Remove(filepath.Join(repo, "setup-ran.txt")); err != nil {
		t.Fatal(err)
	}

	repeated, warning, err := manager.CreateWorktreeWithSetupHook(context.Background(), CreateWorktreeRequest{
		ProjectID: project.ID, Path: worktree.Path, SetupDecision: "run",
	})
	if err != nil {
		t.Fatalf("repeated create failed: %v", err)
	}
	if repeated.ID != worktree.ID {
		t.Fatalf("repeated create returned %q, want the existing %q", repeated.ID, worktree.ID)
	}
	if warning != "" {
		t.Fatalf("expected no warning for an existing worktree, got %q", warning)
	}
	if _, ok := readSetupMarker(t, repo); ok {
		t.Fatal("setup hook ran a second time for an existing worktree")
	}
}

func TestSetupHookOnAnSshProjectReportsItRunsOnThatHost(t *testing.T) {
	manager, _ := newSshTestManager(t)
	target, err := manager.CreateSshTarget(SshTargetInput{Host: "remote.example"})
	if err != nil {
		t.Fatal(err)
	}
	project, err := manager.CreateProject(CreateProjectRequest{
		Name: "remote", Path: "/srv/remote", LocationKind: "ssh", HostID: target.ID,
	})
	if err != nil {
		t.Fatal(err)
	}

	warning := manager.ApplyWorktreeSetupHook(context.Background(), project.ID, "/srv/remote/feature", WorktreeSetupDecisionRun)
	if warning != worktreeSetupHookRemoteWarning {
		t.Fatalf("warning = %q, want %q", warning, worktreeSetupHookRemoteWarning)
	}
	// Without an opt-in there is nothing to report: this host cannot tell
	// whether the remote repo even has a hook.
	if warning := manager.ApplyWorktreeSetupHook(context.Background(), project.ID, "/srv/remote/feature", WorktreeSetupDecisionUnset); warning != "" {
		t.Fatalf("expected no warning without an opt-in, got %q", warning)
	}
}

func TestWorktreeSetupDecisionFromFoldsThePairedOptIns(t *testing.T) {
	cases := []struct {
		setupDecision string
		runHooks      bool
		want          WorktreeSetupDecision
	}{
		{setupDecision: "run", want: WorktreeSetupDecisionRun},
		{setupDecision: "skip", want: WorktreeSetupDecisionSkip},
		{setupDecision: "", want: WorktreeSetupDecisionUnset},
		{setupDecision: "inherit", want: WorktreeSetupDecisionUnset},
		{setupDecision: "", runHooks: true, want: WorktreeSetupDecisionRun},
		// runHooks is the older signal and still wins, matching the paired
		// path's `runHooks || setupDecision == "run"`.
		{setupDecision: "skip", runHooks: true, want: WorktreeSetupDecisionRun},
	}
	for _, testCase := range cases {
		got := WorktreeSetupDecisionFrom(testCase.setupDecision, testCase.runHooks)
		if got != testCase.want {
			t.Fatalf("WorktreeSetupDecisionFrom(%q, %v) = %q, want %q", testCase.setupDecision, testCase.runHooks, got, testCase.want)
		}
	}
}
