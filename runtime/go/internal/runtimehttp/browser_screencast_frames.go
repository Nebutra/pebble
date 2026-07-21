package runtimehttp

import (
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
)

const maxBrowserScreencastFrameBytes int64 = 16 * 1024 * 1024

type browserScreencastFrameSink struct {
	frames chan []byte
}

type browserScreencastFrameRegistry struct {
	mu    sync.RWMutex
	sinks map[string]*browserScreencastFrameSink
}

func newBrowserScreencastFrameRegistry() *browserScreencastFrameRegistry {
	return &browserScreencastFrameRegistry{sinks: make(map[string]*browserScreencastFrameSink)}
}

func (registry *browserScreencastFrameRegistry) register(streamID string) *browserScreencastFrameSink {
	sink := &browserScreencastFrameSink{frames: make(chan []byte, 1)}
	registry.mu.Lock()
	registry.sinks[streamID] = sink
	registry.mu.Unlock()
	return sink
}

func (registry *browserScreencastFrameRegistry) unregister(streamID string, sink *browserScreencastFrameSink) {
	registry.mu.Lock()
	if registry.sinks[streamID] == sink {
		delete(registry.sinks, streamID)
	}
	registry.mu.Unlock()
}

func (registry *browserScreencastFrameRegistry) deliver(streamID string, frame []byte) bool {
	registry.mu.RLock()
	sink := registry.sinks[streamID]
	registry.mu.RUnlock()
	if sink == nil {
		return false
	}
	// Why: remote rendering needs the newest frame, not an unbounded backlog;
	// replacing the single pending frame propagates client backpressure.
	select {
	case sink.frames <- frame:
	default:
		select {
		case <-sink.frames:
		default:
		}
		sink.frames <- frame
	}
	return true
}

func (s *Server) handleBrowserScreencastFrame(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if !strings.HasSuffix(r.URL.Path, "/frames") {
		writeError(w, http.StatusNotFound, "browser screencast endpoint was not found")
		return
	}
	encoded := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/v1/browser/screencasts/"), "/frames")
	streamID, err := url.PathUnescape(strings.Trim(encoded, "/"))
	if err != nil || streamID == "" || len(streamID) > 256 {
		writeError(w, http.StatusBadRequest, "invalid browser screencast stream id")
		return
	}
	frame, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBrowserScreencastFrameBytes))
	if err != nil || !validBrowserScreencastFrame(frame) {
		writeError(w, http.StatusBadRequest, "invalid browser screencast frame")
		return
	}
	if !s.browserScreencasts.deliver(streamID, frame) {
		writeError(w, http.StatusNotFound, "browser screencast is not active")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func validBrowserScreencastFrame(frame []byte) bool {
	return len(frame) >= 16 && frame[0] == 0x62 && frame[1] == 1 && frame[2] == 1 && (frame[3] == 1 || frame[3] == 2)
}
