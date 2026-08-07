package runtimecore

import (
	"testing"
	"time"
)

// benchmarkChunk mimics one 4 KB PTY read. lineWidth 0 stands for the
// single-long-line worst case (a progress bar, a minified log, `cat` of a blob);
// a positive width stands for ordinary line-oriented command output.
func benchmarkChunk(lineWidth int) string {
	raw := make([]byte, 4096)
	for i := range raw {
		if lineWidth > 0 && i%lineWidth == lineWidth-1 {
			raw[i] = '\n'
			continue
		}
		raw[i] = byte('a' + i%26)
	}
	return string(raw)
}

// benchmarkSession builds a session whose output ring is already saturated,
// which is the state every long-lived terminal reaches within a few seconds of
// real output — and the state the append hot path has to stay cheap in.
func benchmarkSession(b *testing.B, content string) *processSession {
	b.Helper()
	started := time.Now().UTC()
	session := &processSession{
		id:           "sess-bench",
		projectID:    "proj-bench",
		worktreeID:   "wt-bench",
		cwd:          "/tmp/bench",
		command:      []string{"/bin/bash", "-l"},
		status:       SessionRunning,
		startedAt:    started,
		updatedAt:    started,
		cols:         120,
		rows:         40,
		output:       make([]OutputChunk, 0, 256),
		screen:       newTerminalScreen(120, 40),
		stateChanged: make(chan struct{}),
		exitHandled:  make(chan struct{}),
	}
	session.outputEvents.configure(func(string, interface{}) {})
	for range maxSessionChunks {
		session.appendOutput("stdout", content)
	}
	return session
}

func benchmarkAppendOutput(b *testing.B, lineWidth int) {
	content := benchmarkChunk(lineWidth)
	session := benchmarkSession(b, content)
	b.ReportAllocs()
	b.ResetTimer()
	for range b.N {
		session.appendOutput("stdout", content)
	}
}

func BenchmarkSessionAppendOutputLineOriented(b *testing.B) {
	benchmarkAppendOutput(b, 80)
}

func BenchmarkSessionAppendOutputSingleLongLine(b *testing.B) {
	benchmarkAppendOutput(b, 0)
}
