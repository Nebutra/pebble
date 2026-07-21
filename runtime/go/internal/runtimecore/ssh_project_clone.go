package runtimecore

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"strings"
)

type sshProjectCloneEvent struct {
	Type    string `json:"type"`
	Phase   string `json:"phase,omitempty"`
	Percent int    `json:"percent,omitempty"`
	Path    string `json:"path,omitempty"`
	Name    string `json:"name,omitempty"`
	Error   string `json:"error,omitempty"`
}

func (m *Manager) cloneSshProject(ctx context.Context, req CloneProjectRequest) (Project, error) {
	remoteURL := strings.TrimSpace(req.URL)
	destination := strings.TrimSpace(req.Destination)
	hostID := strings.TrimSpace(req.HostID)
	if remoteURL == "" || destination == "" || hostID == "" {
		return Project{}, errors.New("clone url, destination, and SSH host are required")
	}
	cloneCtx, cancel := context.WithTimeout(ctx, gitCloneCommandLimit)
	if !m.beginClone(cancel) {
		cancel()
		return Project{}, errors.New("another clone is already in progress")
	}
	defer func() {
		m.finishClone()
		cancel()
	}()
	complete, err := m.streamSshProjectClone(cloneCtx, hostID, remoteURL, destination)
	if err != nil {
		if errors.Is(cloneCtx.Err(), context.Canceled) {
			return Project{}, errors.New("Clone canceled.")
		}
		return Project{}, err
	}
	return m.CreateProject(CreateProjectRequest{
		Name: complete.Name, Path: complete.Path, LocationKind: "ssh", HostID: hostID, Provider: "git",
	})
}

func (m *Manager) streamSshProjectClone(ctx context.Context, hostID string, remoteURL string, destination string) (sshProjectCloneEvent, error) {
	target, ok := m.GetSshTarget(hostID)
	if !ok {
		return sshProjectCloneEvent{}, ErrNotFound
	}
	sshPath, ok := findSystemSshBinary()
	if !ok {
		return sshProjectCloneEvent{}, errors.New("system ssh binary not found")
	}
	deployment, err := m.deploySshRelayWorker(ctx, sshPath, hostID, target)
	if err != nil {
		return sshProjectCloneEvent{}, err
	}
	remoteCommand := remoteWorkerCommand(deployment, []string{
		"project-clone-json", "--url", remoteURL, "--destination", destination,
	})
	command := exec.CommandContext(ctx, sshPath, append(sshConnectionArgs(target), remoteCommand)...)
	stdout, err := command.StdoutPipe()
	if err != nil {
		return sshProjectCloneEvent{}, err
	}
	var stderr strings.Builder
	command.Stderr = &stderr
	cleanup, err := configureSshAskpass(command, m, hostID)
	if err != nil {
		return sshProjectCloneEvent{}, err
	}
	defer cleanup()
	if err := command.Start(); err != nil {
		return sshProjectCloneEvent{}, err
	}
	var complete sshProjectCloneEvent
	var remoteError string
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 4096), 1024*1024)
	for scanner.Scan() {
		var event sshProjectCloneEvent
		if err := json.Unmarshal(scanner.Bytes(), &event); err != nil {
			continue
		}
		switch event.Type {
		case "progress":
			m.emit("project.cloneProgress", map[string]interface{}{"phase": event.Phase, "percent": event.Percent})
		case "complete":
			complete = event
		case "error":
			remoteError = event.Error
		}
	}
	waitErr := command.Wait()
	if ctx.Err() != nil {
		return sshProjectCloneEvent{}, ctx.Err()
	}
	if waitErr != nil {
		detail := strings.TrimSpace(remoteError)
		if detail == "" {
			detail = strings.TrimSpace(stderr.String())
		}
		if detail == "" {
			detail = waitErr.Error()
		}
		return sshProjectCloneEvent{}, fmt.Errorf("Clone failed: %s", detail)
	}
	if scanErr := scanner.Err(); scanErr != nil {
		return sshProjectCloneEvent{}, scanErr
	}
	if complete.Type != "complete" || complete.Path == "" || complete.Name == "" {
		return sshProjectCloneEvent{}, errors.New("clone relay completed without project metadata")
	}
	return complete, nil
}
