package runtimehttp

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/tsekaluk/pebble/go-runtime/internal/runtimecore"
)

func TestStatusEndpoint(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), []string{"zig"})
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(manager)

	req := httptest.NewRequest(http.MethodGet, "/v1/status", nil)
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	var status runtimecore.RuntimeStatus
	if err := json.Unmarshal(rec.Body.Bytes(), &status); err != nil {
		t.Fatal(err)
	}
	if status.Version != runtimecore.ProtocolVersion {
		t.Fatalf("unexpected protocol version %q", status.Version)
	}
	if len(status.Capabilities) == 0 {
		t.Fatal("expected advertised capabilities")
	}
}

func TestServerBearerToken(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	server := NewServerWithOptions(manager, ServerOptions{BearerToken: "secret"})

	req := httptest.NewRequest(http.MethodGet, "/v1/status", nil)
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 without token, got %d: %s", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/v1/status", nil)
	req.Header.Set("Authorization", "Bearer wrong")
	rec = httptest.NewRecorder()
	server.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 with wrong token, got %d: %s", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/v1/status", nil)
	req.Header.Set("Authorization", "Bearer secret")
	rec = httptest.NewRecorder()
	server.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 with token, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestEventsEndpointStreamsRuntimeEvents(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	testServer := httptest.NewServer(NewServer(manager))
	defer testServer.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, testServer.URL+"/v1/events", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	if contentType := resp.Header.Get("Content-Type"); !strings.HasPrefix(contentType, "text/event-stream") {
		t.Fatalf("expected event-stream content type, got %q", contentType)
	}

	events := make(chan runtimecore.RuntimeEvent, 1)
	errs := make(chan error, 1)
	go func() {
		scanner := bufio.NewScanner(resp.Body)
		var sseEventID string
		var sseEventTopic string
		for scanner.Scan() {
			line := scanner.Text()
			switch {
			case strings.HasPrefix(line, "id: "):
				sseEventID = strings.TrimPrefix(line, "id: ")
			case strings.HasPrefix(line, "event: "):
				sseEventTopic = strings.TrimPrefix(line, "event: ")
			case strings.HasPrefix(line, "data: "):
				var event runtimecore.RuntimeEvent
				if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &event); err != nil {
					errs <- err
					return
				}
				if event.ID != sseEventID || event.Topic != sseEventTopic {
					errs <- io.ErrUnexpectedEOF
					return
				}
				events <- event
				return
			}
		}
		if err := scanner.Err(); err != nil {
			errs <- err
			return
		}
		errs <- io.EOF
	}()

	if _, err := manager.CreateProject(runtimecore.CreateProjectRequest{Name: "repo", Path: t.TempDir()}); err != nil {
		t.Fatal(err)
	}
	select {
	case event := <-events:
		if event.Version != "pebble.events.v1" || event.Topic != "project.changed" {
			t.Fatalf("unexpected event: %#v", event)
		}
	case err := <-errs:
		t.Fatalf("event stream failed: %v", err)
	case <-ctx.Done():
		t.Fatal("timed out waiting for event stream")
	}
}

func TestEventsEndpointFiltersByTopic(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	testServer := httptest.NewServer(NewServer(manager))
	defer testServer.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, testServer.URL+"/v1/events?topic=browser.changed", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}

	events := make(chan runtimecore.RuntimeEvent, 1)
	errs := make(chan error, 1)
	go func() {
		scanner := bufio.NewScanner(resp.Body)
		for scanner.Scan() {
			line := scanner.Text()
			if !strings.HasPrefix(line, "data: ") {
				continue
			}
			var event runtimecore.RuntimeEvent
			if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &event); err != nil {
				errs <- err
				return
			}
			events <- event
			return
		}
		if err := scanner.Err(); err != nil {
			errs <- err
			return
		}
		errs <- io.EOF
	}()

	project, err := manager.CreateProject(runtimecore.CreateProjectRequest{Name: "repo", Path: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.CreateBrowserTab(runtimecore.CreateBrowserTabRequest{
		ProjectID: project.ID,
		Title:     "Docs",
		URL:       "https://example.test",
	}); err != nil {
		t.Fatal(err)
	}
	select {
	case event := <-events:
		if event.Topic != "browser.changed" {
			t.Fatalf("unexpected filtered event: %#v", event)
		}
	case err := <-errs:
		t.Fatalf("event stream failed: %v", err)
	case <-ctx.Done():
		t.Fatal("timed out waiting for filtered event stream")
	}
}

func TestEventsEndpointRejectsNonGet(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(manager)

	req := httptest.NewRequest(http.MethodPost, "/v1/events", nil)
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestEventsEndpointRequiresBearerToken(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	server := NewServerWithOptions(manager, ServerOptions{BearerToken: "secret"})

	req := httptest.NewRequest(http.MethodGet, "/v1/events", nil)
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestSplitActionPathsPreserveExtraSegments(t *testing.T) {
	if id, action := splitSessionPath("/v1/sessions/sess_1/tail/extra"); id != "sess_1" || action != "tail/extra" {
		t.Fatalf("unexpected session split id=%q action=%q", id, action)
	}
	if id, action := splitReleasePath("/v1/releases/rel_1/manifest/extra"); id != "rel_1" || action != "manifest/extra" {
		t.Fatalf("unexpected release split id=%q action=%q", id, action)
	}
	if id, action := splitOrchestrationPath("/v1/orchestration/messages/msg_1/reply/extra", "/v1/orchestration/messages/"); id != "msg_1" || action != "reply/extra" {
		t.Fatalf("unexpected message split id=%q action=%q", id, action)
	}
	if id, action := splitBrowserDownloadPath("/v1/browser/downloads/down_1/commands/start/extra"); id != "down_1" || action != "commands/start/extra" {
		t.Fatalf("unexpected browser download split id=%q action=%q", id, action)
	}
	if id, action := splitEmulatorSessionPath("/v1/emulator/sessions/emus_1/commands/extra"); id != "emus_1" || action != "commands/extra" {
		t.Fatalf("unexpected emulator session split id=%q action=%q", id, action)
	}
}

func TestSessionClearBufferEndpoint(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	project, err := manager.CreateProject(runtimecore.CreateProjectRequest{Name: "repo", Path: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	session, err := manager.StartSession(context.Background(), runtimecore.StartSessionRequest{
		ProjectID: project.ID,
		Command:   runtimeHTTPTestEchoCommand(),
	})
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if current := manager.ListSessions()[0]; current.Status == runtimecore.SessionExited {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if tail, err := manager.TailSession(session.ID, 10); err != nil || len(tail.Chunks) == 0 {
		t.Fatalf("expected output before clear, tail=%#v err=%v", tail, err)
	}
	server := NewServer(manager)
	req := httptest.NewRequest(http.MethodPost, "/v1/sessions/"+session.ID+"/clear-buffer", nil)
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var cleared runtimecore.Session
	if err := json.Unmarshal(rec.Body.Bytes(), &cleared); err != nil {
		t.Fatal(err)
	}
	if cleared.OutputChunks != 0 {
		t.Fatalf("expected cleared snapshot to report 0 chunks, got %d", cleared.OutputChunks)
	}
	tail, err := manager.TailSession(session.ID, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(tail.Chunks) != 0 {
		t.Fatalf("expected cleared tail, got %#v", tail.Chunks)
	}
}

func TestSessionResizeEndpoint(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	project, err := manager.CreateProject(runtimecore.CreateProjectRequest{Name: "repo", Path: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	session, err := manager.StartSession(context.Background(), runtimecore.StartSessionRequest{
		ProjectID: project.ID,
		Command:   runtimeHTTPTestSleepCommand(),
		Cols:      80,
		Rows:      24,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		_, _ = manager.StopSession(session.ID)
	}()

	server := NewServer(manager)
	req := httptest.NewRequest(
		http.MethodPost,
		"/v1/sessions/"+session.ID+"/resize",
		strings.NewReader(`{"cols":144,"rows":47}`),
	)
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var resized runtimecore.Session
	if err := json.Unmarshal(rec.Body.Bytes(), &resized); err != nil {
		t.Fatal(err)
	}
	if resized.Cols != 144 || resized.Rows != 47 {
		t.Fatalf("expected resized session, got cols=%d rows=%d", resized.Cols, resized.Rows)
	}
}

func TestWorktreeLineageEndpoints(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	project, err := manager.CreateProject(runtimecore.CreateProjectRequest{Name: "repo", Path: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	parent, err := manager.CreateWorktree(context.Background(), runtimecore.CreateWorktreeRequest{
		ProjectID: project.ID,
		Path:      t.TempDir(),
		Branch:    "parent",
	})
	if err != nil {
		t.Fatal(err)
	}
	child, err := manager.CreateWorktree(context.Background(), runtimecore.CreateWorktreeRequest{
		ProjectID: project.ID,
		Path:      t.TempDir(),
		Branch:    "child",
	})
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(manager)
	updateReq := httptest.NewRequest(
		http.MethodPatch,
		"/v1/worktrees/"+child.ID,
		strings.NewReader(`{"parentWorktreeId":"`+parent.ID+`"}`),
	)
	updateRec := httptest.NewRecorder()
	server.ServeHTTP(updateRec, updateReq)
	if updateRec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", updateRec.Code, updateRec.Body.String())
	}
	var updated runtimecore.Worktree
	if err := json.Unmarshal(updateRec.Body.Bytes(), &updated); err != nil {
		t.Fatal(err)
	}
	if updated.Lineage == nil || updated.Lineage.ParentWorktreeID != parent.ID {
		t.Fatalf("unexpected lineage update: %#v", updated.Lineage)
	}
	listReq := httptest.NewRequest(http.MethodGet, "/v1/worktrees/lineage", nil)
	listRec := httptest.NewRecorder()
	server.ServeHTTP(listRec, listReq)
	if listRec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", listRec.Code, listRec.Body.String())
	}
	var list runtimecore.WorktreeLineageListResponse
	if err := json.Unmarshal(listRec.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	if got := list.Lineage[child.ID]; got.ParentWorktreeID != parent.ID {
		t.Fatalf("lineage endpoint missed child: %#v", list)
	}
	if got := list.WorkspaceLineage["worktree:"+child.ID]; got.ParentWorkspaceKey != "worktree:"+parent.ID {
		t.Fatalf("workspace lineage endpoint missed child: %#v", list)
	}
	folderReq := httptest.NewRequest(
		http.MethodPatch,
		"/v1/worktrees/"+child.ID,
		strings.NewReader(`{"parentWorkspace":"folder:folder-1","origin":"cli","capture":{"source":"explicit-cli-flag","confidence":"explicit"}}`),
	)
	folderRec := httptest.NewRecorder()
	server.ServeHTTP(folderRec, folderReq)
	if folderRec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", folderRec.Code, folderRec.Body.String())
	}
	listReq = httptest.NewRequest(http.MethodGet, "/v1/worktrees/lineage", nil)
	listRec = httptest.NewRecorder()
	server.ServeHTTP(listRec, listReq)
	if listRec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", listRec.Code, listRec.Body.String())
	}
	list = runtimecore.WorktreeLineageListResponse{}
	if err := json.Unmarshal(listRec.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	if len(list.Lineage) != 0 || list.WorkspaceLineage["worktree:"+child.ID].ParentWorkspaceKey != "folder:folder-1" {
		t.Fatalf("folder workspace lineage endpoint mismatch: %#v", list)
	}
}

func TestProjectGroupAndFolderWorkspaceEndpoints(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(manager)
	folderPath := t.TempDir()
	folderPathJSON, err := json.Marshal(folderPath)
	if err != nil {
		t.Fatal(err)
	}
	groupReq := httptest.NewRequest(
		http.MethodPost,
		"/v1/project-groups",
		strings.NewReader(`{"name":"Platform","parentPath":`+string(folderPathJSON)+`}`),
	)
	groupRec := httptest.NewRecorder()
	server.ServeHTTP(groupRec, groupReq)
	if groupRec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", groupRec.Code, groupRec.Body.String())
	}
	var group runtimecore.ProjectGroup
	if err := json.Unmarshal(groupRec.Body.Bytes(), &group); err != nil {
		t.Fatal(err)
	}
	groupIDJSON, err := json.Marshal(group.ID)
	if err != nil {
		t.Fatal(err)
	}
	statusReq := httptest.NewRequest(
		http.MethodPost,
		"/v1/folder-workspaces/path-status",
		strings.NewReader(`{"scope":"project-group","projectGroupId":`+string(groupIDJSON)+`}`),
	)
	statusRec := httptest.NewRecorder()
	server.ServeHTTP(statusRec, statusReq)
	if statusRec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", statusRec.Code, statusRec.Body.String())
	}
	var status runtimecore.FolderWorkspacePathStatus
	if err := json.Unmarshal(statusRec.Body.Bytes(), &status); err != nil {
		t.Fatal(err)
	}
	if !status.Exists {
		t.Fatalf("expected path to exist, got %#v", status)
	}
	workspaceReq := httptest.NewRequest(
		http.MethodPost,
		"/v1/folder-workspaces",
		strings.NewReader(`{"projectGroupId":`+string(groupIDJSON)+`,"name":"Area"}`),
	)
	workspaceRec := httptest.NewRecorder()
	server.ServeHTTP(workspaceRec, workspaceReq)
	if workspaceRec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", workspaceRec.Code, workspaceRec.Body.String())
	}
	var workspace runtimecore.FolderWorkspace
	if err := json.Unmarshal(workspaceRec.Body.Bytes(), &workspace); err != nil {
		t.Fatal(err)
	}
	updateReq := httptest.NewRequest(
		http.MethodPatch,
		"/v1/folder-workspaces/"+workspace.ID,
		strings.NewReader(`{"updates":{"comment":"Ready","isPinned":true}}`),
	)
	updateRec := httptest.NewRecorder()
	server.ServeHTTP(updateRec, updateReq)
	if updateRec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", updateRec.Code, updateRec.Body.String())
	}
	var updated runtimecore.FolderWorkspace
	if err := json.Unmarshal(updateRec.Body.Bytes(), &updated); err != nil {
		t.Fatal(err)
	}
	if updated.Comment != "Ready" || !updated.IsPinned {
		t.Fatalf("unexpected folder workspace update: %#v", updated)
	}
	deleteReq := httptest.NewRequest(http.MethodDelete, "/v1/folder-workspaces/"+workspace.ID, nil)
	deleteRec := httptest.NewRecorder()
	server.ServeHTTP(deleteRec, deleteReq)
	if deleteRec.Code != http.StatusOK || !strings.Contains(deleteRec.Body.String(), `"deleted":true`) {
		t.Fatalf("expected successful delete, got %d: %s", deleteRec.Code, deleteRec.Body.String())
	}
}

func TestProjectGroupNestedRepoEndpoints(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(manager)
	parentPath := t.TempDir()
	appPath := filepath.Join(parentPath, "apps", "app")
	libPath := filepath.Join(parentPath, "apps", "lib")
	createHTTPGitMarker(t, appPath)
	createHTTPGitMarker(t, libPath)
	parentPathJSON, err := json.Marshal(parentPath)
	if err != nil {
		t.Fatal(err)
	}
	scanReq := httptest.NewRequest(
		http.MethodPost,
		"/v1/project-groups/scan-nested",
		strings.NewReader(`{"path":`+string(parentPathJSON)+`,"options":{"maxDepth":4}}`),
	)
	scanRec := httptest.NewRecorder()
	server.ServeHTTP(scanRec, scanReq)
	if scanRec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", scanRec.Code, scanRec.Body.String())
	}
	var scan runtimecore.NestedRepoScanResult
	if err := json.Unmarshal(scanRec.Body.Bytes(), &scan); err != nil {
		t.Fatal(err)
	}
	if len(scan.Repos) != 2 {
		t.Fatalf("expected nested repo scan results, got %#v", scan)
	}
	appPathJSON, err := json.Marshal(appPath)
	if err != nil {
		t.Fatal(err)
	}
	libPathJSON, err := json.Marshal(libPath)
	if err != nil {
		t.Fatal(err)
	}
	importReq := httptest.NewRequest(
		http.MethodPost,
		"/v1/project-groups/import-nested",
		strings.NewReader(
			`{"parentPath":`+string(parentPathJSON)+`,"groupName":"Apps","projectPaths":[`+
				string(appPathJSON)+`,`+string(libPathJSON)+`],"mode":"group"}`,
		),
	)
	importRec := httptest.NewRecorder()
	server.ServeHTTP(importRec, importReq)
	if importRec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", importRec.Code, importRec.Body.String())
	}
	var result runtimecore.ProjectGroupImportResult
	if err := json.Unmarshal(importRec.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.ImportedCount != 2 || result.Group == nil {
		t.Fatalf("expected imported nested repos, got %#v", result)
	}
}

func createHTTPGitMarker(t *testing.T, repoPath string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(repoPath, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
}

func TestForceDeletePreservedBranchEndpointRejectsMissingBranch(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git executable is not available")
	}
	repo := t.TempDir()
	for _, args := range [][]string{
		{"init"},
		{"config", "user.email", "dev@example.test"},
		{"config", "user.name", "Dev"},
	} {
		cmd := exec.Command("git", append([]string{"-C", repo}, args...)...)
		cmd.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1")
		if output, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v failed: %v\n%s", args, err, output)
		}
	}
	if err := os.WriteFile(filepath.Join(repo, "README.md"), []byte("one\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{{"add", "README.md"}, {"commit", "-m", "init"}} {
		cmd := exec.Command("git", append([]string{"-C", repo}, args...)...)
		cmd.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1")
		if output, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v failed: %v\n%s", args, err, output)
		}
	}
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	project, err := manager.CreateProject(runtimecore.CreateProjectRequest{Name: "repo", Path: repo})
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(manager)
	// The exact path must route to the force-delete handler, not the /v1/worktrees/
	// by-id catch-all, and a missing branch must surface as a 404.
	req := httptest.NewRequest(
		http.MethodPost,
		"/v1/worktrees/branches/force-delete",
		strings.NewReader(`{"projectId":"`+project.ID+`","branchName":"missing/branch"}`),
	)
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for missing branch, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestWorktreeSortOrderEndpoint(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	project, err := manager.CreateProject(runtimecore.CreateProjectRequest{Name: "repo", Path: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	first, err := manager.CreateWorktree(context.Background(), runtimecore.CreateWorktreeRequest{
		ProjectID: project.ID,
		Path:      t.TempDir(),
		Branch:    "first",
	})
	if err != nil {
		t.Fatal(err)
	}
	second, err := manager.CreateWorktree(context.Background(), runtimecore.CreateWorktreeRequest{
		ProjectID: project.ID,
		Path:      t.TempDir(),
		Branch:    "second",
	})
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(manager)
	req := httptest.NewRequest(
		http.MethodPost,
		"/v1/worktrees/sort-order",
		strings.NewReader(`{"orderedIds":["`+second.ID+`","`+first.ID+`"]}`),
	)
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	worktrees := manager.ListWorktrees(project.ID)
	byID := map[string]runtimecore.Worktree{}
	for _, worktree := range worktrees {
		byID[worktree.ID] = worktree
	}
	if byID[second.ID].SortOrder <= byID[first.ID].SortOrder {
		t.Fatalf("expected sort order to persist: %#v", byID)
	}
}

func TestProjectReorderEndpoint(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	first, err := manager.CreateProject(runtimecore.CreateProjectRequest{Name: "first", Path: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	second, err := manager.CreateProject(runtimecore.CreateProjectRequest{Name: "second", Path: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(manager)
	req := httptest.NewRequest(
		http.MethodPost,
		"/v1/projects/reorder",
		strings.NewReader(`{"orderedIds":["`+second.ID+`","`+first.ID+`"]}`),
	)
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	projects := manager.ListProjects()
	if len(projects) != 2 || projects[0].ID != second.ID || projects[1].ID != first.ID {
		t.Fatalf("project reorder endpoint did not persist order: %#v", projects)
	}
}

func runtimeHTTPTestEchoCommand() []string {
	if runtime.GOOS == "windows" {
		return []string{"cmd.exe", "/d", "/s", "/c", "echo pebble"}
	}
	return []string{"/bin/sh", "-c", "printf 'pebble\n'"}
}

func runtimeHTTPTestSleepCommand() []string {
	if runtime.GOOS == "windows" {
		return []string{"cmd.exe", "/d", "/s", "/c", "ping -n 10 127.0.0.1 > NUL"}
	}
	return []string{"/bin/sh", "-c", "sleep 10"}
}

func TestProjectLifecycleEndpoints(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(manager)

	payload := map[string]string{
		"name":         "repo",
		"path":         t.TempDir(),
		"locationKind": "local",
	}
	content, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/v1/projects", bytes.NewReader(content))
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/v1/projects", nil)
	rec = httptest.NewRecorder()
	server.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	var projects []runtimecore.Project
	if err := json.Unmarshal(rec.Body.Bytes(), &projects); err != nil {
		t.Fatal(err)
	}
	if len(projects) != 1 || projects[0].Name != "repo" {
		t.Fatalf("unexpected projects: %#v", projects)
	}
}

func TestJSONDecoderRejectsTrailingValues(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(manager)
	content := []byte(`{"name":"repo","path":"/tmp"} {}`)

	req := httptest.NewRequest(http.MethodPost, "/v1/projects", bytes.NewReader(content))
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "single JSON value") {
		t.Fatalf("expected trailing JSON error, got %s", rec.Body.String())
	}
}

func TestProjectUpdateAndDeleteEndpoints(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	project, err := manager.CreateProject(runtimecore.CreateProjectRequest{Name: "repo", Path: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(manager)

	content, err := json.Marshal(runtimecore.UpdateProjectRequest{Name: "renamed"})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPatch, "/v1/projects/"+project.ID, bytes.NewReader(content))
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var updated runtimecore.Project
	if err := json.Unmarshal(rec.Body.Bytes(), &updated); err != nil {
		t.Fatal(err)
	}
	if updated.Name != "renamed" {
		t.Fatalf("project was not updated: %#v", updated)
	}

	req = httptest.NewRequest(http.MethodDelete, "/v1/projects/"+project.ID, nil)
	rec = httptest.NewRecorder()
	server.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if got := manager.ListProjects(); len(got) != 0 {
		t.Fatalf("project was not deleted: %#v", got)
	}
}

func TestWorktreeDeleteEndpoint(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	project, err := manager.CreateProject(runtimecore.CreateProjectRequest{Name: "repo", Path: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	worktree, err := manager.CreateWorktree(context.Background(), runtimecore.CreateWorktreeRequest{
		ProjectID: project.ID,
		Path:      t.TempDir(),
		Branch:    "feature",
	})
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(manager)

	req := httptest.NewRequest(http.MethodDelete, "/v1/worktrees/"+worktree.ID, nil)
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if got := manager.ListWorktrees(project.ID); len(got) != 0 {
		t.Fatalf("worktree was not deleted: %#v", got)
	}
}

func TestBrowserTabDeleteEndpoint(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	tab, err := manager.CreateBrowserTab(runtimecore.CreateBrowserTabRequest{
		Title: "Docs",
		URL:   "https://example.test",
	})
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(manager)

	req := httptest.NewRequest(http.MethodDelete, "/v1/browser/tabs/"+tab.ID, nil)
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if got := manager.ListBrowserTabs(); len(got) != 0 {
		t.Fatalf("browser tab was not deleted: %#v", got)
	}
}

func TestBrowserCommandEndpointQueuesBrowserAction(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	tab, err := manager.CreateBrowserTab(runtimecore.CreateBrowserTabRequest{
		Title: "Docs",
		URL:   "https://example.test",
	})
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(manager)

	req := httptest.NewRequest(
		http.MethodPost,
		"/v1/browser/tabs/"+tab.ID+"/commands",
		strings.NewReader(`{"command":"goBack","payload":{"reason":"mobile"}}`),
	)
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("expected 202, got %d: %s", rec.Code, rec.Body.String())
	}
	var action runtimecore.ComputerAction
	if err := json.Unmarshal(rec.Body.Bytes(), &action); err != nil {
		t.Fatal(err)
	}
	if action.Kind != "browser.goBack" || action.Target != tab.ID {
		t.Fatalf("unexpected browser action: %#v", action)
	}
	if action.Payload["tabId"] != tab.ID || action.Payload["command"] != "goBack" {
		t.Fatalf("browser action payload lost tab context: %#v", action.Payload)
	}
}

func TestBrowserProfilePermissionAndDownloadEndpoints(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(manager)

	profileReq := httptest.NewRequest(
		http.MethodPost,
		"/v1/browser/profiles",
		strings.NewReader(`{"name":"Default","persistent":true}`),
	)
	profileRec := httptest.NewRecorder()
	server.ServeHTTP(profileRec, profileReq)
	if profileRec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", profileRec.Code, profileRec.Body.String())
	}
	var profile runtimecore.BrowserProfile
	if err := json.Unmarshal(profileRec.Body.Bytes(), &profile); err != nil {
		t.Fatal(err)
	}

	permissionReq := httptest.NewRequest(
		http.MethodPost,
		"/v1/browser/permissions",
		strings.NewReader(`{"profileId":"`+profile.ID+`","origin":"https://example.test","name":"camera","state":"granted"}`),
	)
	permissionRec := httptest.NewRecorder()
	server.ServeHTTP(permissionRec, permissionReq)
	if permissionRec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", permissionRec.Code, permissionRec.Body.String())
	}

	downloadReq := httptest.NewRequest(
		http.MethodPost,
		"/v1/browser/downloads",
		strings.NewReader(`{"url":"https://example.test/archive.zip","filename":"archive.zip","status":"inProgress"}`),
	)
	downloadRec := httptest.NewRecorder()
	server.ServeHTTP(downloadRec, downloadReq)
	if downloadRec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", downloadRec.Code, downloadRec.Body.String())
	}
	var download runtimecore.BrowserDownload
	if err := json.Unmarshal(downloadRec.Body.Bytes(), &download); err != nil {
		t.Fatal(err)
	}

	startReq := httptest.NewRequest(
		http.MethodPost,
		"/v1/browser/downloads/"+download.ID+"/commands/start",
		nil,
	)
	startRec := httptest.NewRecorder()
	server.ServeHTTP(startRec, startReq)
	if startRec.Code != http.StatusAccepted {
		t.Fatalf("expected 202, got %d: %s", startRec.Code, startRec.Body.String())
	}
	var downloadAction runtimecore.ComputerAction
	if err := json.Unmarshal(startRec.Body.Bytes(), &downloadAction); err != nil {
		t.Fatal(err)
	}
	if downloadAction.Kind != "browser.download" || downloadAction.Target != download.ID {
		t.Fatalf("unexpected browser download action: %#v", downloadAction)
	}

	updateReq := httptest.NewRequest(
		http.MethodPatch,
		"/v1/browser/downloads/"+download.ID,
		strings.NewReader(`{"status":"completed","bytesReceived":100}`),
	)
	updateRec := httptest.NewRecorder()
	server.ServeHTTP(updateRec, updateReq)
	if updateRec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", updateRec.Code, updateRec.Body.String())
	}
	var updated runtimecore.BrowserDownload
	if err := json.Unmarshal(updateRec.Body.Bytes(), &updated); err != nil {
		t.Fatal(err)
	}
	if updated.Status != runtimecore.BrowserDownloadCompleted || updated.BytesReceived != 100 {
		t.Fatalf("unexpected updated browser download: %#v", updated)
	}

	deleteProfileReq := httptest.NewRequest(
		http.MethodDelete,
		"/v1/browser/profiles/"+profile.ID,
		nil,
	)
	deleteProfileRec := httptest.NewRecorder()
	server.ServeHTTP(deleteProfileRec, deleteProfileReq)
	if deleteProfileRec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", deleteProfileRec.Code, deleteProfileRec.Body.String())
	}
	if got := manager.ListBrowserProfiles(); len(got) != 0 {
		t.Fatalf("browser profile was not deleted: %#v", got)
	}
}

func TestAutomationEndpointsCreateTriggerAndListRuns(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(manager)

	createReq := httptest.NewRequest(
		http.MethodPost,
		"/v1/automations",
		strings.NewReader(`{"name":"nightly","enabled":true,"schedule":{"kind":"manual"},"action":{"kind":"createTask","payload":{"title":"automation task"}}}`),
	)
	createRec := httptest.NewRecorder()
	server.ServeHTTP(createRec, createReq)
	if createRec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", createRec.Code, createRec.Body.String())
	}
	var automation runtimecore.Automation
	if err := json.Unmarshal(createRec.Body.Bytes(), &automation); err != nil {
		t.Fatal(err)
	}

	triggerReq := httptest.NewRequest(
		http.MethodPost,
		"/v1/automations/"+automation.ID+"/runs",
		strings.NewReader(`{"reason":"manual"}`),
	)
	triggerRec := httptest.NewRecorder()
	server.ServeHTTP(triggerRec, triggerReq)
	if triggerRec.Code != http.StatusAccepted {
		t.Fatalf("expected 202, got %d: %s", triggerRec.Code, triggerRec.Body.String())
	}
	var run runtimecore.AutomationRun
	if err := json.Unmarshal(triggerRec.Body.Bytes(), &run); err != nil {
		t.Fatal(err)
	}
	if run.Status != runtimecore.AutomationRunCompleted || run.TaskID == "" {
		t.Fatalf("unexpected automation run: %#v", run)
	}

	listReq := httptest.NewRequest(http.MethodGet, "/v1/automations/runs?automationId="+automation.ID, nil)
	listRec := httptest.NewRecorder()
	server.ServeHTTP(listRec, listReq)
	if listRec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", listRec.Code, listRec.Body.String())
	}
	var runs []runtimecore.AutomationRun
	if err := json.Unmarshal(listRec.Body.Bytes(), &runs); err != nil {
		t.Fatal(err)
	}
	if len(runs) != 1 || runs[0].ID != run.ID {
		t.Fatalf("unexpected automation runs: %#v", runs)
	}
}

func TestExternalTaskEndpointsUpsertFilterAndDelete(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(manager)

	upsertReq := httptest.NewRequest(
		http.MethodPost,
		"/v1/external-tasks",
		strings.NewReader(`{"provider":"jira","externalId":"ORC-7","title":"triage bug","status":"open","createTask":true}`),
	)
	upsertRec := httptest.NewRecorder()
	server.ServeHTTP(upsertRec, upsertReq)
	if upsertRec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", upsertRec.Code, upsertRec.Body.String())
	}
	var item runtimecore.ExternalWorkItem
	if err := json.Unmarshal(upsertRec.Body.Bytes(), &item); err != nil {
		t.Fatal(err)
	}
	if item.Provider != "jira" || item.TaskID == "" {
		t.Fatalf("unexpected external work item: %#v", item)
	}

	listReq := httptest.NewRequest(http.MethodGet, "/v1/external-tasks?provider=jira&kind=ticket", nil)
	listRec := httptest.NewRecorder()
	server.ServeHTTP(listRec, listReq)
	if listRec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", listRec.Code, listRec.Body.String())
	}
	var items []runtimecore.ExternalWorkItem
	if err := json.Unmarshal(listRec.Body.Bytes(), &items); err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].ID != item.ID {
		t.Fatalf("unexpected external task list: %#v", items)
	}

	deleteReq := httptest.NewRequest(http.MethodDelete, "/v1/external-tasks/"+item.ID, nil)
	deleteRec := httptest.NewRecorder()
	server.ServeHTTP(deleteRec, deleteReq)
	if deleteRec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", deleteRec.Code, deleteRec.Body.String())
	}
}

func TestFileEndpointsWriteReadAndListTree(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	project, err := manager.CreateProject(runtimecore.CreateProjectRequest{Name: "repo", Path: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(manager)

	writeReq := httptest.NewRequest(
		http.MethodPost,
		"/v1/files/write",
		strings.NewReader(`{"projectId":"`+project.ID+`","path":"src/main.txt","content":"hello","createDirs":true}`),
	)
	writeRec := httptest.NewRecorder()
	server.ServeHTTP(writeRec, writeReq)
	if writeRec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", writeRec.Code, writeRec.Body.String())
	}

	readReq := httptest.NewRequest(http.MethodGet, "/v1/files/read?projectId="+project.ID+"&path=src/main.txt", nil)
	readRec := httptest.NewRecorder()
	server.ServeHTTP(readRec, readReq)
	if readRec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", readRec.Code, readRec.Body.String())
	}
	var content runtimecore.FileContent
	if err := json.Unmarshal(readRec.Body.Bytes(), &content); err != nil {
		t.Fatal(err)
	}
	if content.Content != "hello" {
		t.Fatalf("unexpected file content: %#v", content)
	}

	treeReq := httptest.NewRequest(http.MethodGet, "/v1/files/tree?projectId="+project.ID+"&maxDepth=2", nil)
	treeRec := httptest.NewRecorder()
	server.ServeHTTP(treeRec, treeReq)
	if treeRec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", treeRec.Code, treeRec.Body.String())
	}
	var entries []runtimecore.FileEntry
	if err := json.Unmarshal(treeRec.Body.Bytes(), &entries); err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 {
		t.Fatalf("expected directory and file entries, got %#v", entries)
	}
}

func TestRemoteFileSnapshotEndpointsBackRemoteRead(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	project, err := manager.CreateProject(runtimecore.CreateProjectRequest{
		Name:         "remote",
		Path:         "/remote/repo",
		LocationKind: "ssh",
		HostID:       "host-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(manager)

	treeReq := httptest.NewRequest(
		http.MethodPost,
		"/v1/files/tree-snapshots",
		strings.NewReader(`{"projectId":"`+project.ID+`","entries":[{"path":"README.md","name":"README.md","kind":"file"}]}`),
	)
	treeRec := httptest.NewRecorder()
	server.ServeHTTP(treeRec, treeReq)
	if treeRec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", treeRec.Code, treeRec.Body.String())
	}

	contentReq := httptest.NewRequest(
		http.MethodPost,
		"/v1/files/content-snapshots",
		strings.NewReader(`{"projectId":"`+project.ID+`","path":"README.md","content":"remote"}`),
	)
	contentRec := httptest.NewRecorder()
	server.ServeHTTP(contentRec, contentReq)
	if contentRec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", contentRec.Code, contentRec.Body.String())
	}

	readReq := httptest.NewRequest(http.MethodGet, "/v1/files/read?projectId="+project.ID+"&path=README.md", nil)
	readRec := httptest.NewRecorder()
	server.ServeHTTP(readRec, readReq)
	if readRec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", readRec.Code, readRec.Body.String())
	}
	var content runtimecore.FileContent
	if err := json.Unmarshal(readRec.Body.Bytes(), &content); err != nil {
		t.Fatal(err)
	}
	if content.Content != "remote" {
		t.Fatalf("unexpected remote content: %#v", content)
	}
}

func TestReleaseEndpointsCreateArtifactCheckAndPublish(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(manager)

	createReq := httptest.NewRequest(http.MethodPost, "/v1/releases", strings.NewReader(`{"version":"1.2.3"}`))
	createRec := httptest.NewRecorder()
	server.ServeHTTP(createRec, createReq)
	if createRec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", createRec.Code, createRec.Body.String())
	}
	var plan runtimecore.ReleasePlan
	if err := json.Unmarshal(createRec.Body.Bytes(), &plan); err != nil {
		t.Fatal(err)
	}
	if plan.Status != runtimecore.ReleasePlanDraft || len(plan.RequiredArtifacts) == 0 {
		t.Fatalf("unexpected release plan: %#v", plan)
	}

	artifactReq := httptest.NewRequest(
		http.MethodPost,
		"/v1/releases/"+plan.ID+"/artifacts",
		strings.NewReader(`{"platform":"macos","kind":"appArchive","name":"dmg-or-zip","uri":"file://mac.dmg"}`),
	)
	artifactRec := httptest.NewRecorder()
	server.ServeHTTP(artifactRec, artifactReq)
	if artifactRec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", artifactRec.Code, artifactRec.Body.String())
	}

	checkReq := httptest.NewRequest(
		http.MethodPost,
		"/v1/releases/"+plan.ID+"/checks",
		strings.NewReader(`{"name":"macos-notarization","status":"passed"}`),
	)
	checkRec := httptest.NewRecorder()
	server.ServeHTTP(checkRec, checkReq)
	if checkRec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", checkRec.Code, checkRec.Body.String())
	}

	publishReq := httptest.NewRequest(http.MethodPost, "/v1/releases/"+plan.ID+"/publish", strings.NewReader(`{"force":true}`))
	publishRec := httptest.NewRecorder()
	server.ServeHTTP(publishRec, publishReq)
	if publishRec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", publishRec.Code, publishRec.Body.String())
	}
	var published runtimecore.ReleasePlan
	if err := json.Unmarshal(publishRec.Body.Bytes(), &published); err != nil {
		t.Fatal(err)
	}
	if published.Status != runtimecore.ReleasePlanPublished {
		t.Fatalf("release was not published: %#v", published)
	}

	manifestReq := httptest.NewRequest(http.MethodGet, "/v1/releases/"+plan.ID+"/manifest", nil)
	manifestRec := httptest.NewRecorder()
	server.ServeHTTP(manifestRec, manifestReq)
	if manifestRec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", manifestRec.Code, manifestRec.Body.String())
	}
	var manifest runtimecore.ReleaseUpdateManifest
	if err := json.Unmarshal(manifestRec.Body.Bytes(), &manifest); err != nil {
		t.Fatal(err)
	}
	if manifest.ReleaseID != plan.ID || manifest.Version != plan.Version || len(manifest.Artifacts) != 1 {
		t.Fatalf("unexpected release manifest: %#v", manifest)
	}
}

func TestSettingsEndpointsSetAndListKeybindings(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(manager)

	settingReq := httptest.NewRequest(
		http.MethodPost,
		"/v1/settings",
		strings.NewReader(`{"scope":"global","key":"theme","value":{"name":"system"}}`),
	)
	settingRec := httptest.NewRecorder()
	server.ServeHTTP(settingRec, settingReq)
	if settingRec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", settingRec.Code, settingRec.Body.String())
	}

	keybindingReq := httptest.NewRequest(
		http.MethodPost,
		"/v1/settings/keybindings",
		strings.NewReader(`{"command":"command.palette","accelerator":"CmdOrCtrl+Shift+P","context":"workbench"}`),
	)
	keybindingRec := httptest.NewRecorder()
	server.ServeHTTP(keybindingRec, keybindingReq)
	if keybindingRec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", keybindingRec.Code, keybindingRec.Body.String())
	}

	listReq := httptest.NewRequest(http.MethodGet, "/v1/settings/keybindings?context=workbench", nil)
	listRec := httptest.NewRecorder()
	server.ServeHTTP(listRec, listReq)
	if listRec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", listRec.Code, listRec.Body.String())
	}
	var keybindings []runtimecore.Keybinding
	if err := json.Unmarshal(listRec.Body.Bytes(), &keybindings); err != nil {
		t.Fatal(err)
	}
	if len(keybindings) != 1 || keybindings[0].Command != "command.palette" {
		t.Fatalf("unexpected keybindings: %#v", keybindings)
	}
}

func TestEmulatorCommandEndpointQueuesEmulatorAction(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	device, err := manager.RegisterEmulatorDevice(runtimecore.RegisterEmulatorDeviceRequest{
		Name:     "Pixel",
		Platform: "android",
	})
	if err != nil {
		t.Fatal(err)
	}
	session, err := manager.AttachEmulator(runtimecore.AttachEmulatorRequest{DeviceID: device.ID})
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(manager)

	req := httptest.NewRequest(
		http.MethodPost,
		"/v1/emulator/sessions/"+session.ID+"/commands",
		strings.NewReader(`{"command":"screenshot","payload":{"format":"png"}}`),
	)
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("expected 202, got %d: %s", rec.Code, rec.Body.String())
	}
	var action runtimecore.ComputerAction
	if err := json.Unmarshal(rec.Body.Bytes(), &action); err != nil {
		t.Fatal(err)
	}
	if action.Kind != "emulator.screenshot" || action.Target != session.ID {
		t.Fatalf("unexpected emulator action: %#v", action)
	}
	if action.Payload["sessionId"] != session.ID || action.Payload["deviceId"] != device.ID {
		t.Fatalf("emulator action payload lost session context: %#v", action.Payload)
	}
}

func TestNativeProviderEndpointUpdatesSubsystemStatus(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(manager)

	req := httptest.NewRequest(
		http.MethodPost,
		"/v1/providers",
		strings.NewReader(`{"subsystem":"browser","name":"tauri-webview","capabilities":["tabs","screenshots"],"message":"ready"}`),
	)
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	status := manager.SubsystemStatus("browser")
	if !status.Configured || len(status.Capabilities) != 2 {
		t.Fatalf("unexpected browser subsystem status: %#v", status)
	}
}

func TestSourceControlProjectionEndpoint(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	project, err := manager.CreateProject(runtimecore.CreateProjectRequest{
		Name:         "remote-repo",
		Path:         t.TempDir(),
		LocationKind: "ssh",
		HostID:       "host-1",
		Provider:     "gitlab",
	})
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(manager)

	req := httptest.NewRequest(http.MethodGet, "/v1/source-control?projectId="+project.ID, nil)
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var projections []runtimecore.SourceControlProjection
	if err := json.Unmarshal(rec.Body.Bytes(), &projections); err != nil {
		t.Fatal(err)
	}
	if len(projections) != 1 {
		t.Fatalf("expected one source-control projection, got %#v", projections)
	}
	if projections[0].RepositoryID != project.ID || projections[0].Provider != "gitlab" {
		t.Fatalf("unexpected source-control projection: %#v", projections[0])
	}
	if projections[0].SyncStatus != "unknown" {
		t.Fatalf("remote workspace should not be reported clean: %#v", projections[0])
	}
}

func TestSourceControlProjectionUpdateEndpoint(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	project, err := manager.CreateProject(runtimecore.CreateProjectRequest{
		Name:         "remote-repo",
		Path:         "/remote/repo",
		LocationKind: "ssh",
		HostID:       "host-1",
		Provider:     "gitlab",
	})
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(manager)

	req := httptest.NewRequest(
		http.MethodPost,
		"/v1/source-control/projections",
		strings.NewReader(`{"repositoryId":"`+project.ID+`","workspaceId":"`+project.ID+`","branch":"feature","syncStatus":"dirty","changes":[{"path":"README.md","status":"modified"}]}`),
	)
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var projection runtimecore.SourceControlProjection
	if err := json.Unmarshal(rec.Body.Bytes(), &projection); err != nil {
		t.Fatal(err)
	}
	if projection.SyncStatus != "dirty" || len(projection.Changes) != 1 {
		t.Fatalf("unexpected updated source-control projection: %#v", projection)
	}
}

func TestGitDiffEndpoint(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git executable is not available")
	}
	repo := t.TempDir()
	runHTTPGitCommand(t, repo, "init")
	runHTTPGitCommand(t, repo, "config", "user.email", "dev@example.test")
	runHTTPGitCommand(t, repo, "config", "user.name", "Dev")
	if err := os.WriteFile(filepath.Join(repo, "README.md"), []byte("one\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	runHTTPGitCommand(t, repo, "add", "README.md")
	runHTTPGitCommand(t, repo, "commit", "-m", "init")
	if err := os.WriteFile(filepath.Join(repo, "README.md"), []byte("two\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	project, err := manager.CreateProject(runtimecore.CreateProjectRequest{Name: "repo", Path: repo})
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(manager)

	req := httptest.NewRequest(http.MethodGet, "/v1/source-control/diff?projectId="+project.ID+"&path=README.md", nil)
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var diff runtimecore.GitDiff
	if err := json.Unmarshal(rec.Body.Bytes(), &diff); err != nil {
		t.Fatal(err)
	}
	if diff.FilePath != "README.md" || !strings.Contains(diff.Patch, "+two") {
		t.Fatalf("unexpected diff: %#v", diff)
	}
}

func TestComputerActionClaimEndpoint(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	action, err := manager.CreateComputerAction(runtimecore.CreateComputerActionRequest{Kind: "browser.reload"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.CreateComputerAction(runtimecore.CreateComputerActionRequest{Kind: "keyboard.type"}); err != nil {
		t.Fatal(err)
	}
	server := NewServer(manager)
	content, err := json.Marshal(runtimecore.ClaimComputerActionsRequest{
		KindPrefix: "browser.",
		Limit:      5,
	})
	if err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPost, "/v1/computer/actions/claim", bytes.NewReader(content))
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var claimed []runtimecore.ComputerAction
	if err := json.Unmarshal(rec.Body.Bytes(), &claimed); err != nil {
		t.Fatal(err)
	}
	if len(claimed) != 1 || claimed[0].ID != action.ID || claimed[0].Status != runtimecore.ComputerActionRunning {
		t.Fatalf("unexpected claimed actions: %#v", claimed)
	}
}

func TestEmulatorUpdateAndDetachEndpoints(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	device, err := manager.RegisterEmulatorDevice(runtimecore.RegisterEmulatorDeviceRequest{
		Name:     "iPhone",
		Platform: "ios",
	})
	if err != nil {
		t.Fatal(err)
	}
	session, err := manager.AttachEmulator(runtimecore.AttachEmulatorRequest{DeviceID: device.ID})
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(manager)

	content, err := json.Marshal(runtimecore.UpdateEmulatorDeviceRequest{
		Status: runtimecore.EmulatorDeviceError,
		Error:  "simulator unavailable",
	})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPatch, "/v1/emulator/devices/"+device.ID, bytes.NewReader(content))
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var updatedDevice runtimecore.EmulatorDevice
	if err := json.Unmarshal(rec.Body.Bytes(), &updatedDevice); err != nil {
		t.Fatal(err)
	}
	if updatedDevice.Status != runtimecore.EmulatorDeviceError || updatedDevice.Error == "" {
		t.Fatalf("unexpected updated device: %#v", updatedDevice)
	}

	req = httptest.NewRequest(http.MethodDelete, "/v1/emulator/sessions/"+session.ID, nil)
	rec = httptest.NewRecorder()
	server.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var detached runtimecore.EmulatorSession
	if err := json.Unmarshal(rec.Body.Bytes(), &detached); err != nil {
		t.Fatal(err)
	}
	if detached.Active {
		t.Fatalf("expected detached session: %#v", detached)
	}
}

func TestSubsystemEndpoint(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(manager)

	req := httptest.NewRequest(http.MethodGet, "/v1/browser/status", nil)
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var status runtimecore.SubsystemStatus
	if err := json.Unmarshal(rec.Body.Bytes(), &status); err != nil {
		t.Fatal(err)
	}
	if status.Name != "browser" {
		t.Fatalf("unexpected subsystem: %#v", status)
	}
}

func runHTTPGitCommand(t *testing.T, path string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", path}, args...)...)
	cmd.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1")
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v failed: %v\n%s", args, err, output)
	}
}

func TestMessageEndpoint(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(manager)

	content, err := json.Marshal(map[string]string{
		"from":    "coordinator",
		"to":      "worker",
		"subject": "hello",
		"type":    "status",
	})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/v1/orchestration/messages", bytes.NewReader(content))
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/v1/orchestration/messages?to=worker", nil)
	rec = httptest.NewRecorder()
	server.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var messages []runtimecore.Message
	if err := json.Unmarshal(rec.Body.Bytes(), &messages); err != nil {
		t.Fatal(err)
	}
	if len(messages) != 1 || messages[0].To != "worker" {
		t.Fatalf("unexpected messages: %#v", messages)
	}
}

func TestDispatchUpdateEndpoint(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	task, err := manager.CreateTask(runtimecore.CreateTaskRequest{Title: "dispatch"})
	if err != nil {
		t.Fatal(err)
	}
	dispatch, err := manager.DispatchTask(runtimecore.DispatchTaskRequest{
		TaskID:   task.ID,
		Assignee: "worker",
	})
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(manager)
	content, err := json.Marshal(runtimecore.UpdateDispatchRequest{Status: runtimecore.DispatchFailed})
	if err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPatch, "/v1/orchestration/dispatches/"+dispatch.ID, bytes.NewReader(content))
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var updated runtimecore.Dispatch
	if err := json.Unmarshal(rec.Body.Bytes(), &updated); err != nil {
		t.Fatal(err)
	}
	if updated.Status != runtimecore.DispatchFailed {
		t.Fatalf("dispatch was not failed: %#v", updated)
	}
}

func TestAgentProfileEndpoint(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(manager)

	content, err := json.Marshal(map[string]interface{}{
		"name":                "shell-agent",
		"kind":                "shell",
		"command":             []string{"/bin/sh"},
		"promptInjectionMode": "stdin-after-start",
	})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/v1/agents/profiles", bytes.NewReader(content))
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/v1/agents/profiles", nil)
	rec = httptest.NewRecorder()
	server.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var profiles []runtimecore.AgentProfile
	if err := json.Unmarshal(rec.Body.Bytes(), &profiles); err != nil {
		t.Fatal(err)
	}
	if len(profiles) != 1 || profiles[0].Kind != "shell" {
		t.Fatalf("unexpected profiles: %#v", profiles)
	}
}

func TestAgentProfileUpdateDeleteEndpoint(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	profile, err := manager.CreateAgentProfile(runtimecore.CreateAgentProfileRequest{
		Name:                "agent",
		Kind:                "shell",
		Command:             []string{"echo", "ok"},
		PromptInjectionMode: runtimecore.PromptNone,
	})
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(manager)
	content, err := json.Marshal(runtimecore.UpdateAgentProfileRequest{Name: "renamed"})
	if err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPatch, "/v1/agents/profiles/"+profile.ID, bytes.NewReader(content))
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var updated runtimecore.AgentProfile
	if err := json.Unmarshal(rec.Body.Bytes(), &updated); err != nil {
		t.Fatal(err)
	}
	if updated.Name != "renamed" {
		t.Fatalf("agent profile was not updated: %#v", updated)
	}

	req = httptest.NewRequest(http.MethodDelete, "/v1/agents/profiles/"+profile.ID, nil)
	rec = httptest.NewRecorder()
	server.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if got := manager.ListAgentProfiles(); len(got) != 0 {
		t.Fatalf("agent profile was not deleted: %#v", got)
	}
}
