package runtimecore

import "testing"

func TestAltScreenScannerEntersAndLeaves(t *testing.T) {
	var s altScreenScanner
	if s.Active() {
		t.Fatal("scanner should start inactive")
	}
	if !s.Feed([]byte("hello\x1b[?1049hworld")) {
		t.Fatal("expected active after smcup (1049h)")
	}
	if !s.Feed([]byte("still in tui")) {
		t.Fatal("expected to stay active with no marker")
	}
	if s.Feed([]byte("bye\x1b[?1049l")) {
		t.Fatal("expected inactive after rmcup (1049l)")
	}
}

func TestAltScreenScannerLegacyModes(t *testing.T) {
	for _, mode := range []struct{ enter, leave string }{
		{"\x1b[?1047h", "\x1b[?1047l"},
		{"\x1b[?47h", "\x1b[?47l"},
	} {
		var s altScreenScanner
		if !s.Feed([]byte(mode.enter)) {
			t.Fatalf("expected active after %q", mode.enter)
		}
		if s.Feed([]byte(mode.leave)) {
			t.Fatalf("expected inactive after %q", mode.leave)
		}
	}
}

func TestAltScreenScannerLastMarkerWins(t *testing.T) {
	var s altScreenScanner
	// Enter then leave in one chunk: final state is inactive.
	if s.Feed([]byte("\x1b[?1049h...\x1b[?1049l")) {
		t.Fatal("expected inactive when leave follows enter in one chunk")
	}
	// Leave then enter: final state is active.
	if !s.Feed([]byte("\x1b[?1049l...\x1b[?1049h")) {
		t.Fatal("expected active when enter follows leave in one chunk")
	}
}

func TestAltScreenScannerMarkerSplitAcrossChunks(t *testing.T) {
	var s altScreenScanner
	// Split the enter marker across two Feed calls.
	if s.Feed([]byte("prefix\x1b[?10")) {
		t.Fatal("partial marker must not activate yet")
	}
	if !s.Feed([]byte("49hsuffix")) {
		t.Fatal("expected active once the split marker completes")
	}
}
