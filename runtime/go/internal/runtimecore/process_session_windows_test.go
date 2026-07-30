//go:build windows

package runtimecore

import (
	"testing"

	terminalpty "github.com/aymanbagabas/go-pty"
)

func TestWindowsSessionInputLeavesConPtyOwnedByWaitCleanup(t *testing.T) {
	pty, err := terminalpty.New()
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = pty.Close() }()
	conPty, ok := pty.(terminalpty.ConPty)
	if !ok {
		t.Fatal("Windows PTY does not expose its input pipe")
	}

	input := windowsSessionInput(pty)
	if input != conPty.InputPipe() {
		t.Fatal("session stdin owns the whole ConPTY instead of only its input pipe")
	}
	if err := input.Close(); err != nil {
		t.Fatal(err)
	}
	if err := pty.Resize(81, 26); err != nil {
		t.Fatalf("closing session stdin also closed the ConPTY: %v", err)
	}
}
