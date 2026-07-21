package main

import (
	"os/exec"
	"path/filepath"
	"testing"
)

func TestGitBaseRefsDefaultAndSearch(t *testing.T) {
	root := t.TempDir()
	runGitForBaseRefTest(t, root, "init", "-b", "main")
	runGitForBaseRefTest(t, root, "config", "user.name", "Pebble Test")
	runGitForBaseRefTest(t, root, "config", "user.email", "pebble@example.test")
	runGitForBaseRefTest(t, root, "commit", "--allow-empty", "-m", "initial")
	runGitForBaseRefTest(t, root, "branch", "feature/terminal")
	remote := filepath.Join(t.TempDir(), "remote.git")
	runGitForBaseRefTest(t, filepath.Dir(remote), "init", "--bare", remote)
	runGitForBaseRefTest(t, root, "remote", "add", "origin", remote)
	runGitForBaseRefTest(t, root, "push", "-u", "origin", "main", "feature/terminal")
	runGitForBaseRefTest(t, root, "remote", "set-head", "origin", "main")

	result, err := defaultGitBaseRef(root)
	if err != nil {
		t.Fatal(err)
	}
	if result.DefaultBaseRef == nil || *result.DefaultBaseRef != "origin/main" || result.RemoteCount != 1 {
		t.Fatalf("unexpected default result: %#v", result)
	}
	refs, err := searchGitBaseRefs(root, "terminal", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(refs) != 2 || refs[0].LocalBranchName != "feature/terminal" || refs[1].LocalBranchName != "feature/terminal" {
		t.Fatalf("unexpected search results: %#v", refs)
	}
}

func TestResolveGitReviewStartForRemoteBranches(t *testing.T) {
	root := t.TempDir()
	runGitForBaseRefTest(t, root, "init", "-b", "main")
	runGitForBaseRefTest(t, root, "config", "user.name", "Pebble Test")
	runGitForBaseRefTest(t, root, "config", "user.email", "pebble@example.test")
	runGitForBaseRefTest(t, root, "commit", "--allow-empty", "-m", "initial")
	runGitForBaseRefTest(t, root, "branch", "topic")
	remote := filepath.Join(t.TempDir(), "remote.git")
	runGitForBaseRefTest(t, filepath.Dir(remote), "init", "--bare", remote)
	runGitForBaseRefTest(t, root, "remote", "add", "origin", remote)
	runGitForBaseRefTest(t, root, "push", "origin", "main", "topic")

	pr, err := resolveGitReviewStart(root, "pr", 9, "topic", "main", false)
	if err != nil {
		t.Fatal(err)
	}
	if pr.HeadSHA == "" || pr.BaseBranch != pr.HeadSHA || pr.PushTarget == nil || pr.CompareBaseRef != "refs/remotes/origin/main" {
		t.Fatalf("unexpected PR start point: %#v", pr)
	}
	mr, err := resolveGitReviewStart(root, "mr", 3, "topic", "main", false)
	if err != nil {
		t.Fatal(err)
	}
	if mr.BaseBranch != "origin/topic" || mr.PushTarget == nil || mr.PushTarget.BranchName != "topic" {
		t.Fatalf("unexpected MR start point: %#v", mr)
	}
}

func runGitForBaseRefTest(t *testing.T, root string, args ...string) {
	t.Helper()
	command := exec.Command("git", append([]string{"-C", root}, args...)...)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v: %s", args, err, output)
	}
}
