package runtimecore

import (
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
	mu          sync.RWMutex
	id          string
	projectID   string
	worktreeID  string
	cwd         string
	command     []string
	agentKind   string
	tabID       string
	leafID      string
	launchToken string
	prompt      string
	status      SessionStatus
	exitCode    *int
	startedAt   time.Time
	updatedAt   time.Time
	cols        int
	rows        int
	cmd         *exec.Cmd
	stdin       io.WriteCloser
	resizePty   func(cols int, rows int) error
	output      []OutputChunk
	emit        func(topic string, payload interface{})
}

func startProcessSession(ctx context.Context, req StartSessionRequest, emit func(topic string, payload interface{})) (*processSession, error) {
	command := req.Command
	if len(command) == 0 {
		command = defaultShellCommand()
	}
	if len(command) == 0 || command[0] == "" {
		return nil, errors.New("session command is required")
	}
	cols, rows := normalizeSessionSize(req.Cols, req.Rows)
	startedAt := time.Now().UTC()
	session := &processSession{
		id:          newID("sess"),
		projectID:   req.ProjectID,
		worktreeID:  req.WorktreeID,
		cwd:         req.Cwd,
		command:     append([]string(nil), command...),
		agentKind:   req.AgentKind,
		tabID:       req.TabID,
		leafID:      req.LeafID,
		launchToken: req.LaunchToken,
		prompt:      req.Prompt,
		status:      SessionStarting,
		startedAt:   startedAt,
		updatedAt:   startedAt,
		cols:        cols,
		rows:        rows,
		output:      make([]OutputChunk, 0, 256),
		emit:        emit,
	}
	if err := startPlatformProcessSession(ctx, session, req); err != nil {
		return nil, err
	}
	session.setStatus(SessionRunning)
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
		TabID:        s.tabID,
		LeafID:       s.leafID,
		LaunchToken:  s.launchToken,
		Prompt:       s.prompt,
		Status:       s.status,
		ExitCode:     cloneExitCode(s.exitCode),
		StartedAt:    s.startedAt,
		UpdatedAt:    s.updatedAt,
		OutputChunks: len(s.output),
		Cols:         s.cols,
		Rows:         s.rows,
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

func (s *processSession) resize(req SessionResizeRequest) (Session, error) {
	cols, rows := normalizeSessionSize(req.Cols, req.Rows)
	s.mu.RLock()
	resizePty := s.resizePty
	status := s.status
	s.mu.RUnlock()
	if status != SessionRunning {
		return Session{}, errors.New("session is not running")
	}
	if resizePty != nil {
		if err := resizePty(cols, rows); err != nil {
			return Session{}, err
		}
	}
	s.mu.Lock()
	s.cols = cols
	s.rows = rows
	s.updatedAt = time.Now().UTC()
	snapshot := s.snapshotLocked()
	s.mu.Unlock()
	return snapshot, nil
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

func (s *processSession) clearBuffer() Session {
	s.mu.Lock()
	s.output = s.output[:0]
	s.updatedAt = time.Now().UTC()
	snapshot := s.snapshotLocked()
	s.mu.Unlock()
	return snapshot
}

func (s *processSession) stop() (Session, error) {
	s.mu.Lock()
	if s.status == SessionExited || s.status == SessionStopped || s.status == SessionFailed {
		s.mu.Unlock()
		return s.snapshot(), nil
	}
	cmd := s.cmd
	stdin := s.stdin
	s.status = SessionStopped
	s.updatedAt = time.Now().UTC()
	s.mu.Unlock()
	if stdin != nil {
		_ = stdin.Close()
	}
	if cmd != nil && cmd.Process != nil {
		if err := cmd.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
			return Session{}, err
		}
	}
	return s.snapshot(), nil
}

func (s *processSession) readStream(stream string, reader io.Reader) {
	buffer := make([]byte, 8192)
	for {
		n, err := reader.Read(buffer)
		if n > 0 {
			s.appendOutput(stream, string(buffer[:n]))
		}
		if err != nil {
			if !errors.Is(err, io.EOF) && !errors.Is(err, os.ErrClosed) {
				s.appendOutput("stderr", err.Error()+"\n")
			}
			return
		}
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
		Cols:         s.cols,
		Rows:         s.rows,
	}
}

func normalizeSessionSize(cols int, rows int) (int, int) {
	if cols < 1 {
		cols = 80
	}
	if rows < 1 {
		rows = 24
	}
	if cols > 1000 {
		cols = 1000
	}
	if rows > 1000 {
		rows = 1000
	}
	return cols, rows
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
