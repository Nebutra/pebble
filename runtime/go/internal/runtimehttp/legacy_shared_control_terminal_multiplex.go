package runtimehttp

import (
	"encoding/json"
	"strings"

	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
)

// terminal.multiplex carries every terminal of one client over a single
// subscription: the client allocates the stream ids and opens each terminal
// with a Subscribe control frame, instead of one RPC subscription per pane.

const legacySharedControlMultiplexSubscriptionID = "terminal-multiplex"

const legacySharedControlMultiplexSnapshotRows = 2000

type legacySharedControlMultiplexStream struct {
	TerminalID string
	ClientID   string
	Source     runtimecore.SessionInputSource
}

type legacySharedControlMultiplex struct {
	streams map[uint32]legacySharedControlMultiplexStream
}

func (s *Server) startLegacySharedControlTerminalMultiplex(conn *websocketConn, sharedKey *[32]byte, request legacySharedControlRequest, subscriptions map[string]legacySharedControlSubscription) {
	// Why: the renderer keeps one multiplexer per environment, so a second
	// terminal.multiplex is a reconnect whose predecessor's streams are gone.
	subscriptions[legacySharedControlMultiplexSubscriptionID] = legacySharedControlSubscription{
		RequestID:      request.ID,
		SubscriptionID: legacySharedControlMultiplexSubscriptionID,
		Kind:           "terminal.multiplex",
		Binary:         true,
		Multiplex:      &legacySharedControlMultiplex{streams: make(map[uint32]legacySharedControlMultiplexStream)},
	}
	// The client blocks every stream on this handshake, so it must precede any
	// stream traffic on the subscription.
	_ = s.writeLegacySharedControlSuccess(conn, sharedKey, request.ID, map[string]string{"type": "ready"}, true)
}

// handleLegacySharedControlMultiplexFrame reports whether the frame belonged to
// the multiplex subscription, so unclaimed stream ids can still fall through to
// the single-terminal subscriptions that number streams from the same space.
func (s *Server) handleLegacySharedControlMultiplexFrame(conn *websocketConn, sharedKey *[32]byte, frame terminalStreamFrame, device runtimecore.LegacySharedControlDevice, subscriptions map[string]legacySharedControlSubscription) bool {
	subscription, found := subscriptions[legacySharedControlMultiplexSubscriptionID]
	if !found || subscription.Multiplex == nil {
		return false
	}
	if frame.Opcode == terminalStreamSubscribe {
		s.openLegacySharedControlMultiplexStream(conn, sharedKey, subscription, device, frame.Payload)
		return true
	}
	stream, open := subscription.Multiplex.streams[frame.StreamID]
	if !open {
		return false
	}
	switch frame.Opcode {
	case terminalStreamInput:
		if len(frame.Payload) > 0 {
			_ = s.manager.WriteSessionFromClient(stream.TerminalID, runtimecore.SessionInputRequest{Text: string(frame.Payload), Source: string(stream.Source)}, stream.Source, stream.ClientID)
		}
	case terminalStreamResize:
		var viewport struct {
			Cols int `json:"cols"`
			Rows int `json:"rows"`
		}
		if json.Unmarshal(frame.Payload, &viewport) == nil && viewport.Cols > 0 && viewport.Rows > 0 {
			_, _ = s.manager.ResizeSession(stream.TerminalID, runtimecore.SessionResizeRequest{Cols: viewport.Cols, Rows: viewport.Rows, ClientID: stream.ClientID, Source: string(stream.Source)})
		}
	case terminalStreamSnapshotRequest:
		s.writeLegacySharedControlMultiplexSnapshotRequest(conn, sharedKey, frame.StreamID, stream.TerminalID, frame.Payload)
	case terminalStreamUnsubscribe:
		delete(subscription.Multiplex.streams, frame.StreamID)
	}
	return true
}

func (s *Server) openLegacySharedControlMultiplexStream(conn *websocketConn, sharedKey *[32]byte, subscription legacySharedControlSubscription, device runtimecore.LegacySharedControlDevice, payload []byte) {
	var params struct {
		StreamID uint32 `json:"streamId"`
		Terminal string `json:"terminal"`
		Client   struct {
			ID   string `json:"id"`
			Type string `json:"type"`
		} `json:"client"`
		Viewport struct {
			Cols int `json:"cols"`
			Rows int `json:"rows"`
		} `json:"viewport"`
	}
	if json.Unmarshal(payload, &params) != nil || params.StreamID == 0 || strings.TrimSpace(params.Terminal) == "" {
		return
	}
	if _, err := s.manager.SessionStatus(params.Terminal); err != nil {
		_ = s.writeLegacySharedControlSuccess(conn, sharedKey, subscription.RequestID, map[string]interface{}{"type": "error", "streamId": params.StreamID, "message": err.Error()}, true)
		return
	}
	// Why: a desktop-sourced write is refused while a mobile client drives the
	// session, so the client's own claim decides which side of the lock it is on.
	source := runtimecore.SessionInputSourceMobile
	if params.Client.Type == "desktop" {
		source = runtimecore.SessionInputSourceDesktop
	}
	clientID := strings.TrimSpace(params.Client.ID)
	if clientID == "" {
		clientID = device.DeviceID
	}
	subscription.Multiplex.streams[params.StreamID] = legacySharedControlMultiplexStream{TerminalID: params.Terminal, ClientID: clientID, Source: source}
	_ = s.writeLegacySharedControlSuccess(conn, sharedKey, subscription.RequestID, map[string]interface{}{"type": "subscribed", "streamId": params.StreamID}, true)
	if tail, err := s.manager.TailSession(params.Terminal, legacySharedControlMultiplexSnapshotRows); err == nil {
		s.writeLegacySharedControlTerminalSnapshot(conn, sharedKey, legacySharedControlSnapshotTarget{TerminalID: params.Terminal, StreamID: params.StreamID, Kind: "scrollback"}, tail.Chunks)
	}
	// Resizing after the snapshot keeps the reflow it provokes as live output
	// appended to the replay rather than as history the client never asked for.
	if params.Viewport.Cols > 0 && params.Viewport.Rows > 0 {
		_, _ = s.manager.ResizeSession(params.Terminal, runtimecore.SessionResizeRequest{Cols: params.Viewport.Cols, Rows: params.Viewport.Rows, ClientID: clientID, Source: string(source)})
	}
}

func (s *Server) writeLegacySharedControlMultiplexSnapshotRequest(conn *websocketConn, sharedKey *[32]byte, streamID uint32, terminalID string, payload []byte) {
	var params struct {
		RequestID      int `json:"requestId"`
		ScrollbackRows int `json:"scrollbackRows"`
	}
	_ = json.Unmarshal(payload, &params)
	rows := params.ScrollbackRows
	if rows <= 0 {
		rows = legacySharedControlMultiplexSnapshotRows
	}
	tail, err := s.manager.TailSession(terminalID, rows)
	if err != nil {
		// The client settles a pending snapshot promise on this frame, so a
		// failed read must be reported rather than left to time out.
		_ = writeLegacySharedControlBinary(conn, sharedKey, terminalStreamFrame{Opcode: terminalStreamError, StreamID: streamID, Payload: []byte(err.Error())})
		return
	}
	requestID := params.RequestID
	s.writeLegacySharedControlTerminalSnapshot(conn, sharedKey, legacySharedControlSnapshotTarget{TerminalID: terminalID, StreamID: streamID, Kind: "request", RequestID: &requestID}, tail.Chunks)
}

func (s *Server) writeLegacySharedControlMultiplexEvent(conn *websocketConn, sharedKey *[32]byte, subscription legacySharedControlSubscription, event runtimecore.RuntimeEvent) {
	if subscription.Multiplex == nil {
		return
	}
	switch event.Topic {
	case "session.output":
		sessionID, chunk := legacySharedControlOutputEvent(event)
		if sessionID == "" || chunk == "" {
			return
		}
		for streamID, stream := range subscription.Multiplex.streams {
			if stream.TerminalID != sessionID {
				continue
			}
			for _, frame := range legacySharedControlTerminalOutputFrames(streamID, uint64(event.Timestamp.UnixNano()), []byte(chunk)) {
				_ = writeLegacySharedControlBinary(conn, sharedKey, frame)
			}
		}
	case "session.status":
		session, valid := legacySharedControlSessionEvent(event)
		if !valid || (session.Status != runtimecore.SessionExited && session.Status != runtimecore.SessionFailed && session.Status != runtimecore.SessionStopped) {
			// Why: unlike the mobile single-terminal stream, a multiplex client
			// owns a live emulator and reflows itself, so a running session's
			// status change must not replace its buffer with a fresh snapshot.
			return
		}
		for streamID, stream := range subscription.Multiplex.streams {
			if stream.TerminalID != session.ID {
				continue
			}
			delete(subscription.Multiplex.streams, streamID)
			_ = s.writeLegacySharedControlSuccess(conn, sharedKey, subscription.RequestID, map[string]interface{}{"type": "end", "streamId": streamID}, true)
		}
	case "session.driver":
		sessionID, driver, valid := legacySharedControlDriverEvent(event)
		if !valid {
			return
		}
		for streamID, stream := range subscription.Multiplex.streams {
			if stream.TerminalID != sessionID {
				continue
			}
			_ = s.writeLegacySharedControlSuccess(conn, sharedKey, subscription.RequestID, map[string]interface{}{"type": "driver-changed", "streamId": streamID, "driver": driver}, true)
		}
	}
}

func legacySharedControlDriverEvent(event runtimecore.RuntimeEvent) (string, runtimecore.SessionDriverState, bool) {
	encoded, err := json.Marshal(event.Payload)
	if err != nil {
		return "", runtimecore.SessionDriverState{}, false
	}
	var payload struct {
		SessionID string                         `json:"sessionId"`
		Driver    runtimecore.SessionDriverState `json:"driver"`
	}
	if json.Unmarshal(encoded, &payload) != nil || payload.SessionID == "" || payload.Driver.Kind == "" {
		return "", runtimecore.SessionDriverState{}, false
	}
	return payload.SessionID, payload.Driver, true
}
