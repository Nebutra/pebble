package runtimecore

import (
	"strings"
	"testing"
)

func TestTerminalTranscriptPreservesChunkBoundaryAndPartialLine(t *testing.T) {
	var transcript terminalTranscript
	transcript.append("one\r")
	transcript.append("\ntw")
	transcript.append("o\npartial")
	snapshot := transcript.snapshot()
	if strings.Join(snapshot.CompletedLines, "|") != "one|two" || snapshot.PartialLine != "partial" {
		t.Fatalf("unexpected transcript: %#v", snapshot)
	}
	if snapshot.CompletedLineCount != 2 || snapshot.BufferTruncated {
		t.Fatalf("unexpected transcript metadata: %#v", snapshot)
	}
}

func TestTerminalTranscriptBareCarriageReturnRedrawsWithoutAdvancingCursor(t *testing.T) {
	var transcript terminalTranscript
	transcript.append("step 1\rstep 2\rstep 3\n")
	snapshot := transcript.snapshot()
	if len(snapshot.CompletedLines) != 1 || snapshot.CompletedLines[0] != "step 3" || snapshot.CompletedLineCount != 1 {
		t.Fatalf("carriage-return redraw leaked frames: %#v", snapshot)
	}
}

func TestTerminalTranscriptPreservesUtf8SplitAcrossChunks(t *testing.T) {
	var transcript terminalTranscript
	encoded := []byte("界🙂\n")
	transcript.append(string(encoded[:2]))
	transcript.append(string(encoded[2:5]))
	transcript.append(string(encoded[5:]))
	snapshot := transcript.snapshot()
	if len(snapshot.CompletedLines) != 1 || snapshot.CompletedLines[0] != "界🙂" {
		t.Fatalf("split UTF-8 was corrupted: %#v", snapshot)
	}
}

func TestTerminalTranscriptTracksAbsoluteCursorAfterEviction(t *testing.T) {
	var transcript terminalTranscript
	for index := 0; index < maxTerminalTranscriptLines+3; index++ {
		transcript.append("line\n")
	}
	snapshot := transcript.snapshot()
	if snapshot.CompletedLineCount != maxTerminalTranscriptLines+3 {
		t.Fatalf("completed count = %d", snapshot.CompletedLineCount)
	}
	if len(snapshot.CompletedLines) != maxTerminalTranscriptLines || !snapshot.BufferTruncated {
		t.Fatalf("retention metadata is not truthful: %#v", snapshot)
	}
	oldest := snapshot.CompletedLineCount - uint64(len(snapshot.CompletedLines))
	if oldest != 3 {
		t.Fatalf("oldest cursor = %d, want 3", oldest)
	}
}

func TestTerminalTranscriptClearResetsCursorEpoch(t *testing.T) {
	var transcript terminalTranscript
	transcript.append("one\ntwo\npartial")
	transcript.clear()
	if snapshot := transcript.snapshot(); snapshot.CompletedLineCount != 0 || len(snapshot.CompletedLines) != 0 || snapshot.PartialLine != "" || snapshot.BufferTruncated {
		t.Fatalf("clear did not reset transcript: %#v", snapshot)
	}
}

func TestTerminalTranscriptReadPagesAbsoluteCursorsAndReportsStaleCursor(t *testing.T) {
	var transcript terminalTranscript
	for index := 0; index < maxTerminalTranscriptLines+3; index++ {
		transcript.append("line\n")
	}
	stale := uint64(1)
	read := transcript.read(&stale, 2)
	if !read.Truncated || !read.Limited || read.OldestCursor != "3" || read.NextCursor != "5" || read.LatestCursor != "2003" {
		t.Fatalf("unexpected stale cursor page: %#v", read)
	}
	if len(read.Tail) != 2 || read.ReturnedLineCount != 2 {
		t.Fatalf("unexpected page lines: %#v", read)
	}
}

func TestTerminalTranscriptPreviewIncludesPartialWithoutAdvancingCursor(t *testing.T) {
	var transcript terminalTranscript
	transcript.append("one\ntwo\npartial")
	read := transcript.read(nil, 2)
	if strings.Join(read.Tail, "|") != "two|partial" || read.NextCursor != "2" || read.LatestCursor != "2" || !read.Limited {
		t.Fatalf("unexpected preview: %#v", read)
	}
}
