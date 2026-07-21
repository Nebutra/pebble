package providercli

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestMergeGitHubPullRequestSupportsEveryMethod(t *testing.T) {
	dir := fakeCLIStub(t, "gh", "", 0)
	withPath(t, dir)
	for _, method := range []string{"merge", "squash", "rebase"} {
		result := MergeGitHubPullRequest(context.Background(), t.TempDir(), MergeReviewRequest{
			Provider: "github", Number: 42, Method: method,
		})
		if !result.OK {
			t.Fatalf("expected %s merge to succeed, got %+v", method, result)
		}
	}
}

func TestProviderCLICommandsDisableInteractivePrompts(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell fixture is POSIX-only")
	}
	dir := t.TempDir()
	script := "#!/bin/sh\nprintf '%s,%s' \"$GH_PROMPT_DISABLED\" \"$GLAB_PROMPT_DISABLED\"\n"
	if err := os.WriteFile(filepath.Join(dir, "gh"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	withPath(t, dir)
	out, err := runCLI(context.Background(), "gh", t.TempDir(), "status")
	if err != nil {
		t.Fatal(err)
	}
	if string(out) != "1,1" {
		t.Fatalf("expected non-interactive environment, got %q", out)
	}
}

func TestMergeGitLabMergeRequestSupportsEveryMethod(t *testing.T) {
	dir := fakeCLIStub(t, "glab", "", 0)
	withPath(t, dir)
	for _, method := range []string{"merge", "squash", "rebase"} {
		result := MergeGitLabMergeRequest(context.Background(), t.TempDir(), MergeReviewRequest{
			Provider: "gitlab", Number: 7, Method: method,
		})
		if !result.OK {
			t.Fatalf("expected %s merge to succeed, got %+v", method, result)
		}
	}
}

func TestMergeReviewRejectsInvalidMethod(t *testing.T) {
	result := MergeGitHubPullRequest(context.Background(), t.TempDir(), MergeReviewRequest{
		Provider: "github", Number: 1, Method: "octopus",
	})
	if result.OK || result.Code != "validation" {
		t.Fatalf("expected validation error, got %+v", result)
	}
}
