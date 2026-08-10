package runtimehttp

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
)

type legacySharedControlMultiplexMessage struct {
	JSON  map[string]interface{}
	Frame *terminalStreamFrame
}

// Why: a multiplex subscription interleaves JSON stream events with binary
// terminal frames on one connection, so the strict per-kind readers used by the
// single-terminal tests cannot be used here.
func readLegacySharedControlMultiplexMessage(t *testing.T, conn *websocketConn, sharedKey *[32]byte) legacySharedControlMultiplexMessage {
	t.Helper()
	opcode, encrypted, err := conn.readMessage(false)
	if err != nil {
		t.Fatal(err)
	}
	if opcode == 0x2 {
		plaintext, err := decryptLegacySharedControlBytes(encrypted, sharedKey)
		if err != nil {
			t.Fatal(err)
		}
		frame, err := decodeTerminalStreamFrame(plaintext)
		if err != nil {
			t.Fatal(err)
		}
		return legacySharedControlMultiplexMessage{Frame: &frame}
	}
	plaintext, err := decryptLegacySharedControlText(string(encrypted), sharedKey)
	if err != nil {
		t.Fatal(err)
	}
	var value map[string]interface{}
	if err := json.Unmarshal(plaintext, &value); err != nil {
		t.Fatal(err)
	}
	return legacySharedControlMultiplexMessage{JSON: value}
}

func legacySharedControlMultiplexStreamEvent(message legacySharedControlMultiplexMessage) map[string]interface{} {
	if message.JSON == nil {
		return nil
	}
	result, _ := message.JSON["result"].(map[string]interface{})
	return result
}

type legacySharedControlMultiplexFixture struct {
	manager   *runtimecore.Manager
	session   runtimecore.Session
	conn      *websocketConn
	rawConn   interface{ Write([]byte) (int, error) }
	sharedKey *[32]byte
}

func startLegacySharedControlMultiplexFixture(t *testing.T) legacySharedControlMultiplexFixture {
	t.Helper()
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
	pairing, err := manager.CreateLegacySharedControlPairing("multiplex-test", "mobile", false)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(NewServer(manager))
	t.Cleanup(server.Close)
	rawConn, reader := dialTestWebSocket(t, server.URL, "/v1/shared-control")
	t.Cleanup(func() { _ = rawConn.Close() })
	conn := &websocketConn{conn: rawConn, reader: reader}
	sharedKey := authenticateLegacySharedControlTestClient(t, rawConn, conn, pairing)
	writeEncryptedLegacySharedControlTestFrame(t, rawConn, sharedKey, map[string]interface{}{"id": "mux", "deviceToken": pairing.DeviceToken, "method": "terminal.multiplex", "params": map[string]interface{}{}})
	ready := readEncryptedLegacySharedControlTestFrame(t, conn, sharedKey)
	result, _ := ready["result"].(map[string]interface{})
	if result["type"] != "ready" || ready["streaming"] != true {
		t.Fatalf("expected a streaming multiplex ready handshake, got %#v", ready)
	}
	return legacySharedControlMultiplexFixture{manager: manager, session: session, conn: conn, rawConn: rawConn, sharedKey: sharedKey}
}

func (f legacySharedControlMultiplexFixture) openStream(t *testing.T, streamID uint32, terminalID string, viewport map[string]int) {
	t.Helper()
	payload, err := json.Marshal(map[string]interface{}{
		"streamId": streamID,
		"terminal": terminalID,
		"client":   map[string]string{"id": "web-1", "type": "desktop"},
		"viewport": viewport,
	})
	if err != nil {
		t.Fatal(err)
	}
	writeEncryptedLegacySharedControlBinaryFrame(t, f.rawConn, f.sharedKey, terminalStreamFrame{Opcode: terminalStreamSubscribe, StreamID: 0, Payload: payload})
}

func TestLegacySharedControlTerminalMultiplexOpensAStreamAndReplaysScrollback(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("terminal stream integration uses /bin/sh")
	}
	fixture := startLegacySharedControlMultiplexFixture(t)
	fixture.openStream(t, 7, fixture.session.ID, map[string]int{"cols": 100, "rows": 40})

	subscribed := false
	snapshotStarted := false
	snapshotEnded := false
	for attempts := 0; attempts < 12 && !snapshotEnded; attempts++ {
		message := readLegacySharedControlMultiplexMessage(t, fixture.conn, fixture.sharedKey)
		if event := legacySharedControlMultiplexStreamEvent(message); event != nil {
			if event["type"] == "subscribed" && event["streamId"] == float64(7) {
				subscribed = true
			}
			continue
		}
		if message.Frame.StreamID != 7 {
			t.Fatalf("multiplex frame addressed the wrong stream: %#v", message.Frame)
		}
		snapshotStarted = snapshotStarted || message.Frame.Opcode == terminalStreamSnapshotStart
		snapshotEnded = snapshotEnded || message.Frame.Opcode == terminalStreamSnapshotEnd
	}
	if !subscribed || !snapshotStarted || !snapshotEnded {
		t.Fatalf("expected a subscribed event and snapshot bounds, subscribed=%v start=%v end=%v", subscribed, snapshotStarted, snapshotEnded)
	}

	// The subscribe viewport has to reach the PTY, otherwise the client renders
	// its own fit against a differently sized terminal.
	deadline := time.Now().Add(2 * time.Second)
	for {
		status, statusErr := fixture.manager.SessionStatus(fixture.session.ID)
		if statusErr == nil && status.Cols == 100 && status.Rows == 40 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("multiplex subscribe viewport did not reach the PTY: %#v, %v", status, statusErr)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestLegacySharedControlTerminalMultiplexCarriesInputAndOutput(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("terminal stream integration uses /bin/sh")
	}
	fixture := startLegacySharedControlMultiplexFixture(t)
	fixture.openStream(t, 3, fixture.session.ID, nil)
	waitForLegacySharedControlMultiplexSnapshotEnd(t, fixture, 3)

	writeEncryptedLegacySharedControlBinaryFrame(t, fixture.rawConn, fixture.sharedKey, terminalStreamFrame{Opcode: terminalStreamInput, StreamID: 3, Payload: []byte("printf multiplex-marker\n")})
	seenOutput := false
	for attempts := 0; attempts < 10 && !seenOutput; attempts++ {
		message := readLegacySharedControlMultiplexMessage(t, fixture.conn, fixture.sharedKey)
		if message.Frame == nil {
			continue
		}
		seenOutput = message.Frame.Opcode == terminalStreamOutput && message.Frame.StreamID == 3 && strings.Contains(string(message.Frame.Payload), "multiplex-marker")
	}
	if !seenOutput {
		t.Fatal("expected multiplex output for the stream that sent the input")
	}
}

func TestLegacySharedControlTerminalMultiplexSnapshotRequestEchoesItsRequestID(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("terminal stream integration uses /bin/sh")
	}
	fixture := startLegacySharedControlMultiplexFixture(t)
	fixture.openStream(t, 5, fixture.session.ID, nil)
	waitForLegacySharedControlMultiplexSnapshotEnd(t, fixture, 5)

	payload, err := json.Marshal(map[string]int{"requestId": 42, "scrollbackRows": 200})
	if err != nil {
		t.Fatal(err)
	}
	writeEncryptedLegacySharedControlBinaryFrame(t, fixture.rawConn, fixture.sharedKey, terminalStreamFrame{Opcode: terminalStreamSnapshotRequest, StreamID: 5, Payload: payload})
	for attempts := 0; attempts < 10; attempts++ {
		message := readLegacySharedControlMultiplexMessage(t, fixture.conn, fixture.sharedKey)
		if message.Frame == nil || message.Frame.Opcode != terminalStreamSnapshotStart {
			continue
		}
		var metadata map[string]interface{}
		if json.Unmarshal(message.Frame.Payload, &metadata) != nil {
			t.Fatalf("unreadable snapshot metadata: %s", message.Frame.Payload)
		}
		if metadata["requestId"] != float64(42) {
			t.Fatalf("expected the snapshot to echo its request id, got %#v", metadata)
		}
		return
	}
	t.Fatal("expected a snapshot for the requested stream")
}

func TestLegacySharedControlTerminalMultiplexRejectsAnUnknownTerminal(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("terminal stream integration uses /bin/sh")
	}
	fixture := startLegacySharedControlMultiplexFixture(t)
	fixture.openStream(t, 9, "missing-session", nil)
	for attempts := 0; attempts < 6; attempts++ {
		message := readLegacySharedControlMultiplexMessage(t, fixture.conn, fixture.sharedKey)
		event := legacySharedControlMultiplexStreamEvent(message)
		if event == nil {
			continue
		}
		if event["type"] != "error" || event["streamId"] != float64(9) {
			t.Fatalf("expected a stream error event, got %#v", event)
		}
		return
	}
	t.Fatal("expected an error event for an unknown terminal")
}

func TestLegacySharedControlTerminalMultiplexEndsAStreamWhenItsSessionStops(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("terminal stream integration uses /bin/sh")
	}
	fixture := startLegacySharedControlMultiplexFixture(t)
	fixture.openStream(t, 11, fixture.session.ID, nil)
	waitForLegacySharedControlMultiplexSnapshotEnd(t, fixture, 11)

	if _, err := fixture.manager.StopSession(fixture.session.ID); err != nil {
		t.Fatal(err)
	}
	for attempts := 0; attempts < 20; attempts++ {
		message := readLegacySharedControlMultiplexMessage(t, fixture.conn, fixture.sharedKey)
		event := legacySharedControlMultiplexStreamEvent(message)
		if event == nil || event["type"] != "end" {
			continue
		}
		if event["streamId"] != float64(11) {
			t.Fatalf("expected the stopped session's stream to end, got %#v", event)
		}
		return
	}
	t.Fatal("expected an end event after the session stopped")
}

func waitForLegacySharedControlMultiplexSnapshotEnd(t *testing.T, fixture legacySharedControlMultiplexFixture, streamID uint32) {
	t.Helper()
	for attempts := 0; attempts < 12; attempts++ {
		message := readLegacySharedControlMultiplexMessage(t, fixture.conn, fixture.sharedKey)
		if message.Frame != nil && message.Frame.Opcode == terminalStreamSnapshotEnd && message.Frame.StreamID == streamID {
			return
		}
	}
	t.Fatalf("stream %d never finished its initial snapshot", streamID)
}
