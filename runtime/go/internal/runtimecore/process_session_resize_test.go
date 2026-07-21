package runtimecore

import (
	"errors"
	"testing"
)

func TestProcessSessionResizeUpdatesMirrorAfterPtyAccepts(t *testing.T) {
	screen := newTerminalScreen(80, 24)
	ptyCalled := false
	session := &processSession{
		status: SessionRunning,
		cols:   80,
		rows:   24,
		screen: screen,
		resizePty: func(cols, rows int) error {
			ptyCalled = true
			snapshot := screen.Snapshot()
			if snapshot.Cols != 80 || snapshot.Rows != 24 {
				t.Fatalf("mirror resized before PTY accepted: %dx%d", snapshot.Cols, snapshot.Rows)
			}
			return nil
		},
	}

	resized, err := session.resize(SessionResizeRequest{Cols: 120, Rows: 30})
	if err != nil {
		t.Fatal(err)
	}
	if !ptyCalled {
		t.Fatal("resize did not reach PTY")
	}
	if resized.Cols != 120 || resized.Rows != 30 {
		t.Fatalf("session size = %dx%d, want 120x30", resized.Cols, resized.Rows)
	}
	snapshot := screen.Snapshot()
	if snapshot.Cols != 120 || snapshot.Rows != 30 {
		t.Fatalf("mirror size = %dx%d, want 120x30", snapshot.Cols, snapshot.Rows)
	}
}

func TestProcessSessionResizeLeavesMirrorUnchangedWhenPtyRejects(t *testing.T) {
	screen := newTerminalScreen(80, 24)
	session := &processSession{
		status: SessionRunning,
		cols:   80,
		rows:   24,
		screen: screen,
		resizePty: func(_, _ int) error {
			return errors.New("resize rejected")
		},
	}

	if _, err := session.resize(SessionResizeRequest{Cols: 120, Rows: 30}); err == nil {
		t.Fatal("expected rejected PTY resize")
	}
	snapshot := screen.Snapshot()
	if snapshot.Cols != 80 || snapshot.Rows != 24 {
		t.Fatalf("rejected resize changed mirror to %dx%d", snapshot.Cols, snapshot.Rows)
	}
	if session.cols != 80 || session.rows != 24 {
		t.Fatalf("rejected resize changed session to %dx%d", session.cols, session.rows)
	}
}
