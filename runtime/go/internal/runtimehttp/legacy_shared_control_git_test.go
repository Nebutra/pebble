package runtimehttp

import (
	"context"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
)

type legacySharedControlGitFixture struct {
	repo      string
	worktree  runtimecore.Worktree
	conn      *websocketConn
	rawConn   interface{ Write([]byte) (int, error) }
	sharedKey *[32]byte
}

func runGit(t *testing.T, dir string, args ...string) {
	t.Helper()
	command := exec.Command("git", args...)
	command.Dir = dir
	command.Env = append(os.Environ(),
		"GIT_AUTHOR_NAME=Test", "GIT_AUTHOR_EMAIL=test@example.com",
		"GIT_COMMITTER_NAME=Test", "GIT_COMMITTER_EMAIL=test@example.com",
	)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, output)
	}
}

func startLegacySharedControlGitFixture(t *testing.T) legacySharedControlGitFixture {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	repo := t.TempDir()
	runGit(t, repo, "init", "--initial-branch=main")
	if err := os.WriteFile(filepath.Join(repo, "tracked.txt"), []byte("one\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repo, ".gitignore"), []byte("ignored.txt\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	runGit(t, repo, "add", "tracked.txt", ".gitignore")
	runGit(t, repo, "commit", "-m", "first commit")

	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	project, err := manager.CreateProject(runtimecore.CreateProjectRequest{Name: "repo", Path: repo})
	if err != nil {
		t.Fatal(err)
	}
	worktree, err := manager.CreateWorktree(context.Background(), runtimecore.CreateWorktreeRequest{ProjectID: project.ID, Path: repo, Branch: "main"})
	if err != nil {
		t.Fatal(err)
	}
	pairing, err := manager.CreateLegacySharedControlPairing("git-test", "runtime", false)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(NewServer(manager))
	t.Cleanup(server.Close)
	rawConn, reader := dialTestWebSocket(t, server.URL, "/v1/shared-control")
	t.Cleanup(func() { _ = rawConn.Close() })
	conn := &websocketConn{conn: rawConn, reader: reader}
	sharedKey := authenticateLegacySharedControlTestClient(t, rawConn, conn, pairing)
	return legacySharedControlGitFixture{repo: repo, worktree: worktree, conn: conn, rawConn: rawConn, sharedKey: sharedKey}
}

func (f legacySharedControlGitFixture) call(t *testing.T, id string, method string, params map[string]interface{}) map[string]interface{} {
	t.Helper()
	if params == nil {
		params = map[string]interface{}{}
	}
	params["worktree"] = f.worktree.ID
	writeEncryptedLegacySharedControlTestFrame(t, f.rawConn, f.sharedKey, map[string]interface{}{"id": id, "method": method, "params": params})
	response := readEncryptedLegacySharedControlTestFrame(t, f.conn, f.sharedKey)
	if response["id"] != id {
		t.Fatalf("expected the next message to answer %s, got %#v", method, response)
	}
	return response
}

func TestLegacySharedControlGitStatusReportsWorkingTreeChanges(t *testing.T) {
	fixture := startLegacySharedControlGitFixture(t)
	if err := os.WriteFile(filepath.Join(fixture.repo, "tracked.txt"), []byte("two\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(fixture.repo, "added.txt"), []byte("new\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	response := fixture.call(t, "status", "git.status", nil)
	result, ok := response["result"].(map[string]interface{})
	if !ok {
		t.Fatalf("git.status did not answer with a result: %#v", response)
	}
	entries, _ := result["entries"].([]interface{})
	paths := map[string]string{}
	for _, entry := range entries {
		value, _ := entry.(map[string]interface{})
		path, _ := value["path"].(string)
		status, _ := value["status"].(string)
		paths[path] = status
	}
	if paths["tracked.txt"] != "modified" {
		t.Fatalf("expected tracked.txt to be modified, got %#v", paths)
	}
	if paths["added.txt"] != "untracked" {
		t.Fatalf("expected added.txt to be untracked, got %#v", paths)
	}
	if result["conflictOperation"] == nil {
		t.Fatalf("expected a conflict operation field, got %#v", result)
	}
}

func TestLegacySharedControlGitStatusSeparatesIgnoredPaths(t *testing.T) {
	fixture := startLegacySharedControlGitFixture(t)
	if err := os.WriteFile(filepath.Join(fixture.repo, "ignored.txt"), []byte("skip\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	plain, _ := fixture.call(t, "plain", "git.status", nil)["result"].(map[string]interface{})
	for _, entry := range plain["entries"].([]interface{}) {
		value, _ := entry.(map[string]interface{})
		if value["path"] == "ignored.txt" {
			t.Fatalf("an ignored path must not appear as a change: %#v", plain)
		}
	}

	withIgnored, _ := fixture.call(t, "ignored", "git.status", map[string]interface{}{"includeIgnored": true})["result"].(map[string]interface{})
	// The ignored rows must be reported apart from the changes, otherwise every
	// ignored file renders as an untracked change in source control.
	ignoredPaths, _ := withIgnored["ignoredPaths"].([]interface{})
	found := false
	for _, path := range ignoredPaths {
		if path == "ignored.txt" {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected ignored.txt among the ignored paths, got %#v", withIgnored)
	}
	for _, entry := range withIgnored["entries"].([]interface{}) {
		value, _ := entry.(map[string]interface{})
		if value["path"] == "ignored.txt" {
			t.Fatalf("an ignored path leaked into the change entries: %#v", withIgnored)
		}
	}
}

func TestLegacySharedControlGitHistoryAndDiffReadTheRepository(t *testing.T) {
	fixture := startLegacySharedControlGitFixture(t)
	if err := os.WriteFile(filepath.Join(fixture.repo, "tracked.txt"), []byte("two\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	history, ok := fixture.call(t, "history", "git.history", map[string]interface{}{"limit": 10})["result"].(map[string]interface{})
	if !ok || history == nil {
		t.Fatal("git.history did not answer with a result")
	}

	diff, ok := fixture.call(t, "diff", "git.diff", map[string]interface{}{"filePath": "tracked.txt"})["result"].(map[string]interface{})
	if !ok {
		t.Fatal("git.diff did not answer with a result")
	}
	if diff["modifiedContent"] != "two\n" {
		t.Fatalf("expected the diff to carry the working-tree content, got %#v", diff)
	}
}

func TestLegacySharedControlGitUpstreamStatusAnswersALocalRepo(t *testing.T) {
	fixture := startLegacySharedControlGitFixture(t)
	response := fixture.call(t, "upstream", "git.upstreamStatus", nil)
	result, ok := response["result"].(map[string]interface{})
	if !ok {
		t.Fatalf("git.upstreamStatus did not answer with a result: %#v", response)
	}
	if result["hasUpstream"] != false {
		t.Fatalf("expected no upstream on the fixture repo, got %#v", result)
	}
	if result["ahead"] != float64(0) || result["behind"] != float64(0) {
		t.Fatalf("expected placeholder ahead/behind zeros, got %#v", result)
	}
}

func TestLegacySharedControlGitRejectsAnUnknownWorktree(t *testing.T) {
	fixture := startLegacySharedControlGitFixture(t)
	writeEncryptedLegacySharedControlTestFrame(t, fixture.rawConn, fixture.sharedKey, map[string]interface{}{
		"id": "missing", "method": "git.status", "params": map[string]interface{}{"worktree": "nope"},
	})
	response := readEncryptedLegacySharedControlTestFrame(t, fixture.conn, fixture.sharedKey)
	if response["error"] == nil {
		t.Fatalf("expected an error for an unknown worktree, got %#v", response)
	}
}

func TestLegacySharedControlGitLeavesUnimplementedMethodsUnknown(t *testing.T) {
	fixture := startLegacySharedControlGitFixture(t)
	// Why: mutating git methods have no runtimecore implementation. They must
	// keep reporting an unknown method rather than a git failure, so a client
	// can tell "not supported here" from "your repository is broken".
	response := fixture.call(t, "commit", "git.commit", map[string]interface{}{"message": "nope"})
	failure, ok := response["error"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected git.commit to fail, got %#v", response)
	}
	if failure["code"] != "method_not_found" {
		t.Fatalf("expected method_not_found for an unimplemented git method, got %#v", failure)
	}
}
