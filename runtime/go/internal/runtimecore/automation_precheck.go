package runtimecore

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"runtime"
	"strings"
	"time"
)

// Limits mirror packages/product-core/shared/automation-precheck.ts so precheck behavior stays
// identical between the Electron reference and the native runtime.
const (
	defaultAutomationPrecheckTimeoutSeconds = 60
	maxAutomationPrecheckTimeoutSeconds     = 600
	maxAutomationPrecheckOutputChars        = 4000
	// Mirrors Electron's SIGTERM->SIGKILL grace so a timed-out precheck whose
	// children hold the output pipes cannot hang the scheduler.
	automationPrecheckKillGrace = 2 * time.Second
)

type AutomationPrecheck struct {
	Command        string `json:"command"`
	TimeoutSeconds int64  `json:"timeoutSeconds,omitempty"`
	// WorkingDir pins the precheck cwd explicitly; when empty the cwd is
	// resolved from the action payload (cwd, worktreeId, projectId).
	WorkingDir string `json:"workingDir,omitempty"`
}

// AutomationPrecheckResult mirrors the Electron AutomationPrecheckResult shape:
// exitCode is null on timeout/spawn error, output keeps only the tail.
type AutomationPrecheckResult struct {
	Command         string    `json:"command"`
	ExitCode        *int      `json:"exitCode"`
	TimedOut        bool      `json:"timedOut"`
	DurationMs      int64     `json:"durationMs"`
	Stdout          string    `json:"stdout"`
	Stderr          string    `json:"stderr"`
	StdoutTruncated bool      `json:"stdoutTruncated"`
	StderrTruncated bool      `json:"stderrTruncated"`
	Error           string    `json:"error,omitempty"`
	StartedAt       time.Time `json:"startedAt"`
	CompletedAt     time.Time `json:"completedAt"`
}

func normalizeAutomationPrecheck(precheck *AutomationPrecheck) *AutomationPrecheck {
	if precheck == nil {
		return nil
	}
	command := strings.TrimSpace(precheck.Command)
	if command == "" {
		return nil
	}
	timeout := precheck.TimeoutSeconds
	if timeout <= 0 {
		timeout = defaultAutomationPrecheckTimeoutSeconds
	}
	if timeout > maxAutomationPrecheckTimeoutSeconds {
		timeout = maxAutomationPrecheckTimeoutSeconds
	}
	return &AutomationPrecheck{
		Command:        command,
		TimeoutSeconds: timeout,
		WorkingDir:     strings.TrimSpace(precheck.WorkingDir),
	}
}

func automationPrecheckPassed(result AutomationPrecheckResult) bool {
	return !result.TimedOut && result.Error == "" && result.ExitCode != nil && *result.ExitCode == 0
}

func formatAutomationPrecheckFailure(result AutomationPrecheckResult) string {
	if result.TimedOut {
		seconds := result.DurationMs / 1000
		if seconds < 1 {
			seconds = 1
		}
		return fmt.Sprintf("Precheck timed out after %ds.", seconds)
	}
	if result.Error != "" {
		return "Precheck failed: " + result.Error
	}
	if result.ExitCode != nil {
		return fmt.Sprintf("Precheck exited with code %d.", *result.ExitCode)
	}
	return "Precheck exited with code unknown."
}

// resolveAutomationPrecheckCwd finds the workspace directory a precheck must
// run in: an explicit WorkingDir wins, then the action payload's cwd, then the
// worktree/project the automation targets. Mirrors Electron's rule that a
// precheck without a resolvable run target cannot pass.
func (m *Manager) resolveAutomationPrecheckCwd(automation Automation) (string, error) {
	if automation.Precheck != nil && automation.Precheck.WorkingDir != "" {
		return automation.Precheck.WorkingDir, nil
	}
	payload := automation.Action.Payload
	if cwd, ok := payload["cwd"].(string); ok && strings.TrimSpace(cwd) != "" {
		return strings.TrimSpace(cwd), nil
	}
	m.mu.RLock()
	defer m.mu.RUnlock()
	if worktreeID, ok := payload["worktreeId"].(string); ok && worktreeID != "" {
		if worktree, exists := m.worktrees[worktreeID]; exists && worktree.Path != "" {
			return worktree.Path, nil
		}
	}
	if projectID, ok := payload["projectId"].(string); ok && projectID != "" {
		if project, exists := m.projects[projectID]; exists && project.Path != "" {
			return project.Path, nil
		}
	}
	return "", errors.New("no working directory could be resolved for the automation precheck")
}

func failedAutomationPrecheckResult(precheck AutomationPrecheck, startedAt time.Time, message string) AutomationPrecheckResult {
	return AutomationPrecheckResult{
		Command:     precheck.Command,
		Error:       message,
		StartedAt:   startedAt,
		CompletedAt: startedAt,
	}
}

// runAutomationPrecheck executes the precheck shell command bounded by its
// timeout. Success is exit code 0; timeout and spawn failures report a null
// exit code, matching Electron's precheck-runner semantics.
func runAutomationPrecheck(ctx context.Context, precheck AutomationPrecheck, cwd string) AutomationPrecheckResult {
	startedAt := time.Now().UTC()
	runCtx, cancel := context.WithTimeout(ctx, time.Duration(precheck.TimeoutSeconds)*time.Second)
	defer cancel()

	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.CommandContext(runCtx, "cmd", "/C", precheck.Command)
	} else {
		cmd = exec.CommandContext(runCtx, "/bin/sh", "-c", precheck.Command)
	}
	cmd.Dir = cwd
	stdout := &automationPrecheckTail{}
	stderr := &automationPrecheckTail{}
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	cmd.WaitDelay = automationPrecheckKillGrace

	runErr := cmd.Run()
	completedAt := time.Now().UTC()
	result := AutomationPrecheckResult{
		Command:         precheck.Command,
		DurationMs:      completedAt.Sub(startedAt).Milliseconds(),
		Stdout:          stdout.String(),
		Stderr:          stderr.String(),
		StdoutTruncated: stdout.truncated,
		StderrTruncated: stderr.truncated,
		StartedAt:       startedAt,
		CompletedAt:     completedAt,
	}
	if errors.Is(runCtx.Err(), context.DeadlineExceeded) {
		result.TimedOut = true
		result.Error = fmt.Sprintf("Precheck timed out after %ds.", precheck.TimeoutSeconds)
		return result
	}
	if runErr != nil {
		var exitErr *exec.ExitError
		if errors.As(runErr, &exitErr) {
			code := exitErr.ExitCode()
			result.ExitCode = &code
			return result
		}
		result.Error = runErr.Error()
		return result
	}
	exitCode := 0
	result.ExitCode = &exitCode
	return result
}

// automationPrecheckTail keeps only the last maxAutomationPrecheckOutputChars
// bytes so a chatty precheck cannot bloat the persisted run record.
type automationPrecheckTail struct {
	content   []byte
	truncated bool
}

func (t *automationPrecheckTail) Write(p []byte) (int, error) {
	t.content = append(t.content, p...)
	if len(t.content) > maxAutomationPrecheckOutputChars {
		t.content = t.content[len(t.content)-maxAutomationPrecheckOutputChars:]
		t.truncated = true
	}
	return len(p), nil
}

func (t *automationPrecheckTail) String() string {
	return string(t.content)
}
