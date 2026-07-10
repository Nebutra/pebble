//go:build windows

package runtimecore

import (
	"context"
	"os"
	"os/exec"
)

func startPlatformProcessSession(ctx context.Context, session *processSession, req StartSessionRequest) error {
	cmd := exec.CommandContext(ctx, session.command[0], session.command[1:]...)
	cmd.Dir = session.cwd
	cmd.Env = append(os.Environ(), req.hookEnv...)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	session.mu.Lock()
	session.cmd = cmd
	session.stdin = stdin
	session.mu.Unlock()
	go session.readStream("stdout", stdout)
	go session.readStream("stderr", stderr)
	go session.wait()
	return nil
}
