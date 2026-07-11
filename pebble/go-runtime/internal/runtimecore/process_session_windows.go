//go:build windows

package runtimecore

import (
	"context"
	"os"
	"os/exec"

	terminalpty "github.com/aymanbagabas/go-pty"
)

func startPlatformProcessSession(ctx context.Context, session *processSession, req StartSessionRequest) error {
	launchCommand := req.launchCommand
	if len(launchCommand) == 0 {
		launchCommand = session.command
	}
	pty, err := terminalpty.New()
	if err != nil {
		return err
	}
	cmd := pty.CommandContext(ctx, launchCommand[0], launchCommand[1:]...)
	cmd.Dir = session.cwd
	if req.launchCwd != "" {
		cmd.Dir = req.launchCwd
	}
	cmd.Env = append(os.Environ(), req.hookEnv...)
	var credentialCleanup func()
	if req.configureCommand != nil {
		// The credential configurator only mutates env; copy it to go-pty's Cmd
		// while preserving the CreatePseudoConsole startup path.
		environmentCommand := &exec.Cmd{Env: cmd.Env}
		credentialCleanup, err = req.configureCommand(environmentCommand)
		if err != nil {
			_ = pty.Close()
			return err
		}
		cmd.Env = environmentCommand.Env
	}
	cleanup := func() {
		_ = pty.Close()
		if credentialCleanup != nil {
			credentialCleanup()
		}
	}
	if err := pty.Resize(session.cols, session.rows); err != nil {
		cleanup()
		return err
	}
	if err := cmd.Start(); err != nil {
		cleanup()
		return err
	}
	session.mu.Lock()
	session.pid = cmd.Process.Pid
	session.stdin = pty
	session.waitProcess = cmd.Wait
	session.killProcess = cmd.Process.Kill
	session.resizePty = pty.Resize
	session.cleanupProcess = cleanup
	session.mu.Unlock()
	go session.readStream("stdout", pty)
	go session.wait()
	return nil
}
