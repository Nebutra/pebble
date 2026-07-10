package runtimecore

import (
	"bytes"
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
	altScreen   altScreenScanner
	// hookAgentState holds the latest agent-hook-reported readiness (working/
	// idle/permission); stateChanged is closed-and-replaced on every status or
	// hook transition so waiters can block without polling.
	hookAgentState   SessionHookState
	hookAgentStateAt time.Time
	stateChanged     chan struct{}
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
		id:           newID("sess"),
		projectID:    req.ProjectID,
		worktreeID:   req.WorktreeID,
		cwd:          req.Cwd,
		command:      append([]string(nil), command...),
		agentKind:    req.AgentKind,
		tabID:        req.TabID,
		leafID:       req.LeafID,
		launchToken:  req.LaunchToken,
		prompt:       req.Prompt,
		status:       SessionStarting,
		startedAt:    startedAt,
		updatedAt:    startedAt,
		cols:         cols,
		rows:         rows,
		output:       make([]OutputChunk, 0, 256),
		emit:         emit,
		stateChanged: make(chan struct{}),
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
	return s.buildSnapshotLocked()
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
	s.notifyStateChangedLocked()
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
	// Why: alt-screen smcup/rmcup sequences (e.g. ESC[?1049h) carry no newline,
	// so a line scanner would not observe them until the next newline — which a
	// full-screen TUI may never emit. Feed the raw bytes to the alt-screen
	// scanner as they arrive, then split into newline-delimited output chunks.
	buf := make([]byte, 4096)
	var pending []byte
	for {
		n, readErr := reader.Read(buf)
		if n > 0 {
			raw := buf[:n]
			if stream == "stdout" {
				s.mu.Lock()
				s.altScreen.Feed(raw)
				s.mu.Unlock()
			}
			pending = append(pending, raw...)
			pending = s.flushCompleteLines(stream, pending)
		}
		if readErr != nil {
			if len(pending) > 0 {
				s.appendOutput(stream, string(pending))
			}
			// A closed PTY surfaces as EOF or os.ErrClosed on the master fd; both
			// are normal session teardown, not stream errors worth surfacing.
			if !errors.Is(readErr, io.EOF) && !errors.Is(readErr, os.ErrClosed) {
				s.appendOutput("stderr", readErr.Error()+"\n")
			}
			return
		}
	}
}

// flushCompleteLines emits each newline-terminated line as its own output chunk
// (preserving the trailing newline) and returns the unterminated remainder.
func (s *processSession) flushCompleteLines(stream string, pending []byte) []byte {
	for {
		idx := bytes.IndexByte(pending, '\n')
		if idx < 0 {
			return pending
		}
		s.appendOutput(stream, string(pending[:idx+1]))
		pending = pending[idx+1:]
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
	s.notifyStateChangedLocked()
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
	s.notifyStateChangedLocked()
	s.mu.Unlock()
}

// notifyStateChangedLocked wakes wait callers after a status or hook-state
// transition. Close-and-replace broadcasts to every waiter at once.
func (s *processSession) notifyStateChangedLocked() {
	if s.stateChanged != nil {
		close(s.stateChanged)
	}
	s.stateChanged = make(chan struct{})
}

func (s *processSession) stateChangeChannel() <-chan struct{} {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.stateChanged
}

func (s *processSession) snapshotLocked() Session {
	return s.buildSnapshotLocked()
}

// buildSnapshotLocked builds the Session view under the caller-held lock. It
// includes altScreenActive but not the foreground process, which is resolved
// lazily on status reads via statusSnapshot to avoid a hot polling loop.
func (s *processSession) buildSnapshotLocked() Session {
	return Session{
		ID:               s.id,
		ProjectID:        s.projectID,
		WorktreeID:       s.worktreeID,
		Cwd:              s.cwd,
		Command:          append([]string(nil), s.command...),
		AgentKind:        s.agentKind,
		TabID:            s.tabID,
		LeafID:           s.leafID,
		LaunchToken:      s.launchToken,
		Prompt:           s.prompt,
		Status:           s.status,
		ExitCode:         cloneExitCode(s.exitCode),
		StartedAt:        s.startedAt,
		UpdatedAt:        s.updatedAt,
		OutputChunks:     len(s.output),
		Cols:             s.cols,
		Rows:             s.rows,
		AltScreenActive:  s.altScreen.Active(),
		HookAgentState:   s.hookAgentState,
		HookAgentStateAt: cloneHookStateAt(s.hookAgentStateAt),
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

// statusSnapshot returns a snapshot enriched with the terminal foreground
// process. Foreground resolution runs one bounded ps probe here — on status
// reads only — rather than in a hot loop, per the runtime's polling budget.
func (s *processSession) statusSnapshot() Session {
	s.mu.RLock()
	snapshot := s.buildSnapshotLocked()
	pid := 0
	if s.cmd != nil && s.cmd.Process != nil {
		pid = s.cmd.Process.Pid
	}
	running := s.status == SessionRunning
	s.mu.RUnlock()

	if !foregroundProcessSupported {
		snapshot.ForegroundProcessUnsupportedReason = foregroundProcessUnsupportedReason
		return snapshot
	}
	if running {
		if name, ok := resolveForegroundProcessName(pid); ok {
			snapshot.ForegroundProcess = &name
		}
	}
	return snapshot
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

func cloneHookStateAt(value time.Time) *time.Time {
	if value.IsZero() {
		return nil
	}
	copied := value
	return &copied
}

func cloneExitCode(value *int) *int {
	if value == nil {
		return nil
	}
	copied := *value
	return &copied
}
