package runtimecore

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"time"
)

const sshPortForwardStartTimeout = 15 * time.Second

type SshPortForwardInput struct {
	LocalPort  int    `json:"localPort"`
	RemoteHost string `json:"remoteHost"`
	RemotePort int    `json:"remotePort"`
	Label      string `json:"label,omitempty"`
}

type SshPortForwardEntry struct {
	ID           string `json:"id"`
	ConnectionID string `json:"connectionId"`
	LocalPort    int    `json:"localPort"`
	RemoteHost   string `json:"remoteHost"`
	RemotePort   int    `json:"remotePort"`
	Label        string `json:"label,omitempty"`
}

type sshPortForwardProcess struct {
	command *exec.Cmd
	cleanup func()
}

func (m *Manager) AddSshPortForward(ctx context.Context, targetID string, input SshPortForwardInput) (SshPortForwardEntry, error) {
	forward, err := normalizeSshPortForward(input)
	if err != nil {
		return SshPortForwardEntry{}, err
	}
	forward.ID = newID("sshfwd")
	if err := m.startSshPortForward(ctx, targetID, forward); err != nil {
		return SshPortForwardEntry{}, err
	}
	if err := m.persistSshPortForward(targetID, forward, "add"); err != nil {
		m.stopSshPortForward(forward.ID)
		return SshPortForwardEntry{}, err
	}
	return toSshPortForwardEntry(targetID, forward), nil
}

func (m *Manager) UpdateSshPortForward(ctx context.Context, targetID, forwardID string, input SshPortForwardInput) (SshPortForwardEntry, error) {
	forward, err := normalizeSshPortForward(input)
	if err != nil {
		return SshPortForwardEntry{}, err
	}
	forward.ID = strings.TrimSpace(forwardID)
	old, ok := m.findSavedSshPortForward(targetID, forward.ID)
	if !ok {
		return SshPortForwardEntry{}, ErrNotFound
	}
	m.stopSshPortForward(forward.ID)
	if err := m.startSshPortForward(ctx, targetID, forward); err != nil {
		_ = m.startSshPortForward(context.Background(), targetID, old)
		return SshPortForwardEntry{}, err
	}
	if err := m.persistSshPortForward(targetID, forward, "update"); err != nil {
		m.stopSshPortForward(forward.ID)
		_ = m.startSshPortForward(context.Background(), targetID, old)
		return SshPortForwardEntry{}, err
	}
	return toSshPortForwardEntry(targetID, forward), nil
}

func (m *Manager) RemoveSshPortForward(targetID, forwardID string) (*SshPortForwardEntry, error) {
	forward, ok := m.findSavedSshPortForward(targetID, strings.TrimSpace(forwardID))
	if !ok {
		return nil, nil
	}
	m.stopSshPortForward(forward.ID)
	if err := m.persistSshPortForward(targetID, forward, "remove"); err != nil {
		return nil, err
	}
	entry := toSshPortForwardEntry(targetID, forward)
	return &entry, nil
}

func (m *Manager) ListSshPortForwards(targetID string) ([]SshPortForwardEntry, error) {
	target, ok := m.GetSshTarget(strings.TrimSpace(targetID))
	if !ok {
		return nil, ErrNotFound
	}
	entries := make([]SshPortForwardEntry, 0, len(target.PortForwards))
	for _, forward := range target.PortForwards {
		entries = append(entries, toSshPortForwardEntry(target.ID, forward))
	}
	return entries, nil
}

func (m *Manager) RestoreSshPortForwards(ctx context.Context, targetID string) ([]SshPortForwardEntry, error) {
	target, ok := m.GetSshTarget(strings.TrimSpace(targetID))
	if !ok {
		return nil, ErrNotFound
	}
	entries := make([]SshPortForwardEntry, 0, len(target.PortForwards))
	for _, forward := range target.PortForwards {
		m.mu.RLock()
		_, running := m.sshPortForwards[forward.ID]
		m.mu.RUnlock()
		if !running {
			if err := m.startSshPortForward(ctx, target.ID, forward); err != nil {
				return entries, fmt.Errorf("restore SSH port forward %s: %w", forward.ID, err)
			}
		}
		entries = append(entries, toSshPortForwardEntry(target.ID, forward))
	}
	return entries, nil
}

func (m *Manager) TerminateSshPortForwards(targetID string) ([]string, error) {
	target, ok := m.GetSshTarget(strings.TrimSpace(targetID))
	if !ok {
		return nil, ErrNotFound
	}
	terminated := make([]string, 0, len(target.PortForwards))
	for _, forward := range target.PortForwards {
		m.mu.RLock()
		_, running := m.sshPortForwards[forward.ID]
		m.mu.RUnlock()
		if running {
			m.stopSshPortForward(forward.ID)
			terminated = append(terminated, forward.ID)
		}
	}
	return terminated, nil
}

func (m *Manager) startSshPortForward(ctx context.Context, targetID string, forward SavedSshPortForward) error {
	target, ok := m.GetSshTarget(targetID)
	if !ok {
		return ErrNotFound
	}
	sshPath, ok := findSystemSshBinary()
	if !ok {
		return errors.New("system ssh binary not found")
	}
	bind := fmt.Sprintf("127.0.0.1:%d:%s:%d", forward.LocalPort, forward.RemoteHost, forward.RemotePort)
	args := sshTargetArgs(target)
	destination := args[len(args)-1]
	args = append(args[:len(args)-1], "-N", "-o", "ExitOnForwardFailure=yes", "-L", bind, destination)
	command := exec.Command(sshPath, args...)
	command.Stdin, command.Stdout, command.Stderr = nil, io.Discard, io.Discard
	cleanup, err := configureSshAskpass(command, m, targetID)
	if err != nil {
		return err
	}
	if err := command.Start(); err != nil {
		cleanup()
		return err
	}
	started := time.NewTimer(250 * time.Millisecond)
	defer started.Stop()
	timeout := time.NewTimer(sshPortForwardStartTimeout)
	defer timeout.Stop()
	exited := make(chan error, 1)
	go func() { exited <- command.Wait() }()
	select {
	case err := <-exited:
		cleanup()
		if err == nil {
			return errors.New("SSH port forward exited before becoming ready")
		}
		return fmt.Errorf("SSH port forward failed to start: %w", err)
	case <-started.C:
		m.mu.Lock()
		m.sshPortForwards[forward.ID] = &sshPortForwardProcess{command: command, cleanup: cleanup}
		m.mu.Unlock()
		go m.watchSshPortForward(forward.ID, exited)
		return nil
	case <-ctx.Done():
		_ = command.Process.Kill()
		cleanup()
		return ctx.Err()
	case <-timeout.C:
		_ = command.Process.Kill()
		cleanup()
		return errors.New("SSH port forward timed out")
	}
}

func (m *Manager) watchSshPortForward(id string, exited <-chan error) {
	<-exited
	m.mu.Lock()
	process := m.sshPortForwards[id]
	delete(m.sshPortForwards, id)
	m.mu.Unlock()
	if process != nil {
		process.cleanup()
	}
}

func (m *Manager) stopSshPortForward(id string) {
	m.mu.Lock()
	process := m.sshPortForwards[id]
	delete(m.sshPortForwards, id)
	m.mu.Unlock()
	if process != nil && process.command.Process != nil {
		_ = process.command.Process.Kill()
		process.cleanup()
	}
}

func normalizeSshPortForward(input SshPortForwardInput) (SavedSshPortForward, error) {
	host := strings.TrimSpace(input.RemoteHost)
	if input.LocalPort < 1 || input.LocalPort > 65535 || input.RemotePort < 1 || input.RemotePort > 65535 {
		return SavedSshPortForward{}, errors.New("SSH port forward ports must be between 1 and 65535")
	}
	if host == "" || len(host) > 253 || strings.ContainsAny(host, "\x00\r\n\t ") {
		return SavedSshPortForward{}, errors.New("invalid SSH port forward host")
	}
	return SavedSshPortForward{LocalPort: input.LocalPort, RemoteHost: host, RemotePort: input.RemotePort, Label: strings.TrimSpace(input.Label)}, nil
}

func (m *Manager) findSavedSshPortForward(targetID, forwardID string) (SavedSshPortForward, bool) {
	target, ok := m.GetSshTarget(targetID)
	if !ok {
		return SavedSshPortForward{}, false
	}
	for _, forward := range target.PortForwards {
		if forward.ID == forwardID {
			return forward, true
		}
	}
	return SavedSshPortForward{}, false
}

func (m *Manager) persistSshPortForward(targetID string, forward SavedSshPortForward, operation string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	target, ok := m.sshTargets[targetID]
	if !ok {
		return ErrNotFound
	}
	if operation == "add" {
		target.PortForwards = append(target.PortForwards, forward)
	} else {
		next := make([]SavedSshPortForward, 0, len(target.PortForwards))
		for _, existing := range target.PortForwards {
			if existing.ID == forward.ID {
				if operation == "update" {
					next = append(next, forward)
				}
				continue
			}
			next = append(next, existing)
		}
		target.PortForwards = next
	}
	target.UpdatedAt = time.Now().UTC()
	m.sshTargets[targetID] = target
	return m.saveLocked()
}

func toSshPortForwardEntry(targetID string, forward SavedSshPortForward) SshPortForwardEntry {
	return SshPortForwardEntry{ID: forward.ID, ConnectionID: targetID, LocalPort: forward.LocalPort, RemoteHost: forward.RemoteHost, RemotePort: forward.RemotePort, Label: forward.Label}
}
