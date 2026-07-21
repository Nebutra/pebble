package providercli

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestResolveGitLabReviewThreadSupportsReopen(t *testing.T) {
	dir := fakeCLIStub(t, "glab", "", 0)
	withPath(t, dir)
	result := ResolveGitLabReviewThread(context.Background(), t.TempDir(), ResolveReviewThreadRequest{Number: 5, ThreadID: "discussion/one", Resolved: false})
	if !result.OK {
		t.Fatalf("expected reopen to succeed, got %+v", result)
	}
}

func TestResolveGitHubReviewThreadUsesResolveAndUnresolveMutations(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell fixture is POSIX-only")
	}
	dir := t.TempDir()
	logPath := filepath.Join(dir, "commands.log")
	t.Setenv("PEBBLE_THREAD_LOG", logPath)
	script := "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$PEBBLE_THREAD_LOG\"\nprintf '{}'\n"
	if err := os.WriteFile(filepath.Join(dir, "gh"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	withPath(t, dir)
	for _, resolved := range []bool{true, false} {
		result := ResolveGitHubReviewThread(context.Background(), t.TempDir(), ResolveReviewThreadRequest{Provider: "github", ThreadID: "PRRT_1", Resolved: resolved})
		if !result.OK {
			t.Fatalf("mutation failed: %+v", result)
		}
	}
	commands, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	output := string(commands)
	if !strings.Contains(output, "resolveReviewThread") || !strings.Contains(output, "unresolveReviewThread") {
		t.Fatalf("expected both mutations, got:\n%s", output)
	}
}

func TestSetGitHubReviewFileViewedUsesMarkAndUnmarkMutations(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell fixture is POSIX-only")
	}
	dir := t.TempDir()
	logPath := filepath.Join(dir, "viewed.log")
	t.Setenv("PEBBLE_VIEWED_LOG", logPath)
	script := "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$PEBBLE_VIEWED_LOG\"\nprintf '{}'\n"
	if err := os.WriteFile(filepath.Join(dir, "gh"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	withPath(t, dir)
	for _, viewed := range []bool{true, false} {
		result := SetGitHubReviewFileViewed(context.Background(), t.TempDir(), SetReviewFileViewedRequest{PullRequestID: "PR_1", Path: "src/app.ts", Viewed: viewed})
		if !result.OK {
			t.Fatalf("mutation failed: %+v", result)
		}
	}
	commands, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	output := string(commands)
	if !strings.Contains(output, "markFileAsViewed") || !strings.Contains(output, "unmarkFileAsViewed") || !strings.Contains(output, "path=src/app.ts") {
		t.Fatalf("unexpected commands:\n%s", output)
	}
}
