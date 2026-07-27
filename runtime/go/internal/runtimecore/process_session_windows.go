//go:build windows

package runtimecore

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"

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
	commandEnvironment := interactiveSessionEnvironment(append(req.Environment, req.hookEnv...))
	var credentialCleanup func()
	if req.configureCommand != nil {
		// Why: askpass also relaxes SSH argv policy; apply both transformations
		// before creating the ConPTY command instead of copying only its env.
		configured := &exec.Cmd{Args: append([]string(nil), launchCommand...), Env: commandEnvironment}
		credentialCleanup, err = req.configureCommand(configured)
		if err != nil {
			_ = pty.Close()
			return err
		}
		launchCommand = configured.Args
		commandEnvironment = configured.Env
	}
	launchCommand = append([]string(nil), launchCommand...)
	launchCommand[0] = resolveWindowsPtyExecutable(launchCommand[0])
	cmd := pty.CommandContext(ctx, launchCommand[0], launchCommand[1:]...)
	cmd.Dir = session.cwd
	// Why: Windows cannot use a WSL UNC directory as CreateProcess cwd. The
	// inner WSL bash command owns its Linux-side cd before launching the shell.
	if strings.EqualFold(filepath.Base(launchCommand[0]), "wsl.exe") || strings.EqualFold(filepath.Base(launchCommand[0]), "wsl") {
		cmd.Dir = ""
	}
	if req.launchCwd != "" {
		cmd.Dir = req.launchCwd
	}
	cmd.Env = commandEnvironment
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
	session.killProcess = func() error {
		// Why: ConPTY commands can own descendants; killing only cmd.exe leaves
		// those children and inherited handles alive after a user stops a run.
		if err := runWindowsTaskkill(cmd.Process.Pid, true); err == nil {
			return nil
		}
		err := cmd.Process.Kill()
		if err == nil || errors.Is(err, os.ErrProcessDone) || errors.Is(err, syscall.EINVAL) {
			return nil
		}
		return err
	}
	session.resizePty = pty.Resize
	session.cleanupProcess = cleanup
	session.mu.Unlock()
	go session.readStream("stdout", pty)
	go session.wait()
	return nil
}

func resolveWindowsPtyExecutable(command string) string {
	if filepath.IsAbs(command) || strings.ContainsAny(command, `\\/`) {
		return command
	}
	if strings.EqualFold(command, "cmd") || strings.EqualFold(command, "cmd.exe") {
		return windowsSystemExecutable("cmd.exe")
	}
	if resolved, err := exec.LookPath(command); err == nil {
		return resolved
	}
	return command
}
