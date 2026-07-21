package providercli

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestGitHubPRForBranchUsesForkParentWithoutUpstreamRemote(t *testing.T) {
	dir, logPath := githubPRForkParentCLI(t)
	withPath(t, dir)

	result, err := GetGitHubPRForBranch(
		context.Background(),
		t.TempDir(),
		GitHubPRForBranchRequest{Branch: "feature/fork-parent"},
	)
	if err != nil || result == nil || result.Number != 91 {
		t.Fatalf("unexpected fork-parent PR result: result=%+v err=%v", result, err)
	}
	if result.PRRepo == nil || result.PRRepo.Owner != "nebutra" {
		t.Fatalf("expected parent PR repository, got %+v", result.PRRepo)
	}
	if result.HeadRepo == nil || result.HeadRepo.Owner != "contributor" {
		t.Fatalf("expected contributor head repository, got %+v", result.HeadRepo)
	}
	commands, readErr := os.ReadFile(logPath)
	if readErr != nil {
		t.Fatal(readErr)
	}
	log := string(commands)
	if !strings.Contains(log, "repo view contributor/pebble --json isFork,parent") ||
		!strings.Contains(log, "repos/nebutra/pebble/pulls?head=contributor%3Afeature%2Ffork-parent") {
		t.Fatalf("expected parent discovery and parent PR lookup, got:\n%s", log)
	}
}

func githubPRForkParentCLI(t *testing.T) (string, string) {
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
  "remote get-url upstream") exit 1 ;;
  "remote get-url origin") printf '%s' 'git@github.com:contributor/pebble.git' ;;
  "for-each-ref"*) printf '%s' '' ;;
  *) exit 1 ;;
esac
`
	ghScript := `#!/bin/sh
printf 'gh %s\n' "$*" >> "$PEBBLE_TEST_COMMAND_LOG"
case "$*" in
  "repo view contributor/pebble --json isFork,parent") printf '%s' '{"isFork":true,"parent":{"name":"pebble","owner":{"login":"nebutra"}}}' ;;
  *"repos/nebutra/pebble/pulls?head=contributor%3Afeature%2Ffork-parent"*) printf '%s' '[{"number":91}]' ;;
  "pr view 91 --repo nebutra/pebble"*) printf '%s' '{"number":91,"title":"Fork parent","state":"OPEN","url":"https://github.test/pr/91","updatedAt":"2026-07-17T00:00:00Z","headRefOid":"head91","headRefName":"feature/fork-parent","baseRefOid":"base91","baseRefName":"main","mergeable":"MERGEABLE","autoMergeRequest":null,"statusCheckRollup":[]}' ;;
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
