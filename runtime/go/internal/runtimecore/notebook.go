package runtimecore

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

const notebookTimeout = 60 * time.Second
const notebookCaptureLimit = 2 * 1024 * 1024

type NotebookRunPythonCellRequest struct {
	FilePath     string  `json:"filePath"`
	Code         string  `json:"code"`
	Preamble     string  `json:"preamble,omitempty"`
	ConnectionID *string `json:"connectionId,omitempty"`
}

type NotebookRunResult struct {
	Stdout   string `json:"stdout"`
	Stderr   string `json:"stderr"`
	ExitCode *int   `json:"exitCode"`
	Error    string `json:"error,omitempty"`
}

type notebookPythonCandidate struct {
	command string
	prefix  []string
}

func (m *Manager) RunNotebookPythonCell(parent context.Context, req NotebookRunPythonCellRequest) (NotebookRunResult, error) {
	if req.ConnectionID != nil && strings.TrimSpace(*req.ConnectionID) != "" {
		return NotebookRunResult{Error: "Notebook execution is currently supported for local files only."}, nil
	}
	if len(req.FilePath) == 0 || len(req.FilePath) > 32*1024 || strings.ContainsAny(req.FilePath, "\x00\r\n") {
		return NotebookRunResult{}, errors.New("invalid notebook file path")
	}
	resolved, err := filepath.EvalSymlinks(req.FilePath)
	if err != nil {
		return NotebookRunResult{}, fmt.Errorf("could not resolve notebook file: %w", err)
	}
	info, err := os.Stat(resolved)
	if err != nil || !info.Mode().IsRegular() {
		return NotebookRunResult{}, errors.New("notebook file is not a regular file")
	}
	if !m.notebookPathAuthorized(resolved) {
		return NotebookRunResult{}, errors.New("notebook file is outside registered workspaces")
	}
	if strings.TrimSpace(req.Code) == "" && strings.TrimSpace(req.Preamble) == "" {
		zero := 0
		return NotebookRunResult{ExitCode: &zero}, nil
	}
	for _, candidate := range notebookPythonCandidates() {
		result, notFound := runNotebookPythonCandidate(parent, candidate, req, filepath.Dir(resolved))
		if !notFound {
			return result, nil
		}
	}
	return NotebookRunResult{Error: "Python was not found."}, nil
}

func (m *Manager) notebookPathAuthorized(resolvedFile string) bool {
	m.mu.RLock()
	roots := make([]string, 0, len(m.projects)+len(m.worktrees))
	for _, project := range m.projects {
		if strings.TrimSpace(project.Path) != "" && project.LocationKind != "ssh" {
			roots = append(roots, project.Path)
		}
	}
	for _, worktree := range m.worktrees {
		if strings.TrimSpace(worktree.Path) != "" {
			roots = append(roots, worktree.Path)
		}
	}
	m.mu.RUnlock()
	for _, root := range roots {
		resolvedRoot, err := filepath.EvalSymlinks(root)
		if err == nil && requirePathInsideWorkspace(resolvedRoot, resolvedFile) == nil {
			return true
		}
	}
	return false
}

func notebookPythonCandidates() []notebookPythonCandidate {
	candidates := make([]notebookPythonCandidate, 0, 4)
	if configured := strings.TrimSpace(os.Getenv("PEBBLE_NOTEBOOK_PYTHON")); configured != "" {
		candidates = append(candidates, notebookPythonCandidate{command: configured})
	}
	if runtime.GOOS == "windows" {
		candidates = append(candidates, notebookPythonCandidate{command: "py", prefix: []string{"-3"}})
	}
	return append(candidates,
		notebookPythonCandidate{command: "python3"},
		notebookPythonCandidate{command: "python"},
	)
}

func runNotebookPythonCandidate(parent context.Context, candidate notebookPythonCandidate, req NotebookRunPythonCellRequest, cwd string) (NotebookRunResult, bool) {
	payload, _ := json.Marshal(map[string]string{"code": req.Code, "preamble": req.Preamble})
	script := notebookPythonScript(base64.StdEncoding.EncodeToString(payload))
	ctx, cancel := context.WithTimeout(parent, notebookTimeout)
	defer cancel()
	cmd := exec.Command(candidate.command, append(candidate.prefix, "-c", script)...)
	cmd.Dir = cwd
	cmd.Env = os.Environ()
	configureNotebookProcess(cmd)
	stdout := &boundedNotebookCapture{}
	stderr := &boundedNotebookCapture{}
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	if err := cmd.Start(); err != nil {
		return NotebookRunResult{Error: err.Error()}, errors.Is(err, exec.ErrNotFound)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		code := 0
		if err != nil {
			if exitError, ok := err.(*exec.ExitError); ok {
				code = exitError.ExitCode()
			} else {
				return NotebookRunResult{Stdout: stdout.String(), Stderr: stderr.String(), Error: err.Error()}, false
			}
		}
		return NotebookRunResult{Stdout: stdout.String(), Stderr: stderr.String(), ExitCode: &code}, false
	case <-ctx.Done():
		terminateNotebookProcessTree(cmd)
		return NotebookRunResult{Stdout: stdout.String(), Stderr: stderr.String(), Error: "Python cell timed out."}, false
	}
}

func notebookPythonScript(payload string) string {
	return strings.Join([]string{
		"import base64, contextlib, io, json, sys, traceback",
		fmt.Sprintf("payload = json.loads(base64.b64decode(%q).decode(\"utf-8\"))", payload),
		"namespace = {\"__name__\": \"__main__\"}",
		"try:",
		"    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):",
		"        exec(payload[\"preamble\"], namespace)",
		"    exec(payload[\"code\"], namespace)",
		"except Exception:",
		"    traceback.print_exc()",
		"    sys.exit(1)",
	}, "\n")
}

type boundedNotebookCapture struct {
	buffer    bytes.Buffer
	truncated bool
	mu        sync.Mutex
}

func (capture *boundedNotebookCapture) Write(chunk []byte) (int, error) {
	capture.mu.Lock()
	defer capture.mu.Unlock()
	original := len(chunk)
	if capture.truncated {
		return original, nil
	}
	remaining := notebookCaptureLimit - capture.buffer.Len()
	if remaining <= 0 {
		capture.truncated = true
		return original, nil
	}
	if len(chunk) > remaining {
		_, _ = capture.buffer.Write(chunk[:remaining])
		_, _ = capture.buffer.WriteString("\n[output truncated]\n")
		capture.truncated = true
		return original, nil
	}
	_, _ = capture.buffer.Write(chunk)
	return original, nil
}

func (capture *boundedNotebookCapture) String() string {
	capture.mu.Lock()
	defer capture.mu.Unlock()
	return capture.buffer.String()
}
