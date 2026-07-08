package runtimecore

import (
	"bufio"
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"runtime"
	"sync"
	"time"
)

const maxSessionChunks = 2048

type processSession struct {
	mu         sync.RWMutex
	id         string
	projectID  string
	worktreeID string
	cwd        string
	command    []string
	agentKind  string
	status     SessionStatus
	exitCode   *int
	startedAt  time.Time
	updatedAt  time.Time
	cmd        *exec.Cmd
	stdin      io.WriteCloser
	output     []OutputChunk
	emit       func(topic string, payload interface{})
}

func startProcessSession(ctx context.Context, req StartSessionRequest, emit func(topic string, payload interface{})) (*processSession, error) {
	command := req.Command
	if len(command) == 0 {
		command = defaultShellCommand()
	}
	if len(command) == 0 || command[0] == "" {
		return nil, errors.New("session command is required")
	}
	startedAt := time.Now().UTC()
	cmd := exec.CommandContext(ctx, command[0], command[1:]...)
	cmd.Dir = req.Cwd
	cmd.Env = os.Environ()
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}
	session := &processSession{
		id:         newID("sess"),
		projectID:  req.ProjectID,
		worktreeID: req.WorktreeID,
		cwd:        req.Cwd,
		command:    append([]string(nil), command...),
		agentKind:  req.AgentKind,
		status:     SessionStarting,
		startedAt:  startedAt,
		updatedAt:  startedAt,
		cmd:        cmd,
		stdin:      stdin,
		output:     make([]OutputChunk, 0, 256),
		emit:       emit,
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	session.setStatus(SessionRunning)
	go session.readStream("stdout", stdout)
	go session.readStream("stderr", stderr)
	go session.wait()
	if req.Prompt != "" {
		_ = session.write(SessionInputRequest{Text: req.Prompt, AppendNewline: true})
	}
	return session, nil
}

func (s *processSession) snapshot() Session {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return Session{
		ID:           s.id,
		ProjectID:    s.projectID,
		WorktreeID:   s.worktreeID,
		Cwd:          s.cwd,
		Command:      append([]string(nil), s.command...),
		AgentKind:    s.agentKind,
		Status:       s.status,
		ExitCode:     cloneExitCode(s.exitCode),
		StartedAt:    s.startedAt,
		UpdatedAt:    s.updatedAt,
		OutputChunks: len(s.output),
	}
}

func (s *processSession) write(req SessionInputRequest) error {
	s.mu.RLock()
	stdin := s.stdin
	status := s.status
	s.mu.RUnlock()
	if stdin == nil || status != SessionRunning {
		return errors.New("session is not accepting input")
	}
	text := req.Text
	if req.AppendNewline {
		text += "\n"
	}
	_, err := io.WriteString(stdin, text)
	return err
}

func (s *processSession) tail(limit int) []OutputChunk {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if limit <= 0 || limit > len(s.output) {
		limit = len(s.output)
	}
	start := len(s.output) - limit
	chunks := make([]OutputChunk, limit)
	copy(chunks, s.output[start:])
	return chunks
}

func (s *processSession) stop() (Session, error) {
	s.mu.Lock()
	if s.status == SessionExited || s.status == SessionStopped || s.status == SessionFailed {
		s.mu.Unlock()
		return s.snapshot(), nil
	}
	cmd := s.cmd
	s.status = SessionStopped
	s.updatedAt = time.Now().UTC()
	s.mu.Unlock()
	if cmd != nil && cmd.Process != nil {
		if err := cmd.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
			return Session{}, err
		}
	}
	return s.snapshot(), nil
}

func (s *processSession) readStream(stream string, reader io.Reader) {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 4096), 1024*1024)
	for scanner.Scan() {
		s.appendOutput(stream, scanner.Text()+"\n")
	}
	if err := scanner.Err(); err != nil {
		s.appendOutput("stderr", err.Error()+"\n")
	}
}

func (s *processSession) appendOutput(stream string, content string) {
	chunk := OutputChunk{At: time.Now().UTC(), Stream: stream, Content: content}
	s.mu.Lock()
	s.output = append(s.output, chunk)
	if len(s.output) > maxSessionChunks {
		copy(s.output, s.output[len(s.output)-maxSessionChunks:])
		s.output = s.output[:maxSessionChunks]
	}
	s.updatedAt = chunk.At
	snapshot := s.snapshotLocked()
	s.mu.Unlock()
	if s.emit != nil {
		s.emit("session.output", map[string]interface{}{
			"session": snapshot,
			"chunk":   chunk,
		})
	}
}

func (s *processSession) wait() {
	err := s.cmd.Wait()
	s.mu.Lock()
	if s.status == SessionStopped {
		s.updatedAt = time.Now().UTC()
		s.mu.Unlock()
		return
	}
	if err == nil {
		code := 0
		s.exitCode = &code
		s.status = SessionExited
	} else if exitErr, ok := err.(*exec.ExitError); ok {
		code := exitErr.ExitCode()
		s.exitCode = &code
		s.status = SessionExited
	} else {
		s.status = SessionFailed
	}
	s.updatedAt = time.Now().UTC()
	snapshot := s.snapshotLocked()
	s.mu.Unlock()
	if s.emit != nil {
		s.emit("session.status", snapshot)
	}
}

func (s *processSession) setStatus(status SessionStatus) {
	s.mu.Lock()
	s.status = status
	s.updatedAt = time.Now().UTC()
	s.mu.Unlock()
}

func (s *processSession) snapshotLocked() Session {
	return Session{
		ID:           s.id,
		ProjectID:    s.projectID,
		WorktreeID:   s.worktreeID,
		Cwd:          s.cwd,
		Command:      append([]string(nil), s.command...),
		AgentKind:    s.agentKind,
		Status:       s.status,
		ExitCode:     cloneExitCode(s.exitCode),
		StartedAt:    s.startedAt,
		UpdatedAt:    s.updatedAt,
		OutputChunks: len(s.output),
	}
}

func defaultShellCommand() []string {
	if runtime.GOOS == "windows" {
		return []string{"cmd.exe"}
	}
	if shell := os.Getenv("SHELL"); shell != "" {
		return []string{shell}
	}
	return []string{"/bin/sh"}
}

func cloneExitCode(value *int) *int {
	if value == nil {
		return nil
	}
	copied := *value
	return &copied
}
