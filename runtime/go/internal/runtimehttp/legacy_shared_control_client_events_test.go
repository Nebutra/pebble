package runtimehttp

import (
	"context"
	"net/http/httptest"
	"testing"

	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
)

type legacySharedControlClientEventsFixture struct {
	manager   *runtimecore.Manager
	project   runtimecore.Project
	conn      *websocketConn
	rawConn   interface{ Write([]byte) (int, error) }
	sharedKey *[32]byte
}

func startLegacySharedControlClientEventsFixture(t *testing.T) legacySharedControlClientEventsFixture {
	t.Helper()
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	project, err := manager.CreateProject(runtimecore.CreateProjectRequest{Name: "repo", Path: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	pairing, err := manager.CreateLegacySharedControlPairing("client-events-test", "runtime", false)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(NewServer(manager))
	t.Cleanup(server.Close)
	rawConn, reader := dialTestWebSocket(t, server.URL, "/v1/shared-control")
	t.Cleanup(func() { _ = rawConn.Close() })
	conn := &websocketConn{conn: rawConn, reader: reader}
	sharedKey := authenticateLegacySharedControlTestClient(t, rawConn, conn, pairing)
	return legacySharedControlClientEventsFixture{manager: manager, project: project, conn: conn, rawConn: rawConn, sharedKey: sharedKey}
}

func (f legacySharedControlClientEventsFixture) call(t *testing.T, id string, method string, params interface{}) map[string]interface{} {
	t.Helper()
	writeEncryptedLegacySharedControlTestFrame(t, f.rawConn, f.sharedKey, map[string]interface{}{"id": id, "method": method, "params": params})
	response := readEncryptedLegacySharedControlTestFrame(t, f.conn, f.sharedKey)
	if response["id"] != id {
		t.Fatalf("expected the next message to answer %s, got %#v", method, response)
	}
	result, ok := response["result"].(map[string]interface{})
	if !ok {
		t.Fatalf("%s did not answer with a result: %#v", method, response)
	}
	return result
}

func TestLegacySharedControlClientEventsAnnouncesRepoAndWorktreeChanges(t *testing.T) {
	fixture := startLegacySharedControlClientEventsFixture(t)
	ready := fixture.call(t, "events", "runtime.clientEvents.subscribe", map[string]interface{}{})
	if ready["type"] != "ready" || ready["subscriptionId"] == "" {
		t.Fatalf("expected a ready handshake carrying a subscription id, got %#v", ready)
	}

	if _, err := fixture.manager.CreateProject(runtimecore.CreateProjectRequest{Name: "second", Path: t.TempDir()}); err != nil {
		t.Fatal(err)
	}
	repos := readEncryptedLegacySharedControlTestFrame(t, fixture.conn, fixture.sharedKey)
	reposEvent, _ := repos["result"].(map[string]interface{})
	if reposEvent["type"] != "reposChanged" || repos["streaming"] != true {
		t.Fatalf("expected a streaming reposChanged event, got %#v", repos)
	}

	if _, err := fixture.manager.CreateWorktree(context.Background(), runtimecore.CreateWorktreeRequest{ProjectID: fixture.project.ID, Path: fixture.project.Path}); err != nil {
		t.Fatal(err)
	}
	for attempts := 0; attempts < 6; attempts++ {
		message := readEncryptedLegacySharedControlTestFrame(t, fixture.conn, fixture.sharedKey)
		event, _ := message["result"].(map[string]interface{})
		if event["type"] != "worktreesChanged" {
			continue
		}
		if event["repoId"] != fixture.project.ID {
			t.Fatalf("expected the worktree event to name its project, got %#v", event)
		}
		return
	}
	t.Fatal("expected a worktreesChanged event after creating a worktree")
}

func TestLegacySharedControlClientEventsStopOnUnsubscribe(t *testing.T) {
	fixture := startLegacySharedControlClientEventsFixture(t)
	ready := fixture.call(t, "events", "runtime.clientEvents.subscribe", map[string]interface{}{})
	subscriptionID, _ := ready["subscriptionId"].(string)
	if subscriptionID == "" {
		t.Fatalf("expected a subscription id, got %#v", ready)
	}

	writeEncryptedLegacySharedControlTestFrame(t, fixture.rawConn, fixture.sharedKey, map[string]interface{}{"id": "stop", "method": "runtime.clientEvents.unsubscribe", "params": map[string]interface{}{"subscriptionId": subscriptionID}})
	end := readEncryptedLegacySharedControlTestFrame(t, fixture.conn, fixture.sharedKey)
	endEvent, _ := end["result"].(map[string]interface{})
	if endEvent["type"] != "end" {
		t.Fatalf("expected the subscription to be closed with an end event, got %#v", end)
	}
	acknowledgement := readEncryptedLegacySharedControlTestFrame(t, fixture.conn, fixture.sharedKey)
	acknowledged, _ := acknowledgement["result"].(map[string]interface{})
	if acknowledged["unsubscribed"] != true {
		t.Fatalf("expected the unsubscribe to be acknowledged, got %#v", acknowledgement)
	}

	// A change after the unsubscribe must not reach the client, so the next
	// message on the socket has to be the answer to the request that follows it.
	if _, err := fixture.manager.CreateProject(runtimecore.CreateProjectRequest{Name: "after", Path: t.TempDir()}); err != nil {
		t.Fatal(err)
	}
	fixture.call(t, "status", "status.get", map[string]interface{}{})
}

func TestLegacySharedControlSettingsRoundTrip(t *testing.T) {
	fixture := startLegacySharedControlClientEventsFixture(t)
	initial := fixture.call(t, "get-1", "settings.get", map[string]interface{}{})
	settings, ok := initial["settings"].(map[string]interface{})
	if !ok || len(settings) != 0 {
		t.Fatalf("expected an empty settings map before anything is stored, got %#v", initial)
	}

	updated := fixture.call(t, "update-1", "settings.update", map[string]interface{}{
		"compactWorktreeCards": true,
		"minimaxGroupId":       "group-7",
		// Why: an unknown key must be dropped rather than echoed back, otherwise a
		// newer client would believe this runtime persisted it.
		"unknownSetting": "ignored",
	})
	stored, _ := updated["settings"].(map[string]interface{})
	if stored["compactWorktreeCards"] != true || stored["minimaxGroupId"] != "group-7" {
		t.Fatalf("expected the update to be persisted, got %#v", updated)
	}
	if _, present := stored["unknownSetting"]; present {
		t.Fatalf("expected the unknown key to be dropped, got %#v", updated)
	}

	reread := fixture.call(t, "get-2", "settings.get", map[string]interface{}{})
	rereadSettings, _ := reread["settings"].(map[string]interface{})
	if rereadSettings["compactWorktreeCards"] != true || rereadSettings["minimaxGroupId"] != "group-7" {
		t.Fatalf("expected settings.get to read the stored values back, got %#v", reread)
	}
}

func TestLegacySharedControlSettingsRejectAWronglyTypedValue(t *testing.T) {
	fixture := startLegacySharedControlClientEventsFixture(t)
	updated := fixture.call(t, "update-1", "settings.update", map[string]interface{}{"compactWorktreeCards": "yes"})
	stored, _ := updated["settings"].(map[string]interface{})
	if _, present := stored["compactWorktreeCards"]; present {
		t.Fatalf("expected a wrongly typed value to be dropped, got %#v", updated)
	}
}
