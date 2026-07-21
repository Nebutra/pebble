package runtimecore

import "testing"

func TestProcessSessionSignalWinchReappliesPtySize(t *testing.T) {
	var resizedCols, resizedRows int
	session := &processSession{
		status: SessionRunning,
		cols:   132,
		rows:   43,
		resizePty: func(cols, rows int) error {
			resizedCols, resizedRows = cols, rows
			return nil
		},
	}

	if err := session.signal("sigwinch"); err != nil {
		t.Fatal(err)
	}
	if resizedCols != 132 || resizedRows != 43 {
		t.Fatalf("signal resize = %dx%d, want 132x43", resizedCols, resizedRows)
	}
}

func TestProcessSessionSignalRejectsStoppedSession(t *testing.T) {
	session := &processSession{status: SessionStopped}
	if err := session.signal("SIGWINCH"); err == nil || err.Error() != "session is not running" {
		t.Fatalf("unexpected signal error: %v", err)
	}
}

func TestManagerSignalSessionRejectsUnknownSession(t *testing.T) {
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := manager.SignalSession("missing", SessionSignalRequest{Signal: "SIGWINCH"}); err != ErrSessionNotFound {
		t.Fatalf("signal error = %v, want %v", err, ErrSessionNotFound)
	}
}
