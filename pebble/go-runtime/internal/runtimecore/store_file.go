package runtimecore

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

const persistedStateSchemaVersion = 1

type persistedState struct {
	SchemaVersion      int                          `json:"schemaVersion"`
	RelayID            string                       `json:"relayId"`
	Projects           []Project                    `json:"projects"`
	ProjectGroups      []ProjectGroup               `json:"projectGroups"`
	FolderWorkspaces   []FolderWorkspace            `json:"folderWorkspaces"`
	Worktrees          []Worktree                   `json:"worktrees"`
	Agents             []AgentProfile               `json:"agents"`
	AgentRuns          []AgentRun                   `json:"agentRuns"`
	Tasks              []Task                       `json:"tasks"`
	Messages           []Message                    `json:"messages"`
	Dispatches         []Dispatch                   `json:"dispatches"`
	Automations        []Automation                 `json:"automations"`
	AutomationRuns     []AutomationRun              `json:"automationRuns"`
	ExternalWorkItems  []ExternalWorkItem           `json:"externalWorkItems"`
	SourceControl      []SourceControlProjection    `json:"sourceControl"`
	Releases           []ReleasePlan                `json:"releases"`
	RemoteFileTrees    []RemoteFileTreeSnapshot     `json:"remoteFileTrees"`
	RemoteFileContents []RemoteFileContentSnapshot  `json:"remoteFileContents"`
	Settings           []RuntimeSetting             `json:"settings"`
	Keybindings        []Keybinding                 `json:"keybindings"`
	BrowserTabs        []BrowserTab                 `json:"browserTabs"`
	BrowserProfiles    []BrowserProfile             `json:"browserProfiles"`
	BrowserPerms       []BrowserPermission          `json:"browserPermissions"`
	BrowserDownloads   []BrowserDownload            `json:"browserDownloads"`
	ComputerActions    []ComputerAction             `json:"computerActions"`
	EmulatorDevices    []EmulatorDevice             `json:"emulatorDevices"`
	EmulatorSessions   []EmulatorSession            `json:"emulatorSessions"`
	NativeProviders    []NativeProviderRegistration `json:"nativeProviders"`
	MobilePairings     []MobileRelayPairingRecord   `json:"mobilePairings"`
	SshTargets         []SshTarget                  `json:"sshTargets"`
}

type fileStore struct {
	path string
}

func newFileStore(dataDir string) (*fileStore, error) {
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return nil, err
	}
	return &fileStore{path: filepath.Join(dataDir, "runtime-state.json")}, nil
}

func (s *fileStore) load() (persistedState, error) {
	var state persistedState
	content, err := os.ReadFile(s.path)
	if err != nil {
		if os.IsNotExist(err) {
			return state, nil
		}
		return state, err
	}
	if len(content) == 0 {
		return state, nil
	}
	if err := json.Unmarshal(content, &state); err != nil {
		return state, err
	}
	if state.SchemaVersion > persistedStateSchemaVersion {
		return state, fmt.Errorf("unsupported runtime state schema version %d", state.SchemaVersion)
	}
	return state, nil
}

func (s *fileStore) save(state persistedState) error {
	state.SchemaVersion = persistedStateSchemaVersion
	content, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	dir := filepath.Dir(s.path)
	tmpFile, err := os.CreateTemp(dir, ".runtime-state-*.tmp")
	if err != nil {
		return err
	}
	tmp := tmpFile.Name()
	defer func() {
		_ = os.Remove(tmp)
	}()
	if _, err := tmpFile.Write(content); err != nil {
		_ = tmpFile.Close()
		return err
	}
	if err := tmpFile.Sync(); err != nil {
		_ = tmpFile.Close()
		return err
	}
	if err := tmpFile.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp, s.path); err != nil {
		return err
	}
	return syncStoreDirectory(dir)
}
