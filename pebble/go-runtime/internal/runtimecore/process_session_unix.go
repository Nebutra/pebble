//go:build !windows

package runtimecore

import (
	"context"
	"os"
	"os/exec"

	terminalpty "github.com/creack/pty"
)

func startPlatformProcessSession(ctx context.Context, session *processSession, _ StartSessionRequest) error {
	cmd := exec.CommandContext(ctx, session.command[0], session.command[1:]...)
	cmd.Dir = session.cwd
	cmd.Env = os.Environ()
	ptyFile, err := terminalpty.StartWithSize(cmd, toPtyWinsize(session.cols, session.rows))
	if err != nil {
		return err
	}
	session.mu.Lock()
	session.cmd = cmd
	session.stdin = ptyFile
	session.resizePty = func(cols int, rows int) error {
		return terminalpty.Setsize(ptyFile, toPtyWinsize(cols, rows))
	}
	session.mu.Unlock()
	go session.readStream("stdout", ptyFile)
	go session.wait()
	return nil
}

func toPtyWinsize(cols int, rows int) *terminalpty.Winsize {
	return &terminalpty.Winsize{
		Cols: uint16(clampPtyDimension(cols)),
		Rows: uint16(clampPtyDimension(rows)),
	}
}

func clampPtyDimension(value int) int {
	if value < 1 {
		return 1
	}
	if value > 65535 {
		return 65535
	}
	return value
}
