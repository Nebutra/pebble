package runtimecore

import (
	"strings"
	"testing"
)

func TestTerminalScreenSnapshotRendersFinalCells(t *testing.T) {
	screen := newTerminalScreen(8, 3)
	screen.Write([]byte("hello\rXY"))
	snapshot := screen.Snapshot()
	if snapshot.Alternate {
		t.Fatal("plain shell output unexpectedly entered alternate screen")
	}
	if !strings.Contains(snapshot.ANSI, "XYllo") {
		t.Fatalf("snapshot did not render cursor overwrite: %q", snapshot.ANSI)
	}
	if !strings.HasPrefix(snapshot.ANSI, "\x1b[2J\x1b[H") {
		t.Fatalf("snapshot must clear stale client cells: %q", snapshot.ANSI)
	}
}

func TestTerminalScreenSnapshotTracksAlternateScreenAndResize(t *testing.T) {
	screen := newTerminalScreen(6, 2)
	screen.Write([]byte("shell\r\n\x1b[?1049hTUI"))
	screen.Resize(10, 4)
	snapshot := screen.Snapshot()
	if !snapshot.Alternate {
		t.Fatal("expected alternate-screen snapshot")
	}
	if snapshot.Cols != 10 || snapshot.Rows != 4 {
		t.Fatalf("snapshot size = %dx%d, want 10x4", snapshot.Cols, snapshot.Rows)
	}
	if !strings.Contains(snapshot.ANSI, "TUI") || strings.Contains(snapshot.ANSI, "shell") {
		t.Fatalf("snapshot did not isolate alternate screen: %q", snapshot.ANSI)
	}
}

func TestTerminalScreenSnapshotPreservesCellStyles(t *testing.T) {
	screen := newTerminalScreen(20, 2)
	screen.Write([]byte("\x1b[?1049h\x1b[1;3;4;38;5;196;48;5;22m红\x1b[0m plain"))
	snapshot := screen.Snapshot()
	if !strings.Contains(snapshot.ANSI, "\x1b[1;3;4;38;5;196;48;5;22m红") {
		t.Fatalf("snapshot lost styled UTF-8 cell: %q", snapshot.ANSI)
	}
	if !strings.Contains(snapshot.ANSI, "\x1b[m plain") {
		t.Fatalf("snapshot did not reset style before plain text: %q", snapshot.ANSI)
	}
}

func TestTerminalScreenEmojiWidthMatchesRendererPositioning(t *testing.T) {
	screen := newTerminalScreen(40, 4)
	screen.Write([]byte("\x1b[H🤖AB"))
	screen.Write([]byte("\x1b[1;5HZ"))
	if got := terminalSnapshotFirstVisibleLine(screen.Snapshot().ANSI); got != "🤖ABZ" {
		t.Fatalf("emoji width diverged from renderer positioning: %q", got)
	}
}

func TestTerminalScreenZWJEmojiMatchesRendererPositioning(t *testing.T) {
	screen := newTerminalScreen(40, 4)
	screen.Write([]byte("\x1b[H👩‍💻X"))
	screen.Write([]byte("\x1b[1;3HY"))
	if got := terminalSnapshotFirstVisibleLine(screen.Snapshot().ANSI); got != "👩‍💻Y" {
		t.Fatalf("ZWJ emoji width diverged from renderer positioning: %q", got)
	}
}

func terminalSnapshotFirstVisibleLine(snapshot string) string {
	line := strings.SplitN(strings.TrimPrefix(snapshot, "\x1b[2J\x1b[H"), "\r\n", 2)[0]
	var visible strings.Builder
	for index := 0; index < len(line); {
		if line[index] == 0x1b && index+1 < len(line) && line[index+1] == '[' {
			end := index + 2
			for end < len(line) && (line[end] < 0x40 || line[end] > 0x7e) {
				end++
			}
			if end < len(line) {
				index = end + 1
				continue
			}
		}
		visible.WriteByte(line[index])
		index++
	}
	return visible.String()
}
