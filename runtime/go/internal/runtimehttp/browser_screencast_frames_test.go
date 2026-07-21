package runtimehttp

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
)

func TestBrowserScreencastFrameIngestKeepsNewestPendingFrame(t *testing.T) {
	server := NewServer(newBrowserScreencastTestManager(t))
	streamID := "browser-screencast:test"
	sink := server.browserScreencasts.register(streamID)
	first := testBrowserScreencastFrame(1)
	second := testBrowserScreencastFrame(2)

	for _, frame := range [][]byte{first, second} {
		request := httptest.NewRequest(http.MethodPost, "/v1/browser/screencasts/"+streamID+"/frames", bytes.NewReader(frame))
		response := httptest.NewRecorder()
		server.ServeHTTP(response, request)
		if response.Code != http.StatusNoContent {
			t.Fatalf("frame ingest returned %d: %s", response.Code, response.Body.String())
		}
	}

	if frame := <-sink.frames; !bytes.Equal(frame, second) {
		t.Fatalf("pending frame was not replaced with newest frame: %v", frame)
	}
}

func TestBrowserScreencastFrameIngestRejectsMalformedOrInactiveFrames(t *testing.T) {
	server := NewServer(newBrowserScreencastTestManager(t))
	for _, testCase := range []struct {
		name   string
		path   string
		frame  []byte
		status int
	}{
		{name: "malformed", path: "/v1/browser/screencasts/active/frames", frame: []byte("json"), status: http.StatusBadRequest},
		{name: "inactive", path: "/v1/browser/screencasts/missing/frames", frame: testBrowserScreencastFrame(1), status: http.StatusNotFound},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, testCase.path, bytes.NewReader(testCase.frame))
			response := httptest.NewRecorder()
			server.ServeHTTP(response, request)
			if response.Code != testCase.status {
				t.Fatalf("got status %d, want %d", response.Code, testCase.status)
			}
		})
	}
}

func testBrowserScreencastFrame(seq byte) []byte {
	frame := make([]byte, 16)
	copy(frame, []byte{0x62, 1, 1, 1, seq})
	return frame
}

func newBrowserScreencastTestManager(t *testing.T) *runtimecore.Manager {
	t.Helper()
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	return manager
}
