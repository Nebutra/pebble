package providercli

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestGitHubPRForBranchUsesLinkedNumberAsSourceOfTruth(t *testing.T) {
	withPath(t, githubPRForBranchCLI(t))
	number := 42
	result, err := GetGitHubPRForBranch(context.Background(), t.TempDir(), GitHubPRForBranchRequest{
		Branch: "other", LinkedPRNumber: &number,
	})
	if err != nil || result == nil || result.Number != 42 || result.ChecksStatus != "failure" || result.Mergeable != "MERGEABLE" {
		t.Fatalf("unexpected linked PR result: result=%+v err=%v", result, err)
	}
}

func TestGitHubPRForBranchTreatsDirtyMergeStateAsConflicting(t *testing.T) {
	dirty := "DIRTY"
	result := mapGitHubPRBranchInfo(&githubPRBranchRaw{
		Number: 1, State: "OPEN", Mergeable: "UNKNOWN", MergeStateStatus: &dirty,
	})
	if result.Mergeable != "CONFLICTING" {
		t.Fatalf("expected DIRTY merge state to be conflicting, got %+v", result)
	}
}

func TestGitHubPRForBranchUsesUpstreamBaseOriginHeadAndCommitContainment(t *testing.T) {
	dir, logPath := githubPRCandidateCLI(t)
	withPath(t, dir)
	head := "abc123"
	result, err := GetGitHubPRForBranch(context.Background(), t.TempDir(), GitHubPRForBranchRequest{
		Branch: "feature/fork", CurrentHeadOID: &head,
	})
	if err != nil || result == nil || result.Number != 77 || result.PRRepo == nil || result.PRRepo.Owner != "nebutra" || result.HeadRepo == nil || result.HeadRepo.Owner != "contributor" || result.ConfirmedHeadOID != head {
		t.Fatalf("unexpected fork PR result: result=%+v err=%v", result, err)
	}
	commands, readErr := os.ReadFile(logPath)
	if readErr != nil {
		t.Fatal(readErr)
	}
	log := string(commands)
	if !strings.Contains(log, "repos/nebutra/pebble/pulls?head=contributor%3Afeature%2Ffork") || !strings.Contains(log, "repos/nebutra/pebble/commits/abc123/pulls?per_page=100") {
		t.Fatalf("expected candidate and membership API calls, got:\n%s", log)
	}
}

func TestGitHubPRConflictSummaryParsesMergeTreeFiles(t *testing.T) {
	dir, _ := githubPRCandidateCLI(t)
	withPath(t, dir)
	result := readGitHubPRConflictSummary(context.Background(), t.TempDir(), "main", "base-old", "head-new")
	if result == nil || result.BaseCommit != "base123" || result.CommitsBehind != 3 || len(result.Files) != 2 || result.Files[0] != "a.ts" || result.Files[1] != "b.ts" {
		t.Fatalf("unexpected conflict summary: %+v", result)
	}
}

func TestGitHubPRForBranchRetriesTrackedRemoteBranch(t *testing.T) {
	dir, logPath := githubPRTrackedBranchCLI(t)
	withPath(t, dir)
	result, err := GetGitHubPRForBranch(context.Background(), t.TempDir(), GitHubPRForBranchRequest{Branch: "local-name"})
	if err != nil || result == nil || result.Number != 88 || result.HeadRepo == nil || result.HeadRepo.Owner != "other-contributor" {
		t.Fatalf("unexpected tracked branch result: result=%+v err=%v", result, err)
	}
	commands, _ := os.ReadFile(logPath)
	if !strings.Contains(string(commands), "head=other-contributor%3Aremote-name") {
		t.Fatalf("tracked branch retry was not issued:\n%s", commands)
	}
}

func TestGitHubPRForBranchPreservesExplicitMergedFallback(t *testing.T) {
	withPath(t, githubPRForBranchCLI(t))
	fallback := 42
	hidden, err := GetGitHubPRForBranch(context.Background(), t.TempDir(), GitHubPRForBranchRequest{
		Branch: "missing", FallbackPRNumber: &fallback,
	})
	if err != nil || hidden != nil {
		t.Fatalf("expected implicit merged fallback to be hidden: result=%+v err=%v", hidden, err)
	}
	kept, err := GetGitHubPRForBranch(context.Background(), t.TempDir(), GitHubPRForBranchRequest{
		Branch: "missing", FallbackPRNumber: &fallback, AcceptMergedFallbackPR: true,
	})
	if err != nil || kept == nil || kept.State != "merged" {
		t.Fatalf("expected explicit merged fallback: result=%+v err=%v", kept, err)
	}
}

func githubPRForBranchCLI(t *testing.T) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("fake CLI stub uses a POSIX shell script")
	}
	dir := t.TempDir()
	script := `#!/bin/sh
case "$*" in
  "pr list --head missing"*) printf '%s' '[]' ;;
  "pr view 42"*) printf '%s' '{"number":42,"title":"Fix","state":"MERGED","url":"https://github.test/pr/42","updatedAt":"2026-07-15T00:00:00Z","headRefOid":"head42","baseRefName":"main","mergeable":"MERGEABLE","reviewDecision":"APPROVED","autoMergeRequest":null,"mergeStateStatus":"CLEAN","statusCheckRollup":[{"status":"COMPLETED","conclusion":"FAILURE"}]}' ;;
  *) exit 1 ;;
esac
`
	if err := os.WriteFile(filepath.Join(dir, "gh"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return dir
}

func githubPRCandidateCLI(t *testing.T) (string, string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("fake CLI stub uses POSIX shell scripts")
	}
	dir := t.TempDir()
	logPath := filepath.Join(dir, "commands.log")
	t.Setenv("PEBBLE_TEST_COMMAND_LOG", logPath)
	gitScript := `#!/bin/sh
printf 'git %s\n' "$*" >> "$PEBBLE_TEST_COMMAND_LOG"
case "$*" in
  "remote get-url upstream") printf '%s' 'git@github.com:nebutra/pebble.git' ;;
  "remote get-url origin") printf '%s' 'git@github.com:contributor/pebble.git' ;;
  "for-each-ref"*) printf '%s' '' ;;
  "fetch --quiet origin main") exit 0 ;;
  "rev-parse --verify refs/remotes/origin/main") printf '%s' 'base123456789' ;;
  "merge-base head-new base123456789") printf '%s' 'mergebase' ;;
  "rev-list --count head-new..base123456789") printf '%s' '3' ;;
  "merge-tree"*) printf 'treeoid\0a.ts\0b.ts\0'; exit 1 ;;
  *) exit 1 ;;
esac
`
	ghScript := `#!/bin/sh
printf 'gh %s\n' "$*" >> "$PEBBLE_TEST_COMMAND_LOG"
case "$*" in
  *"repos/nebutra/pebble/pulls?head=contributor%3Afeature%2Ffork"*) printf '%s' '[{"number":77}]' ;;
  "pr view 77 --repo nebutra/pebble"*) printf '%s' '{"number":77,"title":"Fork fix","state":"MERGED","url":"https://github.test/pr/77","updatedAt":"2026-07-15T00:00:00Z","headRefOid":"remote-head","headRefName":"feature/fork","baseRefOid":"base-old","baseRefName":"main","mergeable":"MERGEABLE","autoMergeRequest":null,"statusCheckRollup":[]}' ;;
  *"repos/nebutra/pebble/commits/abc123/pulls?per_page=100"*) printf '%s' '[{"number":77}]' ;;
  *) exit 1 ;;
esac
`
	for name, content := range map[string]string{"git": gitScript, "gh": ghScript} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return dir, logPath
}

func githubPRTrackedBranchCLI(t *testing.T) (string, string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("fake CLI stub uses POSIX shell scripts")
	}
	dir := t.TempDir()
	logPath := filepath.Join(dir, "commands.log")
	t.Setenv("PEBBLE_TEST_COMMAND_LOG", logPath)
	gitScript := `#!/bin/sh
printf 'git %s\n' "$*" >> "$PEBBLE_TEST_COMMAND_LOG"
case "$*" in
  "remote get-url upstream") printf '%s' 'git@github.com:nebutra/pebble.git' ;;
  "remote get-url origin") printf '%s' 'git@github.com:contributor/pebble.git' ;;
  "remote get-url fork") printf '%s' 'git@github.com:other-contributor/pebble.git' ;;
  "for-each-ref"*) printf 'refs/heads/local-name\0refs/remotes/fork/remote-name' ;;
  *) exit 1 ;;
esac
`
	ghScript := `#!/bin/sh
printf 'gh %s\n' "$*" >> "$PEBBLE_TEST_COMMAND_LOG"
case "$*" in
  *"head=contributor%3Alocal-name"*) printf '%s' '[]' ;;
  *"head=other-contributor%3Aremote-name"*) printf '%s' '[{"number":88}]' ;;
  "pr view 88 --repo nebutra/pebble"*) printf '%s' '{"number":88,"title":"Tracked","state":"OPEN","url":"https://github.test/pr/88","updatedAt":"2026-07-15T00:00:00Z","headRefOid":"tracked-head","headRefName":"remote-name","baseRefOid":"base","baseRefName":"main","mergeable":"MERGEABLE","autoMergeRequest":null,"statusCheckRollup":[]}' ;;
  *) exit 1 ;;
esac
`
	for name, content := range map[string]string{"git": gitScript, "gh": ghScript} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return dir, logPath
}
