package runtimecore

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
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

func (m *Manager) EnsureSshLocalhostLabelForward(ctx context.Context, targetID, remoteHost string, remotePort int) (SshPortForwardEntry, error) {
	remoteHost = strings.Trim(strings.ToLower(strings.TrimSpace(remoteHost)), "[]")
	if !isSshLabelLoopbackHost(remoteHost) || remotePort < 1 || remotePort > 65535 {
		return SshPortForwardEntry{}, errors.New("invalid remote localhost label target")
	}
	ports, err := m.DetectSshPorts(ctx, targetID)
	if err != nil {
		return SshPortForwardEntry{}, err
	}
	if !sshLabelPortIsAdvertised(ports, remoteHost, remotePort) {
		return SshPortForwardEntry{}, errors.New("remote localhost label target is not an advertised workspace port")
	}
	if remoteHost == "0.0.0.0" {
		remoteHost = "127.0.0.1"
	} else if remoteHost == "::" {
		remoteHost = "::1"
	}
	key := fmt.Sprintf("%s\x00%s\x00%d", targetID, remoteHost, remotePort)
	m.localhostLabelForwardMu.Lock()
	defer m.localhostLabelForwardMu.Unlock()
	if existing, ok := m.localhostLabelForwards[key]; ok {
		m.mu.RLock()
		_, running := m.sshPortForwards[existing.ID]
		m.mu.RUnlock()
		if running {
			return existing, nil
		}
		delete(m.localhostLabelForwards, key)
	}
	localPort, err := reserveSshLabelLocalPort()
	if err != nil {
		return SshPortForwardEntry{}, err
	}
	forward := SavedSshPortForward{
		ID: newID("label-fwd"), LocalPort: localPort, RemoteHost: remoteHost, RemotePort: remotePort,
	}
	if err := m.startSshPortForward(ctx, targetID, forward); err != nil {
		return SshPortForwardEntry{}, err
	}
	entry := toSshPortForwardEntry(targetID, forward)
	m.localhostLabelForwards[key] = entry
	return entry, nil
}

func reserveSshLabelLocalPort() (int, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	port := listener.Addr().(*net.TCPAddr).Port
	if err := listener.Close(); err != nil {
		return 0, err
	}
	return port, nil
}

func sshLabelPortIsAdvertised(ports []SshDetectedPort, remoteHost string, remotePort int) bool {
	for _, port := range ports {
		host := strings.Trim(strings.ToLower(port.Host), "[]")
		if port.Port == remotePort && isSshLabelLoopbackHost(host) && isSshLabelLoopbackHost(remoteHost) {
			return true
		}
	}
	return false
}

func isSshLabelLoopbackHost(host string) bool {
	switch strings.Trim(strings.ToLower(host), "[]") {
	case "localhost", "127.0.0.1", "0.0.0.0", "::1", "::":
		return true
	default:
		return false
	}
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
	m.localhostLabelForwardMu.Lock()
	for key, forward := range m.localhostLabelForwards {
		if forward.ConnectionID != targetID {
			continue
		}
		m.stopSshPortForward(forward.ID)
		delete(m.localhostLabelForwards, key)
		terminated = append(terminated, forward.ID)
	}
	m.localhostLabelForwardMu.Unlock()
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
		process := &sshPortForwardProcess{command: command, cleanup: cleanup}
		m.mu.Lock()
		m.sshPortForwards[forward.ID] = process
		m.mu.Unlock()
		go m.watchSshPortForward(forward.ID, process, exited)
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

// watchSshPortForward waits for the forward process this call started to
// exit, then untracks and cleans it up. It only acts if the map still holds
// the SAME process instance: an id can be reused (UpdateSshPortForward stops
// then immediately restarts a forward under the same id), and this
// goroutine's exit signal can arrive after a new process has already been
// registered under that id — deleting/cleaning up by id alone would tear
// down the new, still-running forward instead of the one this call owns.
func (m *Manager) watchSshPortForward(id string, owned *sshPortForwardProcess, exited <-chan error) {
	<-exited
	m.mu.Lock()
	current, ok := m.sshPortForwards[id]
	if ok && current == owned {
		delete(m.sshPortForwards, id)
	}
	m.mu.Unlock()
	owned.cleanup()
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
