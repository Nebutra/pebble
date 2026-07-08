package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/tsekaluk/pebble/go-runtime/internal/runtimecore"
)

func TestBuildFileEntriesBlocksWorkspaceEscape(t *testing.T) {
	if _, err := buildFileEntries("proj", "", t.TempDir(), "../outside", 1); err == nil {
		t.Fatal("expected workspace escape to be rejected")
	}
}

func TestRunFileTreePostsSnapshot(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "docs"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "docs", "readme.md"), []byte("remote"), 0o644); err != nil {
		t.Fatal(err)
	}
	var gotPath string
	var gotAuth string
	var got runtimecore.UpdateRemoteFileTreeRequest
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		body, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(body, &got); err != nil {
			t.Fatal(err)
		}
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()

	var output bytes.Buffer
	err := run([]string{
		"file-tree",
		"--endpoint",
		server.URL,
		"--token",
		"secret",
		"--project",
		"proj_remote",
		"--root",
		root,
		"--max-depth",
		"2",
	}, server.Client(), &output)
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/v1/files/tree-snapshots" {
		t.Fatalf("unexpected path %q", gotPath)
	}
	if gotAuth != "Bearer secret" {
		t.Fatalf("unexpected authorization header %q", gotAuth)
	}
	if got.ProjectID != "proj_remote" || len(got.Entries) != 2 {
		t.Fatalf("unexpected snapshot payload: %#v", got)
	}
}

func TestRunFileReadPostsContentSnapshot(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "README.md"), []byte("remote"), 0o644); err != nil {
		t.Fatal(err)
	}
	var got runtimecore.UpdateRemoteFileContentRequest
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/content-snapshots") {
			t.Fatalf("unexpected path %q", r.URL.Path)
		}
		body, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(body, &got); err != nil {
			t.Fatal(err)
		}
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()

	var output bytes.Buffer
	err := run([]string{
		"file-read",
		"--endpoint",
		server.URL,
		"--project",
		"proj_remote",
		"--root",
		root,
		"--path",
		"README.md",
	}, server.Client(), &output)
	if err != nil {
		t.Fatal(err)
	}
	if got.Path != "README.md" || got.Content != "remote" {
		t.Fatalf("unexpected content payload: %#v", got)
	}
}

func TestReadWorkspaceFileBlocksSymlinkEscape(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(outside, "secret.txt"), filepath.Join(root, "linked.txt")); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	if _, _, _, err := readWorkspaceFile(root, "linked.txt", 1024); err == nil || !strings.Contains(err.Error(), "escapes workspace root") {
		t.Fatalf("expected symlink escape rejection, got %v", err)
	}
}

func TestParseGitStatusOutput(t *testing.T) {
	branch, ahead, behind, changes := parseGitStatusOutput("## feature...origin/feature [ahead 2, behind 1]\n M README.md\n?? docs/new.md\nR  old.go -> new.go\n")
	if branch != "feature" || ahead != 2 || behind != 1 {
		t.Fatalf("unexpected branch data: %s ahead=%d behind=%d", branch, ahead, behind)
	}
	if len(changes) != 3 ||
		changes[0].Path != "README.md" ||
		changes[0].Status != "modified" ||
		changes[1].Status != "untracked" ||
		changes[2].Path != "new.go" ||
		changes[2].Status != "renamed" {
		t.Fatalf("unexpected changes: %#v", changes)
	}
}

func TestRunGitStatusPostsProjection(t *testing.T) {
	root := t.TempDir()
	if _, err := exec.Command("git", "-C", root, "init").CombinedOutput(); err != nil {
		t.Skipf("git unavailable: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "README.md"), []byte("remote"), 0o644); err != nil {
		t.Fatal(err)
	}
	var got runtimecore.UpdateSourceControlProjectionRequest
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/source-control/projections" {
			t.Fatalf("unexpected path %q", r.URL.Path)
		}
		body, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(body, &got); err != nil {
			t.Fatal(err)
		}
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()

	var output bytes.Buffer
	err := run([]string{
		"git-status",
		"--endpoint",
		server.URL,
		"--repository",
		"proj_remote",
		"--workspace",
		"wt_remote",
		"--root",
		root,
		"--provider",
		"gitlab",
	}, server.Client(), &output)
	if err != nil {
		t.Fatal(err)
	}
	if got.RepositoryID != "proj_remote" || got.WorkspaceID != "wt_remote" || got.SyncStatus != "dirty" {
		t.Fatalf("unexpected projection: %#v", got)
	}
	if len(got.Changes) != 1 || got.Changes[0].Path != "README.md" || got.Changes[0].Status != "untracked" {
		t.Fatalf("unexpected projection changes: %#v", got.Changes)
	}
}
