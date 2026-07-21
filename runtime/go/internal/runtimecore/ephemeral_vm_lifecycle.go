package runtimecore

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

const ephemeralVMOutputLimit = 1024 * 1024

type EphemeralVMRuntimeRecord struct {
	ID                   string          `json:"id"`
	RecipeID             string          `json:"recipeId"`
	RepoID               string          `json:"repoId,omitempty"`
	ProjectID            string          `json:"projectId,omitempty"`
	WorkspaceID          string          `json:"workspaceId,omitempty"`
	WorkspaceName        string          `json:"workspaceName,omitempty"`
	ConnectionMode       string          `json:"connectionMode,omitempty"`
	RuntimeEnvironmentID string          `json:"runtimeEnvironmentId,omitempty"`
	SshTargetID          string          `json:"sshTargetId,omitempty"`
	Status               string          `json:"status"`
	CleanupStatus        string          `json:"cleanupStatus"`
	CleanupDisabled      bool            `json:"cleanupDisabled,omitempty"`
	CleanupLastAttemptAt int64           `json:"cleanupLastAttemptAt,omitempty"`
	CleanupLastError     string          `json:"cleanupLastError,omitempty"`
	CreatedAt            int64           `json:"createdAt"`
	UpdatedAt            int64           `json:"updatedAt"`
	RecipeResult         json.RawMessage `json:"recipeResult"`
}

type EphemeralVMProvisionRequest struct {
	RepoID        string `json:"repoId"`
	RecipeID      string `json:"recipeId"`
	WorkspaceName string `json:"workspaceName,omitempty"`
	ProjectID     string `json:"projectId,omitempty"`
	WorkspaceID   string `json:"workspaceId,omitempty"`
	ProvisionID   string `json:"provisionId,omitempty"`
}

type EphemeralVMProvisionResult struct {
	OK             bool                      `json:"ok"`
	ConnectionType string                    `json:"connectionType,omitempty"`
	Runtime        *EphemeralVMRuntimeRecord `json:"runtime,omitempty"`
	Connection     json.RawMessage           `json:"connection,omitempty"`
	Error          string                    `json:"error,omitempty"`
	Stdout         string                    `json:"stdout,omitempty"`
	Stderr         string                    `json:"stderr"`
	Warnings       []interface{}             `json:"warnings"`
}

type ephemeralVMStore struct {
	Version  int                        `json:"version"`
	Runtimes []EphemeralVMRuntimeRecord `json:"runtimes"`
}
type ephemeralVMContext struct{ InstanceID, RecipeID, ProjectID, WorkspaceID, WorkspaceName, RepoPath string }
type ephemeralVMProcessResult struct {
	Stdout, Stderr string
	ExitCode       int
	Cancelled      bool
}

func (m *Manager) ListEphemeralVMRuntimes() ([]EphemeralVMRuntimeRecord, error) {
	m.ephemeralVMMu.Lock()
	defer m.ephemeralVMMu.Unlock()
	store, err := m.readEphemeralVMStore()
	if err != nil {
		return nil, err
	}
	sort.Slice(store.Runtimes, func(i, j int) bool { return store.Runtimes[i].CreatedAt > store.Runtimes[j].CreatedAt })
	return store.Runtimes, nil
}

func (m *Manager) ProvisionEphemeralVM(parent context.Context, input EphemeralVMProvisionRequest) EphemeralVMProvisionResult {
	project, err := m.localGitProject(strings.TrimSpace(input.RepoID))
	if err != nil {
		return ephemeralVMFailure(err, "", "")
	}
	recipes, _ := readEphemeralVMRecipes(project.Path)
	recipe := findEphemeralVMRecipe(recipes, input.RecipeID)
	if recipe == nil {
		return ephemeralVMFailure(fmt.Errorf("recipe not found: %s", input.RecipeID), "", "")
	}
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	if input.ProvisionID != "" {
		m.registerEphemeralVMCancel(input.ProvisionID, cancel)
		defer m.unregisterEphemeralVMCancel(input.ProvisionID)
	}
	instanceID := newID("pebble")
	recipeContext := ephemeralVMContext{InstanceID: instanceID, RecipeID: recipe.ID, ProjectID: input.ProjectID, WorkspaceID: input.WorkspaceID, WorkspaceName: input.WorkspaceName, RepoPath: project.Path}
	result, err := m.runEphemeralVMCommand(ctx, recipe.Create, project.Path, "create", recipeContext, nil, input.ProvisionID)
	if err != nil {
		return ephemeralVMFailure(err, result.Stdout, result.Stderr)
	}
	parsed, connection, mode, err := parseEphemeralVMResult(result.Stdout)
	if err != nil {
		return ephemeralVMFailure(err, result.Stdout, result.Stderr)
	}
	now := time.Now().UnixMilli()
	runtime := EphemeralVMRuntimeRecord{ID: instanceID, RecipeID: recipe.ID, RepoID: project.ID, ProjectID: input.ProjectID, WorkspaceID: input.WorkspaceID, WorkspaceName: input.WorkspaceName, ConnectionMode: mode, Status: "running", CleanupStatus: "not_started", CleanupDisabled: recipe.DestroyDisabled, CreatedAt: now, UpdatedAt: now, RecipeResult: parsed}
	if recipe.DestroyDisabled {
		runtime.CleanupStatus = "disabled"
	}
	if err := m.upsertEphemeralVMRuntime(runtime); err != nil {
		return ephemeralVMFailure(err, result.Stdout, result.Stderr)
	}
	return EphemeralVMProvisionResult{OK: true, ConnectionType: mode, Runtime: &runtime, Connection: connection, Stderr: redactEphemeralVMText(result.Stderr), Warnings: []interface{}{}}
}

func (m *Manager) CancelEphemeralVMProvision(id string) bool {
	m.ephemeralVMMu.Lock()
	cancel := m.ephemeralVMCancels[strings.TrimSpace(id)]
	if cancel != nil {
		delete(m.ephemeralVMCancels, strings.TrimSpace(id))
	}
	m.ephemeralVMMu.Unlock()
	if cancel == nil {
		return false
	}
	cancel()
	return true
}

func (m *Manager) AttachEphemeralVMWorkspace(runtimeID, workspaceID string) (EphemeralVMRuntimeRecord, error) {
	return m.updateEphemeralVMRuntime(runtimeID, func(record *EphemeralVMRuntimeRecord) {
		record.WorkspaceID = strings.TrimSpace(workspaceID)
		record.Status = "running"
	})
}

func (m *Manager) SetEphemeralVMConnection(runtimeID, environmentID, sshTargetID string) (EphemeralVMRuntimeRecord, error) {
	return m.updateEphemeralVMRuntime(runtimeID, func(record *EphemeralVMRuntimeRecord) {
		if environmentID != "" {
			record.RuntimeEnvironmentID = strings.TrimSpace(environmentID)
		}
		if sshTargetID != "" {
			record.SshTargetID = strings.TrimSpace(sshTargetID)
		}
	})
}

func (m *Manager) FindEphemeralVMRuntimeByWorkspace(workspaceID string) (*EphemeralVMRuntimeRecord, error) {
	runtimes, err := m.ListEphemeralVMRuntimes()
	if err != nil {
		return nil, err
	}
	for index := range runtimes {
		if runtimes[index].WorkspaceID == workspaceID && runtimes[index].Status != "cleaned" && runtimes[index].Status != "cleanup_pending" {
			return &runtimes[index], nil
		}
	}
	return nil, nil
}

func (m *Manager) EphemeralVMCleanupDetails(runtimeID string) (string, string, bool, error) {
	runtimeRecord, recipe, _, err := m.ephemeralVMRuntimeContext(runtimeID)
	if err != nil {
		return "", "", false, err
	}
	payload, _ := json.Marshal(map[string]interface{}{"schemaVersion": 1, "mode": "destroy", "recipeId": runtimeRecord.RecipeID, "instanceId": runtimeRecord.ID, "projectId": runtimeRecord.ProjectID, "workspaceId": runtimeRecord.WorkspaceID, "workspaceName": runtimeRecord.WorkspaceName, "recipeResult": json.RawMessage(runtimeRecord.RecipeResult)})
	if recipe.DestroyDisabled || recipe.Destroy == "" {
		return string(payload), "", true, nil
	}
	return string(payload), EphemeralVMCleanupCommand(recipe.Destroy, runtimeRecord), false, nil
}

func (m *Manager) RunEphemeralVMLifecycle(ctx context.Context, runtimeID, mode string) (EphemeralVMRuntimeRecord, error) {
	runtimeRecord, recipe, repoPath, err := m.ephemeralVMRuntimeContext(runtimeID)
	if err != nil {
		return EphemeralVMRuntimeRecord{}, err
	}
	if mode == "resume" && runtimeRecord.Status != "suspended" && runtimeRecord.Status != "resume_failed" {
		return runtimeRecord, nil
	}
	command := recipe.Destroy
	nextStatus, failedStatus := "cleaned", "cleanup_failed"
	if mode == "suspend" {
		command, nextStatus, failedStatus = recipe.Suspend, "suspended", "suspend_failed"
	}
	if mode == "resume" {
		command, nextStatus, failedStatus = recipe.Resume, "running", "resume_failed"
	}
	if mode == "destroy" {
		_, _ = m.updateEphemeralVMRuntime(runtimeID, func(record *EphemeralVMRuntimeRecord) {
			record.Status = "cleanup_pending"
			record.CleanupStatus = "running"
			record.CleanupLastAttemptAt = time.Now().UnixMilli()
		})
	}
	if command == "" || (mode == "destroy" && recipe.DestroyDisabled) {
		return m.updateEphemeralVMRuntime(runtimeID, func(record *EphemeralVMRuntimeRecord) {
			if mode == "destroy" {
				record.Status = "cleaned"
				record.CleanupStatus = "disabled"
			}
		})
	}
	payload, _ := json.Marshal(map[string]interface{}{"schemaVersion": 1, "mode": mode, "recipeId": runtimeRecord.RecipeID, "instanceId": runtimeRecord.ID, "projectId": runtimeRecord.ProjectID, "workspaceId": runtimeRecord.WorkspaceID, "workspaceName": runtimeRecord.WorkspaceName, "recipeResult": json.RawMessage(runtimeRecord.RecipeResult)})
	result, runErr := m.runEphemeralVMCommand(ctx, command, repoPath, mode, ephemeralVMContext{InstanceID: runtimeRecord.ID, RecipeID: runtimeRecord.RecipeID, ProjectID: runtimeRecord.ProjectID, WorkspaceID: runtimeRecord.WorkspaceID, WorkspaceName: runtimeRecord.WorkspaceName, RepoPath: repoPath}, append(payload, '\n'), "")
	if runErr != nil {
		failed, _ := m.updateEphemeralVMRuntime(runtimeID, func(record *EphemeralVMRuntimeRecord) {
			record.Status = failedStatus
			if mode == "destroy" {
				record.CleanupStatus = "failed"
				record.CleanupLastError = runErr.Error()
			}
		})
		return failed, fmt.Errorf("%s: %w: %s", mode, runErr, redactEphemeralVMText(result.Stderr))
	}
	var resumedResult json.RawMessage
	var resumedMode string
	if mode == "resume" {
		resumedResult, _, resumedMode, err = parseEphemeralVMResult(result.Stdout)
		if err != nil {
			failed, _ := m.updateEphemeralVMRuntime(runtimeID, func(record *EphemeralVMRuntimeRecord) { record.Status = "resume_failed" })
			return failed, fmt.Errorf("resume: %w", err)
		}
	}
	return m.updateEphemeralVMRuntime(runtimeID, func(record *EphemeralVMRuntimeRecord) {
		record.Status = nextStatus
		if mode == "destroy" {
			record.CleanupStatus = "succeeded"
		}
		if mode == "resume" {
			record.RecipeResult = resumedResult
			record.ConnectionMode = resumedMode
		}
	})
}

func (m *Manager) runEphemeralVMCommand(ctx context.Context, command, cwd, mode string, recipeContext ephemeralVMContext, stdin []byte, provisionID string) (ephemeralVMProcessResult, error) {
	cmd := ephemeralVMShellCommand(ctx, command)
	cmd.Dir = cwd
	cmd.Env = append(os.Environ(), "PEBBLE_VM_MODE="+mode, "PEBBLE_VM_INSTANCE_ID="+recipeContext.InstanceID, "PEBBLE_RECIPE_ID="+recipeContext.RecipeID, "PEBBLE_PROJECT_ID="+recipeContext.ProjectID, "PEBBLE_WORKSPACE_ID="+recipeContext.WorkspaceID, "PEBBLE_WORKSPACE_NAME="+recipeContext.WorkspaceName, "PEBBLE_REPO_PATH="+recipeContext.RepoPath)
	configureEphemeralVMProcess(cmd)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return ephemeralVMProcessResult{}, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return ephemeralVMProcessResult{}, err
	}
	input, err := cmd.StdinPipe()
	if err != nil {
		return ephemeralVMProcessResult{}, err
	}
	if err := cmd.Start(); err != nil {
		return ephemeralVMProcessResult{}, err
	}
	go func() { _, _ = input.Write(stdin); _ = input.Close() }()
	var outTail, errTail boundedTail
	var wg sync.WaitGroup
	wg.Add(2)
	go m.captureEphemeralVMStream(&wg, stdout, &outTail, provisionID, "stdout")
	go m.captureEphemeralVMStream(&wg, stderr, &errTail, provisionID, "stderr")
	waitErr := cmd.Wait()
	if ctx.Err() != nil {
		killEphemeralVMProcess(cmd)
		waitErr = ctx.Err()
	}
	wg.Wait()
	result := ephemeralVMProcessResult{Stdout: outTail.String(), Stderr: errTail.String(), ExitCode: 0, Cancelled: errors.Is(ctx.Err(), context.Canceled)}
	if waitErr != nil {
		if exit, ok := waitErr.(*exec.ExitError); ok {
			result.ExitCode = exit.ExitCode()
		}
		return result, waitErr
	}
	return result, nil
}

func (m *Manager) captureEphemeralVMStream(wg *sync.WaitGroup, reader io.Reader, tail *boundedTail, provisionID, stream string) {
	defer wg.Done()
	buffer := make([]byte, 32*1024)
	for {
		count, err := reader.Read(buffer)
		if count > 0 {
			chunk := string(buffer[:count])
			tail.Write(buffer[:count])
			if provisionID != "" {
				m.emit("ephemeral-vm.provision", map[string]string{"provisionId": provisionID, "stream": stream, "chunk": redactEphemeralVMText(chunk)})
			}
		}
		if err != nil {
			return
		}
	}
}

type boundedTail struct{ data []byte }

func (b *boundedTail) Write(value []byte) {
	b.data = append(b.data, value...)
	if len(b.data) > ephemeralVMOutputLimit {
		b.data = append([]byte(nil), b.data[len(b.data)-ephemeralVMOutputLimit:]...)
	}
}
func (b *boundedTail) String() string { return string(b.data) }

func parseEphemeralVMResult(stdout string) (json.RawMessage, json.RawMessage, string, error) {
	raw := json.RawMessage(strings.TrimSpace(stdout))
	var result map[string]interface{}
	if len(raw) == 0 || json.Unmarshal(raw, &result) != nil {
		return nil, nil, "", errors.New("recipe stdout must be one JSON object")
	}
	if version, ok := result["schemaVersion"].(float64); !ok || version != 1 {
		return nil, nil, "", errors.New("recipe result schemaVersion must be 1")
	}
	connection := result["connection"]
	if connection == nil {
		connection = map[string]interface{}{"type": "pebble-server", "pairingCode": result["pairingCode"], "projectRoot": result["projectRoot"]}
	}
	encoded, _ := json.Marshal(connection)
	var details map[string]interface{}
	if json.Unmarshal(encoded, &details) != nil {
		return nil, nil, "", errors.New("recipe connection is invalid")
	}
	mode, _ := details["type"].(string)
	root, _ := details["projectRoot"].(string)
	if (mode != "ssh" && mode != "pebble-server") || strings.TrimSpace(root) == "" || !filepath.IsAbs(root) {
		return nil, nil, "", errors.New("recipe connection type or projectRoot is invalid")
	}
	return raw, encoded, mode, nil
}

func (m *Manager) ephemeralVMRuntimeContext(id string) (EphemeralVMRuntimeRecord, *EphemeralVMRecipe, string, error) {
	runtimes, err := m.ListEphemeralVMRuntimes()
	if err != nil {
		return EphemeralVMRuntimeRecord{}, nil, "", err
	}
	for _, record := range runtimes {
		if record.ID == id {
			listed := m.ListEphemeralVMRecipes(record.RepoID)
			recipe := findEphemeralVMRecipe(listed.Recipes, record.RecipeID)
			if recipe == nil || listed.RepoPath == nil {
				return record, nil, "", errors.New("runtime recipe is unavailable")
			}
			return record, recipe, *listed.RepoPath, nil
		}
	}
	return EphemeralVMRuntimeRecord{}, nil, "", fmt.Errorf("unknown ephemeral VM runtime: %s", id)
}
func findEphemeralVMRecipe(recipes []EphemeralVMRecipe, id string) *EphemeralVMRecipe {
	for index := range recipes {
		if recipes[index].ID == id {
			return &recipes[index]
		}
	}
	return nil
}
func (m *Manager) ephemeralVMStorePath() string {
	return filepath.Join(filepath.Dir(m.store.path), "ephemeral-vm-runtimes.json")
}
func (m *Manager) readEphemeralVMStore() (ephemeralVMStore, error) {
	data, err := os.ReadFile(m.ephemeralVMStorePath())
	if errors.Is(err, os.ErrNotExist) {
		return ephemeralVMStore{Version: 1, Runtimes: []EphemeralVMRuntimeRecord{}}, nil
	}
	if err != nil {
		return ephemeralVMStore{}, err
	}
	var store ephemeralVMStore
	if json.Unmarshal(data, &store) != nil || store.Version != 1 {
		return ephemeralVMStore{}, errors.New("ephemeral VM runtime store is invalid")
	}
	return store, nil
}
func (m *Manager) writeEphemeralVMStore(store ephemeralVMStore) error {
	data, err := json.MarshalIndent(store, "", "  ")
	if err != nil {
		return err
	}
	path := m.ephemeralVMStorePath()
	file, err := os.CreateTemp(filepath.Dir(path), ".ephemeral-vm-*.tmp")
	if err != nil {
		return err
	}
	temporary := file.Name()
	defer os.Remove(temporary)
	if _, err = file.Write(data); err == nil {
		err = file.Chmod(0o600)
	}
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return os.Rename(temporary, path)
}
func (m *Manager) upsertEphemeralVMRuntime(record EphemeralVMRuntimeRecord) error {
	m.ephemeralVMMu.Lock()
	defer m.ephemeralVMMu.Unlock()
	store, err := m.readEphemeralVMStore()
	if err != nil {
		return err
	}
	filtered := store.Runtimes[:0]
	for _, current := range store.Runtimes {
		if current.ID != record.ID {
			filtered = append(filtered, current)
		}
	}
	store.Runtimes = append(filtered, record)
	return m.writeEphemeralVMStore(store)
}
func (m *Manager) updateEphemeralVMRuntime(id string, update func(*EphemeralVMRuntimeRecord)) (EphemeralVMRuntimeRecord, error) {
	m.ephemeralVMMu.Lock()
	defer m.ephemeralVMMu.Unlock()
	store, err := m.readEphemeralVMStore()
	if err != nil {
		return EphemeralVMRuntimeRecord{}, err
	}
	for index := range store.Runtimes {
		if store.Runtimes[index].ID == id {
			update(&store.Runtimes[index])
			store.Runtimes[index].UpdatedAt = time.Now().UnixMilli()
			if err := m.writeEphemeralVMStore(store); err != nil {
				return EphemeralVMRuntimeRecord{}, err
			}
			return store.Runtimes[index], nil
		}
	}
	return EphemeralVMRuntimeRecord{}, fmt.Errorf("unknown ephemeral VM runtime: %s", id)
}
func (m *Manager) registerEphemeralVMCancel(id string, cancel context.CancelFunc) {
	m.ephemeralVMMu.Lock()
	m.ephemeralVMCancels[id] = cancel
	m.ephemeralVMMu.Unlock()
}
func (m *Manager) unregisterEphemeralVMCancel(id string) {
	m.ephemeralVMMu.Lock()
	delete(m.ephemeralVMCancels, id)
	m.ephemeralVMMu.Unlock()
}
func ephemeralVMFailure(err error, stdout, stderr string) EphemeralVMProvisionResult {
	return EphemeralVMProvisionResult{OK: false, Error: err.Error(), Stdout: redactEphemeralVMText(stdout), Stderr: redactEphemeralVMText(stderr), Warnings: []interface{}{}}
}

var ephemeralVMPairingCodePattern = regexp.MustCompile(`pebble://pair\?code=[A-Za-z0-9_-]+`)

func redactEphemeralVMText(value string) string {
	return ephemeralVMPairingCodePattern.ReplaceAllString(value, "pebble://pair?code=[redacted]")
}
func EphemeralVMCleanupCommand(command string, runtime EphemeralVMRuntimeRecord) string {
	payload, _ := json.Marshal(map[string]interface{}{"schemaVersion": 1, "mode": "destroy", "recipeId": runtime.RecipeID, "instanceId": runtime.ID, "projectId": runtime.ProjectID, "workspaceId": runtime.WorkspaceID, "workspaceName": runtime.WorkspaceName, "recipeResult": json.RawMessage(runtime.RecipeResult)})
	return ephemeralVMCleanupShellCommand(command, append(payload, '\n'))
}
