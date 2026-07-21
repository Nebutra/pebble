package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
)

func TestStreamRemoteWorkspaceChangesPublishesExternalRevision(t *testing.T) {
	root := t.TempDir()
	ctx, cancel := context.WithCancel(context.Background())
	reader, writer := io.Pipe()
	done := make(chan error, 1)
	go func() {
		done <- streamRemoteWorkspaceChanges(ctx, root, "workspace-1", 10*time.Millisecond, writer)
		_ = writer.Close()
	}()
	decoder := json.NewDecoder(reader)
	var initial runtimecore.RemoteWorkspaceSnapshot
	if err := decoder.Decode(&initial); err != nil {
		t.Fatal(err)
	}
	if initial.Revision != 0 {
		t.Fatalf("unexpected initial revision %d", initial.Revision)
	}
	result, err := runtimecore.PatchRemoteWorkspace(root, runtimecore.RemoteWorkspacePatchRequest{
		Namespace: "workspace-1", BaseRevision: 0, ClientID: "other-client",
		Patch: runtimecore.RemoteWorkspacePatch{Kind: "replace-session", Session: runtimecore.RemoteWorkspaceSession{"active": "wt-1"}},
	})
	if err != nil || !result.OK {
		t.Fatalf("external patch failed: %#v %v", result, err)
	}
	var changed runtimecore.RemoteWorkspaceSnapshot
	if err := decoder.Decode(&changed); err != nil {
		t.Fatal(err)
	}
	if changed.Revision != 1 || changed.Session["active"] != "wt-1" {
		t.Fatalf("unexpected changed snapshot %#v", changed)
	}
	cancel()
	if err := <-done; err != context.Canceled {
		t.Fatalf("expected cancellation, got %v", err)
	}
}

func TestRewriteProviderRelayRequestUsesRemoteLocalProject(t *testing.T) {
	request, err := rewriteProviderRelayRequest(runtimecore.ProviderRelayRequest{
		Method:   http.MethodPost,
		Path:     "/v1/providers/reviews",
		RawQuery: "projectId=desktop-project&worktreeId=desktop-worktree",
		Headers:  map[string]string{"Content-Type": "application/json"},
		Body:     []byte(`{"projectId":"desktop-project","worktreeId":"desktop-worktree","title":"Ship"}`),
	}, "remote-local-project")
	if err != nil {
		t.Fatal(err)
	}
	if request.URL.Query().Get("projectId") != "remote-local-project" || request.URL.Query().Has("worktreeId") {
		t.Fatalf("unexpected rewritten query %q", request.URL.RawQuery)
	}
	var body map[string]any
	if json.NewDecoder(request.Body).Decode(&body) != nil || body["projectId"] != "remote-local-project" {
		t.Fatalf("unexpected rewritten body %#v", body)
	}
	if _, exists := body["worktreeId"]; exists {
		t.Fatalf("desktop worktree selector leaked into remote request %#v", body)
	}
}

func TestBuildFileEntriesBlocksWorkspaceEscape(t *testing.T) {
	if _, err := buildFileEntries("proj", "", t.TempDir(), "../outside", 1); err == nil {
		t.Fatal("expected workspace escape to be rejected")
	}
}

func TestCommitUploadAtomicallyReplacesExistingRelayFile(t *testing.T) {
	root := t.TempDir()
	temporary := filepath.Join(root, ".capture.tmp")
	target := filepath.Join(root, "recordings", "capture.webm")
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(temporary, []byte("new recording"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target, []byte("old recording"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := applyFileMutation(fileMutationPayload{
		Operation:       "commit-upload",
		Root:            root,
		SourcePath:      ".capture.tmp",
		DestinationPath: "recordings/capture.webm",
	}); err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "new recording" {
		t.Fatalf("unexpected committed content %q", content)
	}
	if _, err := os.Stat(temporary); !os.IsNotExist(err) {
		t.Fatalf("expected temporary upload to be removed, got %v", err)
	}
}

func TestRunAiVaultScanJSONReturnsHostPlatform(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("CODEX_HOME", filepath.Join(t.TempDir(), "codex"))
	var output bytes.Buffer
	if err := run([]string{"ai-vault-scan-json", "--limit", "2"}, http.DefaultClient, &output); err != nil {
		t.Fatal(err)
	}
	var result runtimecore.AiVaultListResult
	if err := json.Unmarshal(output.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Sessions == nil || result.Issues == nil || result.ScannedAt == "" {
		t.Fatalf("unexpected AI Vault relay result: %#v", result)
	}
}

func TestRunAiVaultScanJSONAcceptsRepeatedScopePaths(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	var output bytes.Buffer
	if err := run([]string{
		"ai-vault-scan-json",
		"--limit", "2",
		"--scope-path", "/srv/pebble",
		"--scope-path", "/srv/other project",
	}, http.DefaultClient, &output); err != nil {
		t.Fatal(err)
	}
	var result runtimecore.AiVaultListResult
	if err := json.Unmarshal(output.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
}

func TestRunClipboardWriteJSONUsesSystemTempDirectory(t *testing.T) {
	var output bytes.Buffer
	input := strings.NewReader(`{"contentBase64":"cG5nLWJ5dGVz"}`)
	if err := runClipboardWriteJSON(input, &output); err != nil {
		t.Fatal(err)
	}
	var result struct {
		Path string `json:"path"`
	}
	if err := json.Unmarshal(output.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	defer os.Remove(result.Path)
	content, err := os.ReadFile(result.Path)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "png-bytes" {
		t.Fatalf("unexpected clipboard content %q", content)
	}
	if filepath.Clean(filepath.Dir(result.Path)) != filepath.Clean(os.TempDir()) {
		t.Fatalf("expected system temp path, got %q", result.Path)
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

func TestRunFileReadJSONReturnsBoundedContentWithoutRuntimeCallback(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "README.md"), []byte("remote-json"), 0o644); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	if err := run([]string{
		"file-read-json",
		"--project", "proj_remote",
		"--worktree", "wt_remote",
		"--root", root,
		"--path", "README.md",
		"--max-bytes", "1024",
	}, http.DefaultClient, &output); err != nil {
		t.Fatal(err)
	}
	var content runtimecore.FileContent
	if err := json.Unmarshal(output.Bytes(), &content); err != nil {
		t.Fatal(err)
	}
	if content.ProjectID != "proj_remote" || content.WorktreeID != "wt_remote" || content.Content != "remote-json" || content.Size != 11 {
		t.Fatalf("unexpected direct file content: %#v", content)
	}
}

func TestRunFileTreeJSONReturnsLiveDirectoryEntries(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "src"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "src", "main.go"), []byte("package main"), 0o644); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	if err := run([]string{
		"file-tree-json",
		"--project", "proj_remote",
		"--worktree", "wt_remote",
		"--root", root,
		"--path", "src",
		"--max-depth", "1",
	}, http.DefaultClient, &output); err != nil {
		t.Fatal(err)
	}
	var entries []runtimecore.FileEntry
	if err := json.Unmarshal(output.Bytes(), &entries); err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Path != "src/main.go" || entries[0].WorktreeID != "wt_remote" {
		t.Fatalf("unexpected direct file tree: %#v", entries)
	}
}

func TestRunFileReadChunkJSONReturnsBinarySafeContent(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "data.bin"), []byte{0, 1, 2, 3, 4}, 0o644); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	if err := run([]string{
		"file-read-chunk-json",
		"--root", root,
		"--path", "data.bin",
		"--offset", "1",
		"--length", "3",
	}, http.DefaultClient, &output); err != nil {
		t.Fatal(err)
	}
	var chunk runtimecore.FileChunk
	if err := json.Unmarshal(output.Bytes(), &chunk); err != nil {
		t.Fatal(err)
	}
	if chunk.ContentBase64 != "AQID" || chunk.BytesRead != 3 || chunk.EOF {
		t.Fatalf("unexpected direct file chunk: %#v", chunk)
	}
}

func TestRunFileStatJSONReturnsPreviewMetadata(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "image.png"), []byte{1, 2, 3, 4}, 0o644); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	if err := run([]string{
		"file-stat-json",
		"--root", root,
		"--path", "image.png",
	}, http.DefaultClient, &output); err != nil {
		t.Fatal(err)
	}
	var stat runtimecore.FileStat
	if err := json.Unmarshal(output.Bytes(), &stat); err != nil {
		t.Fatal(err)
	}
	if stat.Size != 4 || stat.IsDirectory || stat.Mtime <= 0 {
		t.Fatalf("unexpected direct file stat: %#v", stat)
	}
}

func TestRunFileListAllJSONPreservesExclusionsAndLimit(t *testing.T) {
	root := t.TempDir()
	for path, content := range map[string]string{
		"src/a.ts":          "a",
		"src/b.ts":          "b",
		"node_modules/x.js": "x",
	} {
		fullPath := filepath.Join(root, filepath.FromSlash(path))
		if err := os.MkdirAll(filepath.Dir(fullPath), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(fullPath, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	var output bytes.Buffer
	if err := run([]string{
		"file-list-all-json",
		"--root", root,
		"--exclude-json", `["node_modules"]`,
		"--limit", "1",
	}, http.DefaultClient, &output); err != nil {
		t.Fatal(err)
	}
	var result runtimecore.FileListResult
	if err := json.Unmarshal(output.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if len(result.Files) != 1 || result.Files[0].RelativePath != "src/a.ts" || !result.Truncated {
		t.Fatalf("unexpected direct file list: %#v", result)
	}
}

func TestRunFileMutateJSONAppliesBoundedWorkspaceOperations(t *testing.T) {
	root := t.TempDir()
	runMutation := func(payload fileMutationPayload) {
		t.Helper()
		payload.Root = root
		input, err := json.Marshal(payload)
		if err != nil {
			t.Fatal(err)
		}
		var output bytes.Buffer
		if err := runFileMutateJSON(bytes.NewReader(input), &output); err != nil {
			t.Fatal(err)
		}
	}
	runMutation(fileMutationPayload{Operation: "write", Path: "src/main.txt", Content: "hello", CreateDirs: true})
	runMutation(fileMutationPayload{Operation: "write-base64", Path: "upload.bin", ContentBase64: "AQI="})
	runMutation(fileMutationPayload{Operation: "write-base64", Path: "upload.bin", ContentBase64: "AwQ=", Append: true})
	runMutation(fileMutationPayload{Operation: "create-dir", Path: "empty"})
	runMutation(fileMutationPayload{Operation: "create-file", Path: "nested/new.txt"})
	runMutation(fileMutationPayload{Operation: "rename", OldPath: "nested/new.txt", NewPath: "nested/renamed.txt"})
	runMutation(fileMutationPayload{Operation: "copy", SourcePath: "src/main.txt", DestinationPath: "copied/main.txt"})
	runMutation(fileMutationPayload{Operation: "delete", Path: "empty", Recursive: true})

	content, err := os.ReadFile(filepath.Join(root, "copied", "main.txt"))
	if err != nil || string(content) != "hello" {
		t.Fatalf("copied content = %q, err = %v", content, err)
	}
	upload, err := os.ReadFile(filepath.Join(root, "upload.bin"))
	if err != nil || !bytes.Equal(upload, []byte{1, 2, 3, 4}) {
		t.Fatalf("uploaded content = %v, err = %v", upload, err)
	}
	if _, err := os.Stat(filepath.Join(root, "nested", "renamed.txt")); err != nil {
		t.Fatal(err)
	}
}

func TestRunFileMutateJSONRejectsSymlinkParentEscape(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(root, "outside")); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	input, err := json.Marshal(fileMutationPayload{
		Operation: "write", Root: root, Path: "outside/stolen.txt", Content: "blocked", CreateDirs: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := runFileMutateJSON(bytes.NewReader(input), io.Discard); err == nil || !strings.Contains(err.Error(), "escapes workspace root") {
		t.Fatalf("expected symlink escape rejection, got %v", err)
	}
	if _, err := os.Stat(filepath.Join(outside, "stolen.txt")); !os.IsNotExist(err) {
		t.Fatalf("outside file should not exist, got %v", err)
	}
}

func TestRunFileSearchJSONUsesSharedSearchSemantics(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "one.txt"), []byte("needle here\nneedlework\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	input, err := json.Marshal(map[string]any{
		"root": root,
		"request": runtimecore.FileSearchRequest{
			Query: "needle", WholeWord: true, IncludePattern: "*.txt", MaxResults: 10,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	if err := runFileSearchJSON(bytes.NewReader(input), &output); err != nil {
		t.Fatal(err)
	}
	var result runtimecore.SearchResult
	if err := json.Unmarshal(output.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.TotalMatches != 1 || len(result.Files) != 1 || result.Files[0].Matches[0].Line != 1 {
		t.Fatalf("unexpected direct search result: %#v", result)
	}
}

func TestRunFileWatchSnapshotJSONReturnsDirectoryMetadata(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "src"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "src", "main.ts"), []byte("main"), 0o644); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	if err := runFileWatchSnapshotJSON([]string{"--root", root}, &output); err != nil {
		t.Fatal(err)
	}
	var entries []runtimecore.FileWatchSnapshotEntry
	if err := json.Unmarshal(output.Bytes(), &entries); err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 || entries[0].Path != "src" || !entries[0].IsDirectory || entries[1].Path != "src/main.ts" || entries[1].MtimeNanos <= 0 {
		t.Fatalf("unexpected watch snapshot: %#v", entries)
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
	branch, ahead, behind, changes := parseGitStatusOutput("## feature...origin/feature [ahead 2, behind 1]\n M README.md\n?? docs/new.md\nR  old.go -> new.go\nUU conflicted.txt\n", "")
	if branch != "feature" || ahead != 2 || behind != 1 {
		t.Fatalf("unexpected branch data: %s ahead=%d behind=%d", branch, ahead, behind)
	}
	if len(changes) != 4 ||
		changes[0].Path != "README.md" ||
		changes[0].Status != "modified" ||
		changes[1].Status != "untracked" ||
		changes[2].Path != "new.go" ||
		changes[2].Status != "renamed" {
		t.Fatalf("unexpected changes: %#v", changes)
	}
	if changes[3].ConflictKind != "both_modified" || changes[3].ConflictStatus != "unresolved" || changes[3].Area != "unstaged" {
		t.Fatalf("unexpected conflict change: %#v", changes[3])
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
