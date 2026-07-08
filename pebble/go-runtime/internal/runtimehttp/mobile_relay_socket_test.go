package runtimehttp

import (
	"bufio"
	"bytes"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"

	"github.com/tsekaluk/pebble/go-runtime/internal/runtimecore"
)

func TestDecodeMobileRelayJSONRejectsUnknownFieldsAndTrailingValues(t *testing.T) {
	var message mobileRelayClientMessage
	if err := decodeMobileRelayJSON([]byte(`{"version":"pebble.mobile-relay.v1","id":"1","type":"heartbeat","payload":{},"extra":true}`), &message); err == nil {
		t.Fatal("expected unknown field to be rejected")
	}
	if err := decodeMobileRelayJSON([]byte(`{"version":"pebble.mobile-relay.v1","id":"1","type":"heartbeat","payload":{}} {}`), &message); err == nil {
		t.Fatal("expected trailing JSON value to be rejected")
	}
	if err := decodeMobileRelayJSON([]byte(`{"version":"pebble.mobile-relay.v1","id":"1","type":"heartbeat","payload":{}}`), &message); err != nil {
		t.Fatal(err)
	}
}

func TestMobileRelayCryptoRejectsInvalidNonceLength(t *testing.T) {
	session, err := newMobileRelayCryptoSessionFromSecret([]byte("shared-secret"), "secret-ref", "relay")
	if err != nil {
		t.Fatal(err)
	}
	_, err = session.decrypt(relayCryptoEnvelope{
		KeyID:          session.keyID,
		Nonce:          encodeRelayBase64([]byte("short")),
		Ciphertext:     encodeRelayBase64([]byte("ciphertext")),
		AssociatedData: mobileRelayCryptoAssociatedData,
	})
	if err == nil {
		t.Fatal("expected invalid nonce length to be rejected")
	}
}

func TestMobileRelayEndpoints(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(manager)

	content, err := json.Marshal(map[string]interface{}{
		"endpoint":      "ws://127.0.0.1:17777/v1/mobile-relay",
		"workspaceName": "repo",
		"ttlSeconds":    60,
	})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/v1/mobile-relay/pairing-codes", bytes.NewReader(content))
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", rec.Code, rec.Body.String())
	}
	var code runtimecore.MobileRelayPairingCode
	if err := json.Unmarshal(rec.Body.Bytes(), &code); err != nil {
		t.Fatal(err)
	}
	if code.Code == "" || code.ChallengeID == "" {
		t.Fatalf("unexpected pairing code: %#v", code)
	}

	req = httptest.NewRequest(http.MethodGet, "/v1/mobile-relay/status", nil)
	rec = httptest.NewRecorder()
	server.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var status runtimecore.MobileRelayStatus
	if err := json.Unmarshal(rec.Body.Bytes(), &status); err != nil {
		t.Fatal(err)
	}
	if !status.Configured || status.ActivePairingCodes != 1 {
		t.Fatalf("unexpected mobile relay status: %#v", status)
	}

	req = httptest.NewRequest(http.MethodGet, "/v1/mobile-relay/projection?projection=browser", nil)
	rec = httptest.NewRecorder()
	server.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var snapshot runtimecore.MobileRelayProjectionSnapshot
	if err := json.Unmarshal(rec.Body.Bytes(), &snapshot); err != nil {
		t.Fatal(err)
	}
	if snapshot.ReceivedAt.IsZero() {
		t.Fatalf("projection snapshot was not populated: %#v", snapshot)
	}
}

func TestMobileRelayWebSocketBearerTokenBoundary(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(NewServerWithOptions(manager, ServerOptions{BearerToken: "secret"}))
	defer server.Close()

	req := httptest.NewRequest(http.MethodGet, "/v1/mobile-relay/projection", nil)
	rec := httptest.NewRecorder()
	NewServerWithOptions(manager, ServerOptions{BearerToken: "secret"}).ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected mobile relay HTTP projection to require token, got %d", rec.Code)
	}

	conn, reader := dialTestWebSocket(t, server.URL, "/v1/mobile-relay")
	defer conn.Close()
	client := &websocketConn{conn: conn, reader: reader}

	writeTestClientMessage(t, conn, map[string]interface{}{
		"version": runtimecore.MobileRelayProtocolVersion,
		"id":      "input-1",
		"type":    "terminal.input",
		"payload": map[string]string{
			"sessionId": "session-1",
			"data":      "whoami\n",
		},
	})
	message := readTestServerMessage(t, client)
	if message.Type != "error" {
		t.Fatalf("expected websocket pairing error, got %#v", message)
	}
	payload := decodeTestPayload[map[string]string](t, message)
	if payload["code"] != "pairing_required" {
		t.Fatalf("unexpected websocket error payload: %#v", payload)
	}
}

func TestMobileRelayWebSocketRejectsInvalidUpgradeKey(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(NewServer(manager))
	defer server.Close()

	resp := requestRawWebSocketUpgrade(t, server.URL, "/v1/mobile-relay", "not-a-real-key", "13")
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected invalid websocket key to be rejected, got %d", resp.StatusCode)
	}
}

func TestMobileRelayWebSocketRejectsUnsupportedVersion(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(NewServer(manager))
	defer server.Close()

	key := base64.StdEncoding.EncodeToString([]byte("abcdefghijklmnop"))
	resp := requestRawWebSocketUpgrade(t, server.URL, "/v1/mobile-relay", key, "12")
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected unsupported websocket version to be rejected, got %d", resp.StatusCode)
	}
}

func TestProjectionOutputLimitFromRequest(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/v1/mobile-relay/projection?outputLimit=5", nil)
	if got := projectionOutputLimitFromRequest(req); got != 5 {
		t.Fatalf("unexpected output limit %d", got)
	}

	req = httptest.NewRequest(http.MethodGet, "/v1/mobile-relay/projection?outputLimit=bad", nil)
	if got := projectionOutputLimitFromRequest(req); got != 200 {
		t.Fatalf("unexpected fallback output limit %d", got)
	}
}

func TestMobileRelayWebSocketPairingFlow(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	code, err := manager.CreateMobileRelayPairingCode(runtimecore.CreateMobileRelayPairingCodeRequest{WorkspaceName: "repo"})
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(NewServer(manager))
	defer server.Close()

	conn, reader := dialTestWebSocket(t, server.URL, "/v1/mobile-relay")
	defer conn.Close()
	client := &websocketConn{conn: conn, reader: reader}

	writeTestClientMessage(t, conn, map[string]interface{}{
		"version": runtimecore.MobileRelayProtocolVersion,
		"id":      "pair-1",
		"type":    "pair.start",
		"payload": map[string]interface{}{
			"endpoint":    server.URL,
			"pairingCode": code.Code,
			"device": map[string]string{
				"deviceId":   "device-1",
				"deviceName": "Phone",
				"platform":   "ios",
			},
		},
	})
	accepted := readTestServerMessage(t, client)
	if accepted.Type != "pair.accepted" {
		t.Fatalf("expected pair.accepted, got %#v", accepted)
	}
	if pairings := manager.ListMobileRelayPairings(); len(pairings) != 1 {
		t.Fatalf("expected persisted pairing, got %#v", pairings)
	}
	writeTestClientMessage(t, conn, map[string]interface{}{
		"version": runtimecore.MobileRelayProtocolVersion,
		"id":      "sub-after-pair",
		"type":    "projection.subscribe",
		"payload": map[string]interface{}{
			"projections": []string{"browser"},
		},
	})
	actionError := readTestServerMessage(t, client)
	if actionError.Type != "error" {
		t.Fatalf("expected pairing error after pair.start, got %#v", actionError)
	}
	payload := decodeTestPayload[map[string]string](t, actionError)
	if payload["code"] != "pairing_required" {
		t.Fatalf("expected pairing_required after pair.start, got %#v", payload)
	}
}

func TestMobileRelayWebSocketRejectsUnpairedClientHelloAndActions(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(NewServer(manager))
	defer server.Close()

	conn, reader := dialTestWebSocket(t, server.URL, "/v1/mobile-relay")
	defer conn.Close()
	client := &websocketConn{conn: conn, reader: reader}

	writeTestClientMessage(t, conn, map[string]interface{}{
		"version": runtimecore.MobileRelayProtocolVersion,
		"id":      "input-1",
		"type":    "terminal.input",
		"payload": map[string]string{
			"sessionId": "session-1",
			"data":      "whoami\n",
		},
	})
	actionError := readTestServerMessage(t, client)
	if actionError.Type != "error" {
		t.Fatalf("expected pairing error for action, got %#v", actionError)
	}
	actionPayload := decodeTestPayload[map[string]string](t, actionError)
	if actionPayload["code"] != "pairing_required" {
		t.Fatalf("unexpected action error payload: %#v", actionPayload)
	}

	writeTestClientMessage(t, conn, map[string]interface{}{
		"version": runtimecore.MobileRelayProtocolVersion,
		"id":      "hello-1",
		"type":    "client.hello",
		"payload": map[string]interface{}{
			"device": map[string]string{
				"deviceId":   "device-unpaired",
				"deviceName": "Phone",
				"platform":   "ios",
			},
			"runtimeApiVersion":   runtimecore.ProtocolVersion,
			"runtimeEventVersion": "pebble.events.v1",
			"subscriptions":       []string{"terminal", "browser"},
		},
	})
	helloError := readTestServerMessage(t, client)
	if helloError.Type != "error" {
		t.Fatalf("expected pairing error for hello, got %#v", helloError)
	}
	helloPayload := decodeTestPayload[map[string]string](t, helloError)
	if helloPayload["code"] != "pairing_required" {
		t.Fatalf("unexpected hello error payload: %#v", helloPayload)
	}
}

func TestMobileRelayWebSocketAcceptsFragmentedClientHello(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	record := createTestMobileRelayPairing(t, manager, "device-fragmented")
	server := httptest.NewServer(NewServer(manager))
	defer server.Close()

	conn, reader := dialTestWebSocket(t, server.URL, "/v1/mobile-relay")
	defer conn.Close()
	client := &websocketConn{conn: conn, reader: reader}

	writeFragmentedTestClientMessage(t, conn, map[string]interface{}{
		"version": runtimecore.MobileRelayProtocolVersion,
		"id":      "hello-fragmented",
		"type":    "client.hello",
		"payload": map[string]interface{}{
			"device": map[string]string{
				"deviceId":   record.DeviceID,
				"deviceName": "Phone",
				"platform":   "android",
			},
			"runtimeApiVersion":   runtimecore.ProtocolVersion,
			"runtimeEventVersion": "pebble.events.v1",
			"subscriptions":       []string{"terminal"},
			"pairingSecretRef":    record.PairingSecretRef,
		},
	})
	first := readTestServerMessage(t, client)
	if first.Type != "server.hello" {
		t.Fatalf("expected server.hello, got %#v", first)
	}
	second := readTestServerMessage(t, client)
	if second.Type != "projection.snapshot" {
		t.Fatalf("expected projection snapshot, got %#v", second)
	}
}

func TestMobileRelayWebSocketFileReadWriteFlow(t *testing.T) {
	repo := t.TempDir()
	if err := os.WriteFile(filepath.Join(repo, "README.md"), []byte("one\n"), 0o600); err != nil {
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
	record := createTestMobileRelayPairing(t, manager, "device-files")
	server := httptest.NewServer(NewServer(manager))
	defer server.Close()

	conn, reader := dialTestWebSocket(t, server.URL, "/v1/mobile-relay")
	defer conn.Close()
	client := &websocketConn{conn: conn, reader: reader}

	writeTestClientMessage(t, conn, map[string]interface{}{
		"version": runtimecore.MobileRelayProtocolVersion,
		"id":      "hello-1",
		"type":    "client.hello",
		"payload": map[string]interface{}{
			"device": map[string]string{
				"deviceId":   record.DeviceID,
				"deviceName": "Phone",
				"platform":   "ios",
			},
			"runtimeApiVersion":   runtimecore.ProtocolVersion,
			"runtimeEventVersion": "pebble.events.v1",
			"subscriptions":       []string{"files"},
			"pairingSecretRef":    record.PairingSecretRef,
		},
	})
	if hello := readTestServerMessage(t, client); hello.Type != "server.hello" {
		t.Fatalf("expected server.hello, got %#v", hello)
	}
	snapshot := readTestServerMessage(t, client)
	if snapshot.Type != "projection.snapshot" {
		t.Fatalf("expected projection snapshot, got %#v", snapshot)
	}
	projected := decodeTestPayload[runtimecore.MobileRelayProjectionSnapshot](t, snapshot)
	if len(projected.Files) != 1 || projected.Files[0].Path != "README.md" {
		t.Fatalf("expected README file projection, got %#v", projected.Files)
	}

	writeTestClientMessage(t, conn, map[string]interface{}{
		"version": runtimecore.MobileRelayProtocolVersion,
		"id":      "read-1",
		"type":    "file.read",
		"payload": map[string]interface{}{
			"projectId": project.ID,
			"path":      "README.md",
			"maxBytes":  4096,
		},
	})
	readResponse := readTestServerMessage(t, client)
	if readResponse.Type != "file.content" {
		t.Fatalf("expected file.content, got %#v", readResponse)
	}
	readPayload := decodeTestPayload[struct {
		RequestID string                  `json:"requestId"`
		Content   runtimecore.FileContent `json:"content"`
	}](t, readResponse)
	if readPayload.RequestID != "read-1" || readPayload.Content.Content != "one\n" {
		t.Fatalf("unexpected file read payload: %#v", readPayload)
	}

	writeTestClientMessage(t, conn, map[string]interface{}{
		"version": runtimecore.MobileRelayProtocolVersion,
		"id":      "write-1",
		"type":    "file.write",
		"payload": map[string]interface{}{
			"projectId":  project.ID,
			"path":       "docs/notes.md",
			"content":    "two\n",
			"createDirs": true,
		},
	})
	writeResponse := readTestServerMessage(t, client)
	if writeResponse.Type != "file.content" {
		t.Fatalf("expected file.content write response, got %#v", writeResponse)
	}
	writePayload := decodeTestPayload[struct {
		RequestID string                  `json:"requestId"`
		Content   runtimecore.FileContent `json:"content"`
	}](t, writeResponse)
	if writePayload.RequestID != "write-1" || writePayload.Content.Path != "docs/notes.md" || writePayload.Content.Content != "two\n" {
		t.Fatalf("unexpected file write payload: %#v", writePayload)
	}
	stored, err := os.ReadFile(filepath.Join(repo, "docs", "notes.md"))
	if err != nil {
		t.Fatal(err)
	}
	if string(stored) != "two\n" {
		t.Fatalf("unexpected written file content: %q", stored)
	}
	changed := readTestServerMessage(t, client)
	if changed.Type != "runtime.event" {
		t.Fatalf("expected runtime.event after file write, got %#v", changed)
	}
	event := decodeTestPayload[runtimecore.RuntimeEvent](t, changed)
	if event.Topic != "file.changed" {
		t.Fatalf("expected file.changed event, got %#v", event)
	}
}

func TestMobileRelayEncryptedWebSocketFlow(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	code, err := manager.CreateMobileRelayPairingCode(runtimecore.CreateMobileRelayPairingCodeRequest{WorkspaceName: "repo"})
	if err != nil {
		t.Fatal(err)
	}
	record, err := manager.PairMobileRelayDevice(runtimecore.PairMobileRelayDeviceRequest{
		PairingCode: code.Code,
		Device: runtimecore.MobileRelayDeviceIdentity{
			DeviceID:   "device-crypto",
			DeviceName: "Phone",
			Platform:   "ios",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(NewServer(manager))
	defer server.Close()

	conn, reader := dialTestWebSocket(t, server.URL, "/v1/mobile-relay")
	defer conn.Close()
	client := &websocketConn{conn: conn, reader: reader}

	clientPrivateKey, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	writeTestClientMessage(t, conn, map[string]interface{}{
		"version": runtimecore.MobileRelayProtocolVersion,
		"id":      "crypto-1",
		"type":    "crypto.handshake",
		"payload": map[string]interface{}{
			"device": map[string]string{
				"deviceId":   record.DeviceID,
				"deviceName": record.DeviceName,
				"platform":   record.Platform,
			},
			"clientPublicKey":  encodeRelayBase64(clientPrivateKey.PublicKey().Bytes()),
			"pairingSecretRef": record.PairingSecretRef,
			"subscriptions":    []string{"terminal", "browser"},
		},
	})
	readyMessage := readTestServerMessage(t, client)
	if readyMessage.Type != "crypto.ready" {
		t.Fatalf("expected crypto.ready, got %#v", readyMessage)
	}
	ready := decodeTestPayload[cryptoReadyPayload](t, readyMessage)
	clientCrypto, err := newMobileRelayClientCryptoSession(
		clientPrivateKey,
		ready,
		record.PairingSecretRef,
		record.RelayID,
	)
	if err != nil {
		t.Fatal(err)
	}

	hello := readEncryptedTestServerMessage(t, client, clientCrypto)
	if hello.Type != "server.hello" {
		t.Fatalf("expected encrypted server.hello, got %#v", hello)
	}
	snapshot := readEncryptedTestServerMessage(t, client, clientCrypto)
	if snapshot.Type != "projection.snapshot" {
		t.Fatalf("expected encrypted projection snapshot, got %#v", snapshot)
	}

	writeEncryptedTestClientMessage(t, conn, clientCrypto, "beat-1", "heartbeat", map[string]string{
		"sentAt": "2026-07-07T00:00:00Z",
	})
	heartbeat := readEncryptedTestServerMessage(t, client, clientCrypto)
	if heartbeat.Type != "heartbeat" {
		t.Fatalf("expected encrypted heartbeat, got %#v", heartbeat)
	}
}

func createTestMobileRelayPairing(t *testing.T, manager *runtimecore.Manager, deviceID string) runtimecore.MobileRelayPairingRecord {
	t.Helper()
	code, err := manager.CreateMobileRelayPairingCode(runtimecore.CreateMobileRelayPairingCodeRequest{WorkspaceName: "repo"})
	if err != nil {
		t.Fatal(err)
	}
	record, err := manager.PairMobileRelayDevice(runtimecore.PairMobileRelayDeviceRequest{
		PairingCode: code.Code,
		Device: runtimecore.MobileRelayDeviceIdentity{
			DeviceID:   deviceID,
			DeviceName: "Phone",
			Platform:   "ios",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	return record
}

func dialTestWebSocket(t *testing.T, serverURL string, path string) (net.Conn, *bufio.Reader) {
	t.Helper()
	parsed, err := url.Parse(serverURL)
	if err != nil {
		t.Fatal(err)
	}
	conn, err := net.Dial("tcp", parsed.Host)
	if err != nil {
		t.Fatal(err)
	}
	key := base64.StdEncoding.EncodeToString([]byte("abcdefghijklmnop"))
	_, err = fmt.Fprintf(conn, "GET %s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n", path, parsed.Host, key)
	if err != nil {
		_ = conn.Close()
		t.Fatal(err)
	}
	reader := bufio.NewReader(conn)
	resp, err := http.ReadResponse(reader, &http.Request{Method: http.MethodGet})
	if err != nil {
		_ = conn.Close()
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusSwitchingProtocols {
		_ = conn.Close()
		t.Fatalf("expected websocket upgrade, got %d", resp.StatusCode)
	}
	return conn, reader
}

func requestRawWebSocketUpgrade(t *testing.T, serverURL string, path string, key string, version string) *http.Response {
	t.Helper()
	parsed, err := url.Parse(serverURL)
	if err != nil {
		t.Fatal(err)
	}
	conn, err := net.Dial("tcp", parsed.Host)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = conn.Close()
	})
	_, err = fmt.Fprintf(conn, "GET %s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: %s\r\nSec-WebSocket-Version: %s\r\n\r\n", path, parsed.Host, key, version)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.ReadResponse(bufio.NewReader(conn), &http.Request{Method: http.MethodGet})
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

func decodeTestPayload[T any](t *testing.T, message mobileRelayServerMessage) T {
	t.Helper()
	content, err := json.Marshal(message.Payload)
	if err != nil {
		t.Fatal(err)
	}
	var payload T
	if err := json.Unmarshal(content, &payload); err != nil {
		t.Fatal(err)
	}
	return payload
}

func writeEncryptedTestClientMessage(
	t *testing.T,
	writer io.Writer,
	session *mobileRelayCryptoSession,
	id string,
	messageType string,
	payload interface{},
) {
	t.Helper()
	payloadContent, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	innerContent, err := json.Marshal(mobileRelayClientMessage{
		Version: runtimecore.MobileRelayProtocolVersion,
		ID:      id,
		Type:    messageType,
		Payload: payloadContent,
	})
	if err != nil {
		t.Fatal(err)
	}
	envelope, err := session.encrypt(innerContent)
	if err != nil {
		t.Fatal(err)
	}
	writeTestClientMessage(t, writer, map[string]interface{}{
		"version": runtimecore.MobileRelayProtocolVersion,
		"id":      id + "-outer",
		"type":    "encrypted",
		"payload": envelope,
	})
}

func readEncryptedTestServerMessage(
	t *testing.T,
	conn *websocketConn,
	session *mobileRelayCryptoSession,
) mobileRelayServerMessage {
	t.Helper()
	outer := readTestServerMessage(t, conn)
	if outer.Type != "encrypted" {
		t.Fatalf("expected encrypted server message, got %#v", outer)
	}
	envelope := decodeTestPayload[relayCryptoEnvelope](t, outer)
	content, err := session.decrypt(envelope)
	if err != nil {
		t.Fatal(err)
	}
	var inner mobileRelayServerMessage
	if err := json.Unmarshal(content, &inner); err != nil {
		t.Fatal(err)
	}
	return inner
}

func writeTestClientMessage(t *testing.T, writer io.Writer, message interface{}) {
	t.Helper()
	content, err := json.Marshal(message)
	if err != nil {
		t.Fatal(err)
	}
	if err := writeMaskedTextFrame(writer, content); err != nil {
		t.Fatal(err)
	}
}

func writeFragmentedTestClientMessage(t *testing.T, writer io.Writer, message interface{}) {
	t.Helper()
	content, err := json.Marshal(message)
	if err != nil {
		t.Fatal(err)
	}
	split := len(content) / 2
	if split == 0 {
		split = 1
	}
	if err := writeMaskedFrame(writer, false, 0x1, content[:split]); err != nil {
		t.Fatal(err)
	}
	if err := writeMaskedFrame(writer, true, 0x0, content[split:]); err != nil {
		t.Fatal(err)
	}
}

func readTestServerMessage(t *testing.T, conn *websocketConn) mobileRelayServerMessage {
	t.Helper()
	raw, err := conn.readText(false)
	if err != nil {
		t.Fatal(err)
	}
	var message mobileRelayServerMessage
	if err := json.Unmarshal([]byte(raw), &message); err != nil {
		t.Fatal(err)
	}
	return message
}

func writeMaskedTextFrame(writer io.Writer, payload []byte) error {
	return writeMaskedFrame(writer, true, 0x1, payload)
}

func writeMaskedFrame(writer io.Writer, fin bool, opcode byte, payload []byte) error {
	mask := [4]byte{1, 2, 3, 4}
	firstByte := opcode
	if fin {
		firstByte |= 0x80
	}
	header := []byte{firstByte}
	length := len(payload)
	switch {
	case length <= 125:
		header = append(header, 0x80|byte(length))
	case length <= 65535:
		header = append(header, 0x80|126)
		var lengthBytes [2]byte
		binary.BigEndian.PutUint16(lengthBytes[:], uint16(length))
		header = append(header, lengthBytes[:]...)
	default:
		header = append(header, 0x80|127)
		var lengthBytes [8]byte
		binary.BigEndian.PutUint64(lengthBytes[:], uint64(length))
		header = append(header, lengthBytes[:]...)
	}
	masked := make([]byte, len(payload))
	for index, value := range payload {
		masked[index] = value ^ mask[index%4]
	}
	if _, err := writer.Write(header); err != nil {
		return err
	}
	if _, err := writer.Write(mask[:]); err != nil {
		return err
	}
	_, err := writer.Write(masked)
	return err
}
