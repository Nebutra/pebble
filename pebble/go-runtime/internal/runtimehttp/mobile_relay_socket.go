package runtimehttp

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/tsekaluk/pebble/go-runtime/internal/runtimecore"
)

type mobileRelayClientMessage struct {
	Version string          `json:"version"`
	ID      string          `json:"id"`
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload"`
}

type mobileRelayServerMessage struct {
	Version string      `json:"version"`
	ID      string      `json:"id"`
	Type    string      `json:"type"`
	Payload interface{} `json:"payload"`
}

type mobileRelayConnectionState struct {
	relayID       string
	deviceID      string
	subscriptions []runtimecore.ProjectionKind
	ready         bool
	paired        bool
	crypto        *mobileRelayCryptoSession
}

type clientHelloPayload struct {
	Device              runtimecore.MobileRelayDeviceIdentity `json:"device"`
	RuntimeAPIVersion   string                                `json:"runtimeApiVersion"`
	RuntimeEventVersion string                                `json:"runtimeEventVersion"`
	Subscriptions       []runtimecore.ProjectionKind          `json:"subscriptions"`
	PairingSecretRef    string                                `json:"pairingSecretRef,omitempty"`
}

type pairStartPayload struct {
	Endpoint    string                                `json:"endpoint"`
	PairingCode string                                `json:"pairingCode"`
	Device      runtimecore.MobileRelayDeviceIdentity `json:"device"`
}

type projectionSubscribePayload struct {
	Projections []runtimecore.ProjectionKind `json:"projections"`
}

type terminalInputPayload struct {
	SessionID string `json:"sessionId"`
	Data      string `json:"data"`
}

type browserCommandPayload struct {
	TabID   string `json:"tabId"`
	Command string `json:"command"`
	URL     string `json:"url,omitempty"`
}

type fileReadPayload struct {
	ProjectID  string `json:"projectId"`
	WorktreeID string `json:"worktreeId,omitempty"`
	Path       string `json:"path"`
	MaxBytes   int64  `json:"maxBytes,omitempty"`
}

type fileWritePayload struct {
	ProjectID  string `json:"projectId"`
	WorktreeID string `json:"worktreeId,omitempty"`
	Path       string `json:"path"`
	Content    string `json:"content"`
	CreateDirs bool   `json:"createDirs,omitempty"`
}

type heartbeatPayload struct {
	SentAt string `json:"sentAt"`
}

func (s *Server) handleMobileRelaySocket(w http.ResponseWriter, r *http.Request) {
	conn, err := upgradeWebSocket(w, r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	defer conn.close()

	state := mobileRelayConnectionState{
		relayID:       s.manager.MobileRelayStatus().RelayID,
		subscriptions: runtimecore.NormalizeMobileProjectionKinds(nil),
	}
	incoming := make(chan mobileRelayClientMessage, 16)
	errCh := make(chan error, 1)
	go readMobileRelayMessages(conn, incoming, errCh)

	subscriberID, events := s.manager.Subscribe(128)
	defer s.manager.Unsubscribe(subscriberID)

	for {
		select {
		case <-r.Context().Done():
			return
		case err := <-errCh:
			if err != nil && !errors.Is(err, errWebSocketClosed) {
				_ = writeMobileRelayError(conn, &state, "transport_error", err.Error())
			}
			return
		case message, ok := <-incoming:
			if !ok {
				return
			}
			keepOpen := s.handleMobileRelayClientMessage(conn, &state, message)
			if !keepOpen {
				return
			}
		case event, ok := <-events:
			if !ok {
				return
			}
			if !state.ready {
				continue
			}
			projected, ok := s.manager.MobileRelayEvent(event, state.subscriptions)
			if !ok {
				continue
			}
			if err := writeMobileRelayMessage(conn, &state, "runtime.event", projected); err != nil {
				return
			}
		}
	}
}

func readMobileRelayMessages(conn *websocketConn, incoming chan<- mobileRelayClientMessage, errCh chan<- error) {
	defer close(incoming)
	for {
		raw, err := conn.readText(true)
		if err != nil {
			errCh <- err
			return
		}
		var message mobileRelayClientMessage
		if err := decodeMobileRelayJSON([]byte(raw), &message); err != nil {
			errCh <- err
			return
		}
		incoming <- message
	}
}

func (s *Server) handleMobileRelayClientMessage(conn *websocketConn, state *mobileRelayConnectionState, message mobileRelayClientMessage) bool {
	if message.Version != runtimecore.MobileRelayProtocolVersion {
		_ = writeMobileRelayError(conn, state, "version_mismatch", "unsupported mobile relay protocol version")
		return true
	}
	if !state.paired && mobileRelayMessageRequiresPairing(message.Type) {
		_ = writeMobileRelayError(conn, state, "pairing_required", "mobile relay pairing is required")
		return true
	}
	switch message.Type {
	case "crypto.handshake":
		return s.handleMobileRelayCryptoHandshake(conn, state, message)
	case "encrypted":
		return s.handleMobileRelayEncryptedMessage(conn, state, message)
	case "client.hello":
		return s.handleMobileRelayHello(conn, state, message)
	case "pair.start":
		return s.handleMobileRelayPairStart(conn, state, message)
	case "projection.subscribe":
		return s.handleMobileRelayProjectionSubscribe(conn, state, message)
	case "terminal.input":
		return s.handleMobileRelayTerminalInput(conn, state, message)
	case "browser.command":
		return s.handleMobileRelayBrowserCommand(conn, state, message)
	case "file.read":
		return s.handleMobileRelayFileRead(conn, state, message)
	case "file.write":
		return s.handleMobileRelayFileWrite(conn, state, message)
	case "heartbeat":
		return s.handleMobileRelayHeartbeat(conn, state, message)
	default:
		_ = writeMobileRelayError(conn, state, "unknown_message", "unknown mobile relay message type")
		return true
	}
}

func mobileRelayMessageRequiresPairing(messageType string) bool {
	switch messageType {
	case "crypto.handshake", "client.hello", "pair.start":
		return false
	default:
		return true
	}
}

func (s *Server) handleMobileRelayCryptoHandshake(conn *websocketConn, state *mobileRelayConnectionState, message mobileRelayClientMessage) bool {
	var payload cryptoHandshakePayload
	if !decodeMobileRelayPayload(conn, state, message.Payload, &payload) {
		return true
	}
	deviceID := strings.TrimSpace(payload.Device.DeviceID)
	if deviceID == "" {
		_ = writeMobileRelayError(conn, state, "crypto_handshake_failed", "device id is required")
		return true
	}
	record, ok := s.manager.TouchMobileRelayPairing(deviceID, payload.PairingSecretRef)
	if !ok {
		_ = writeMobileRelayError(conn, state, "crypto_handshake_failed", "pairing secret was not accepted")
		return false
	}
	session, ready, err := newMobileRelayServerCryptoSession(
		payload.ClientPublicKey,
		record.PairingSecretRef,
		record.RelayID,
	)
	if err != nil {
		_ = writeMobileRelayError(conn, state, "crypto_handshake_failed", err.Error())
		return true
	}
	if err := writePlainMobileRelayMessage(conn, "crypto.ready", ready); err != nil {
		return false
	}
	state.crypto = session
	state.deviceID = record.DeviceID
	state.subscriptions = runtimecore.NormalizeMobileProjectionKinds(payload.Subscriptions)
	state.paired = true
	state.ready = true
	if err := writeMobileRelayServerHello(conn, state); err != nil {
		return false
	}
	return writeMobileRelaySnapshot(conn, state, s.manager, state.subscriptions)
}

func (s *Server) handleMobileRelayEncryptedMessage(conn *websocketConn, state *mobileRelayConnectionState, message mobileRelayClientMessage) bool {
	if state.crypto == nil {
		_ = writeMobileRelayError(conn, state, "crypto_required", "encrypted message received before crypto handshake")
		return true
	}
	var envelope relayCryptoEnvelope
	if !decodeMobileRelayPayload(conn, state, message.Payload, &envelope) {
		return true
	}
	content, err := state.crypto.decrypt(envelope)
	if err != nil {
		_ = writeMobileRelayError(conn, state, "decrypt_failed", err.Error())
		return true
	}
	var inner mobileRelayClientMessage
	if err := decodeMobileRelayJSON(content, &inner); err != nil {
		_ = writeMobileRelayError(conn, state, "decrypt_failed", "encrypted payload is not a relay message")
		return true
	}
	if inner.Type == "encrypted" || inner.Type == "crypto.handshake" {
		_ = writeMobileRelayError(conn, state, "invalid_encrypted_message", "nested relay crypto control messages are not allowed")
		return true
	}
	return s.handleMobileRelayClientMessage(conn, state, inner)
}

func (s *Server) handleMobileRelayHello(conn *websocketConn, state *mobileRelayConnectionState, message mobileRelayClientMessage) bool {
	var payload clientHelloPayload
	if !decodeMobileRelayPayload(conn, state, message.Payload, &payload) {
		return true
	}
	state.subscriptions = runtimecore.NormalizeMobileProjectionKinds(payload.Subscriptions)
	state.deviceID = strings.TrimSpace(payload.Device.DeviceID)
	if state.deviceID == "" || strings.TrimSpace(payload.PairingSecretRef) == "" {
		_ = writeMobileRelayError(conn, state, "pairing_required", "client.hello requires a paired device and pairing secret")
		return false
	}
	if _, ok := s.manager.TouchMobileRelayPairing(state.deviceID, payload.PairingSecretRef); !ok {
		_ = writeMobileRelayError(conn, state, "pairing_failed", "pairing secret was not accepted")
		return false
	}
	state.paired = true
	state.ready = true
	if err := writeMobileRelayServerHello(conn, state); err != nil {
		return false
	}
	return writeMobileRelaySnapshot(conn, state, s.manager, state.subscriptions)
}

func (s *Server) handleMobileRelayPairStart(conn *websocketConn, state *mobileRelayConnectionState, message mobileRelayClientMessage) bool {
	var payload pairStartPayload
	if !decodeMobileRelayPayload(conn, state, message.Payload, &payload) {
		return true
	}
	record, err := s.manager.PairMobileRelayDevice(runtimecore.PairMobileRelayDeviceRequest{
		Endpoint:    payload.Endpoint,
		PairingCode: payload.PairingCode,
		Device:      payload.Device,
	})
	if err != nil {
		_ = writeMobileRelayMessage(conn, state, "pair.rejected", map[string]string{"reason": err.Error()})
		return true
	}
	if err := writeMobileRelayMessage(conn, state, "pair.accepted", map[string]interface{}{
		"endpoint":         record.Endpoint,
		"relayId":          record.RelayID,
		"workspaceName":    record.WorkspaceName,
		"pairingSecretRef": record.PairingSecretRef,
	}); err != nil {
		return false
	}
	return true
}

func (s *Server) handleMobileRelayProjectionSubscribe(conn *websocketConn, state *mobileRelayConnectionState, message mobileRelayClientMessage) bool {
	var payload projectionSubscribePayload
	if !decodeMobileRelayPayload(conn, state, message.Payload, &payload) {
		return true
	}
	state.subscriptions = runtimecore.NormalizeMobileProjectionKinds(payload.Projections)
	state.ready = true
	return writeMobileRelaySnapshot(conn, state, s.manager, state.subscriptions)
}

func (s *Server) handleMobileRelayTerminalInput(conn *websocketConn, state *mobileRelayConnectionState, message mobileRelayClientMessage) bool {
	var payload terminalInputPayload
	if !decodeMobileRelayPayload(conn, state, message.Payload, &payload) {
		return true
	}
	err := s.manager.WriteSession(payload.SessionID, runtimecore.SessionInputRequest{Text: payload.Data})
	if err != nil {
		_ = writeMobileRelayError(conn, state, "terminal_input_failed", err.Error())
	}
	return true
}

func (s *Server) handleMobileRelayBrowserCommand(conn *websocketConn, state *mobileRelayConnectionState, message mobileRelayClientMessage) bool {
	var payload browserCommandPayload
	if !decodeMobileRelayPayload(conn, state, message.Payload, &payload) {
		return true
	}
	command := strings.TrimSpace(payload.Command)
	if command != "goto" && command != "reload" && command != "goBack" && command != "goForward" && command != "stop" && command != "screenshot" {
		_ = writeMobileRelayError(conn, state, "browser_command_failed", "unsupported browser command")
		return true
	}
	actionPayload := map[string]interface{}{}
	if url := strings.TrimSpace(payload.URL); url != "" {
		actionPayload["url"] = url
	}
	_, err := s.manager.QueueBrowserCommand(
		strings.TrimSpace(payload.TabID),
		runtimecore.BrowserCommandRequest{
			Command: command,
			Payload: actionPayload,
		},
	)
	if err != nil {
		_ = writeMobileRelayError(conn, state, "browser_command_failed", err.Error())
	}
	return true
}

func (s *Server) handleMobileRelayFileRead(conn *websocketConn, state *mobileRelayConnectionState, message mobileRelayClientMessage) bool {
	var payload fileReadPayload
	if !decodeMobileRelayPayload(conn, state, message.Payload, &payload) {
		return true
	}
	content, err := s.manager.ReadFile(runtimecore.ReadFileRequest{
		ProjectID:  payload.ProjectID,
		WorktreeID: payload.WorktreeID,
		Path:       payload.Path,
		MaxBytes:   payload.MaxBytes,
	})
	if err != nil {
		_ = writeMobileRelayRequestError(conn, state, "file_read_failed", err.Error(), message.ID)
		return true
	}
	_ = writeMobileRelayMessage(conn, state, "file.content", map[string]interface{}{
		"requestId": message.ID,
		"content":   content,
	})
	return true
}

func (s *Server) handleMobileRelayFileWrite(conn *websocketConn, state *mobileRelayConnectionState, message mobileRelayClientMessage) bool {
	var payload fileWritePayload
	if !decodeMobileRelayPayload(conn, state, message.Payload, &payload) {
		return true
	}
	content, err := s.manager.WriteFile(runtimecore.WriteFileRequest{
		ProjectID:  payload.ProjectID,
		WorktreeID: payload.WorktreeID,
		Path:       payload.Path,
		Content:    payload.Content,
		CreateDirs: payload.CreateDirs,
	})
	if err != nil {
		_ = writeMobileRelayRequestError(conn, state, "file_write_failed", err.Error(), message.ID)
		return true
	}
	_ = writeMobileRelayMessage(conn, state, "file.content", map[string]interface{}{
		"requestId": message.ID,
		"content":   content,
	})
	return true
}

func (s *Server) handleMobileRelayHeartbeat(conn *websocketConn, state *mobileRelayConnectionState, message mobileRelayClientMessage) bool {
	var payload heartbeatPayload
	if !decodeMobileRelayPayload(conn, state, message.Payload, &payload) {
		return true
	}
	if payload.SentAt == "" {
		payload.SentAt = time.Now().UTC().Format(time.RFC3339Nano)
	}
	_ = writeMobileRelayMessage(conn, state, "heartbeat", payload)
	return true
}

func decodeMobileRelayPayload(conn *websocketConn, state *mobileRelayConnectionState, raw json.RawMessage, target interface{}) bool {
	if err := decodeMobileRelayJSON(raw, target); err != nil {
		_ = writeMobileRelayError(conn, state, "invalid_payload", err.Error())
		return false
	}
	return true
}

func decodeMobileRelayJSON(raw []byte, target interface{}) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var extra interface{}
	if err := decoder.Decode(&extra); err != nil {
		if errors.Is(err, io.EOF) {
			return nil
		}
		return err
	}
	return errors.New("JSON payload must contain exactly one value")
}

func writeMobileRelaySnapshot(conn *websocketConn, state *mobileRelayConnectionState, manager *runtimecore.Manager, subscriptions []runtimecore.ProjectionKind) bool {
	snapshot := manager.MobileRelaySnapshot(subscriptions, 200)
	return writeMobileRelayMessage(conn, state, "projection.snapshot", snapshot) == nil
}

func writeMobileRelayServerHello(conn *websocketConn, state *mobileRelayConnectionState) error {
	return writeMobileRelayMessage(conn, state, "server.hello", map[string]interface{}{
		"relayId":               state.relayID,
		"workspaceName":         "",
		"acceptedSubscriptions": state.subscriptions,
	})
}

func writeMobileRelayError(conn *websocketConn, state *mobileRelayConnectionState, code string, message string) error {
	return writeMobileRelayMessage(conn, state, "error", map[string]string{
		"code":    code,
		"message": message,
	})
}

func writeMobileRelayRequestError(conn *websocketConn, state *mobileRelayConnectionState, code string, message string, requestID string) error {
	payload := map[string]string{
		"code":    code,
		"message": message,
	}
	if strings.TrimSpace(requestID) != "" {
		payload["requestId"] = requestID
	}
	return writeMobileRelayMessage(conn, state, "error", payload)
}

func writeMobileRelayMessage(conn *websocketConn, state *mobileRelayConnectionState, messageType string, payload interface{}) error {
	message := mobileRelayServerMessage{
		Version: runtimecore.MobileRelayProtocolVersion,
		ID:      relayMessageID(messageType),
		Type:    messageType,
		Payload: payload,
	}
	if state != nil && state.crypto != nil && shouldEncryptMobileRelayServerMessage(messageType) {
		return writeEncryptedMobileRelayMessage(conn, state, message)
	}
	return writePlainMobileRelayServerMessage(conn, message)
}

func writePlainMobileRelayMessage(conn *websocketConn, messageType string, payload interface{}) error {
	return writePlainMobileRelayServerMessage(conn, mobileRelayServerMessage{
		Version: runtimecore.MobileRelayProtocolVersion,
		ID:      relayMessageID(messageType),
		Type:    messageType,
		Payload: payload,
	})
}

func writePlainMobileRelayServerMessage(conn *websocketConn, message mobileRelayServerMessage) error {
	content, err := json.Marshal(message)
	if err != nil {
		return err
	}
	return conn.writeText(string(content))
}

func writeEncryptedMobileRelayMessage(conn *websocketConn, state *mobileRelayConnectionState, message mobileRelayServerMessage) error {
	content, err := json.Marshal(message)
	if err != nil {
		return err
	}
	envelope, err := state.crypto.encrypt(content)
	if err != nil {
		return err
	}
	return writePlainMobileRelayMessage(conn, "encrypted", envelope)
}

func shouldEncryptMobileRelayServerMessage(messageType string) bool {
	switch messageType {
	case "crypto.ready", "pair.rejected":
		return false
	default:
		return true
	}
}

func relayMessageID(messageType string) string {
	prefix := strings.ReplaceAll(messageType, ".", "-")
	return fmt.Sprintf("%s-%d", prefix, time.Now().UTC().UnixNano())
}
