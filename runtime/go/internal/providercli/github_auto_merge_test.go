package providercli

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func autoMergeCLI(t *testing.T, queueJSON string) (string, string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("shell fixture is POSIX-only")
	}
	dir := t.TempDir()
	logPath := filepath.Join(dir, "commands.log")
	t.Setenv("PEBBLE_TEST_COMMAND_LOG", logPath)
	script := `#!/bin/sh
printf '%s\n' "$*" >> "$PEBBLE_TEST_COMMAND_LOG"
case "$*" in
  "pr view "*) printf '%s' '{"id":"PR_node","headRefOid":"abc123","baseRefName":"main"}' ;;
  "repo view "*) printf '%s' '{"nameWithOwner":"nebutra/pebble"}' ;;
  *"mergeQueue"*) printf '%s' '` + queueJSON + `' ;;
  *) printf '%s' '{}' ;;
esac
`
	if err := os.WriteFile(filepath.Join(dir, "gh"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return dir, logPath
}

func TestEnableGitHubAutoMergeUsesGraphQLOutsideMergeQueue(t *testing.T) {
	dir, logPath := autoMergeCLI(t, `{"data":{"repository":{"mergeQueue":null}}}`)
	withPath(t, dir)
	result := SetGitHubPullRequestAutoMerge(context.Background(), t.TempDir(), SetAutoMergeRequest{Number: 4, Enabled: true, Method: "squash"})
	if !result.OK {
		t.Fatalf("expected enable to succeed, got %+v", result)
	}
	commands, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(commands), "enablePullRequestAutoMerge") || strings.Contains(string(commands), "--auto") {
		t.Fatalf("expected GraphQL enable without --auto, got:\n%s", commands)
	}
}

func TestEnableGitHubAutoMergeUsesQueueCommandForMergeQueue(t *testing.T) {
	dir, logPath := autoMergeCLI(t, `{"data":{"repository":{"mergeQueue":{"id":"MQ"}}}}`)
	withPath(t, dir)
	result := SetGitHubPullRequestAutoMerge(context.Background(), t.TempDir(), SetAutoMergeRequest{Number: 4, Enabled: true, Method: "rebase"})
	if !result.OK {
		t.Fatalf("expected queue enable to succeed, got %+v", result)
	}
	commands, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(commands), "pr merge 4 --auto --rebase") || strings.Contains(string(commands), "enablePullRequestAutoMerge") {
		t.Fatalf("expected merge-queue --auto command, got:\n%s", commands)
	}
}

func TestDisableGitHubAutoMergeDoesNotNeedIdentityLookup(t *testing.T) {
	dir := fakeCLIStub(t, "gh", "", 0)
	withPath(t, dir)
	result := SetGitHubPullRequestAutoMerge(context.Background(), t.TempDir(), SetAutoMergeRequest{Number: 4, Enabled: false, Method: "squash"})
	if !result.OK {
		t.Fatalf("expected disable to succeed, got %+v", result)
	}
}

func TestGitHubAutoMergeClassifiesAlreadyMergeable(t *testing.T) {
	dir := fakeCLIStub(t, "gh", "Pull request is in clean status", 1)
	withPath(t, dir)
	result := SetGitHubPullRequestAutoMerge(context.Background(), t.TempDir(), SetAutoMergeRequest{Number: 4, Enabled: true, Method: "squash"})
	if result.OK || result.Code != "already_mergeable" {
		t.Fatalf("expected actionable clean-status error, got %+v", result)
	}
}
