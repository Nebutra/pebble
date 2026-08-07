package runtimecore

import (
	"strings"
	"testing"
	"unicode/utf8"
)

// The transcript's append path decodes bytes itself and bulk-copies plain ASCII
// runs rather than walking runes and concatenating strings. These tests pin the
// decoding rules that rewrite had to preserve by hand.

func TestTerminalTranscriptCollapsesEachRunOfUndecodableBytes(t *testing.T) {
	cases := []struct {
		name string
		raw  []byte
		want string
	}{
		{"single bad byte", []byte("a\xffb\n"), "a�b"},
		{"run of bad bytes collapses to one replacement", []byte("a\xff\xfe\xfdb\n"), "a�b"},
		{"runs separated by text stay separate", []byte("\xffa\xffb\xff\n"), "�a�b�"},
		{"a genuine replacement rune survives", []byte("a�b\n"), "a�b"},
		// Why: a real U+FFFD decodes as RuneError with size 3, so it must not be
		// mistaken for a bad byte and merged into an adjacent run.
		{"real replacement adjacent to a bad run", []byte("�\xff\xfe\n"), "��"},
		{"bad byte between multi-byte runes", []byte("界\xff🙂\n"), "界�🙂"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var transcript terminalTranscript
			transcript.appendBytes(tc.raw)
			snapshot := transcript.snapshot()
			if len(snapshot.CompletedLines) != 1 || snapshot.CompletedLines[0] != tc.want {
				t.Fatalf("got %#v, want %q", snapshot.CompletedLines, tc.want)
			}
		})
	}
}

func TestTerminalTranscriptBareCarriageReturnRedrawsAheadOfAnAsciiRun(t *testing.T) {
	// Why: the ASCII fast path must not run while a bare CR is pending, or the
	// redraw would append to the old frame instead of replacing it.
	var transcript terminalTranscript
	transcript.append("downloading 10%\rdownloading 99%\n")
	snapshot := transcript.snapshot()
	if len(snapshot.CompletedLines) != 1 || snapshot.CompletedLines[0] != "downloading 99%" {
		t.Fatalf("bare CR before an ASCII run leaked the old frame: %#v", snapshot.CompletedLines)
	}
}

func TestTerminalTranscriptAppliesControlsInsideAnAsciiRun(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want string
	}{
		{"backspace erases the last plain byte", "abc\bd\n", "abd"},
		{"backspace erases a whole multi-byte rune", "a界\bd\n", "ad"},
		{"backspace at line start is a no-op", "\babc\n", "abc"},
		{"CRLF completes one line", "one\r\ntwo\n", "one|two"},
		{"trailing blanks are trimmed off completed lines", "text  \t\n", "text"},
		{"interior blanks survive", "a  b\n", "a  b"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var transcript terminalTranscript
			transcript.append(tc.raw)
			snapshot := transcript.snapshot()
			if got := strings.Join(snapshot.CompletedLines, "|"); got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}

func TestTerminalTranscriptBoundsARunawayLineOnARuneBoundary(t *testing.T) {
	var transcript terminalTranscript
	// Why: partialLine is trimmed in place now, so the surviving tail has to stay
	// decodable rather than starting mid-rune.
	for range 400 {
		transcript.append(strings.Repeat("界", 20))
	}
	snapshot := transcript.snapshot()
	if len(snapshot.PartialLine) > maxTerminalTranscriptPartialChars {
		t.Fatalf("runaway line was not bounded: %d bytes", len(snapshot.PartialLine))
	}
	if !utf8.ValidString(snapshot.PartialLine) {
		t.Fatal("in-place trim cut a multi-byte rune in half")
	}
	if !snapshot.BufferTruncated {
		t.Fatal("bounding a runaway line must report truncation")
	}
	if strings.Trim(snapshot.PartialLine, "界") != "" {
		t.Fatalf("retained tail was corrupted: %q", snapshot.PartialLine)
	}
}

func TestTerminalTranscriptReusedBuffersDoNotLeakAcrossReads(t *testing.T) {
	// Why: the join buffer and the partial-line accumulator are reused between
	// reads, so a shorter read must not expose bytes left by a longer one.
	var transcript terminalTranscript
	transcript.append("a long first line of output\n")
	transcript.append("hi\n")
	transcript.append("x")
	snapshot := transcript.snapshot()
	if strings.Join(snapshot.CompletedLines, "|") != "a long first line of output|hi" {
		t.Fatalf("completed lines were corrupted: %#v", snapshot.CompletedLines)
	}
	if snapshot.PartialLine != "x" {
		t.Fatalf("partial line kept stale bytes: %q", snapshot.PartialLine)
	}
}

func TestTerminalTranscriptEvictionKeepsTheRetainedCharBudgetAccurate(t *testing.T) {
	// Why: the char budget is now carried incrementally instead of re-summed, so
	// eviction has to debit exactly what it drops or the transcript would drift
	// into over- or under-retaining.
	var transcript terminalTranscript
	line := strings.Repeat("x", 512)
	for range 4 * (maxTerminalTranscriptChars / 512) {
		transcript.append(line + "\n")
	}
	retained := 0
	for _, completed := range transcript.completedLines {
		retained += len(completed)
	}
	if retained != transcript.completedChars {
		t.Fatalf("carried char total drifted: carried %d, actual %d", transcript.completedChars, retained)
	}
	if retained > maxTerminalTranscriptChars {
		t.Fatalf("retained %d chars, over the %d budget", retained, maxTerminalTranscriptChars)
	}
	// Why: an over-eager debit would silently shrink the transcript to nothing.
	if retained < maxTerminalTranscriptChars/2 {
		t.Fatalf("retained only %d chars, far under the %d budget", retained, maxTerminalTranscriptChars)
	}
}

func TestTerminalTranscriptEvictionReleasesRetiredLines(t *testing.T) {
	var transcript terminalTranscript
	for index := range maxTerminalTranscriptLines * 2 {
		transcript.append(strings.Repeat("y", 8) + "\n")
		_ = index
	}
	// Why: compaction reslices in place, so the vacated tail must be cleared or
	// retired lines stay reachable for the life of the session.
	tail := transcript.completedLines[len(transcript.completedLines):cap(transcript.completedLines)]
	for _, stale := range tail {
		if stale != "" {
			t.Fatalf("retired line still reachable past the live window: %q", stale)
		}
	}
}
