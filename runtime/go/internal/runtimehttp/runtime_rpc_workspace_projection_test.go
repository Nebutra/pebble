package runtimehttp

import (
	"context"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
)

func TestLegacySharedControlRuntimeScopeClonesAndRemovesRealGitWorktree(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is required")
	}
	source := filepath.Join(t.TempDir(), "source")
	if err := os.MkdirAll(source, 0o755); err != nil {
		t.Fatal(err)
	}
	runGitTestCommand(t, source, "init")
	runGitTestCommand(t, source, "config", "user.email", "pebble@example.test")
	runGitTestCommand(t, source, "config", "user.name", "Pebble Test")
	if err := os.WriteFile(filepath.Join(source, "README.md"), []byte("Pebble\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(
		filepath.Join(source, "pebble.yaml"),
		[]byte("scripts:\n  setup: printf setup > setup-ran.txt\n"),
		0o644,
	); err != nil {
		t.Fatal(err)
	}
	for _, directory := range []string{"src", "docs"} {
		if err := os.MkdirAll(filepath.Join(source, directory), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(source, directory, "index.txt"), []byte(directory+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	runGitTestCommand(t, source, "add", ".")
	runGitTestCommand(t, source, "commit", "-m", "initial")

	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	pairing, err := manager.CreateLegacySharedControlPairing("git-runtime", "runtime", false)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(NewServer(manager))
	defer server.Close()
	rawConn, reader := dialTestWebSocket(t, server.URL, "/v1/shared-control")
	defer rawConn.Close()
	conn := &websocketConn{conn: rawConn, reader: reader}
	sharedKey := authenticateLegacySharedControlTestClient(t, rawConn, conn, pairing)
	destination := t.TempDir()
	writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{
		"id": "clone", "deviceToken": pairing.DeviceToken, "method": "repo.clone",
		"params": map[string]interface{}{"url": source, "destination": destination},
	})
	cloned := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey)
	clonedResult, _ := cloned["result"].(map[string]interface{})
	clonedRepo, _ := clonedResult["repo"].(map[string]interface{})
	projectID, _ := clonedRepo["id"].(string)
	clonePath, _ := clonedRepo["path"].(string)
	if projectID == "" || clonePath == "" {
		t.Fatalf("repository clone failed: %#v", cloned)
	}
	worktreePath := filepath.Join(t.TempDir(), "parallel-universe")
	if _, err := manager.UpdateProject(projectID, runtimecore.UpdateProjectRequest{WorktreeBasePath: stringPointer(filepath.Dir(worktreePath))}); err != nil {
		t.Fatal(err)
	}
	writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{
		"id": "create", "deviceToken": pairing.DeviceToken, "method": "worktree.create",
		"params": map[string]interface{}{
			"repo": projectID, "name": filepath.Base(worktreePath), "branchNameOverride": "feature",
			"displayName": "Universe", "comment": "created remotely", "isPinned": true,
			"sparseCheckout": map[string]interface{}{"directories": []string{"src"}, "presetId": "frontend"},
			"runHooks":       true,
			"startupCommand": `printf "$PEBBLE_TEST_STARTUP" > startup-ran.txt`,
			"startupEnv":     map[string]string{"PEBBLE_TEST_STARTUP": "started"},
			"startupAgent":   "codex",
		},
	})
	created := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey)
	createdResult, _ := created["result"].(map[string]interface{})
	createdRecord, _ := createdResult["worktree"].(map[string]interface{})
	worktreeID, _ := createdRecord["id"].(string)
	if worktreeID == "" || createdRecord["displayName"] != "Universe" || createdRecord["comment"] != "created remotely" {
		t.Fatalf("worktree create failed: %#v", created)
	}
	startupTerminal, _ := createdResult["startupTerminal"].(map[string]interface{})
	startupHandle, _ := startupTerminal["handle"].(string)
	if startupHandle == "" || startupTerminal["spawned"] != true {
		t.Fatalf("startup terminal was not returned: %#v", createdResult)
	}
	sparseDirectories, _ := createdRecord["sparseDirectories"].([]interface{})
	if len(sparseDirectories) != 1 || sparseDirectories[0] != "src" || createdRecord["sparsePresetId"] != "frontend" {
		t.Fatalf("sparse metadata was not returned: %#v", createdRecord)
	}
	if _, err := os.Stat(worktreePath); err != nil {
		t.Fatalf("git worktree directory was not created: %v", err)
	}
	if _, err := os.Stat(filepath.Join(worktreePath, "src", "index.txt")); err != nil {
		t.Fatalf("selected sparse directory is missing: %v", err)
	}
	if _, err := os.Stat(filepath.Join(worktreePath, "docs")); !os.IsNotExist(err) {
		t.Fatalf("unselected sparse directory was checked out: %v", err)
	}
	if output, err := os.ReadFile(filepath.Join(worktreePath, "setup-ran.txt")); err != nil || string(output) != "setup" {
		t.Fatalf("setup hook did not run in the worktree: output=%q err=%v", output, err)
	}
	startupPath := filepath.Join(worktreePath, "startup-ran.txt")
	deadline := time.Now().Add(3 * time.Second)
	for {
		output, err := os.ReadFile(startupPath)
		if err == nil && string(output) == "started" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("startup command did not run in the worktree: output=%q err=%v", output, err)
		}
		time.Sleep(20 * time.Millisecond)
	}
	if _, err := manager.StopSession(startupHandle); err != nil {
		t.Fatal(err)
	}
	writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{
		"id": "remove", "deviceToken": pairing.DeviceToken, "method": "worktree.rm",
		"params": map[string]interface{}{"worktree": worktreeID, "force": false, "runHooks": false},
	})
	removed := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey)
	if removed["ok"] != false || len(manager.ListWorktrees(projectID)) != 2 {
		t.Fatalf("dirty worktree removal did not fail safely: %#v", removed)
	}
	writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{
		"id": "force-remove", "deviceToken": pairing.DeviceToken, "method": "worktree.rm",
		"params": map[string]interface{}{"worktree": worktreeID, "force": true, "runHooks": false},
	})
	forceRemoved := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey)
	if forceRemoved["ok"] != true || len(manager.ListWorktrees(projectID)) != 1 {
		t.Fatalf("forced worktree removal failed: %#v", forceRemoved)
	}
	if _, err := os.Stat(worktreePath); !os.IsNotExist(err) {
		t.Fatalf("git worktree directory still exists: %v", err)
	}
}

func stringPointer(value string) *string {
	return &value
}

func runGitTestCommand(t *testing.T, cwd string, args ...string) {
	t.Helper()
	command := exec.Command("git", append([]string{"-C", cwd}, args...)...)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("git %v failed: %v\n%s", args, err, output)
	}
}

func TestLegacySharedControlRuntimeScopeListsRendererWorkspaceRecords(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	projectPath := t.TempDir()
	project, err := manager.CreateProject(runtimecore.CreateProjectRequest{
		Name: "Pebble", Path: projectPath, LocationKind: "local",
	})
	if err != nil {
		t.Fatal(err)
	}
	worktree, err := manager.CreateWorktree(context.Background(), runtimecore.CreateWorktreeRequest{
		ProjectID: project.ID, Path: filepath.Join(projectPath, "parallel-universe"), Branch: "feature",
	})
	if err != nil {
		t.Fatal(err)
	}
	pairing, err := manager.CreateLegacySharedControlPairing("remote-desktop", "runtime", false)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(NewServer(manager))
	defer server.Close()
	rawConn, reader := dialTestWebSocket(t, server.URL, "/v1/shared-control")
	defer rawConn.Close()
	conn := &websocketConn{conn: rawConn, reader: reader}
	sharedKey := authenticateLegacySharedControlTestClient(t, rawConn, conn, pairing)

	writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{
		"id": "repos", "deviceToken": pairing.DeviceToken, "method": "repo.list",
	})
	repoResponse := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey)
	repoResult, _ := repoResponse["result"].(map[string]interface{})
	repos, _ := repoResult["repos"].([]interface{})
	if len(repos) != 1 {
		t.Fatalf("unexpected repo list response: %#v", repoResponse)
	}
	repo, _ := repos[0].(map[string]interface{})
	if repo["id"] != project.ID || repo["displayName"] != "Pebble" || repo["executionHostId"] != "local" {
		t.Fatalf("repo did not match renderer contract: %#v", repo)
	}

	writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{
		"id": "worktrees", "deviceToken": pairing.DeviceToken, "method": "worktree.list",
		"params": map[string]interface{}{"repo": project.ID, "limit": 100},
	})
	worktreeResponse := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey)
	worktreeResult, _ := worktreeResponse["result"].(map[string]interface{})
	worktrees, _ := worktreeResult["worktrees"].([]interface{})
	if len(worktrees) != 1 {
		t.Fatalf("unexpected worktree list response: %#v", worktreeResponse)
	}
	projected, _ := worktrees[0].(map[string]interface{})
	if projected["id"] != worktree.ID || projected["repoId"] != project.ID || projected["branch"] != "feature" {
		t.Fatalf("worktree did not match renderer contract: %#v", projected)
	}
	writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{
		"id": "repo-update", "deviceToken": pairing.DeviceToken, "method": "repo.update",
		"params": map[string]interface{}{"repo": project.ID, "updates": map[string]interface{}{"displayName": "Pebble remote"}},
	})
	repoUpdated := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey)
	repoUpdatedResult, _ := repoUpdated["result"].(map[string]interface{})
	repoRecord, _ := repoUpdatedResult["repo"].(map[string]interface{})
	if repoRecord["displayName"] != "Pebble remote" {
		t.Fatalf("repository update failed: %#v", repoUpdated)
	}
	writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{
		"id": "repo-unsupported", "deviceToken": pairing.DeviceToken, "method": "repo.update",
		"params": map[string]interface{}{"repo": project.ID, "updates": map[string]interface{}{"badgeColor": "#000000"}},
	})
	unsupported := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey)
	unsupportedError, _ := unsupported["error"].(map[string]interface{})
	if unsupported["ok"] != false || unsupportedError["code"] != "workspace_operation_failed" {
		t.Fatalf("unsupported repository update silently succeeded: %#v", unsupported)
	}

	writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{
		"id": "worktree-set", "deviceToken": pairing.DeviceToken, "method": "worktree.set",
		"params": map[string]interface{}{"worktree": worktree.ID, "displayName": "Universe A", "comment": "remote", "isPinned": true},
	})
	worktreeUpdated := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey)
	worktreeUpdatedResult, _ := worktreeUpdated["result"].(map[string]interface{})
	worktreeRecord, _ := worktreeUpdatedResult["worktree"].(map[string]interface{})
	if worktreeRecord["displayName"] != "Universe A" || worktreeRecord["isPinned"] != true {
		t.Fatalf("worktree update failed: %#v", worktreeUpdated)
	}

	for _, request := range []struct {
		id, method string
		params     map[string]interface{}
	}{
		{"repo-show", "repo.show", map[string]interface{}{"repo": project.ID}},
		{"repo-order", "repo.reorder", map[string]interface{}{"orderedIds": []string{project.ID}}},
		{"worktree-show", "worktree.show", map[string]interface{}{"worktree": worktree.ID}},
		{"worktree-order", "worktree.persistSortOrder", map[string]interface{}{"orderedIds": []string{worktree.ID}}},
	} {
		writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{
			"id": request.id, "deviceToken": pairing.DeviceToken, "method": request.method, "params": request.params,
		})
		response := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey)
		if response["ok"] != true {
			t.Fatalf("%s failed: %#v", request.method, response)
		}
	}

	for _, request := range []struct {
		id, method, key string
	}{
		{"groups", "projectGroup.list", "groups"},
		{"folders", "folderWorkspace.list", "folderWorkspaces"},
		{"lineage", "worktree.lineageList", "lineage"},
	} {
		writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{
			"id": request.id, "deviceToken": pairing.DeviceToken, "method": request.method,
		})
		response := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey)
		result, _ := response["result"].(map[string]interface{})
		if response["ok"] != true || result[request.key] == nil {
			t.Fatalf("%s did not return its canonical collection: %#v", request.method, response)
		}
	}

	writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{
		"id": "group-create", "deviceToken": pairing.DeviceToken, "method": "projectGroup.create",
		"params": map[string]interface{}{"name": "Remote", "parentPath": projectPath},
	})
	groupCreated := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey)
	groupResult, _ := groupCreated["result"].(map[string]interface{})
	group, _ := groupResult["group"].(map[string]interface{})
	groupID, _ := group["id"].(string)
	if groupID == "" {
		t.Fatalf("project group create failed: %#v", groupCreated)
	}

	writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{
		"id": "project-move", "deviceToken": pairing.DeviceToken, "method": "projectGroup.moveProject",
		"params": map[string]interface{}{"repo": project.ID, "groupId": groupID, "order": 2},
	})
	moved := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey)
	movedResult, _ := moved["result"].(map[string]interface{})
	movedRepo, _ := movedResult["repo"].(map[string]interface{})
	if movedRepo["projectGroupId"] != groupID {
		t.Fatalf("project move failed: %#v", moved)
	}

	writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{
		"id": "folder-create", "deviceToken": pairing.DeviceToken, "method": "folderWorkspace.create",
		"params": map[string]interface{}{"projectGroupId": groupID, "name": "Notes", "folderPath": projectPath},
	})
	folderCreated := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey)
	folderResult, _ := folderCreated["result"].(map[string]interface{})
	folder, _ := folderResult["folderWorkspace"].(map[string]interface{})
	folderID, _ := folder["id"].(string)
	if folderID == "" {
		t.Fatalf("folder workspace create failed: %#v", folderCreated)
	}

	writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{
		"id": "folder-update", "deviceToken": pairing.DeviceToken, "method": "folderWorkspace.update",
		"params": map[string]interface{}{"folderWorkspaceId": folderID, "updates": map[string]interface{}{"name": "Remote notes"}},
	})
	folderUpdated := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey)
	updatedResult, _ := folderUpdated["result"].(map[string]interface{})
	updatedFolder, _ := updatedResult["folderWorkspace"].(map[string]interface{})
	if updatedFolder["name"] != "Remote notes" {
		t.Fatalf("folder workspace update failed: %#v", folderUpdated)
	}

	writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{
		"id": "folder-status", "deviceToken": pairing.DeviceToken, "method": "folderWorkspace.getPathStatus",
		"params": map[string]interface{}{"scope": "folder-workspace", "folderWorkspaceId": folderID},
	})
	pathStatus := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey)
	pathResult, _ := pathStatus["result"].(map[string]interface{})
	status, _ := pathResult["status"].(map[string]interface{})
	if status["exists"] != true {
		t.Fatalf("folder workspace path status failed: %#v", pathStatus)
	}

	for _, request := range []struct{ id, method, key, value string }{
		{"folder-delete", "folderWorkspace.delete", "folderWorkspaceId", folderID},
		{"group-delete", "projectGroup.delete", "groupId", groupID},
	} {
		writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{
			"id": request.id, "deviceToken": pairing.DeviceToken, "method": request.method,
			"params": map[string]interface{}{request.key: request.value},
		})
		response := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey)
		if response["ok"] != true {
			t.Fatalf("%s failed: %#v", request.method, response)
		}
	}
	folderPath := t.TempDir()
	writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{
		"id": "repo-add", "deviceToken": pairing.DeviceToken, "method": "repo.add",
		"params": map[string]interface{}{"path": folderPath, "kind": "folder"},
	})
	added := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey)
	addedResult, _ := added["result"].(map[string]interface{})
	addedRepo, _ := addedResult["repo"].(map[string]interface{})
	addedID, _ := addedRepo["id"].(string)
	if addedID == "" || addedRepo["kind"] != "folder" {
		t.Fatalf("folder repository add failed: %#v", added)
	}
	writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{
		"id": "folder-repo-remove", "deviceToken": pairing.DeviceToken, "method": "repo.rm",
		"params": map[string]interface{}{"repo": addedID},
	})
	if response := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey); response["ok"] != true {
		t.Fatalf("folder repository removal failed: %#v", response)
	}
	writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{
		"id": "repo-remove", "deviceToken": pairing.DeviceToken, "method": "repo.rm",
		"params": map[string]interface{}{"repo": project.ID},
	})
	removed := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey)
	if removed["ok"] != true || len(manager.ListProjects()) != 0 {
		t.Fatalf("repository removal failed: %#v", removed)
	}
}

func TestMobileScopeCannotListRuntimeWorkspaceRecords(t *testing.T) {
	methods := []string{
		"repo.list", "worktree.list", "projectGroup.list", "projectGroup.create",
		"projectGroup.update", "projectGroup.delete", "projectGroup.moveProject",
		"folderWorkspace.list", "folderWorkspace.create", "folderWorkspace.update",
		"folderWorkspace.delete", "folderWorkspace.getPathStatus", "worktree.lineageList",
		"repo.add", "repo.show", "repo.update", "repo.rm", "repo.reorder",
		"worktree.show", "worktree.set", "worktree.persistSortOrder",
	}
	for _, method := range methods {
		if legacySharedControlMobileMethodAllowed(method) {
			t.Fatalf("%s must remain unavailable to mobile-scoped tokens", method)
		}
	}
}
