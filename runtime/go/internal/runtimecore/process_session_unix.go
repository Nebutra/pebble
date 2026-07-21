//go:build !windows

package runtimecore

import (
	"context"
	"os/exec"

	terminalpty "github.com/creack/pty"
)

func startPlatformProcessSession(ctx context.Context, session *processSession, req StartSessionRequest) error {
	launchCommand := req.launchCommand
	if len(launchCommand) == 0 {
		launchCommand = session.command
	}
	cmd := exec.CommandContext(ctx, launchCommand[0], launchCommand[1:]...)
	cmd.Dir = session.cwd
	if req.launchCwd != "" {
		cmd.Dir = req.launchCwd
	}
	// Why: desktop launchers can expose TERM=dumb; interactive shells then omit
	// their prompt even though they are attached to a real pseudoterminal.
	cmd.Env = interactiveSessionEnvironment(append(req.Environment, req.hookEnv...))
	if req.configureCommand != nil {
		cleanup, err := req.configureCommand(cmd)
		if err != nil {
			return err
		}
		session.cleanupProcess = cleanup
	}
	ptyFile, err := terminalpty.StartWithSize(cmd, toPtyWinsize(session.cols, session.rows))
	if err != nil {
		if session.cleanupProcess != nil {
			session.cleanupProcess()
			session.cleanupProcess = nil
		}
		return err
	}
	session.mu.Lock()
	session.pid = cmd.Process.Pid
	session.waitProcess = cmd.Wait
	session.killProcess = cmd.Process.Kill
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
