package runtimehttp

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
	"golang.org/x/crypto/nacl/box"
)

func TestLegacySharedControlDecryptsTweetNaClFixture(t *testing.T) {
	secretBytes, err := base64.StdEncoding.DecodeString("ZWZnaGlqa2xtbm9wcXJzdHV2d3h5ent8fX5/gIGCg4Q=")
	if err != nil {
		t.Fatal(err)
	}
	var serverSecret [32]byte
	copy(serverSecret[:], secretBytes)
	sharedKey, err := deriveLegacySharedControlKey("B6N8vBQgk8i3VdwbEOhstCY3StFqqFPtC9/AsrhtHHw=", &serverSecret)
	if err != nil {
		t.Fatal(err)
	}
	plaintext, err := decryptLegacySharedControlText("ycrLzM3Oz9DR0tPU1dbX2Nna29zd3t/gTJw4v+6yLT/7amopYKx3B+658qj802XJzclh4uSC/bjh7XDdqCe7sVdcl+u52lE+gTgoTFFhDRve1ri5xMVkoGEw", sharedKey)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"type":"e2ee_auth","deviceToken":"fixture-token"}`
	if string(plaintext) != want {
		t.Fatalf("unexpected plaintext %q", plaintext)
	}
}

func TestLegacySharedControlAccountsSubscription(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	_, err = manager.SetAccountsSnapshot(runtimecore.AccountsSnapshot{
		Claude: json.RawMessage(`{"accounts":[]}`), Codex: json.RawMessage(`{"accounts":[]}`), RateLimits: json.RawMessage(`{"claude":{}}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	pairing, err := manager.CreateLegacySharedControlPairing("test", "runtime", false)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(NewServer(manager))
	defer server.Close()
	rawConn, reader := dialTestWebSocket(t, server.URL, "/v1/shared-control")
	defer rawConn.Close()
	conn := &websocketConn{conn: rawConn, reader: reader}
	clientPublic, clientSecret, err := box.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	writeTestClientMessage(t, rawConn, map[string]string{"type": "e2ee_hello", "publicKeyB64": base64.StdEncoding.EncodeToString(clientPublic[:])})
	ready, err := conn.readText(false)
	if err != nil || ready != `{"type":"e2ee_ready"}` {
		t.Fatalf("unexpected ready frame %q: %v", ready, err)
	}
	serverPublicBytes, err := base64.StdEncoding.DecodeString(pairing.PublicKeyB64)
	if err != nil {
		t.Fatal(err)
	}
	var serverPublic [32]byte
	copy(serverPublic[:], serverPublicBytes)
	var sharedKey [32]byte
	box.Precompute(&sharedKey, &serverPublic, clientSecret)
	writeEncryptedLegacySharedControlTestFrame(t, rawConn, &sharedKey, map[string]string{"type": "e2ee_auth", "deviceToken": pairing.DeviceToken})
	authenticated := readEncryptedLegacySharedControlTestFrame(t, conn, &sharedKey)
	if authenticated["type"] != "e2ee_authenticated" {
		t.Fatalf("unexpected auth frame: %#v", authenticated)
	}
	writeEncryptedLegacySharedControlTestFrame(t, rawConn, &sharedKey, map[string]interface{}{"id": "sub-1", "deviceToken": pairing.DeviceToken, "method": "accounts.subscribe"})
	readyResponse := readEncryptedLegacySharedControlTestFrame(t, conn, &sharedKey)
	readyResult, _ := readyResponse["result"].(map[string]interface{})
	subscriptionID, _ := readyResult["subscriptionId"].(string)
	if readyResponse["id"] != "sub-1" || readyResponse["streaming"] != true || readyResult["type"] != "ready" || subscriptionID == "" {
		t.Fatalf("unexpected subscription response: %#v", readyResponse)
	}
	_, err = manager.SetAccountsSnapshot(runtimecore.AccountsSnapshot{
		Claude: json.RawMessage(`{"accounts":[{"id":"claude-1"}]}`), Codex: json.RawMessage(`{"accounts":[]}`), RateLimits: json.RawMessage(`{"claude":{"claude-1":{}}}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	updateResponse := readEncryptedLegacySharedControlTestFrame(t, conn, &sharedKey)
	result, _ := updateResponse["result"].(map[string]interface{})
	if updateResponse["id"] != "sub-1" || result["type"] != "snapshot" {
		t.Fatalf("unexpected subscription update: %#v", updateResponse)
	}
	writeEncryptedLegacySharedControlTestFrame(t, rawConn, &sharedKey, map[string]interface{}{"id": "unsub-1", "deviceToken": pairing.DeviceToken, "method": "accounts.unsubscribe", "params": map[string]string{"subscriptionId": subscriptionID}})
	seenEnd := false
	seenAck := false
	for attempts := 0; attempts < 2; attempts++ {
		response := readEncryptedLegacySharedControlTestFrame(t, conn, &sharedKey)
		responseResult, _ := response["result"].(map[string]interface{})
		if response["id"] == "sub-1" && responseResult["type"] == "end" {
			seenEnd = true
		}
		if response["id"] == "unsub-1" && responseResult["unsubscribed"] == true {
			seenAck = true
		}
	}
	if !seenEnd || !seenAck {
		t.Fatalf("expected subscription end and unsubscribe acknowledgement")
	}
	writeEncryptedLegacySharedControlTestFrame(t, rawConn, &sharedKey, map[string]interface{}{"id": "tabs-1", "deviceToken": pairing.DeviceToken, "method": "session.tabs.subscribe", "params": map[string]string{"worktree": "id:wt-1"}})
	tabsReady := readEncryptedLegacySharedControlTestFrame(t, conn, &sharedKey)
	tabsResult, _ := tabsReady["result"].(map[string]interface{})
	if tabsReady["id"] != "tabs-1" || tabsResult["type"] != "snapshot" || tabsResult["worktree"] != "wt-1" {
		t.Fatalf("unexpected tabs subscription response: %#v", tabsReady)
	}
	_, err = manager.SaveSessionTabLayout("wt-1", runtimecore.SaveSessionTabLayoutRequest{ActiveGroupID: "main"})
	if err != nil {
		t.Fatal(err)
	}
	tabsUpdate := readEncryptedLegacySharedControlTestFrame(t, conn, &sharedKey)
	tabsUpdateResult, _ := tabsUpdate["result"].(map[string]interface{})
	if tabsUpdate["id"] != "tabs-1" || tabsUpdateResult["type"] != "updated" || tabsUpdateResult["worktree"] != "wt-1" {
		t.Fatalf("unexpected tabs update response: %#v", tabsUpdate)
	}
}

func TestLegacySharedControlPreflightAgentDetectionIsFullScopeOnly(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(NewServer(manager))
	defer server.Close()
	for _, scope := range []string{"runtime", "mobile"} {
		pairing, err := manager.CreateLegacySharedControlPairing("preflight-"+scope, scope, false)
		if err != nil {
			t.Fatal(err)
		}
		rawConn, reader := dialTestWebSocket(t, server.URL, "/v1/shared-control")
		conn := &websocketConn{conn: rawConn, reader: reader}
		sharedKey := authenticateLegacySharedControlTestClient(t, rawConn, conn, pairing)
		writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{
			"id": "detect-" + scope, "deviceToken": pairing.DeviceToken,
			"method": "preflight.detectAgents",
		})
		response := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey)
		if scope == "runtime" {
			if response["ok"] != true {
				t.Fatalf("full-scope detection failed: %#v", response)
			}
			if _, ok := response["result"].([]interface{}); !ok {
				t.Fatalf("full-scope detection did not return an array: %#v", response)
			}
			writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{"id": "refresh-runtime", "deviceToken": pairing.DeviceToken, "method": "preflight.refreshAgents"})
			refresh := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey)
			refreshResult, _ := refresh["result"].(map[string]interface{})
			if refresh["ok"] != true || refreshResult["shellHydrationOk"] != true || refreshResult["pathSource"] != "shell_hydrate" {
				t.Fatalf("full-scope refresh contract is invalid: %#v", refresh)
			}
			if _, ok := refreshResult["agents"].([]interface{}); !ok {
				t.Fatalf("full-scope refresh agents did not return an array: %#v", refresh)
			}
			writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{"id": "check-runtime", "deviceToken": pairing.DeviceToken, "method": "preflight.check"})
			check := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey)
			checkResult, _ := check["result"].(map[string]interface{})
			if check["ok"] != true || checkResult["git"] == nil || checkResult["gh"] == nil || checkResult["glab"] == nil {
				t.Fatalf("full-scope preflight check contract is invalid: %#v", check)
			}
		} else {
			errorValue, _ := response["error"].(map[string]interface{})
			if response["ok"] != false || errorValue["code"] != "forbidden" {
				t.Fatalf("mobile detection was not denied: %#v", response)
			}
		}
		rawConn.Close()
	}
}

func TestLegacySharedControlFileMethodsUseRemoteWorktreeScope(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "src"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "src", "main.ts"), []byte("export const pebble = true\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "logo.png"), []byte{0x89, 0x50, 0x4e, 0x47}, 0o644); err != nil {
		t.Fatal(err)
	}
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	project, err := manager.CreateProject(runtimecore.CreateProjectRequest{Name: "repo", Path: root})
	if err != nil {
		t.Fatal(err)
	}
	worktree, err := manager.CreateWorktree(context.Background(), runtimecore.CreateWorktreeRequest{ProjectID: project.ID, Path: root, Branch: "main"})
	if err != nil {
		t.Fatal(err)
	}
	pairing, err := manager.CreateLegacySharedControlPairing("files-runtime", "runtime", false)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(NewServer(manager))
	defer server.Close()
	rawConn, reader := dialTestWebSocket(t, server.URL, "/v1/shared-control")
	defer rawConn.Close()
	conn := &websocketConn{conn: rawConn, reader: reader}
	sharedKey := authenticateLegacySharedControlTestClient(t, rawConn, conn, pairing)

	request := func(id, method string, params map[string]interface{}) map[string]interface{} {
		params["worktree"] = "id:" + worktree.ID
		writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{"id": id, "deviceToken": pairing.DeviceToken, "method": method, "params": params})
		return readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey)
	}
	directory := request("dir", "files.readDir", map[string]interface{}{"relativePath": "src"})
	directoryEntries, _ := directory["result"].([]interface{})
	if directory["ok"] != true || len(directoryEntries) != 1 || directoryEntries[0].(map[string]interface{})["name"] != "main.ts" {
		t.Fatalf("unexpected directory response: %#v", directory)
	}
	read := request("read", "files.read", map[string]interface{}{"relativePath": "src/main.ts"})
	readResult, _ := read["result"].(map[string]interface{})
	if readResult["content"] != "export const pebble = true\n" || readResult["truncated"] != false || readResult["worktree"] != worktree.ID {
		t.Fatalf("unexpected read response: %#v", read)
	}
	preview := request("preview", "files.readPreview", map[string]interface{}{"relativePath": "logo.png"})
	previewResult, _ := preview["result"].(map[string]interface{})
	if previewResult["content"] != "iVBORw==" || previewResult["mimeType"] != "image/png" || previewResult["isBinary"] != true {
		t.Fatalf("unexpected preview response: %#v", preview)
	}
	search := request("search", "files.search", map[string]interface{}{"query": "pebble"})
	searchResult, _ := search["result"].(map[string]interface{})
	searchFiles, _ := searchResult["files"].([]interface{})
	if len(searchFiles) != 1 || searchFiles[0].(map[string]interface{})["relativePath"] != "src/main.ts" {
		t.Fatalf("unexpected search response: %#v", search)
	}
	write := request("write", "files.write", map[string]interface{}{"relativePath": "src/generated.ts", "content": "generated\n"})
	if write["ok"] != true {
		t.Fatalf("unexpected write response: %#v", write)
	}
	if content, err := os.ReadFile(filepath.Join(root, "src", "generated.ts")); err != nil || string(content) != "generated\n" {
		t.Fatalf("remote write was not persisted: %q, %v", content, err)
	}
	traversal := request("traversal", "files.read", map[string]interface{}{"relativePath": "../outside.txt"})
	if traversal["ok"] != false {
		t.Fatalf("path traversal was not rejected: %#v", traversal)
	}
}

func TestLegacySharedControlFileMethodsAreDeniedToMobileScope(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	pairing, err := manager.CreateLegacySharedControlPairing("files-mobile", "mobile", false)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(NewServer(manager))
	defer server.Close()
	rawConn, reader := dialTestWebSocket(t, server.URL, "/v1/shared-control")
	defer rawConn.Close()
	conn := &websocketConn{conn: rawConn, reader: reader}
	sharedKey := authenticateLegacySharedControlTestClient(t, rawConn, conn, pairing)
	writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{"id": "mobile-files", "deviceToken": pairing.DeviceToken, "method": "files.readDir", "params": map[string]string{"worktree": "id:any"}})
	response := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey)
	errorValue, _ := response["error"].(map[string]interface{})
	if response["ok"] != false || errorValue["code"] != "forbidden" {
		t.Fatalf("mobile file method was not denied: %#v", response)
	}
}

func TestLegacySharedControlTerminalArtifactsRequireLiveOutputProvenance(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("terminal artifact integration uses /bin/sh")
	}
	root := t.TempDir()
	artifact := filepath.Join(t.TempDir(), "agent-note.txt")
	if err := os.WriteFile(artifact, []byte("before\n"), 0o640); err != nil {
		t.Fatal(err)
	}
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	project, err := manager.CreateProject(runtimecore.CreateProjectRequest{Name: "repo", Path: root})
	if err != nil {
		t.Fatal(err)
	}
	worktree, err := manager.CreateWorktree(context.Background(), runtimecore.CreateWorktreeRequest{ProjectID: project.ID, Path: root, Branch: "main"})
	if err != nil {
		t.Fatal(err)
	}
	session, err := manager.StartSession(context.Background(), runtimecore.StartSessionRequest{ProjectID: project.ID, WorktreeID: worktree.ID, Cwd: root, Command: []string{"/bin/sh"}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = manager.StopSession(session.ID) })
	if err := manager.WriteSession(session.ID, runtimecore.SessionInputRequest{Text: "printf '%s\\n' '" + artifact + "'", AppendNewline: true}); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		tail, tailErr := manager.TailSession(session.ID, 2000)
		if tailErr == nil {
			var output strings.Builder
			for _, chunk := range tail.Chunks {
				output.WriteString(chunk.Content)
			}
			if strings.Contains(output.String(), artifact) {
				break
			}
		}
		if time.Now().After(deadline) {
			t.Fatal("terminal did not emit artifact path")
		}
		time.Sleep(10 * time.Millisecond)
	}
	pairing, err := manager.CreateLegacySharedControlPairing("terminal-artifact", "runtime", false)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(NewServer(manager))
	defer server.Close()
	rawConn, reader := dialTestWebSocket(t, server.URL, "/v1/shared-control")
	defer rawConn.Close()
	conn := &websocketConn{conn: rawConn, reader: reader}
	sharedKey := authenticateLegacySharedControlTestClient(t, rawConn, conn, pairing)
	request := func(id, method string, params map[string]interface{}) map[string]interface{} {
		params["worktree"] = "id:" + worktree.ID
		writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{"id": id, "deviceToken": pairing.DeviceToken, "method": method, "params": params})
		return readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey)
	}
	resolved := request("resolve-artifact", "files.resolveTerminalPath", map[string]interface{}{"pathText": artifact, "terminal": session.ID, "cwd": root})
	resolvedResult, _ := resolved["result"].(map[string]interface{})
	openTarget, _ := resolvedResult["openTarget"].(map[string]interface{})
	grantID, _ := openTarget["grantId"].(string)
	if resolved["ok"] != true || resolvedResult["exists"] != true || openTarget["kind"] != "absolute-file" || grantID == "" {
		t.Fatalf("unexpected artifact resolution: %#v", resolved)
	}
	access := map[string]interface{}{"grantId": grantID, "absolutePath": artifact}
	read := request("read-artifact", "files.readTerminalArtifact", access)
	readResult, _ := read["result"].(map[string]interface{})
	if readResult["content"] != "before\n" {
		t.Fatalf("unexpected artifact read: %#v", read)
	}
	write := request("write-artifact", "files.writeTerminalArtifact", map[string]interface{}{"grantId": grantID, "absolutePath": artifact, "content": "after\n"})
	if write["ok"] != true {
		t.Fatalf("unexpected artifact write: %#v", write)
	}
	if content, err := os.ReadFile(artifact); err != nil || string(content) != "after\n" {
		t.Fatalf("artifact write was not persisted: %q, %v", content, err)
	}
	mismatch := request("mismatch-artifact", "files.readTerminalArtifact", map[string]interface{}{"grantId": grantID, "absolutePath": artifact + ".other"})
	if mismatch["ok"] != false {
		t.Fatalf("artifact grant mismatch was accepted: %#v", mismatch)
	}
}

func TestLegacySharedControlNestedRepoScanAndImportRunOnPairedHost(t *testing.T) {
	root := t.TempDir()
	repoPath := filepath.Join(root, "apps", "api")
	if err := os.MkdirAll(filepath.Join(repoPath, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	pairing, err := manager.CreateLegacySharedControlPairing("nested-runtime", "runtime", false)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(NewServer(manager))
	defer server.Close()
	rawConn, reader := dialTestWebSocket(t, server.URL, "/v1/shared-control")
	defer rawConn.Close()
	conn := &websocketConn{conn: rawConn, reader: reader}
	sharedKey := authenticateLegacySharedControlTestClient(t, rawConn, conn, pairing)
	writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{"id": "nested-scan", "deviceToken": pairing.DeviceToken, "method": "projectGroup.scanNested", "params": map[string]interface{}{"path": root, "options": map[string]interface{}{"maxDepth": 4, "maxRepos": 20}}})
	scan := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey)
	scanResult, _ := scan["result"].(map[string]interface{})
	repos, _ := scanResult["repos"].([]interface{})
	if scan["ok"] != true || len(repos) != 1 || repos[0].(map[string]interface{})["path"] != repoPath {
		t.Fatalf("unexpected paired nested scan: %#v", scan)
	}
	writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{"id": "nested-import", "deviceToken": pairing.DeviceToken, "method": "projectGroup.importNested", "params": map[string]interface{}{"parentPath": root, "groupName": "Services", "projectPaths": []string{repoPath}, "mode": "group"}})
	imported := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey)
	importResult, _ := imported["result"].(map[string]interface{})
	if imported["ok"] != true || importResult["importedCount"] != float64(1) {
		t.Fatalf("unexpected paired nested import: %#v", imported)
	}
	projects := manager.ListProjects()
	if len(projects) != 1 || projects[0].Path != repoPath {
		t.Fatalf("paired import did not persist runtime-host project: %#v", projects)
	}
}

func TestLegacySharedControlHostedReviewEligibilityRunsOnPairedHost(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("provider eligibility fixture uses a POSIX CLI stub")
	}
	repo := t.TempDir()
	for _, args := range [][]string{{"init", "-b", "feature"}, {"remote", "add", "origin", "https://github.com/nebutra/pebble.git"}} {
		command := exec.Command("git", args...)
		command.Dir = repo
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("git %v failed: %s: %v", args, output, err)
		}
	}
	bin := t.TempDir()
	gh := filepath.Join(bin, "gh")
	if err := os.WriteFile(gh, []byte("#!/bin/sh\nif [ \"$1\" = auth ]; then exit 0; fi\ncase \"$*\" in *'/comments'*) printf '{\"id\":7,\"body\":\"note\",\"path\":\"src/main.ts\",\"line\":3}' ;; *) printf '[]' ;; esac\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bin, "glab"), []byte("#!/bin/sh\ncase \"$*\" in *'/notes'*) printf '{\"id\":8,\"body\":\"note\"}' ;; *'/discussions'*) printf '{\"id\":\"thread-1\",\"notes\":[{\"id\":9,\"body\":\"inline\",\"position\":{\"new_path\":\"src/main.ts\",\"new_line\":4}}]}' ;; *) printf '[]' ;; esac\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	project, err := manager.CreateProject(runtimecore.CreateProjectRequest{Name: "repo", Path: repo})
	if err != nil {
		t.Fatal(err)
	}
	worktree, err := manager.CreateWorktree(context.Background(), runtimecore.CreateWorktreeRequest{ProjectID: project.ID, Path: repo, Branch: "feature"})
	if err != nil {
		t.Fatal(err)
	}
	pairing, err := manager.CreateLegacySharedControlPairing("review-runtime", "runtime", false)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(NewServer(manager))
	defer server.Close()
	rawConn, reader := dialTestWebSocket(t, server.URL, "/v1/shared-control")
	defer rawConn.Close()
	conn := &websocketConn{conn: rawConn, reader: reader}
	sharedKey := authenticateLegacySharedControlTestClient(t, rawConn, conn, pairing)
	writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{"id": "review-eligibility", "deviceToken": pairing.DeviceToken, "method": "hostedReview.getCreationEligibility", "params": map[string]interface{}{"repo": "id:" + project.ID, "worktree": "id:" + worktree.ID, "branch": "feature", "base": "main", "hasUpstream": true, "ahead": 0, "behind": 0}})
	response := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey)
	result, _ := response["result"].(map[string]interface{})
	if response["ok"] != true || result["provider"] != "github" || result["canCreate"] != true || result["head"] != "feature" || result["defaultBaseRef"] != "main" {
		t.Fatalf("unexpected hosted review eligibility: %#v", response)
	}
	writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{"id": "review-create-validation", "deviceToken": pairing.DeviceToken, "method": "hostedReview.create", "params": map[string]interface{}{"repo": "id:" + project.ID, "worktree": "id:" + worktree.ID, "provider": "github", "base": "main"}})
	validation := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey)
	validationResult, _ := validation["result"].(map[string]interface{})
	if validation["ok"] != true || validationResult["ok"] != false || validationResult["code"] != "validation" {
		t.Fatalf("unexpected hosted review validation response: %#v", validation)
	}
	writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{"id": "review-checks", "deviceToken": pairing.DeviceToken, "method": "github.prChecks", "params": map[string]interface{}{"repo": "id:" + project.ID, "worktree": "id:" + worktree.ID, "prNumber": 12}})
	checks := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey)
	if checks["ok"] != true || len(checks["result"].([]interface{})) != 0 {
		t.Fatalf("unexpected paired GitHub checks response: %#v", checks)
	}
	writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{"id": "review-mrs", "deviceToken": pairing.DeviceToken, "method": "gitlab.listMRs", "params": map[string]interface{}{"repo": "id:" + project.ID, "worktree": "id:" + worktree.ID, "page": 2, "perPage": 20}})
	mrs := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey)
	mrsResult, _ := mrs["result"].(map[string]interface{})
	if mrs["ok"] != true || mrsResult["page"] != float64(2) || mrsResult["totalPages"] != float64(2) || len(mrsResult["items"].([]interface{})) != 0 {
		t.Fatalf("unexpected paired GitLab MR response: %#v", mrs)
	}
	for _, mutation := range []struct {
		id     string
		method string
		params map[string]interface{}
	}{
		{id: "review-update-title", method: "github.updatePRTitle", params: map[string]interface{}{"prNumber": 12, "title": "Updated title"}},
		{id: "review-merge", method: "github.mergePR", params: map[string]interface{}{"prNumber": 12, "method": "squash"}},
		{id: "review-update-mr-state", method: "gitlab.updateMRState", params: map[string]interface{}{"iid": 4, "state": "closed"}},
	} {
		mutation.params["repo"] = "id:" + project.ID
		mutation.params["worktree"] = "id:" + worktree.ID
		writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{"id": mutation.id, "deviceToken": pairing.DeviceToken, "method": mutation.method, "params": mutation.params})
		mutationResponse := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey)
		mutationResult, _ := mutationResponse["result"].(map[string]interface{})
		if mutationResponse["ok"] != true || mutationResult["ok"] != true {
			t.Fatalf("paired review mutation %s failed: %#v", mutation.method, mutationResponse)
		}
	}
	for _, comment := range []struct {
		id     string
		method string
		params map[string]interface{}
	}{
		{id: "review-comment", method: "github.addIssueComment", params: map[string]interface{}{"number": 12, "body": "note"}},
		{id: "review-inline", method: "github.addPRReviewComment", params: map[string]interface{}{"prNumber": 12, "input": map[string]interface{}{"body": "note", "path": "src/main.ts", "line": 3, "commitId": "abc"}}},
		{id: "review-mr-inline", method: "gitlab.addMRInlineComment", params: map[string]interface{}{"iid": 4, "input": map[string]interface{}{"body": "inline", "path": "src/main.ts", "line": 4, "baseSha": "base", "startSha": "start", "headSha": "head"}}},
	} {
		comment.params["repo"] = "id:" + project.ID
		comment.params["worktree"] = "id:" + worktree.ID
		writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{"id": comment.id, "deviceToken": pairing.DeviceToken, "method": comment.method, "params": comment.params})
		commentResponse := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey)
		commentResult, _ := commentResponse["result"].(map[string]interface{})
		if commentResponse["ok"] != true || commentResult["ok"] != true || commentResult["comment"] == nil {
			t.Fatalf("paired review comment %s failed: %#v", comment.method, commentResponse)
		}
	}
	for _, read := range []struct {
		id     string
		method string
		params map[string]interface{}
		assert func(map[string]interface{}) bool
	}{
		{id: "github-issues", method: "github.listIssues", params: map[string]interface{}{"limit": 20}, assert: func(response map[string]interface{}) bool { _, ok := response["result"].([]interface{}); return ok }},
		{id: "github-labels", method: "github.listLabels", params: map[string]interface{}{}, assert: func(response map[string]interface{}) bool { _, ok := response["result"].([]interface{}); return ok }},
		{id: "gitlab-issues", method: "gitlab.listIssues", params: map[string]interface{}{"limit": 20}, assert: func(response map[string]interface{}) bool {
			result, ok := response["result"].(map[string]interface{})
			return ok && result["items"] != nil
		}},
		{id: "gitlab-labels", method: "gitlab.listLabels", params: map[string]interface{}{}, assert: func(response map[string]interface{}) bool { _, ok := response["result"].([]interface{}); return ok }},
	} {
		read.params["repo"] = "id:" + project.ID
		read.params["worktree"] = "id:" + worktree.ID
		writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{"id": read.id, "deviceToken": pairing.DeviceToken, "method": read.method, "params": read.params})
		readResponse := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey)
		if readResponse["ok"] != true || !read.assert(readResponse) {
			t.Fatalf("paired work item read %s failed: %#v", read.method, readResponse)
		}
	}
	for _, projectCall := range []struct {
		id     string
		method string
		params map[string]interface{}
	}{
		{id: "github-project-list", method: "github.project.listAccessible", params: map[string]interface{}{}},
		{id: "github-project-field", method: "github.project.clearItemField", params: map[string]interface{}{"projectId": "project-node", "itemId": "item-node", "fieldId": "field-node"}},
	} {
		writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{"id": projectCall.id, "deviceToken": pairing.DeviceToken, "method": projectCall.method, "params": projectCall.params})
		projectResponse := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey)
		if projectResponse["ok"] != true {
			t.Fatalf("paired GitHub Project call %s was not dispatched: %#v", projectCall.method, projectResponse)
		}
		if _, ok := projectResponse["result"].(map[string]interface{}); !ok {
			t.Fatalf("paired GitHub Project call %s returned the wrong envelope: %#v", projectCall.method, projectResponse)
		}
	}
}

func TestLegacySharedControlTerminalJSONStreamWritesAndEmitsLiveOutput(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("terminal stream integration uses /bin/sh")
	}
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	project, err := manager.CreateProject(runtimecore.CreateProjectRequest{Name: "repo", Path: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	session, err := manager.StartSession(context.Background(), runtimecore.StartSessionRequest{ProjectID: project.ID, Cwd: project.Path, Command: []string{"/bin/sh"}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = manager.StopSession(session.ID) })
	pairing, err := manager.CreateLegacySharedControlPairing("terminal-test", "runtime", false)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(NewServer(manager))
	defer server.Close()
	rawConn, reader := dialTestWebSocket(t, server.URL, "/v1/shared-control")
	defer rawConn.Close()
	conn := &websocketConn{conn: rawConn, reader: reader}
	sharedKey := authenticateLegacySharedControlTestClient(t, rawConn, conn, pairing)
	writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{"id": "terminal-sub", "deviceToken": pairing.DeviceToken, "method": "terminal.subscribe", "params": map[string]string{"terminal": session.ID}})
	subscribed := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey)
	if subscribed["id"] != "terminal-sub" {
		t.Fatalf("unexpected terminal subscription: %#v", subscribed)
	}
	writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{"id": "terminal-send", "deviceToken": pairing.DeviceToken, "method": "terminal.send", "params": map[string]interface{}{"terminal": session.ID, "text": "printf live-marker", "enter": true}})
	seenAck := false
	seenOutput := false
	for attempts := 0; attempts < 4 && (!seenAck || !seenOutput); attempts++ {
		frame := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey)
		if frame["id"] == "terminal-send" {
			seenAck = true
		}
		if frame["id"] == "terminal-sub" {
			result, _ := frame["result"].(map[string]interface{})
			chunk, _ := result["chunk"].(string)
			if result["type"] == "data" && strings.Contains(chunk, "live-marker") {
				seenOutput = true
			}
		}
	}
	if !seenAck || !seenOutput {
		t.Fatalf("expected send acknowledgement and live output, ack=%v output=%v", seenAck, seenOutput)
	}
}

func TestLegacySharedControlBrowserTabsAndNativeActionCompletion(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	pairing, err := manager.CreateLegacySharedControlPairing("browser-test", "mobile", false)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(NewServer(manager))
	defer server.Close()
	rawConn, reader := dialTestWebSocket(t, server.URL, "/v1/shared-control")
	defer rawConn.Close()
	conn := &websocketConn{conn: rawConn, reader: reader}
	sharedKey := authenticateLegacySharedControlTestClient(t, rawConn, conn, pairing)

	writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{"id": "profile-create", "deviceToken": pairing.DeviceToken, "method": "browser.profileCreate", "params": map[string]interface{}{"name": "Mobile", "persistent": true}})
	profileCreated := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey)
	profileCreatedResult, _ := profileCreated["result"].(map[string]interface{})
	profile, _ := profileCreatedResult["profile"].(map[string]interface{})
	profileID, _ := profile["id"].(string)
	if profileID == "" {
		t.Fatalf("unexpected profile create response: %#v", profileCreated)
	}
	writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{"id": "profile-list", "deviceToken": pairing.DeviceToken, "method": "browser.profileList", "params": map[string]interface{}{}})
	profileList := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey)
	profileListResult, _ := profileList["result"].(map[string]interface{})
	profiles, _ := profileListResult["profiles"].([]interface{})
	if len(profiles) != 1 {
		t.Fatalf("unexpected profile list: %#v", profileList)
	}

	writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{"id": "browser-create", "deviceToken": pairing.DeviceToken, "method": "browser.tabCreate", "params": map[string]string{"url": "https://example.test", "profileId": profileID}})
	created := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey)
	createdResult, _ := created["result"].(map[string]interface{})
	pageID, _ := createdResult["browserPageId"].(string)
	if pageID == "" {
		t.Fatalf("unexpected browser create response: %#v", created)
	}

	writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{"id": "browser-list", "deviceToken": pairing.DeviceToken, "method": "browser.tabList", "params": map[string]interface{}{}})
	listed := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey)
	listedResult, _ := listed["result"].(map[string]interface{})
	tabs, _ := listedResult["tabs"].([]interface{})
	if len(tabs) != 1 {
		t.Fatalf("unexpected browser tab list: %#v", listed)
	}

	writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{"id": "browser-goto", "deviceToken": pairing.DeviceToken, "method": "browser.goto", "params": map[string]string{"page": pageID, "url": "https://pebble.test/docs"}})
	var action runtimecore.ComputerAction
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		actions := manager.ListComputerActions(runtimecore.ComputerActionQueued, "browser.")
		if len(actions) > 0 {
			action = actions[0]
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if action.ID == "" || action.Kind != "browser.goto" || action.Target != pageID {
		t.Fatalf("browser goto was not queued for native provider: %#v", action)
	}
	if _, err := manager.UpdateComputerAction(action.ID, runtimecore.UpdateComputerActionRequest{Status: runtimecore.ComputerActionCompleted, Result: map[string]interface{}{"url": "https://pebble.test/docs", "title": "Pebble Docs"}}); err != nil {
		t.Fatal(err)
	}
	gotoResponse := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey)
	gotoResult, _ := gotoResponse["result"].(map[string]interface{})
	if gotoResult["url"] != "https://pebble.test/docs" || gotoResult["title"] != "Pebble Docs" {
		t.Fatalf("browser provider result was not returned: %#v", gotoResponse)
	}

	writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{"id": "browser-intercept", "deviceToken": pairing.DeviceToken, "method": "browser.intercept.enable", "params": map[string]interface{}{"page": pageID, "patterns": []string{"**/api/**"}}})
	deadline = time.Now().Add(2 * time.Second)
	action = runtimecore.ComputerAction{}
	for time.Now().Before(deadline) {
		actions := manager.ListComputerActions(runtimecore.ComputerActionQueued, "browser.interceptEnable")
		if len(actions) > 0 {
			action = actions[0]
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if action.ID == "" || action.Kind != "browser.interceptEnable" {
		t.Fatalf("intercept method was not mapped to native executor command: %#v", action)
	}
	if _, err := manager.UpdateComputerAction(action.ID, runtimecore.UpdateComputerActionRequest{Status: runtimecore.ComputerActionCompleted, Result: map[string]interface{}{"enabled": true}}); err != nil {
		t.Fatal(err)
	}
	interceptResponse := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey)
	interceptResult, _ := interceptResponse["result"].(map[string]interface{})
	if interceptResult["enabled"] != true {
		t.Fatalf("unexpected intercept response: %#v", interceptResponse)
	}

	writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{"id": "browser-storage", "deviceToken": pairing.DeviceToken, "method": "browser.storage.local.set", "params": map[string]interface{}{"page": pageID, "key": "theme", "value": "dark"}})
	deadline = time.Now().Add(2 * time.Second)
	action = runtimecore.ComputerAction{}
	for time.Now().Before(deadline) {
		actions := manager.ListComputerActions(runtimecore.ComputerActionQueued, "browser.storageLocalSet")
		if len(actions) > 0 {
			action = actions[0]
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if action.ID == "" || action.Kind != "browser.storageLocalSet" || action.Payload["key"] != "theme" {
		t.Fatalf("storage method was not mapped to the native executor: %#v", action)
	}
	if _, err := manager.UpdateComputerAction(action.ID, runtimecore.UpdateComputerActionRequest{Status: runtimecore.ComputerActionCompleted, Result: map[string]interface{}{"key": "theme", "value": "dark"}}); err != nil {
		t.Fatal(err)
	}
	storageResponse := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey)
	storageResult, _ := storageResponse["result"].(map[string]interface{})
	if storageResult["value"] != "dark" {
		t.Fatalf("unexpected storage response: %#v", storageResponse)
	}

	writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{"id": "browser-cookie", "deviceToken": pairing.DeviceToken, "method": "browser.cookie.set", "params": map[string]interface{}{"page": pageID, "name": "session", "value": "", "url": "https://example.test", "httpOnly": true}})
	deadline = time.Now().Add(2 * time.Second)
	action = runtimecore.ComputerAction{}
	for time.Now().Before(deadline) {
		actions := manager.ListComputerActions(runtimecore.ComputerActionQueued, "browser.cookieSet")
		if len(actions) > 0 {
			action = actions[0]
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if action.ID == "" || action.Kind != "browser.cookieSet" || action.Payload["value"] != "" || action.Payload["httpOnly"] != true {
		t.Fatalf("cookie method was not mapped with native cookie semantics: %#v", action)
	}
	if _, err := manager.UpdateComputerAction(action.ID, runtimecore.UpdateComputerActionRequest{Status: runtimecore.ComputerActionCompleted, Result: map[string]interface{}{"success": true}}); err != nil {
		t.Fatal(err)
	}
	cookieResponse := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey)
	cookieResult, _ := cookieResponse["result"].(map[string]interface{})
	if cookieResult["success"] != true {
		t.Fatalf("unexpected cookie response: %#v", cookieResponse)
	}

	writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{"id": "browser-close", "deviceToken": pairing.DeviceToken, "method": "browser.tabClose", "params": map[string]string{"page": pageID}})
	closed := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey)
	closedResult, _ := closed["result"].(map[string]interface{})
	if closedResult["closed"] != true || len(manager.ListBrowserTabs()) != 0 {
		t.Fatalf("browser tab was not closed: %#v", closed)
	}
	writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{"id": "profile-delete", "deviceToken": pairing.DeviceToken, "method": "browser.profileDelete", "params": map[string]string{"profileId": profileID}})
	profileDeleted := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey)
	if profileDeleted["ok"] != true || len(manager.ListBrowserProfiles()) != 0 {
		t.Fatalf("browser profile was not deleted: %#v", profileDeleted)
	}
}

func TestLegacySharedControlAllowsNativeTauriBrowserCommands(t *testing.T) {
	methods := []string{
		"browser.keyDown", "browser.keyUp", "browser.harStart", "browser.harStop",
		"browser.pushState", "browser.storage.local.get", "browser.storage.session.set",
		"browser.highlight", "browser.mouseWheel", "browser.clipboardPaste", "browser.eval",
		"browser.viewport", "browser.setHeaders", "browser.setOffline", "browser.setCredentials",
		"browser.cookie.get", "browser.cookie.set", "browser.cookie.delete", "browser.cookie.clear",
		"browser.dialogAccept", "browser.dialogDismiss",
	}
	for _, method := range methods {
		if !legacySharedControlMobileMethodAllowed(method) {
			t.Fatalf("expected %s to be allowed", method)
		}
	}
	if got := legacySharedControlBrowserCommandName("browser.storage.session.clear"); got != "storageSessionClear" {
		t.Fatalf("unexpected storage command mapping %q", got)
	}
}

func TestLegacySharedControlBrowserScreencastStreamsEncryptedNativeFramesAndCancels(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	tab, err := manager.CreateBrowserTab(runtimecore.CreateBrowserTabRequest{URL: "https://example.test"})
	if err != nil {
		t.Fatal(err)
	}
	pairing, err := manager.CreateLegacySharedControlPairing("browser-stream", "mobile", false)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(NewServer(manager))
	defer server.Close()
	rawConn, reader := dialTestWebSocket(t, server.URL, "/v1/shared-control")
	defer rawConn.Close()
	conn := &websocketConn{conn: rawConn, reader: reader}
	sharedKey := authenticateLegacySharedControlTestClient(t, rawConn, conn, pairing)
	writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{"id": "status", "deviceToken": pairing.DeviceToken, "method": "status.get", "params": map[string]interface{}{}})
	status := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey)
	statusResult, _ := status["result"].(map[string]interface{})
	capabilities, _ := statusResult["capabilities"].([]interface{})
	foundScreencast := false
	for _, capability := range capabilities {
		foundScreencast = foundScreencast || capability == "browser.screencast.v1"
	}
	if !foundScreencast {
		t.Fatalf("shared-control status did not advertise screencast: %#v", status)
	}

	writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{"id": "cast-1", "deviceToken": pairing.DeviceToken, "method": "browser.screencast", "params": map[string]interface{}{"page": tab.ID, "format": "jpeg", "minFrameIntervalMs": 250}})
	var startAction runtimecore.ComputerAction
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		actions := manager.ListComputerActions(runtimecore.ComputerActionQueued, "browser.screencastStart")
		if len(actions) > 0 {
			startAction = actions[0]
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if startAction.ID == "" {
		t.Fatal("screencast did not queue a native stream start action")
	}
	if _, err := manager.UpdateComputerAction(startAction.ID, runtimecore.UpdateComputerActionRequest{Status: runtimecore.ComputerActionCompleted, Result: map[string]interface{}{"streamId": "native-stream"}}); err != nil {
		t.Fatal(err)
	}
	ready := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey)
	readyResult, _ := ready["result"].(map[string]interface{})
	subscriptionID, _ := readyResult["subscriptionId"].(string)
	if ready["streaming"] != true || readyResult["type"] != "ready" || subscriptionID == "" {
		t.Fatalf("unexpected screencast ready response: %#v", ready)
	}
	if driver := manager.GetBrowserDriver(tab.ID); driver.Kind != "mobile" || driver.ClientID != pairing.DeviceID {
		t.Fatalf("mobile screencast did not take browser floor: %+v", driver)
	}

	image := []byte{0xff, 0xd8, 0xff, 0xd9}
	nativeFrame, err := encodeLegacySharedControlBrowserFrame(1, "jpeg", image, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	response, err := http.Post(server.URL+"/v1/browser/screencasts/"+url.PathEscape(subscriptionID)+"/frames", "application/octet-stream", bytes.NewReader(nativeFrame))
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusNoContent {
		t.Fatalf("native frame ingest returned %d", response.StatusCode)
	}
	opcode, encrypted, err := conn.readMessage(false)
	if err != nil || opcode != 0x2 {
		t.Fatalf("expected encrypted binary screencast frame, opcode=%d err=%v", opcode, err)
	}
	frame, err := decryptLegacySharedControlBytes(encrypted, sharedKey)
	if err != nil {
		t.Fatal(err)
	}
	if len(frame) < 16 || frame[0] != 0x62 || frame[1] != 1 || frame[2] != 1 || frame[3] != 1 || binary.LittleEndian.Uint32(frame[4:8]) != 1 {
		t.Fatalf("unexpected browser screencast header: %v", frame)
	}
	metadataLength := int(binary.LittleEndian.Uint32(frame[8:12]))
	if 16+metadataLength > len(frame) || !bytes.Equal(frame[16+metadataLength:], image) {
		t.Fatalf("unexpected browser screencast payload: %v", frame)
	}

	writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{"id": "cast-stop", "deviceToken": pairing.DeviceToken, "method": "browser.screencast.unsubscribe", "params": map[string]string{"subscriptionId": subscriptionID}})
	stopped := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey)
	stoppedResult, _ := stopped["result"].(map[string]interface{})
	if stoppedResult["unsubscribed"] != true {
		t.Fatalf("unexpected screencast unsubscribe response: %#v", stopped)
	}
	deadline = time.Now().Add(2 * time.Second)
	stopQueued := false
	for time.Now().Before(deadline) {
		if actions := manager.ListComputerActions(runtimecore.ComputerActionQueued, "browser.screencastStop"); len(actions) > 0 {
			stopQueued = true
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !stopQueued {
		t.Fatal("screencast unsubscribe did not queue native stream stop")
	}
	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if manager.GetBrowserDriver(tab.ID).Kind == "idle" {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("screencast unsubscribe did not release browser floor")
}

func TestLegacySharedControlTerminalBinaryStreamSnapshotInputAndOutput(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("terminal stream integration uses /bin/sh")
	}
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	project, err := manager.CreateProject(runtimecore.CreateProjectRequest{Name: "repo", Path: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	session, err := manager.StartSession(context.Background(), runtimecore.StartSessionRequest{ProjectID: project.ID, Cwd: project.Path, Command: []string{"/bin/sh"}, Cols: 90, Rows: 30})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = manager.StopSession(session.ID) })
	pairing, err := manager.CreateLegacySharedControlPairing("binary-terminal-test", "mobile", false)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(NewServer(manager))
	defer server.Close()
	rawConn, reader := dialTestWebSocket(t, server.URL, "/v1/shared-control")
	defer rawConn.Close()
	conn := &websocketConn{conn: rawConn, reader: reader}
	sharedKey := authenticateLegacySharedControlTestClient(t, rawConn, conn, pairing)
	writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{"id": "binary-sub", "deviceToken": pairing.DeviceToken, "method": "terminal.subscribe", "params": map[string]interface{}{"terminal": session.ID, "client": map[string]string{"id": "phone-1", "type": "mobile"}, "capabilities": map[string]int{"terminalBinaryStream": 1}}})
	subscribed := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey)
	result, _ := subscribed["result"].(map[string]interface{})
	streamID := uint32(result["streamId"].(float64))
	if streamID == 0 || result["type"] != "subscribed" {
		t.Fatalf("unexpected binary subscription: %#v", subscribed)
	}
	seenStart := false
	seenEnd := false
	for attempts := 0; attempts < 3 && !seenEnd; attempts++ {
		frame := readEncryptedLegacySharedControlBinaryFrame(t, conn, sharedKey)
		if frame.StreamID != streamID {
			t.Fatalf("unexpected stream id: %#v", frame)
		}
		seenStart = seenStart || frame.Opcode == terminalStreamSnapshotStart
		seenEnd = seenEnd || frame.Opcode == terminalStreamSnapshotEnd
	}
	if !seenStart || !seenEnd {
		t.Fatalf("expected binary snapshot bounds, start=%v end=%v", seenStart, seenEnd)
	}
	writeEncryptedLegacySharedControlBinaryFrame(t, rawConn, sharedKey, terminalStreamFrame{Opcode: terminalStreamInput, StreamID: streamID, Seq: 10, Payload: []byte("printf binary-marker\n")})
	seenOutput := false
	for attempts := 0; attempts < 4 && !seenOutput; attempts++ {
		frame := readEncryptedLegacySharedControlBinaryFrame(t, conn, sharedKey)
		seenOutput = frame.Opcode == terminalStreamOutput && strings.Contains(string(frame.Payload), "binary-marker")
	}
	if !seenOutput {
		t.Fatal("expected encrypted binary terminal output")
	}
	resizePayload, err := json.Marshal(map[string]int{"cols": 110, "rows": 42})
	if err != nil {
		t.Fatal(err)
	}
	writeEncryptedLegacySharedControlBinaryFrame(t, rawConn, sharedKey, terminalStreamFrame{Opcode: terminalStreamResize, StreamID: streamID, Seq: 11, Payload: resizePayload})
	resized := readEncryptedLegacySharedControlBinaryFrame(t, conn, sharedKey)
	if resized.Opcode != terminalStreamResized {
		t.Fatalf("expected resized frame, got %#v", resized)
	}
	var resizedPayload map[string]interface{}
	if json.Unmarshal(resized.Payload, &resizedPayload) != nil || resizedPayload["cols"] != float64(110) || resizedPayload["rows"] != float64(42) {
		t.Fatalf("unexpected resized payload: %s", resized.Payload)
	}
	reflowStart := readEncryptedLegacySharedControlBinaryFrame(t, conn, sharedKey)
	if reflowStart.Opcode != terminalStreamSnapshotStart {
		t.Fatalf("expected resize snapshot start, got %#v", reflowStart)
	}
	var reflowMetadata map[string]interface{}
	if json.Unmarshal(reflowStart.Payload, &reflowMetadata) != nil || reflowMetadata["kind"] != "resized" {
		t.Fatalf("unexpected resize snapshot metadata: %s", reflowStart.Payload)
	}
	for {
		frame := readEncryptedLegacySharedControlBinaryFrame(t, conn, sharedKey)
		if frame.Opcode == terminalStreamSnapshotEnd {
			break
		}
		if frame.Opcode != terminalStreamSnapshotChunk {
			t.Fatalf("unexpected resize snapshot frame: %#v", frame)
		}
	}
	deadline := time.Now().Add(time.Second)
	for {
		status, statusErr := manager.SessionStatus(session.ID)
		if statusErr == nil && status.Cols == 110 && status.Rows == 42 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("binary resize did not reach PTY: %#v, %v", status, statusErr)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestLegacySharedControlTerminalControlMethodsUseRuntimeSessions(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("terminal control integration uses /bin/sh")
	}
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	project, err := manager.CreateProject(runtimecore.CreateProjectRequest{Name: "repo", Path: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	worktree, err := manager.CreateWorktree(context.Background(), runtimecore.CreateWorktreeRequest{ProjectID: project.ID, Path: project.Path})
	if err != nil {
		t.Fatal(err)
	}
	session, err := manager.StartSession(context.Background(), runtimecore.StartSessionRequest{ProjectID: project.ID, WorktreeID: worktree.ID, Cwd: project.Path, Command: []string{"/bin/sh"}, AgentKind: "codex", TabID: "tab-control", LeafID: "leaf-control"})
	if err != nil {
		t.Fatal(err)
	}
	pairing, err := manager.CreateLegacySharedControlPairing("terminal-controls", "mobile", false)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(NewServer(manager))
	defer server.Close()
	rawConn, reader := dialTestWebSocket(t, server.URL, "/v1/shared-control")
	defer rawConn.Close()
	conn := &websocketConn{conn: rawConn, reader: reader}
	sharedKey := authenticateLegacySharedControlTestClient(t, rawConn, conn, pairing)

	writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{"id": "list", "deviceToken": pairing.DeviceToken, "method": "terminal.list", "params": map[string]int{"limit": 10}})
	listed := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey)
	listedResult, _ := listed["result"].(map[string]interface{})
	if listedResult["totalCount"] != float64(1) {
		t.Fatalf("unexpected terminal list: %#v", listed)
	}

	writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{"id": "agent", "deviceToken": pairing.DeviceToken, "method": "terminal.agentStatus", "params": map[string]string{"terminal": session.ID}})
	agent := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey)
	agentResult, _ := agent["result"].(map[string]interface{})
	agentStatus, _ := agentResult["agentStatus"].(map[string]interface{})
	if agentStatus["isRunningAgent"] != true || agentStatus["status"] != "working" {
		t.Fatalf("unexpected agent status: %#v", agent)
	}

	writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{"id": "resolve-active", "deviceToken": pairing.DeviceToken, "method": "terminal.resolveActive", "params": map[string]interface{}{}})
	resolvedActive := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey)
	resolvedActiveResult, _ := resolvedActive["result"].(map[string]interface{})
	if resolvedActiveResult["handle"] != session.ID {
		t.Fatalf("unexpected active terminal: %#v", resolvedActive)
	}

	writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{"id": "show", "deviceToken": pairing.DeviceToken, "method": "terminal.show", "params": map[string]string{"terminal": session.ID}})
	shown := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey)
	shownResult, _ := shown["result"].(map[string]interface{})
	shownTerminal, _ := shownResult["terminal"].(map[string]interface{})
	if shownTerminal["handle"] != session.ID || shownTerminal["paneRuntimeId"] != float64(0) {
		t.Fatalf("unexpected shown terminal: %#v", shown)
	}

	writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{"id": "inspect", "deviceToken": pairing.DeviceToken, "method": "terminal.inspectProcess", "params": map[string]string{"terminal": session.ID}})
	inspected := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey)
	inspectedResult, _ := inspected["result"].(map[string]interface{})
	process, _ := inspectedResult["process"].(map[string]interface{})
	if process["foregroundProcess"] == nil {
		t.Fatalf("unexpected process inspection: %#v", inspected)
	}

	writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{"id": "split", "deviceToken": pairing.DeviceToken, "method": "terminal.split", "params": map[string]interface{}{"terminal": session.ID, "direction": "vertical", "env": map[string]string{"PEBBLE_SPLIT_TEST": "ready"}}})
	split := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey)
	splitResult, _ := split["result"].(map[string]interface{})
	splitValue, _ := splitResult["split"].(map[string]interface{})
	splitHandle, _ := splitValue["handle"].(string)
	if splitHandle == "" || splitValue["tabId"] != "tab-control" {
		t.Fatalf("unexpected split response: %#v", split)
	}
	splitSession, err := manager.SessionStatus(splitHandle)
	if err != nil || splitSession.WorktreeID != session.WorktreeID || splitSession.Cwd != session.Cwd || splitSession.AgentKind != session.AgentKind || splitSession.TabID != session.TabID {
		t.Fatalf("split session did not preserve source metadata: %#v, %v", splitSession, err)
	}
	splitLayout, layoutErr := manager.GetSessionTabLayout(session.WorktreeID)
	var splitPane struct {
		Root struct {
			Type      string `json:"type"`
			Direction string `json:"direction"`
		} `json:"root"`
		ActiveLeafID string            `json:"activeLeafId"`
		PtyIDs       map[string]string `json:"ptyIdsByLeafId"`
	}
	decodeErr := json.Unmarshal(splitLayout.PaneLayoutByTabID["tab-control"], &splitPane)
	if layoutErr != nil || decodeErr != nil || splitPane.Root.Type != "split" || splitPane.Root.Direction != "vertical" || splitPane.ActiveLeafID != splitSession.LeafID || splitPane.PtyIDs[splitSession.LeafID] != splitHandle {
		t.Fatalf("split did not persist the pane tree: %#v, %v, %v", splitLayout, layoutErr, decodeErr)
	}
	_, _ = manager.StopSession(splitHandle)

	writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{"id": "display-auto", "deviceToken": pairing.DeviceToken, "method": "terminal.setDisplayMode", "params": map[string]interface{}{"terminal": session.ID, "mode": "auto", "client": map[string]string{"type": "mobile", "id": "phone-1"}, "viewport": map[string]int{"cols": 88, "rows": 28}}})
	if response := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey); response["ok"] != true {
		t.Fatalf("unexpected display mode response: %#v", response)
	}
	if driver := manager.GetSessionDriver(session.ID); driver.Kind != "mobile" || driver.ClientID != "phone-1" {
		t.Fatalf("mobile display mode did not take driver floor: %#v", driver)
	}
	writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{"id": "display-get", "deviceToken": pairing.DeviceToken, "method": "terminal.getDisplayMode", "params": map[string]string{"terminal": session.ID}})
	display := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey)
	displayResult, _ := display["result"].(map[string]interface{})
	if displayResult["mode"] != "auto" || displayResult["isPhoneFitted"] != true {
		t.Fatalf("unexpected display mode snapshot: %#v", display)
	}
	writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{"id": "display-desktop", "deviceToken": pairing.DeviceToken, "method": "terminal.setDisplayMode", "params": map[string]interface{}{"terminal": session.ID, "mode": "desktop"}})
	if response := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey); response["ok"] != true || manager.GetSessionDriver(session.ID).Kind != "desktop" {
		t.Fatalf("desktop display mode did not reclaim driver: %#v", response)
	}

	baseline, err := manager.SessionStatus(session.ID)
	if err != nil {
		t.Fatal(err)
	}
	writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{"id": "fit-mobile", "deviceToken": pairing.DeviceToken, "method": "terminal.resizeForClient", "params": map[string]interface{}{"terminal": session.ID, "mode": "mobile-fit", "clientId": "phone-owner", "cols": 76, "rows": 24}})
	fitMobile := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey)
	fitMobileResult, _ := fitMobile["result"].(map[string]interface{})
	fitMobileTerminal, _ := fitMobileResult["terminal"].(map[string]interface{})
	if fitMobileTerminal["mode"] != "mobile-fit" || fitMobileTerminal["previousCols"] != float64(baseline.Cols) || fitMobileTerminal["previousRows"] != float64(baseline.Rows) {
		t.Fatalf("unexpected mobile fit response: %#v", fitMobile)
	}
	writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{"id": "fit-repeat", "deviceToken": pairing.DeviceToken, "method": "terminal.resizeForClient", "params": map[string]interface{}{"terminal": session.ID, "mode": "mobile-fit", "clientId": "phone-owner", "cols": 70, "rows": 20}})
	fitRepeat := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey)
	fitRepeatResult, _ := fitRepeat["result"].(map[string]interface{})
	fitRepeatTerminal, _ := fitRepeatResult["terminal"].(map[string]interface{})
	if fitRepeatTerminal["previousCols"] != float64(baseline.Cols) || fitRepeatTerminal["previousRows"] != float64(baseline.Rows) {
		t.Fatalf("repeat fit lost desktop baseline: %#v", fitRepeat)
	}
	writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{"id": "fit-wrong-owner", "deviceToken": pairing.DeviceToken, "method": "terminal.resizeForClient", "params": map[string]interface{}{"terminal": session.ID, "mode": "restore", "clientId": "phone-other"}})
	if wrongOwner := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey); wrongOwner["ok"] != false {
		t.Fatalf("non-owner restored mobile fit: %#v", wrongOwner)
	}
	writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{"id": "fit-restore", "deviceToken": pairing.DeviceToken, "method": "terminal.resizeForClient", "params": map[string]interface{}{"terminal": session.ID, "mode": "restore", "clientId": "phone-owner"}})
	fitRestore := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey)
	restoredSession, statusErr := manager.SessionStatus(session.ID)
	if fitRestore["ok"] != true || statusErr != nil || restoredSession.Cols != baseline.Cols || restoredSession.Rows != baseline.Rows || manager.GetSessionDriver(session.ID).Kind != "desktop" {
		t.Fatalf("owner restore did not restore desktop fit: %#v, %#v, %v", fitRestore, restoredSession, statusErr)
	}
	writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{"id": "fit-for-desktop", "deviceToken": pairing.DeviceToken, "method": "terminal.resizeForClient", "params": map[string]interface{}{"terminal": session.ID, "mode": "mobile-fit", "clientId": "phone-owner", "cols": 72, "rows": 22}})
	_ = readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey)
	writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{"id": "restore-fit", "deviceToken": pairing.DeviceToken, "method": "terminal.restoreFit", "params": map[string]string{"terminal": session.ID}})
	restoreFit := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey)
	reclaimedSession, statusErr := manager.SessionStatus(session.ID)
	if restoreFit["ok"] != true || statusErr != nil || reclaimedSession.Cols != baseline.Cols || reclaimedSession.Rows != baseline.Rows || manager.GetSessionDriver(session.ID).Kind != "desktop" {
		t.Fatalf("desktop restoreFit did not reclaim fit: %#v, %#v, %v", restoreFit, reclaimedSession, statusErr)
	}

	writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{"id": "resolve-pane", "deviceToken": pairing.DeviceToken, "method": "terminal.resolvePane", "params": map[string]string{"paneKey": "tab-control:leaf-control"}})
	resolved := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey)
	resolvedResult, _ := resolved["result"].(map[string]interface{})
	resolvedTerminal, _ := resolvedResult["terminal"].(map[string]interface{})
	if resolvedTerminal["handle"] != session.ID || resolvedTerminal["ptyId"] != session.ID {
		t.Fatalf("unexpected resolved pane: %#v", resolved)
	}

	writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{"id": "focus", "deviceToken": pairing.DeviceToken, "method": "terminal.focus", "params": map[string]string{"terminal": session.ID}})
	focused := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey)
	focusedResult, _ := focused["result"].(map[string]interface{})
	focusValue, _ := focusedResult["focus"].(map[string]interface{})
	if focusValue["handle"] != session.ID || focusValue["tabId"] != "tab-control" {
		t.Fatalf("unexpected focus response: %#v", focused)
	}
	focusedLayout, layoutErr := manager.GetSessionTabLayout(session.WorktreeID)
	if layoutErr != nil || focusedLayout.ActiveTabID != "tab-control" {
		t.Fatalf("focus did not persist the active tab: %#v, %v", focusedLayout, layoutErr)
	}

	writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{"id": "viewport", "deviceToken": pairing.DeviceToken, "method": "terminal.updateViewport", "params": map[string]interface{}{"terminal": session.ID, "viewport": map[string]int{"cols": 100, "rows": 35}}})
	viewport := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey)
	viewportResult, _ := viewport["result"].(map[string]interface{})
	if viewportResult["cols"] != float64(100) || viewportResult["rows"] != float64(35) {
		t.Fatalf("unexpected viewport result: %#v", viewport)
	}

	writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{"id": "clear", "deviceToken": pairing.DeviceToken, "method": "terminal.clearBuffer", "params": map[string]string{"terminal": session.ID}})
	if clear := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey); clear["id"] != "clear" || clear["ok"] != true {
		t.Fatalf("unexpected clear response: %#v", clear)
	}

	writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{"id": "close", "deviceToken": pairing.DeviceToken, "method": "terminal.close", "params": map[string]string{"terminal": session.ID}})
	closed := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey)
	closedResult, _ := closed["result"].(map[string]interface{})
	closeValue, _ := closedResult["close"].(map[string]interface{})
	if closeValue["ptyKilled"] != true {
		t.Fatalf("unexpected close response: %#v", closed)
	}
}

func TestLegacySharedControlSessionTabMutationsPersistAndStopNativePTY(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("session tab integration uses /bin/sh")
	}
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	project, err := manager.CreateProject(runtimecore.CreateProjectRequest{Name: "repo", Path: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	worktree, err := manager.CreateWorktree(context.Background(), runtimecore.CreateWorktreeRequest{ProjectID: project.ID, Path: project.Path, Branch: "main"})
	if err != nil {
		t.Fatal(err)
	}
	first, err := manager.StartSession(context.Background(), runtimecore.StartSessionRequest{ProjectID: project.ID, WorktreeID: worktree.ID, Cwd: worktree.Path, Command: []string{"/bin/sh"}, TabID: "tab-first", LeafID: "leaf-first"})
	if err != nil {
		t.Fatal(err)
	}
	second, err := manager.StartSession(context.Background(), runtimecore.StartSessionRequest{ProjectID: project.ID, WorktreeID: worktree.ID, Cwd: worktree.Path, Command: []string{"/bin/sh"}, TabID: "tab-second", LeafID: "leaf-second"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = manager.StopSession(first.ID)
		_, _ = manager.StopSession(second.ID)
	})
	pairing, err := manager.CreateLegacySharedControlPairing("tab-controls", "mobile", false)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(NewServer(manager))
	defer server.Close()
	rawConn, reader := dialTestWebSocket(t, server.URL, "/v1/shared-control")
	defer rawConn.Close()
	conn := &websocketConn{conn: rawConn, reader: reader}
	sharedKey := authenticateLegacySharedControlTestClient(t, rawConn, conn, pairing)

	writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{"id": "activate", "deviceToken": pairing.DeviceToken, "method": "session.tabs.activate", "params": map[string]string{"worktree": "id:" + worktree.ID, "tabId": "tab-first"}})
	activated := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey)
	activatedResult, _ := activated["result"].(map[string]interface{})
	if activatedResult["activeTabId"] != "tab-first" {
		t.Fatalf("unexpected activated snapshot: %#v", activated)
	}
	persisted, err := manager.GetSessionTabLayout(worktree.ID)
	if err != nil || persisted.ActiveTabID != "tab-first" {
		t.Fatalf("active tab was not persisted: %#v, %v", persisted, err)
	}

	writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{"id": "tab-props", "deviceToken": pairing.DeviceToken, "method": "session.tabs.setTabProps", "params": map[string]interface{}{"worktree": worktree.ID, "tabId": "tab-first", "color": "green", "isPinned": true, "viewMode": "chat"}})
	if response := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey); response["ok"] != true {
		t.Fatalf("unexpected tab props response: %#v", response)
	}
	writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{"id": "pane-layout", "deviceToken": pairing.DeviceToken, "method": "session.tabs.updatePaneLayout", "params": map[string]interface{}{"worktree": worktree.ID, "tabId": "tab-first", "root": map[string]interface{}{"type": "leaf", "id": "leaf-first"}, "expandedLeafId": "leaf-first", "titlesByLeafId": map[string]string{"leaf-first": "Primary"}}})
	if response := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey); response["ok"] != true {
		t.Fatalf("unexpected pane layout response: %#v", response)
	}
	updatedSnapshot := manager.SessionTabsSnapshot(worktree.ID)
	updatedTabs, _ := updatedSnapshot["tabs"].([]map[string]interface{})
	if len(updatedTabs) != 2 || updatedTabs[0]["color"] != "green" || updatedTabs[0]["isPinned"] != true || updatedTabs[0]["viewMode"] != "chat" {
		t.Fatalf("tab props did not reach authoritative snapshot: %#v", updatedSnapshot)
	}
	parentLayout, _ := updatedTabs[0]["parentLayout"].(map[string]interface{})
	if parentLayout["expandedLeafId"] != "leaf-first" {
		t.Fatalf("pane layout did not reach authoritative snapshot: %#v", updatedSnapshot)
	}
	writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{"id": "rename", "deviceToken": pairing.DeviceToken, "method": "terminal.rename", "params": map[string]interface{}{"terminal": first.ID, "title": "Build logs"}})
	if response := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey); response["ok"] != true {
		t.Fatalf("unexpected rename response: %#v", response)
	}
	renamedSnapshot := manager.SessionTabsSnapshot(worktree.ID)
	renamedTabs, _ := renamedSnapshot["tabs"].([]map[string]interface{})
	if renamedTabs[0]["customTitle"] != "Build logs" {
		t.Fatalf("terminal title was not persisted: %#v", renamedSnapshot)
	}

	writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{"id": "reorder", "deviceToken": pairing.DeviceToken, "method": "session.tabs.move", "params": map[string]interface{}{"worktree": worktree.ID, "kind": "reorder", "tabId": "tab-first", "targetGroupId": "main", "tabOrder": []string{"tab-second", "tab-first"}}})
	if response := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey); response["ok"] != true {
		t.Fatalf("unexpected reorder response: %#v", response)
	}
	reordered := manager.SessionTabsSnapshot(worktree.ID)
	reorderedGroups, _ := reordered["tabGroups"].([]map[string]interface{})
	if len(reorderedGroups) != 1 || strings.Join(interfaceStrings(reorderedGroups[0]["tabOrder"]), ",") != "tab-second,tab-first" {
		t.Fatalf("tab reorder was not persisted: %#v", reordered)
	}

	writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{"id": "split", "deviceToken": pairing.DeviceToken, "method": "session.tabs.move", "params": map[string]interface{}{"worktree": worktree.ID, "kind": "split", "tabId": "tab-first", "targetGroupId": "main", "splitDirection": "right"}})
	if response := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey); response["ok"] != true {
		t.Fatalf("unexpected split response: %#v", response)
	}
	splitSnapshot := manager.SessionTabsSnapshot(worktree.ID)
	splitGroups, _ := splitSnapshot["tabGroups"].([]map[string]interface{})
	activeGroupID, _ := splitSnapshot["activeGroupId"].(string)
	if len(splitGroups) != 2 || activeGroupID == "" || activeGroupID == "main" || splitSnapshot["tabGroupLayout"] == nil {
		t.Fatalf("tab split was not persisted: %#v", splitSnapshot)
	}

	writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{"id": "move-group", "deviceToken": pairing.DeviceToken, "method": "session.tabs.move", "params": map[string]interface{}{"worktree": worktree.ID, "kind": "move-to-group", "tabId": "tab-first", "targetGroupId": "main", "index": 0}})
	if response := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey); response["ok"] != true {
		t.Fatalf("unexpected move-to-group response: %#v", response)
	}
	movedSnapshot := manager.SessionTabsSnapshot(worktree.ID)
	movedGroups, _ := movedSnapshot["tabGroups"].([]map[string]interface{})
	if len(movedGroups) != 1 || strings.Join(interfaceStrings(movedGroups[0]["tabOrder"]), ",") != "tab-first,tab-second" {
		t.Fatalf("cross-group move was not persisted: %#v", movedSnapshot)
	}

	writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{"id": "close-tab", "deviceToken": pairing.DeviceToken, "method": "session.tabs.close", "params": map[string]string{"worktree": worktree.ID, "tabId": "tab-first"}})
	closed := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey)
	closedResult, _ := closed["result"].(map[string]interface{})
	if closedResult["activeTabId"] != "tab-second" {
		t.Fatalf("unexpected closed snapshot: %#v", closed)
	}
	status, err := manager.SessionStatus(first.ID)
	if err != nil || status.Status != runtimecore.SessionStopped {
		t.Fatalf("closed tab PTY is still live: %#v, %v", status, err)
	}
}

func interfaceStrings(value interface{}) []string {
	raw, _ := value.([]interface{})
	result := make([]string, 0, len(raw))
	for _, item := range raw {
		if text, ok := item.(string); ok {
			result = append(result, text)
		}
	}
	return result
}

func TestLegacySharedControlCreatesAndWaitsForNativeTerminalWithoutBlockingConnection(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("terminal create integration uses /bin/sh")
	}
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	project, err := manager.CreateProject(runtimecore.CreateProjectRequest{Name: "repo", Path: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	worktree, err := manager.CreateWorktree(context.Background(), runtimecore.CreateWorktreeRequest{ProjectID: project.ID, Path: project.Path, Branch: "main"})
	if err != nil {
		t.Fatal(err)
	}
	pairing, err := manager.CreateLegacySharedControlPairing("terminal-create", "mobile", false)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(NewServer(manager))
	defer server.Close()
	rawConn, reader := dialTestWebSocket(t, server.URL, "/v1/shared-control")
	defer rawConn.Close()
	conn := &websocketConn{conn: rawConn, reader: reader}
	sharedKey := authenticateLegacySharedControlTestClient(t, rawConn, conn, pairing)

	writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{"id": "create", "deviceToken": pairing.DeviceToken, "method": "terminal.create", "params": map[string]interface{}{"worktree": "id:" + worktree.ID, "tabId": "tab-created", "leafId": "leaf-created", "cols": 91, "rows": 31, "env": map[string]string{"PEBBLE_SHARED_CONTROL_TEST": "ready"}}})
	created := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey)
	createdResult, _ := created["result"].(map[string]interface{})
	terminal, _ := createdResult["terminal"].(map[string]interface{})
	handle, _ := terminal["handle"].(string)
	if handle == "" || terminal["tabId"] != "tab-created" || terminal["paneKey"] != "leaf-created" {
		t.Fatalf("unexpected terminal create response: %#v", created)
	}

	createTabRequest := map[string]interface{}{"deviceToken": pairing.DeviceToken, "method": "session.tabs.createTerminal", "params": map[string]interface{}{"worktree": worktree.ID, "afterTabId": "tab-created", "targetGroupId": "main", "clientMutationId": "create-once", "activate": true}}
	createTabRequest["id"] = "create-tab"
	writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, createTabRequest)
	createdTab := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey)
	createdTabResult, _ := createdTab["result"].(map[string]interface{})
	tab, _ := createdTabResult["tab"].(map[string]interface{})
	createdTabHandle, _ := tab["terminal"].(string)
	if createdTabHandle == "" || tab["isActive"] != true {
		t.Fatalf("unexpected session tab create response: %#v", createdTab)
	}
	createTabRequest["id"] = "create-tab-retry"
	writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, createTabRequest)
	retriedTab := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey)
	retriedResult, _ := retriedTab["result"].(map[string]interface{})
	retried, _ := retriedResult["tab"].(map[string]interface{})
	if retried["terminal"] != createdTabHandle || len(manager.ListSessions()) != 2 {
		t.Fatalf("clientMutationId spawned a duplicate terminal: %#v", retriedTab)
	}

	// Keep the wait alive long enough for the follow-up RPC assertions. A one-second
	// timeout could win the race on loaded CI and leave the test awaiting a second response.
	writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{"id": "wait", "deviceToken": pairing.DeviceToken, "method": "terminal.wait", "params": map[string]interface{}{"terminal": handle, "for": "exit", "timeoutMs": 5000}})
	writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{"id": "list-during-wait", "deviceToken": pairing.DeviceToken, "method": "terminal.list", "params": map[string]int{"limit": 10}})
	firstResponse := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey)
	if firstResponse["id"] != "list-during-wait" {
		t.Fatalf("terminal.wait blocked the shared-control connection: %#v", firstResponse)
	}

	writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{"id": "exit", "deviceToken": pairing.DeviceToken, "method": "terminal.send", "params": map[string]interface{}{"terminal": handle, "text": "exit", "enter": true}})
	// Fail this integration test promptly instead of inheriting the package's
	// ten-minute timeout if the connection stops producing terminal responses.
	if err := rawConn.SetReadDeadline(time.Now().Add(5 * time.Second)); err != nil {
		t.Fatal(err)
	}
	defer rawConn.SetReadDeadline(time.Time{})
	seenExitAck := false
	seenWait := false
	for attempts := 0; attempts < 3 && (!seenExitAck || !seenWait); attempts++ {
		response := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey)
		switch response["id"] {
		case "exit":
			seenExitAck = true
		case "wait":
			result, _ := response["result"].(map[string]interface{})
			wait, _ := result["wait"].(map[string]interface{})
			seenWait = wait["satisfied"] == true && wait["status"] == "exited"
		}
	}
	if !seenExitAck || !seenWait {
		t.Fatalf("expected exit acknowledgement and satisfied wait, ack=%v wait=%v", seenExitAck, seenWait)
	}
}

func TestLegacySharedControlStopExactGuardsConcurrentNativeSessions(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("terminal stop integration uses /bin/sh")
	}
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	project, err := manager.CreateProject(runtimecore.CreateProjectRequest{Name: "repo", Path: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	first, err := manager.StartSession(context.Background(), runtimecore.StartSessionRequest{ProjectID: project.ID, Cwd: project.Path, Command: []string{"/bin/sh"}})
	if err != nil {
		t.Fatal(err)
	}
	second, err := manager.StartSession(context.Background(), runtimecore.StartSessionRequest{ProjectID: project.ID, Cwd: project.Path, Command: []string{"/bin/sh"}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = manager.StopSession(first.ID)
		_, _ = manager.StopSession(second.ID)
	})
	pairing, err := manager.CreateLegacySharedControlPairing("terminal-stop", "mobile", false)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(NewServer(manager))
	defer server.Close()
	rawConn, reader := dialTestWebSocket(t, server.URL, "/v1/shared-control")
	defer rawConn.Close()
	conn := &websocketConn{conn: rawConn, reader: reader}
	sharedKey := authenticateLegacySharedControlTestClient(t, rawConn, conn, pairing)

	writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{"id": "mismatch", "deviceToken": pairing.DeviceToken, "method": "terminal.stopExact", "params": map[string]interface{}{"expectedPtyIds": []string{first.ID}}})
	mismatch := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey)
	mismatchResult, _ := mismatch["result"].(map[string]interface{})
	if mismatchResult["postStopVerified"] != false || mismatchResult["stopped"] != float64(0) {
		t.Fatalf("stopExact ignored a concurrent session: %#v", mismatch)
	}

	writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{"id": "target-only", "deviceToken": pairing.DeviceToken, "method": "terminal.stopExact", "params": map[string]interface{}{"expectedPtyIds": []string{first.ID}, "targetOnly": true}})
	targetOnly := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey)
	targetOnlyResult, _ := targetOnly["result"].(map[string]interface{})
	if targetOnlyResult["postStopVerified"] != true || targetOnlyResult["stopped"] != float64(1) {
		t.Fatalf("target-only stop failed: %#v", targetOnly)
	}
	remaining, _ := targetOnlyResult["remainingLivePtyIds"].([]interface{})
	if len(remaining) != 1 || remaining[0] != second.ID {
		t.Fatalf("target-only stop did not report the remaining live PTY: %#v", targetOnly)
	}

	writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{"id": "stop-rest", "deviceToken": pairing.DeviceToken, "method": "terminal.stop", "params": map[string]interface{}{}})
	stopped := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey)
	stoppedResult, _ := stopped["result"].(map[string]interface{})
	if stoppedResult["stopped"] != float64(1) || stoppedResult["postStopVerified"] != true {
		t.Fatalf("terminal.stop did not stop remaining sessions: %#v", stopped)
	}
	if _, exists := stoppedResult["remainingLivePtyIds"]; exists {
		t.Fatalf("verified stop reported remaining live PTYs: %#v", stopped)
	}
}

func authenticateLegacySharedControlTestClient(t *testing.T, rawConn interface{ Write([]byte) (int, error) }, conn *websocketConn, pairing runtimecore.LegacySharedControlPairingMaterial) *[32]byte {
	t.Helper()
	clientPublic, clientSecret, err := box.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	writeTestClientMessage(t, rawConn, map[string]string{"type": "e2ee_hello", "publicKeyB64": base64.StdEncoding.EncodeToString(clientPublic[:])})
	if ready, err := conn.readText(false); err != nil || ready != `{"type":"e2ee_ready"}` {
		t.Fatalf("unexpected ready frame %q: %v", ready, err)
	}
	serverPublicBytes, err := base64.StdEncoding.DecodeString(pairing.PublicKeyB64)
	if err != nil {
		t.Fatal(err)
	}
	var serverPublic [32]byte
	copy(serverPublic[:], serverPublicBytes)
	var sharedKey [32]byte
	box.Precompute(&sharedKey, &serverPublic, clientSecret)
	writeEncryptedLegacySharedControlTestFrame(t, rawConn, &sharedKey, map[string]string{"type": "e2ee_auth", "deviceToken": pairing.DeviceToken})
	authenticated := readEncryptedLegacySharedControlTestFrame(t, conn, &sharedKey)
	if authenticated["type"] != "e2ee_authenticated" {
		t.Fatalf("unexpected auth frame: %#v", authenticated)
	}
	return &sharedKey
}

func writeEncryptedLegacySharedControlTestFrame(t *testing.T, writer interface{ Write([]byte) (int, error) }, sharedKey *[32]byte, value interface{}) {
	t.Helper()
	plaintext, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	encrypted, err := encryptLegacySharedControlText(plaintext, sharedKey)
	if err != nil {
		t.Fatal(err)
	}
	if err := writeMaskedTextFrame(writer, []byte(encrypted)); err != nil {
		t.Fatal(err)
	}
}

func readEncryptedLegacySharedControlTestFrame(t *testing.T, conn *websocketConn, sharedKey *[32]byte) map[string]interface{} {
	t.Helper()
	encrypted, err := conn.readText(false)
	if err != nil {
		t.Fatal(err)
	}
	plaintext, err := decryptLegacySharedControlText(encrypted, sharedKey)
	if err != nil {
		t.Fatal(err)
	}
	var value map[string]interface{}
	if err := json.Unmarshal(plaintext, &value); err != nil {
		t.Fatal(err)
	}
	return value
}

func writeEncryptedLegacySharedControlBinaryFrame(t *testing.T, writer interface{ Write([]byte) (int, error) }, sharedKey *[32]byte, frame terminalStreamFrame) {
	t.Helper()
	encrypted, err := encryptLegacySharedControlBytes(encodeTerminalStreamFrame(frame), sharedKey)
	if err != nil {
		t.Fatal(err)
	}
	if err := writeMaskedFrame(writer, true, 0x2, encrypted); err != nil {
		t.Fatal(err)
	}
}

func readEncryptedLegacySharedControlBinaryFrame(t *testing.T, conn *websocketConn, sharedKey *[32]byte) terminalStreamFrame {
	t.Helper()
	opcode, encrypted, err := conn.readMessage(false)
	if err != nil {
		t.Fatal(err)
	}
	if opcode != 0x2 {
		t.Fatalf("expected binary websocket frame, got opcode %d", opcode)
	}
	plaintext, err := decryptLegacySharedControlBytes(encrypted, sharedKey)
	if err != nil {
		t.Fatal(err)
	}
	frame, err := decodeTerminalStreamFrame(plaintext)
	if err != nil {
		t.Fatal(err)
	}
	return frame
}
