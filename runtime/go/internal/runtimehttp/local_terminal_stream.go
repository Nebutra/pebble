package runtimehttp

import (
	"crypto/subtle"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
)

// Why: the desktop renderer reached its own PTY through the app's JS bridge —
// invoke(JSON) to the host, HTTP to the runtime, an event channel back — five
// crossings and four JSON encodes for every keystroke. Remote clients already
// stream terminals as binary frames over one socket; this is that same
// transport for the one path still going through the bridge.
//
// This endpoint is unencrypted, so loopback is enforced here rather than
// inferred from the bind address: the runtime can be configured to listen
// beyond loopback for mobile and remote clients.

const localTerminalStreamPath = "/v1/terminal-stream"
const localTerminalStreamProtocol = "pebble.local-terminal.v1"
const localTerminalStreamTokenPrefix = "pebble.token."
const localTerminalStreamEventBuffer = 256
const localTerminalStreamFrameBuffer = 32

type localTerminalStream struct {
	terminalID string
	// Output delivery is opt-in per stream. The renderer moves its input path to
	// this socket before its output path, and while output still arrives on the
	// event channel a stream that also echoed it here would render every byte
	// twice.
	streamOutput bool
}

func (s *Server) handleLocalTerminalStream(w http.ResponseWriter, r *http.Request) {
	if !requestFromLoopback(r) {
		writeError(w, http.StatusForbidden, "local terminal stream is loopback-only")
		return
	}
	if !s.authorizeLocalTerminalStream(r) {
		writeError(w, http.StatusUnauthorized, "missing or invalid bearer token")
		return
	}
	conn, err := upgradeWebSocketWithProtocol(w, r, localTerminalStreamProtocol)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	defer func() { _ = conn.close() }()
	s.serveLocalTerminalStream(conn)
}

func (s *Server) authorizeLocalTerminalStream(r *http.Request) bool {
	if s.bearerToken == "" {
		return true
	}
	token := localTerminalStreamToken(r.Header.Get("Sec-WebSocket-Protocol"))
	if len(token) != len(s.bearerToken) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(token), []byte(s.bearerToken)) == 1
}

func localTerminalStreamToken(header string) string {
	for _, part := range strings.Split(header, ",") {
		value := strings.TrimSpace(part)
		if strings.HasPrefix(value, localTerminalStreamTokenPrefix) {
			return strings.TrimPrefix(value, localTerminalStreamTokenPrefix)
		}
	}
	return ""
}

func (s *Server) serveLocalTerminalStream(conn *websocketConn) {
	// Closing done unblocks the reader if it is parked on a send after this loop
	// has already returned, which would otherwise leak it for the process's life.
	done := make(chan struct{})
	defer close(done)
	incoming := make(chan terminalStreamFrame, localTerminalStreamFrameBuffer)
	failures := make(chan error, 1)
	go readLocalTerminalStreamFrames(conn, incoming, failures, done)

	subscriberID, events := s.manager.Subscribe(localTerminalStreamEventBuffer)
	defer s.manager.Unsubscribe(subscriberID)

	streams := make(map[uint32]localTerminalStream)
	for {
		select {
		case frame, open := <-incoming:
			if !open {
				return
			}
			s.handleLocalTerminalStreamFrame(conn, frame, streams)
		case event, open := <-events:
			if !open {
				return
			}
			s.writeLocalTerminalStreamEvent(conn, streams, event)
		case <-failures:
			return
		}
	}
}

func readLocalTerminalStreamFrames(
	conn *websocketConn,
	incoming chan<- terminalStreamFrame,
	failures chan<- error,
	done <-chan struct{},
) {
	defer close(incoming)
	for {
		// Browsers always mask, so an unmasked client frame is not a peer we serve.
		opcode, payload, err := conn.readMessage(true)
		if err != nil {
			failures <- err
			return
		}
		if opcode != websocketBinaryOpcode {
			continue
		}
		frame, err := decodeTerminalStreamFrame(payload)
		if err != nil {
			continue
		}
		select {
		case incoming <- frame:
		case <-done:
			return
		}
	}
}

func (s *Server) handleLocalTerminalStreamFrame(
	conn *websocketConn,
	frame terminalStreamFrame,
	streams map[uint32]localTerminalStream,
) {
	if frame.Opcode == terminalStreamSubscribe {
		s.openLocalTerminalStream(conn, frame, streams)
		return
	}
	stream, open := streams[frame.StreamID]
	if !open {
		return
	}
	switch frame.Opcode {
	case terminalStreamInput:
		if len(frame.Payload) == 0 {
			return
		}
		_ = s.manager.WriteSessionFromClient(
			stream.terminalID,
			runtimecore.SessionInputRequest{
				Text:   string(frame.Payload),
				Source: string(runtimecore.SessionInputSourceDesktop),
			},
			runtimecore.SessionInputSourceDesktop,
			"",
		)
	case terminalStreamResize:
		s.resizeLocalTerminalStream(stream, frame.Payload)
	case terminalStreamUnsubscribe:
		delete(streams, frame.StreamID)
	}
}

func (s *Server) resizeLocalTerminalStream(stream localTerminalStream, payload []byte) {
	var viewport struct {
		Cols int `json:"cols"`
		Rows int `json:"rows"`
	}
	if json.Unmarshal(payload, &viewport) != nil || viewport.Cols <= 0 || viewport.Rows <= 0 {
		return
	}
	// Presence-lock defense-in-depth, matching the HTTP resize route: while a
	// mobile client drives the session, desktop resizes must not reach the PTY.
	if !s.manager.SessionResizeAllowedFor(stream.terminalID, runtimecore.SessionInputSourceDesktop) {
		return
	}
	_, _ = s.manager.ResizeSession(stream.terminalID, runtimecore.SessionResizeRequest{
		Cols:   viewport.Cols,
		Rows:   viewport.Rows,
		Source: string(runtimecore.SessionInputSourceDesktop),
	})
}

func (s *Server) openLocalTerminalStream(
	conn *websocketConn,
	frame terminalStreamFrame,
	streams map[uint32]localTerminalStream,
) {
	var params struct {
		Terminal string `json:"terminal"`
		Output   bool   `json:"output"`
	}
	if frame.StreamID == 0 || json.Unmarshal(frame.Payload, &params) != nil {
		return
	}
	terminalID := strings.TrimSpace(params.Terminal)
	if terminalID == "" {
		return
	}
	if _, err := s.manager.SessionStatus(terminalID); err != nil {
		writeLocalTerminalStreamMetadata(conn, frame.StreamID, map[string]string{
			"type":    "error",
			"message": err.Error(),
		})
		return
	}
	streams[frame.StreamID] = localTerminalStream{terminalID: terminalID, streamOutput: params.Output}
	// The client holds its first write until this lands, so it must precede any
	// output on the stream.
	writeLocalTerminalStreamMetadata(conn, frame.StreamID, map[string]string{"type": "subscribed"})
}

func (s *Server) writeLocalTerminalStreamEvent(
	conn *websocketConn,
	streams map[uint32]localTerminalStream,
	event runtimecore.RuntimeEvent,
) {
	switch event.Topic {
	case "session.output":
		sessionID, chunk := legacySharedControlOutputEvent(event)
		if sessionID == "" || chunk == "" {
			return
		}
		for streamID, stream := range streams {
			if stream.terminalID != sessionID || !stream.streamOutput {
				continue
			}
			frames := legacySharedControlTerminalOutputFrames(
				streamID,
				uint64(event.Timestamp.UnixNano()),
				[]byte(chunk),
			)
			for _, frame := range frames {
				_ = writeLocalTerminalStreamFrame(conn, frame)
			}
		}
	case "session.status":
		session, valid := legacySharedControlSessionEvent(event)
		if !valid || !isTerminalSessionStatusFinal(session.Status) {
			return
		}
		for streamID, stream := range streams {
			if stream.terminalID != session.ID {
				continue
			}
			delete(streams, streamID)
			writeLocalTerminalStreamMetadata(conn, streamID, map[string]string{"type": "exited"})
		}
	}
}

func isTerminalSessionStatusFinal(status runtimecore.SessionStatus) bool {
	return status == runtimecore.SessionExited ||
		status == runtimecore.SessionFailed ||
		status == runtimecore.SessionStopped
}

func writeLocalTerminalStreamMetadata(conn *websocketConn, streamID uint32, payload map[string]string) {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return
	}
	_ = writeLocalTerminalStreamFrame(conn, terminalStreamFrame{
		Opcode:   terminalStreamMetadata,
		StreamID: streamID,
		Payload:  encoded,
	})
}

func writeLocalTerminalStreamFrame(conn *websocketConn, frame terminalStreamFrame) error {
	return conn.writeBinary(encodeTerminalStreamFrame(frame))
}
