package runtimehttp

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
)

type localTerminalStreamFixture struct {
	manager *runtimecore.Manager
	session runtimecore.Session
	conn    *websocketConn
	rawConn net.Conn
}

func startLocalTerminalStreamFixture(t *testing.T) localTerminalStreamFixture {
	t.Helper()
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
		Cwd:       project.Path,
		Command:   []string{"/bin/sh"},
		Cols:      90,
		Rows:      30,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = manager.StopSession(session.ID) })
	server := httptest.NewServer(NewServer(manager))
	t.Cleanup(server.Close)
	rawConn, reader := dialLocalTerminalStream(t, server.URL, "")
	t.Cleanup(func() { _ = rawConn.Close() })
	return localTerminalStreamFixture{
		manager: manager,
		session: session,
		conn:    &websocketConn{conn: rawConn, reader: reader},
		rawConn: rawConn,
	}
}

// dialLocalTerminalStream offers the endpoint's subprotocol the way a browser
// does, since that is the only field a page can set at upgrade.
func dialLocalTerminalStream(t *testing.T, serverURL string, token string) (net.Conn, *bufio.Reader) {
	t.Helper()
	response, conn, reader := requestLocalTerminalStreamUpgrade(t, serverURL, token)
	if response.StatusCode != http.StatusSwitchingProtocols {
		_ = conn.Close()
		t.Fatalf("expected websocket upgrade, got %d", response.StatusCode)
	}
	if response.Header.Get("Sec-WebSocket-Protocol") != localTerminalStreamProtocol {
		_ = conn.Close()
		t.Fatalf("server did not echo the offered subprotocol: %q", response.Header.Get("Sec-WebSocket-Protocol"))
	}
	return conn, reader
}

func requestLocalTerminalStreamUpgrade(
	t *testing.T,
	serverURL string,
	token string,
) (*http.Response, net.Conn, *bufio.Reader) {
	t.Helper()
	parsed, err := url.Parse(serverURL)
	if err != nil {
		t.Fatal(err)
	}
	conn, err := net.Dial("tcp", parsed.Host)
	if err != nil {
		t.Fatal(err)
	}
	protocols := localTerminalStreamProtocol
	if token != "" {
		protocols += ", " + localTerminalStreamTokenPrefix + token
	}
	key := base64.StdEncoding.EncodeToString([]byte("abcdefghijklmnop"))
	_, err = fmt.Fprintf(
		conn,
		"GET %s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"+
			"Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: %s\r\n\r\n",
		localTerminalStreamPath, parsed.Host, key, protocols,
	)
	if err != nil {
		_ = conn.Close()
		t.Fatal(err)
	}
	reader := bufio.NewReader(conn)
	response, err := http.ReadResponse(reader, &http.Request{Method: http.MethodGet})
	if err != nil {
		_ = conn.Close()
		t.Fatal(err)
	}
	return response, conn, reader
}

func (f localTerminalStreamFixture) subscribe(
	t *testing.T,
	streamID uint32,
	terminalID string,
	streamOutput bool,
) {
	t.Helper()
	payload, err := json.Marshal(map[string]interface{}{
		"terminal": terminalID,
		"output":   streamOutput,
	})
	if err != nil {
		t.Fatal(err)
	}
	f.writeFrame(t, terminalStreamFrame{
		Opcode:   terminalStreamSubscribe,
		StreamID: streamID,
		Payload:  payload,
	})
}

func (f localTerminalStreamFixture) writeFrame(t *testing.T, frame terminalStreamFrame) {
	t.Helper()
	if err := writeMaskedFrame(f.rawConn, true, websocketBinaryOpcode, encodeTerminalStreamFrame(frame)); err != nil {
		t.Fatal(err)
	}
}

func (f localTerminalStreamFixture) readFrame(t *testing.T) terminalStreamFrame {
	t.Helper()
	if err := f.rawConn.SetReadDeadline(time.Now().Add(10 * time.Second)); err != nil {
		t.Fatal(err)
	}
	opcode, payload, err := f.conn.readMessage(false)
	if err != nil {
		t.Fatal(err)
	}
	if opcode != websocketBinaryOpcode {
		t.Fatalf("expected a binary frame, got opcode %d", opcode)
	}
	frame, err := decodeTerminalStreamFrame(payload)
	if err != nil {
		t.Fatal(err)
	}
	return frame
}

func TestLocalTerminalStreamCarriesInputAndOutputAsBinaryFrames(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("terminal stream integration uses /bin/sh")
	}
	fixture := startLocalTerminalStreamFixture(t)
	fixture.subscribe(t, 3, fixture.session.ID, true)

	acknowledged := fixture.readFrame(t)
	if acknowledged.Opcode != terminalStreamMetadata || acknowledged.StreamID != 3 {
		t.Fatalf("expected a subscribe acknowledgement on stream 3, got %#v", acknowledged)
	}
	var ack map[string]string
	if err := json.Unmarshal(acknowledged.Payload, &ack); err != nil {
		t.Fatal(err)
	}
	if ack["type"] != "subscribed" {
		t.Fatalf("expected a subscribed acknowledgement, got %#v", ack)
	}

	fixture.writeFrame(t, terminalStreamFrame{
		Opcode:   terminalStreamInput,
		StreamID: 3,
		Payload:  []byte("echo pebble-direct-socket\n"),
	})

	var output strings.Builder
	for attempts := 0; attempts < 40; attempts++ {
		frame := fixture.readFrame(t)
		if frame.Opcode != terminalStreamOutput {
			continue
		}
		if frame.StreamID != 3 {
			t.Fatalf("output addressed the wrong stream: %#v", frame)
		}
		output.Write(frame.Payload)
		if strings.Contains(output.String(), "pebble-direct-socket") {
			return
		}
	}
	t.Fatalf("input never reached the shell; saw %q", output.String())
}

func TestLocalTerminalStreamWithoutOutputStillDeliversInput(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("terminal stream integration uses /bin/sh")
	}
	fixture := startLocalTerminalStreamFixture(t)
	// Why: while the renderer still receives output on the event channel, a
	// stream that echoed output here too would render every byte twice.
	fixture.subscribe(t, 2, fixture.session.ID, false)
	acknowledged := fixture.readFrame(t)
	if acknowledged.Opcode != terminalStreamMetadata {
		t.Fatalf("expected a subscribe acknowledgement, got %#v", acknowledged)
	}

	fixture.writeFrame(t, terminalStreamFrame{
		Opcode:   terminalStreamInput,
		StreamID: 2,
		Payload:  []byte("echo pebble-input-only\n"),
	})

	// The input must reach the shell even though its output is not streamed back
	// on this socket, so read it from the session's own buffer instead.
	deadline := time.Now().Add(10 * time.Second)
	for {
		tail, err := fixture.manager.TailSession(fixture.session.ID, 200)
		if err != nil {
			t.Fatal(err)
		}
		var seen strings.Builder
		for _, chunk := range tail.Chunks {
			seen.WriteString(chunk.Content)
		}
		if strings.Contains(seen.String(), "pebble-input-only") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("input never reached the shell; saw %q", seen.String())
		}
		time.Sleep(20 * time.Millisecond)
	}

	// Nothing should have arrived on the socket for this stream.
	if err := fixture.rawConn.SetReadDeadline(time.Now().Add(300 * time.Millisecond)); err != nil {
		t.Fatal(err)
	}
	if _, _, err := fixture.conn.readMessage(false); err == nil {
		t.Fatal("expected no output frames on an input-only stream")
	}
}

func TestLocalTerminalStreamIgnoresFramesForUnopenedStreams(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("terminal stream integration uses /bin/sh")
	}
	fixture := startLocalTerminalStreamFixture(t)
	// Why: stream ids are client-allocated, so a frame for an id this connection
	// never opened must be dropped rather than reaching some other session.
	fixture.writeFrame(t, terminalStreamFrame{
		Opcode:   terminalStreamInput,
		StreamID: 99,
		Payload:  []byte("echo leaked\n"),
	})
	fixture.subscribe(t, 1, fixture.session.ID, true)
	acknowledged := fixture.readFrame(t)
	if acknowledged.Opcode != terminalStreamMetadata || acknowledged.StreamID != 1 {
		t.Fatalf("expected the subscribe acknowledgement to be the first frame, got %#v", acknowledged)
	}
}

func TestLocalTerminalStreamReportsUnknownSession(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("terminal stream integration uses /bin/sh")
	}
	fixture := startLocalTerminalStreamFixture(t)
	fixture.subscribe(t, 5, "sess_does_not_exist", true)
	frame := fixture.readFrame(t)
	if frame.Opcode != terminalStreamMetadata || frame.StreamID != 5 {
		t.Fatalf("expected an error acknowledgement on stream 5, got %#v", frame)
	}
	var reported map[string]string
	if err := json.Unmarshal(frame.Payload, &reported); err != nil {
		t.Fatal(err)
	}
	if reported["type"] != "error" {
		t.Fatalf("expected an error acknowledgement, got %#v", reported)
	}
}

func TestLocalTerminalStreamRejectsNonLoopbackPeer(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet, localTerminalStreamPath, nil)
	// Why: the endpoint is unencrypted, so a non-loopback peer must be refused
	// even when the runtime is deliberately bound beyond loopback for mobile.
	request.RemoteAddr = "192.0.2.10:54321"
	request.Header.Set("Upgrade", "websocket")
	request.Header.Set("Connection", "Upgrade")
	recorder := httptest.NewRecorder()
	NewServer(manager).ServeHTTP(recorder, request)
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("expected a non-loopback peer to be refused, got %d", recorder.Code)
	}
}

func TestLocalTerminalStreamRejectsMismatchedToken(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(NewServerWithOptions(manager, ServerOptions{BearerToken: "correct-token"}))
	t.Cleanup(server.Close)

	response, conn, _ := requestLocalTerminalStreamUpgrade(t, server.URL, "wrong-token")
	t.Cleanup(func() { _ = conn.Close() })
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected a mismatched token to be refused, got %d", response.StatusCode)
	}
}

func TestLocalTerminalStreamAcceptsMatchingTokenAndEchoesSubprotocol(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(NewServerWithOptions(manager, ServerOptions{BearerToken: "correct-token"}))
	t.Cleanup(server.Close)

	conn, _ := dialLocalTerminalStream(t, server.URL, "correct-token")
	_ = conn.Close()
}

func TestTerminalStreamFrameMatchesTheRendererGoldenBytes(t *testing.T) {
	// The same vector is asserted in TypeScript by
	// local-terminal-stream-protocol.test.ts. Two hand-written codecs drifting
	// apart is the failure this pair exists to catch, so change both or neither.
	golden := []byte{
		0x74, 0x01, 0x07, 0x00, 0x03, 0x00, 0x00, 0x00,
		0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
		0x68, 0x69,
	}
	encoded := encodeTerminalStreamFrame(terminalStreamFrame{
		Opcode:   terminalStreamInput,
		StreamID: 3,
		Payload:  []byte("hi"),
	})
	if !bytes.Equal(encoded, golden) {
		t.Fatalf("frame layout drifted from the renderer: got %#v", encoded)
	}
}

func TestLocalTerminalStreamTokenReadsTheOfferedSubprotocols(t *testing.T) {
	if got := localTerminalStreamToken("pebble.local-terminal.v1, pebble.token.abc123"); got != "abc123" {
		t.Fatalf("expected the token subprotocol to be read, got %q", got)
	}
	if got := localTerminalStreamToken("pebble.local-terminal.v1"); got != "" {
		t.Fatalf("expected no token when none is offered, got %q", got)
	}
}
