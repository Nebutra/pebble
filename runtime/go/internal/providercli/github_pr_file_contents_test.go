package providercli

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestGetGitHubPRFileContentsReadsBaseAndHead(t *testing.T) {
	dir, logPath := githubPRFileContentsCLI(t)
	withPath(t, dir)
	result := GetGitHubPRFileContents(context.Background(), t.TempDir(), "upstream", GitHubPRFileContentsRequest{
		Path: "src/new name.ts", OldPath: "src/old.ts", Status: "renamed", BaseSHA: "base/sha", HeadSHA: "head-sha",
	})
	if result.Original != "old content" || result.Modified != "new content" || result.OriginalIsBinary || result.ModifiedIsBinary {
		t.Fatalf("unexpected contents: %+v", result)
	}
	calls, _ := os.ReadFile(logPath)
	text := string(calls)
	for _, expected := range []string{
		"repos/nebutra/pebble/contents/src/old.ts?ref=base%2Fsha",
		"repos/nebutra/pebble/contents/src/new%20name.ts?ref=head-sha",
	} {
		if !strings.Contains(text, expected) {
			t.Fatalf("missing %q in calls:\n%s", expected, text)
		}
	}
}

func TestGetGitHubPRFileContentsSkipsMissingAddedSide(t *testing.T) {
	dir, logPath := githubPRFileContentsCLI(t)
	withPath(t, dir)
	result := GetGitHubPRFileContents(context.Background(), t.TempDir(), "upstream", GitHubPRFileContentsRequest{Path: "src/new name.ts", Status: "added", BaseSHA: "base", HeadSHA: "head-sha"})
	if result.Original != "" || result.Modified != "new content" {
		t.Fatalf("unexpected added contents: %+v", result)
	}
	calls, _ := os.ReadFile(logPath)
	if strings.Contains(string(calls), "ref=base") {
		t.Fatalf("added file fetched base content:\n%s", calls)
	}
}

func githubPRFileContentsCLI(t *testing.T) (string, string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("fake CLI stub uses POSIX shell scripts")
	}
	dir := t.TempDir()
	logPath := filepath.Join(dir, "calls.log")
	gitScript := `#!/bin/sh
case "$*" in
  "remote get-url origin") printf '%s' 'git@github.com:fork/pebble.git';;
  "remote get-url upstream") printf '%s' 'https://github.com/nebutra/pebble.git';;
  *) exit 1;;
esac
`
	ghScript := `#!/bin/sh
echo "$*" >> "` + logPath + `"
case "$*" in
  *"src/old.ts?ref=base%2Fsha"*) printf '%s' 'old content';;
  *"src/new%20name.ts?ref=head-sha"*) printf '%s' 'new content';;
  *) exit 1;;
esac
`
	for name, script := range map[string]string{"git": gitScript, "gh": ghScript} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(script), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return dir, logPath
}
