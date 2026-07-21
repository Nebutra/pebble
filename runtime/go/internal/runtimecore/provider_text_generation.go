package runtimecore

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	defaultProviderTextGenerationTimeout = 60 * time.Second
	maxProviderTextGenerationTimeout     = 120 * time.Second
	maxProviderTextGenerationOutputBytes = 8 * 1024 * 1024
	maxProviderTextGenerationInputBytes  = 8 * 1024 * 1024
	maxProviderTextGenerationArgs        = 256
	maxProviderTextGenerationArgBytes    = 64 * 1024
)

var ErrTextGenerationInvalidRequest = errors.New("invalid text-generation request")

type ProviderTextGenerationTarget struct {
	Kind        string `json:"kind"`
	SshTargetID string `json:"sshTargetId,omitempty"`
}

type ProviderTextGenerationPlan struct {
	LaneKey      string                       `json:"laneKey"`
	Target       ProviderTextGenerationTarget `json:"target"`
	Cwd          string                       `json:"cwd"`
	Binary       string                       `json:"binary"`
	Args         []string                     `json:"args"`
	StdinPayload *string                      `json:"stdinPayload,omitempty"`
	TimeoutMs    int64                        `json:"timeoutMs"`
	MaxOutput    int                          `json:"maxOutputBytes"`
}

type ProviderTextGenerationResult struct {
	Stdout     string  `json:"stdout"`
	Stderr     string  `json:"stderr"`
	ExitCode   *int    `json:"exitCode"`
	TimedOut   bool    `json:"timedOut"`
	Canceled   bool    `json:"canceled"`
	SpawnError *string `json:"spawnError"`
}

type textGenerationCancellation struct {
	id     string
	cancel context.CancelFunc
}

func (m *Manager) ExecuteProviderTextGeneration(ctx context.Context, plan ProviderTextGenerationPlan) ProviderTextGenerationResult {
	if err := validateProviderTextGenerationPlan(plan); err != nil {
		return providerTextGenerationSpawnFailure("invalid_request")
	}
	runCtx, cancel := context.WithTimeout(ctx, providerTextGenerationTimeout(plan.TimeoutMs))
	token := newID("textgen")
	if !m.registerTextGeneration(plan.LaneKey, token, cancel) {
		cancel()
		return providerTextGenerationSpawnFailure("runtime_unavailable")
	}
	defer func() {
		cancel()
		m.unregisterTextGeneration(plan.LaneKey, token)
	}()

	var result ProviderTextGenerationResult
	if plan.Target.Kind == "ssh" {
		result = m.executeSshProviderTextGeneration(runCtx, plan)
	} else {
		result = ExecuteProviderTextGenerationPlan(runCtx, plan)
	}
	if errors.Is(runCtx.Err(), context.DeadlineExceeded) {
		result.TimedOut = true
		result.Canceled = false
	} else if errors.Is(runCtx.Err(), context.Canceled) || errors.Is(ctx.Err(), context.Canceled) {
		result.Canceled = true
		result.TimedOut = false
	}
	return result
}

func (m *Manager) CancelProviderTextGeneration(laneKey string) bool {
	laneKey = strings.TrimSpace(laneKey)
	if laneKey == "" {
		return false
	}
	m.textGenerationMu.Lock()
	entry, ok := m.textGenerationCancels[laneKey]
	m.textGenerationMu.Unlock()
	if ok {
		entry.cancel()
	}
	return ok
}

func (m *Manager) registerTextGeneration(laneKey, token string, cancel context.CancelFunc) bool {
	m.textGenerationMu.Lock()
	defer m.textGenerationMu.Unlock()
	if previous, ok := m.textGenerationCancels[laneKey]; ok {
		// Why: one UI lane owns one generation; replacing it must terminate the
		// stale provider process before the new result can race into the draft.
		previous.cancel()
	}
	m.textGenerationCancels[laneKey] = textGenerationCancellation{id: token, cancel: cancel}
	return true
}

func (m *Manager) unregisterTextGeneration(laneKey, token string) {
	m.textGenerationMu.Lock()
	defer m.textGenerationMu.Unlock()
	if current, ok := m.textGenerationCancels[laneKey]; ok && current.id == token {
		delete(m.textGenerationCancels, laneKey)
	}
}

func ExecuteProviderTextGenerationPlan(ctx context.Context, plan ProviderTextGenerationPlan) ProviderTextGenerationResult {
	if err := validateProviderTextGenerationPlan(plan); err != nil {
		return providerTextGenerationSpawnFailure("invalid_request")
	}
	if _, err := os.Stat(plan.Cwd); err != nil {
		return providerTextGenerationSpawnFailure("cwd_unavailable")
	}
	command := exec.Command(plan.Binary, plan.Args...)
	command.Dir = plan.Cwd
	configureTextGenerationProcess(command)
	if plan.StdinPayload != nil {
		command.Stdin = strings.NewReader(*plan.StdinPayload)
	}
	budget := newTextGenerationOutputBudget(providerTextGenerationOutputLimit(plan.MaxOutput))
	stdout := budget.writer()
	stderr := budget.writer()
	command.Stdout = stdout
	command.Stderr = stderr
	if err := command.Start(); err != nil {
		if errors.Is(err, exec.ErrNotFound) || errors.Is(err, os.ErrNotExist) {
			return providerTextGenerationSpawnFailure("binary_not_found")
		}
		return providerTextGenerationSpawnFailure("spawn_failed")
	}

	wait := make(chan error, 1)
	go func() { wait <- command.Wait() }()
	var waitErr error
	select {
	case waitErr = <-wait:
	case <-ctx.Done():
		killTextGenerationProcess(command)
		waitErr = <-wait
	}
	result := ProviderTextGenerationResult{Stdout: stdout.String(), Stderr: stderr.String()}
	if budget.overflowed() {
		result.SpawnError = textGenerationStringPointer("output_limit_exceeded")
		return result
	}
	if waitErr == nil {
		zero := 0
		result.ExitCode = &zero
		return result
	}
	if exitError, ok := waitErr.(*exec.ExitError); ok {
		code := exitError.ExitCode()
		result.ExitCode = &code
		return result
	}
	result.SpawnError = textGenerationStringPointer("process_failed")
	return result
}

func validateProviderTextGenerationPlan(plan ProviderTextGenerationPlan) error {
	if strings.TrimSpace(plan.LaneKey) == "" || len(plan.LaneKey) > 4096 || strings.ContainsRune(plan.LaneKey, 0) {
		return ErrTextGenerationInvalidRequest
	}
	if strings.TrimSpace(plan.Cwd) == "" || !filepath.IsAbs(plan.Cwd) || strings.ContainsRune(plan.Cwd, 0) {
		return ErrTextGenerationInvalidRequest
	}
	if strings.TrimSpace(plan.Binary) == "" || len(plan.Binary) > maxProviderTextGenerationArgBytes || strings.ContainsRune(plan.Binary, 0) {
		return ErrTextGenerationInvalidRequest
	}
	if plan.Target.Kind != "local" && plan.Target.Kind != "ssh" {
		return ErrTextGenerationInvalidRequest
	}
	if plan.Target.Kind == "ssh" && strings.TrimSpace(plan.Target.SshTargetID) == "" {
		return ErrTextGenerationInvalidRequest
	}
	if len(plan.Args) > maxProviderTextGenerationArgs {
		return ErrTextGenerationInvalidRequest
	}
	for _, arg := range plan.Args {
		if len(arg) > maxProviderTextGenerationArgBytes || strings.ContainsRune(arg, 0) {
			return ErrTextGenerationInvalidRequest
		}
	}
	if plan.StdinPayload != nil && len(*plan.StdinPayload) > maxProviderTextGenerationInputBytes {
		return ErrTextGenerationInvalidRequest
	}
	return nil
}

func providerTextGenerationTimeout(timeoutMs int64) time.Duration {
	if timeoutMs <= 0 {
		return defaultProviderTextGenerationTimeout
	}
	duration := time.Duration(timeoutMs) * time.Millisecond
	if duration < time.Second {
		return time.Second
	}
	if duration > maxProviderTextGenerationTimeout {
		return maxProviderTextGenerationTimeout
	}
	return duration
}

func providerTextGenerationOutputLimit(limit int) int {
	if limit < 1024 {
		return 1024
	}
	if limit > maxProviderTextGenerationOutputBytes {
		return maxProviderTextGenerationOutputBytes
	}
	return limit
}

func providerTextGenerationSpawnFailure(code string) ProviderTextGenerationResult {
	return ProviderTextGenerationResult{SpawnError: textGenerationStringPointer(code)}
}

func textGenerationStringPointer(value string) *string { return &value }

type textGenerationOutputBudget struct {
	mu       sync.Mutex
	limit    int
	written  int
	overflow bool
}

type textGenerationOutputWriter struct {
	budget *textGenerationOutputBudget
	buffer bytes.Buffer
}

func newTextGenerationOutputBudget(limit int) *textGenerationOutputBudget {
	return &textGenerationOutputBudget{limit: limit}
}

func (budget *textGenerationOutputBudget) writer() *textGenerationOutputWriter {
	return &textGenerationOutputWriter{budget: budget}
}

func (writer *textGenerationOutputWriter) Write(input []byte) (int, error) {
	original := len(input)
	writer.budget.mu.Lock()
	defer writer.budget.mu.Unlock()
	remaining := writer.budget.limit - writer.budget.written
	if remaining < len(input) {
		writer.budget.overflow = true
	}
	if remaining > 0 {
		if len(input) > remaining {
			input = input[:remaining]
		}
		written, _ := writer.buffer.Write(input)
		writer.budget.written += written
	}
	return original, nil
}

func (writer *textGenerationOutputWriter) String() string { return writer.buffer.String() }

func (budget *textGenerationOutputBudget) overflowed() bool {
	budget.mu.Lock()
	defer budget.mu.Unlock()
	return budget.overflow
}

func (m *Manager) executeSshProviderTextGeneration(ctx context.Context, plan ProviderTextGenerationPlan) ProviderTextGenerationResult {
	payload, err := marshalBoundedRelayInput(plan, maxProviderTextGenerationInputBytes+maxProviderTextGenerationOutputBytes)
	if err != nil {
		return providerTextGenerationSpawnFailure("invalid_request")
	}
	output, err := m.runSshRelayWorkerWithInputTimeout(ctx, plan.Target.SshTargetID, []string{"provider-text-generation-json"}, payload, maxProviderTextGenerationTimeout)
	if err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return ProviderTextGenerationResult{}
		}
		return providerTextGenerationSpawnFailure("ssh_unavailable")
	}
	var result ProviderTextGenerationResult
	if err := unmarshalBoundedRelayOutput(output, &result); err != nil {
		return providerTextGenerationSpawnFailure("invalid_remote_response")
	}
	return result
}

func marshalBoundedRelayInput(value any, limit int) ([]byte, error) {
	var output bytes.Buffer
	limited := &boundedWriteBuffer{writer: &output, remaining: limit}
	if err := encodeJSON(limited, value); err != nil {
		return nil, err
	}
	return output.Bytes(), nil
}

func unmarshalBoundedRelayOutput(input []byte, target any) error {
	return decodeJSON(bytes.NewReader(input), target)
}

type boundedWriteBuffer struct {
	writer    io.Writer
	remaining int
}

func (writer *boundedWriteBuffer) Write(input []byte) (int, error) {
	if len(input) > writer.remaining {
		return 0, fmt.Errorf("payload exceeds limit")
	}
	written, err := writer.writer.Write(input)
	writer.remaining -= written
	return written, err
}
