package runtimecore

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	// Git can hang behind credential helpers or network-backed hooks; runtime calls must stay bounded.
	gitCommandTimeout         = 30 * time.Second
	gitWorktreeCommandLimit   = 2 * time.Minute
	nativeProviderLivenessTTL = 2 * time.Minute
)

type Manager struct {
	mu                       sync.RWMutex
	startedAt                time.Time
	store                    *fileStore
	projects                 map[string]Project
	worktrees                map[string]Worktree
	agents                   map[string]AgentProfile
	agentRuns                map[string]AgentRun
	tasks                    map[string]Task
	messages                 map[string]Message
	dispatches               map[string]Dispatch
	automations              map[string]Automation
	automationRuns           map[string]AutomationRun
	externalWorkItems        map[string]ExternalWorkItem
	sourceControlProjections map[string]SourceControlProjection
	releases                 map[string]ReleasePlan
	remoteFileTrees          map[string]RemoteFileTreeSnapshot
	remoteFileContents       map[string]RemoteFileContentSnapshot
	settings                 map[string]RuntimeSetting
	keybindings              map[string]Keybinding
	browserTabs              map[string]BrowserTab
	browserProfiles          map[string]BrowserProfile
	browserPermissions       map[string]BrowserPermission
	browserDownloads         map[string]BrowserDownload
	computerActions          map[string]ComputerAction
	emulatorDevices          map[string]EmulatorDevice
	emulatorSessions         map[string]EmulatorSession
	nativeProviders          map[string]NativeProviderRegistration
	mobilePairings           map[string]MobileRelayPairingRecord
	mobilePairingCodes       map[string]MobileRelayPairingCode
	sessions                 map[string]*processSession
	subscribers              map[uint64]chan RuntimeEvent
	nextSubscriber           uint64
	unavailableTool          []string
	relayID                  string
}

func NewManager(dataDir string, unavailableTools []string) (*Manager, error) {
	store, err := newFileStore(dataDir)
	if err != nil {
		return nil, err
	}
	state, err := store.load()
	if err != nil {
		return nil, err
	}
	manager := &Manager{
		startedAt:                time.Now().UTC(),
		store:                    store,
		projects:                 make(map[string]Project),
		worktrees:                make(map[string]Worktree),
		agents:                   make(map[string]AgentProfile),
		agentRuns:                make(map[string]AgentRun),
		tasks:                    make(map[string]Task),
		messages:                 make(map[string]Message),
		dispatches:               make(map[string]Dispatch),
		automations:              make(map[string]Automation),
		automationRuns:           make(map[string]AutomationRun),
		externalWorkItems:        make(map[string]ExternalWorkItem),
		sourceControlProjections: make(map[string]SourceControlProjection),
		releases:                 make(map[string]ReleasePlan),
		remoteFileTrees:          make(map[string]RemoteFileTreeSnapshot),
		remoteFileContents:       make(map[string]RemoteFileContentSnapshot),
		settings:                 make(map[string]RuntimeSetting),
		keybindings:              make(map[string]Keybinding),
		browserTabs:              make(map[string]BrowserTab),
		browserProfiles:          make(map[string]BrowserProfile),
		browserPermissions:       make(map[string]BrowserPermission),
		browserDownloads:         make(map[string]BrowserDownload),
		computerActions:          make(map[string]ComputerAction),
		emulatorDevices:          make(map[string]EmulatorDevice),
		emulatorSessions:         make(map[string]EmulatorSession),
		nativeProviders:          make(map[string]NativeProviderRegistration),
		mobilePairings:           make(map[string]MobileRelayPairingRecord),
		mobilePairingCodes:       make(map[string]MobileRelayPairingCode),
		sessions:                 make(map[string]*processSession),
		subscribers:              make(map[uint64]chan RuntimeEvent),
		unavailableTool:          append([]string(nil), unavailableTools...),
		relayID:                  state.RelayID,
	}
	if manager.relayID == "" {
		manager.relayID = newID("relay")
	}
	for _, project := range state.Projects {
		manager.projects[project.ID] = project
	}
	migratedWorktreeInstances := false
	for _, worktree := range state.Worktrees {
		if worktree.InstanceID == "" {
			worktree.InstanceID = newID("wti")
			migratedWorktreeInstances = true
		}
		manager.worktrees[worktree.ID] = worktree
	}
	for _, agent := range state.Agents {
		manager.agents[agent.ID] = agent
	}
	for _, run := range state.AgentRuns {
		manager.agentRuns[run.ID] = run
	}
	for _, task := range state.Tasks {
		manager.tasks[task.ID] = task
	}
	for _, message := range state.Messages {
		manager.messages[message.ID] = message
	}
	for _, dispatch := range state.Dispatches {
		manager.dispatches[dispatch.ID] = dispatch
	}
	for _, automation := range state.Automations {
		manager.automations[automation.ID] = automation
	}
	for _, run := range state.AutomationRuns {
		manager.automationRuns[run.ID] = run
	}
	for _, item := range state.ExternalWorkItems {
		manager.externalWorkItems[item.ID] = item
	}
	for _, projection := range state.SourceControl {
		manager.sourceControlProjections[sourceControlProjectionKey(projection.RepositoryID, projection.WorkspaceID)] = projection
	}
	for _, release := range state.Releases {
		manager.releases[release.ID] = release
	}
	for _, snapshot := range state.RemoteFileTrees {
		manager.remoteFileTrees[remoteFileSnapshotKey(snapshot.ProjectID, snapshot.WorktreeID, snapshot.Path)] = snapshot
	}
	for _, snapshot := range state.RemoteFileContents {
		manager.remoteFileContents[remoteFileSnapshotKey(snapshot.ProjectID, snapshot.WorktreeID, snapshot.Path)] = snapshot
	}
	for _, setting := range state.Settings {
		manager.settings[settingKey(setting.Scope, setting.ProjectID, setting.WorkspaceID, setting.Key)] = setting
	}
	for _, keybinding := range state.Keybindings {
		manager.keybindings[keybindingKey(keybinding.Platform, keybinding.Context, keybinding.Command)] = keybinding
	}
	for _, tab := range state.BrowserTabs {
		manager.browserTabs[tab.ID] = tab
	}
	for _, profile := range state.BrowserProfiles {
		manager.browserProfiles[profile.ID] = profile
	}
	for _, permission := range state.BrowserPerms {
		manager.browserPermissions[permission.ID] = permission
	}
	for _, download := range state.BrowserDownloads {
		manager.browserDownloads[download.ID] = download
	}
	for _, action := range state.ComputerActions {
		manager.computerActions[action.ID] = action
	}
	for _, device := range state.EmulatorDevices {
		manager.emulatorDevices[device.ID] = device
	}
	for _, session := range state.EmulatorSessions {
		manager.emulatorSessions[session.ID] = session
	}
	for _, provider := range state.NativeProviders {
		if !isNativeProviderLive(provider, manager.startedAt) {
			continue
		}
		manager.nativeProviders[provider.ID] = provider
	}
	for _, pairing := range state.MobilePairings {
		manager.mobilePairings[pairing.DeviceID] = pairing
	}
	if migratedWorktreeInstances {
		if err := manager.saveLocked(); err != nil {
			return nil, err
		}
	}
	return manager, nil
}

func (m *Manager) Status() RuntimeStatus {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return RuntimeStatus{
		Version:          ProtocolVersion,
		StartedAt:        m.startedAt,
		UptimeSeconds:    int64(time.Since(m.startedAt).Seconds()),
		ProjectCount:     len(m.projects),
		WorktreeCount:    len(m.worktrees),
		SessionCount:     len(m.sessions),
		AgentRunCount:    len(m.agentRuns),
		TaskCount:        len(m.tasks),
		Capabilities:     allCapabilities(),
		UnavailableTools: append([]string(nil), m.unavailableTool...),
	}
}

func (m *Manager) CreateProject(req CreateProjectRequest) (Project, error) {
	name := strings.TrimSpace(req.Name)
	path := strings.TrimSpace(req.Path)
	if name == "" {
		name = pathBase(path)
	}
	locationKind, err := normalizeProjectLocationKind(req.LocationKind, true)
	if err != nil {
		return Project{}, err
	}
	if path == "" || !isAbsoluteForHost(path) {
		return Project{}, ErrInvalidPath
	}
	if locationKind == "local" {
		normalized, err := normalizeLocalPath(path)
		if err != nil {
			return Project{}, err
		}
		path = normalized
	}
	hostID := strings.TrimSpace(req.HostID)
	if locationKind == "ssh" && hostID == "" {
		return Project{}, errors.New("ssh project host id is required")
	}
	now := time.Now().UTC()
	project := Project{
		ID:           newID("proj"),
		Name:         name,
		Path:         path,
		LocationKind: locationKind,
		HostID:       hostID,
		Provider:     strings.TrimSpace(req.Provider),
		CreatedAt:    now,
		UpdatedAt:    now,
	}
	m.mu.Lock()
	m.projects[project.ID] = project
	err = m.saveLocked()
	m.mu.Unlock()
	if err != nil {
		return Project{}, err
	}
	m.emit("project.changed", project)
	return project, nil
}

func (m *Manager) CloneProject(ctx context.Context, req CloneProjectRequest) (Project, error) {
	remoteURL := strings.TrimSpace(req.URL)
	destination := strings.TrimSpace(req.Destination)
	if remoteURL == "" || destination == "" {
		return Project{}, errors.New("clone url and destination are required")
	}
	destination, err := normalizeLocalPath(destination)
	if err != nil {
		return Project{}, err
	}
	if err := os.MkdirAll(destination, 0o755); err != nil {
		return Project{}, err
	}
	repoName, err := cloneProjectNameFromURL(remoteURL)
	if err != nil {
		return Project{}, err
	}
	clonePath := filepath.Join(destination, repoName)
	ownedTarget := false
	if err := os.Mkdir(clonePath, 0o755); err == nil {
		ownedTarget = true
	} else if !os.IsExist(err) {
		return Project{}, err
	}
	cloneCtx, cancel := context.WithTimeout(ctx, gitWorktreeCommandLimit)
	defer cancel()
	output, err := exec.CommandContext(
		cloneCtx,
		"git",
		"clone",
		"--progress",
		"--",
		remoteURL,
		clonePath,
	).CombinedOutput()
	if err != nil {
		if ownedTarget {
			_ = os.RemoveAll(clonePath)
		}
		message := strings.TrimSpace(string(output))
		if message == "" {
			message = err.Error()
		}
		return Project{}, errors.New("Clone failed: " + message)
	}
	return m.CreateProject(CreateProjectRequest{
		Name:         pathBase(clonePath),
		Path:         clonePath,
		LocationKind: "local",
		Provider:     "git",
	})
}

func (m *Manager) ListProjects() []Project {
	m.mu.RLock()
	defer m.mu.RUnlock()
	projects := make([]Project, 0, len(m.projects))
	for _, project := range m.projects {
		projects = append(projects, project)
	}
	sort.Slice(projects, func(i, j int) bool {
		if projects[i].SortOrder != projects[j].SortOrder {
			return projects[i].SortOrder > projects[j].SortOrder
		}
		return projects[i].CreatedAt.Before(projects[j].CreatedAt)
	})
	return projects
}

func (m *Manager) UpdateProject(id string, req UpdateProjectRequest) (Project, error) {
	m.mu.Lock()
	project, ok := m.projects[id]
	if !ok {
		m.mu.Unlock()
		return Project{}, ErrNotFound
	}
	locationKind, err := normalizeProjectLocationKind(req.LocationKind, false)
	if err != nil {
		m.mu.Unlock()
		return Project{}, err
	}
	if name := strings.TrimSpace(req.Name); name != "" {
		project.Name = name
	}
	nextLocationKind := project.LocationKind
	if locationKind != "" {
		nextLocationKind = locationKind
	}
	nextHostID := project.HostID
	if hostID := strings.TrimSpace(req.HostID); hostID != "" {
		nextHostID = hostID
	}
	if path := strings.TrimSpace(req.Path); path != "" {
		if !isAbsoluteForHost(path) {
			m.mu.Unlock()
			return Project{}, ErrInvalidPath
		}
		if nextLocationKind == "local" {
			normalized, err := normalizeLocalPath(path)
			if err != nil {
				m.mu.Unlock()
				return Project{}, err
			}
			path = normalized
		}
		project.Path = path
	}
	if nextLocationKind == "ssh" && nextHostID == "" {
		m.mu.Unlock()
		return Project{}, errors.New("ssh project host id is required")
	}
	project.LocationKind = nextLocationKind
	project.HostID = nextHostID
	if provider := strings.TrimSpace(req.Provider); provider != "" {
		project.Provider = provider
	}
	project.UpdatedAt = time.Now().UTC()
	m.projects[id] = project
	err = m.saveLocked()
	m.mu.Unlock()
	if err != nil {
		return Project{}, err
	}
	m.emit("project.changed", project)
	return project, nil
}

func (m *Manager) DeleteProject(id string) (Project, error) {
	m.mu.Lock()
	project, ok := m.projects[id]
	if !ok {
		m.mu.Unlock()
		return Project{}, ErrNotFound
	}
	delete(m.projects, id)
	for worktreeID, worktree := range m.worktrees {
		if worktree.ProjectID == id {
			delete(m.worktrees, worktreeID)
		}
	}
	err := m.saveLocked()
	m.mu.Unlock()
	if err != nil {
		return Project{}, err
	}
	m.emit("project.changed", map[string]interface{}{"deleted": project})
	return project, nil
}

func (m *Manager) PersistProjectSortOrder(orderedIDs []string) error {
	if len(orderedIDs) == 0 {
		return nil
	}
	now := time.Now().UTC()
	nowMs := now.UnixMilli()
	changed := make([]Project, 0, len(orderedIDs))
	m.mu.Lock()
	for index, id := range orderedIDs {
		project, ok := m.projects[id]
		if !ok {
			continue
		}
		project.SortOrder = nowMs - int64(index)*1000
		project.UpdatedAt = now
		m.projects[id] = project
		changed = append(changed, project)
	}
	err := m.saveLocked()
	m.mu.Unlock()
	if err != nil {
		return err
	}
	for _, project := range changed {
		m.emit("project.changed", project)
	}
	return nil
}

func normalizeProjectLocationKind(locationKind string, defaultLocal bool) (string, error) {
	locationKind = strings.TrimSpace(locationKind)
	if locationKind == "" {
		if defaultLocal {
			return "local", nil
		}
		return "", nil
	}
	switch locationKind {
	case "local", "ssh":
		return locationKind, nil
	default:
		return "", errors.New("project location kind must be local or ssh")
	}
}

func (m *Manager) CreateWorktree(ctx context.Context, req CreateWorktreeRequest) (Worktree, error) {
	if strings.TrimSpace(req.ProjectID) == "" {
		return Worktree{}, ErrProjectRequired
	}
	m.mu.RLock()
	project, ok := m.projects[req.ProjectID]
	m.mu.RUnlock()
	if !ok {
		return Worktree{}, ErrNotFound
	}
	path := strings.TrimSpace(req.Path)
	if path == "" || !isAbsoluteForHost(path) {
		return Worktree{}, ErrInvalidPath
	}
	if project.LocationKind == "local" {
		normalized, err := normalizeLocalPath(path)
		if err != nil {
			return Worktree{}, err
		}
		path = normalized
	}
	if req.ExecuteGit {
		if project.LocationKind != "local" {
			return Worktree{}, ErrRemoteNeedsRelay
		}
		createdBaseSHA := resolveGitCommitQuiet(ctx, project.Path, req.Base)
		args := []string{"-C", project.Path, "worktree", "add"}
		if req.SkipCheckout {
			args = append(args, "--no-checkout")
		}
		if req.Branch != "" {
			args = append(args, "-b", req.Branch)
		}
		args = append(args, path)
		if req.Base != "" {
			args = append(args, req.Base)
		}
		gitCtx, cancel := context.WithTimeout(ctx, gitWorktreeCommandLimit)
		defer cancel()
		if output, err := exec.CommandContext(gitCtx, "git", args...).CombinedOutput(); err != nil {
			return Worktree{}, errors.New(strings.TrimSpace(string(output)) + ": " + err.Error())
		}
		req.CreatedBaseSHA = createdBaseSHA
	}
	now := time.Now().UTC()
	worktree := Worktree{
		ID:             newID("wt"),
		InstanceID:     newID("wti"),
		ProjectID:      project.ID,
		Path:           path,
		Branch:         strings.TrimSpace(req.Branch),
		Base:           strings.TrimSpace(req.Base),
		CreatedBaseSHA: strings.TrimSpace(req.CreatedBaseSHA),
		ReviewKind:     strings.TrimSpace(req.ReviewKind),
		ReviewID:       strings.TrimSpace(req.ReviewID),
		CreatedAt:      now,
		UpdatedAt:      now,
	}
	m.mu.Lock()
	m.worktrees[worktree.ID] = worktree
	err := m.saveLocked()
	m.mu.Unlock()
	if err != nil {
		return Worktree{}, err
	}
	m.emit("worktree.changed", worktree)
	return worktree, nil
}

func (m *Manager) UpdateWorktree(id string, req UpdateWorktreeRequest) (Worktree, error) {
	m.mu.Lock()
	worktree, ok := m.worktrees[id]
	if !ok {
		m.mu.Unlock()
		return Worktree{}, ErrNotFound
	}
	if worktree.InstanceID == "" {
		worktree.InstanceID = newID("wti")
	}
	applyWorktreeMetadataUpdate(&worktree, req)
	parentWorktreeID := strings.TrimSpace(req.ParentWorktreeID)
	parentWorkspace := strings.TrimSpace(req.ParentWorkspace)
	if req.NoParent && (parentWorktreeID != "" || parentWorkspace != "") {
		m.mu.Unlock()
		return Worktree{}, errors.New("choose either one lineage parent or no parent")
	}
	if parentWorktreeID != "" && parentWorkspace != "" {
		m.mu.Unlock()
		return Worktree{}, errors.New("choose either one lineage parent or no parent")
	}
	switch {
	case req.NoParent:
		worktree.Lineage = nil
		worktree.WorkspaceLineage = nil
	case parentWorkspace != "":
		if err := m.applyWorktreeWorkspaceLineageLocked(&worktree, parentWorkspace, req); err != nil {
			m.mu.Unlock()
			return Worktree{}, err
		}
	case parentWorktreeID != "":
		if err := m.applyWorktreeParentLineageLocked(&worktree, parentWorktreeID, req); err != nil {
			m.mu.Unlock()
			return Worktree{}, err
		}
	}
	worktree.UpdatedAt = time.Now().UTC()
	m.worktrees[id] = worktree
	err := m.saveLocked()
	m.mu.Unlock()
	if err != nil {
		return Worktree{}, err
	}
	m.emit("worktree.changed", worktree)
	return worktree, nil
}

func applyWorktreeMetadataUpdate(worktree *Worktree, req UpdateWorktreeRequest) {
	now := time.Now().UTC().UnixMilli()
	if req.DisplayName != nil {
		worktree.DisplayName = strings.TrimSpace(*req.DisplayName)
		worktree.LastActivityAt = now
	}
	if req.Comment != nil {
		worktree.Comment = *req.Comment
		worktree.LastActivityAt = now
	}
	if req.IsArchived != nil {
		worktree.IsArchived = *req.IsArchived
	}
	if req.IsUnread != nil {
		worktree.IsUnread = *req.IsUnread
	}
	if req.IsPinned != nil {
		worktree.IsPinned = *req.IsPinned
	}
	if req.SortOrder != nil {
		worktree.SortOrder = *req.SortOrder
	}
	if req.ManualOrder != nil {
		order := *req.ManualOrder
		worktree.ManualOrder = &order
	}
	if req.WorkspaceStatus != nil {
		worktree.WorkspaceStatus = strings.TrimSpace(*req.WorkspaceStatus)
	}
	applyWorktreeLinkedItemUpdate(worktree, req)
}

// applyWorktreeLinkedItemUpdate maps the renderer's number|null / string|null
// link references onto the persisted worktree. A nil pointer leaves the field
// untouched; an explicit JSON null clears it.
func applyWorktreeLinkedItemUpdate(worktree *Worktree, req UpdateWorktreeRequest) {
	if req.LinkedIssue != nil {
		worktree.LinkedIssue = decodeLinkedInt(*req.LinkedIssue)
	}
	if req.LinkedPR != nil {
		worktree.LinkedPR = decodeLinkedInt(*req.LinkedPR)
	}
	if req.LinkedLinearIssue != nil {
		worktree.LinkedLinearIssue = decodeLinkedString(*req.LinkedLinearIssue)
	}
}

func decodeLinkedInt(raw json.RawMessage) *int64 {
	var value *int64
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil
	}
	return value
}

func decodeLinkedString(raw json.RawMessage) *string {
	var value *string
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil
	}
	return value
}

func (m *Manager) applyWorktreeWorkspaceLineageLocked(
	worktree *Worktree,
	parentWorkspace string,
	req UpdateWorktreeRequest,
) error {
	if strings.HasPrefix(parentWorkspace, "worktree:") {
		parentID := strings.TrimPrefix(parentWorkspace, "worktree:")
		if parentID == "" {
			return errors.New("parent workspace worktree id is required")
		}
		return m.applyWorktreeParentLineageLocked(worktree, parentID, req)
	}
	if !strings.HasPrefix(parentWorkspace, "folder:") || parentWorkspace == "folder:" {
		return errors.New("parent workspace must be a worktree:<id> or folder:<id> key")
	}
	origin, capture := normalizeWorktreeLineageMetadata(req)
	createdAt := time.Now().UTC().UnixMilli()
	worktree.Lineage = nil
	worktree.WorkspaceLineage = &WorkspaceLineage{
		ChildWorkspaceKey:  worktreeWorkspaceKey(worktree.ID),
		ChildInstanceID:    worktree.InstanceID,
		ParentWorkspaceKey: parentWorkspace,
		Origin:             origin,
		Capture:            capture,
		CreatedAt:          createdAt,
	}
	return nil
}

func (m *Manager) applyWorktreeParentLineageLocked(
	worktree *Worktree,
	parentID string,
	req UpdateWorktreeRequest,
) error {
	parent, ok := m.worktrees[parentID]
	if !ok {
		return ErrNotFound
	}
	if parent.ID == worktree.ID {
		return errors.New("worktree cannot be its own lineage parent")
	}
	if parent.ProjectID != worktree.ProjectID {
		return errors.New("lineage parent must belong to the same project")
	}
	if parent.InstanceID == "" {
		parent.InstanceID = newID("wti")
		m.worktrees[parent.ID] = parent
	}
	if wouldCreateWorktreeLineageCycleLocked(m.worktrees, worktree.ID, parent.ID) {
		return errors.New("lineage parent would create a cycle")
	}
	origin, capture := normalizeWorktreeLineageMetadata(req)
	createdAt := time.Now().UTC().UnixMilli()
	worktree.Lineage = &WorktreeLineage{
		WorktreeID:               worktree.ID,
		WorktreeInstanceID:       worktree.InstanceID,
		ParentWorktreeID:         parent.ID,
		ParentWorktreeInstanceID: parent.InstanceID,
		Origin:                   origin,
		Capture:                  capture,
		CreatedAt:                createdAt,
	}
	worktree.WorkspaceLineage = &WorkspaceLineage{
		ChildWorkspaceKey:  worktreeWorkspaceKey(worktree.ID),
		ChildInstanceID:    worktree.InstanceID,
		ParentWorkspaceKey: worktreeWorkspaceKey(parent.ID),
		ParentInstanceID:   parent.InstanceID,
		Origin:             origin,
		Capture:            capture,
		CreatedAt:          createdAt,
	}
	return nil
}

func (m *Manager) ListWorktrees(projectID string) []Worktree {
	m.mu.RLock()
	defer m.mu.RUnlock()
	worktrees := make([]Worktree, 0, len(m.worktrees))
	for _, worktree := range m.worktrees {
		if projectID == "" || worktree.ProjectID == projectID {
			worktrees = append(worktrees, worktree)
		}
	}
	sort.Slice(worktrees, func(i, j int) bool {
		return worktrees[i].CreatedAt.Before(worktrees[j].CreatedAt)
	})
	return worktrees
}

func (m *Manager) ListWorktreeLineage() WorktreeLineageListResponse {
	m.mu.RLock()
	defer m.mu.RUnlock()
	lineage := make(map[string]WorktreeLineage)
	workspaceLineage := make(map[string]WorkspaceLineage)
	for _, worktree := range m.worktrees {
		if worktree.Lineage == nil {
			if isWorkspaceLineageCurrentLocked(m.worktrees, worktree, worktree.WorkspaceLineage) {
				workspaceLineage[worktree.WorkspaceLineage.ChildWorkspaceKey] = *worktree.WorkspaceLineage
			}
			continue
		}
		parent, ok := m.worktrees[worktree.Lineage.ParentWorktreeID]
		if !ok {
			continue
		}
		if worktree.InstanceID != worktree.Lineage.WorktreeInstanceID ||
			parent.InstanceID != worktree.Lineage.ParentWorktreeInstanceID {
			continue
		}
		lineage[worktree.ID] = *worktree.Lineage
		if isWorkspaceLineageCurrentLocked(m.worktrees, worktree, worktree.WorkspaceLineage) {
			workspaceLineage[worktree.WorkspaceLineage.ChildWorkspaceKey] = *worktree.WorkspaceLineage
		} else {
			childKey := worktreeWorkspaceKey(worktree.ID)
			workspaceLineage[childKey] = WorkspaceLineage{
				ChildWorkspaceKey:  childKey,
				ChildInstanceID:    worktree.Lineage.WorktreeInstanceID,
				ParentWorkspaceKey: worktreeWorkspaceKey(parent.ID),
				ParentInstanceID:   worktree.Lineage.ParentWorktreeInstanceID,
				Origin:             worktree.Lineage.Origin,
				Capture:            worktree.Lineage.Capture,
				CreatedAt:          worktree.Lineage.CreatedAt,
			}
		}
	}
	return WorktreeLineageListResponse{Lineage: lineage, WorkspaceLineage: workspaceLineage}
}

func (m *Manager) PersistWorktreeSortOrder(orderedIDs []string) error {
	if len(orderedIDs) == 0 {
		return nil
	}
	now := time.Now().UTC()
	nowMs := now.UnixMilli()
	changed := make([]Worktree, 0, len(orderedIDs))
	m.mu.Lock()
	for index, id := range orderedIDs {
		worktree, ok := m.worktrees[id]
		if !ok {
			continue
		}
		worktree.SortOrder = nowMs - int64(index)*1000
		worktree.UpdatedAt = now
		m.worktrees[id] = worktree
		changed = append(changed, worktree)
	}
	err := m.saveLocked()
	m.mu.Unlock()
	if err != nil {
		return err
	}
	for _, worktree := range changed {
		m.emit("worktree.changed", worktree)
	}
	return nil
}

func (m *Manager) DeleteWorktree(ctx context.Context, id string, req DeleteWorktreeRequest) (DeleteWorktreeResponse, error) {
	m.mu.RLock()
	worktree, ok := m.worktrees[id]
	if !ok {
		m.mu.RUnlock()
		return DeleteWorktreeResponse{}, ErrNotFound
	}
	project, ok := m.projects[worktree.ProjectID]
	if !ok {
		m.mu.RUnlock()
		return DeleteWorktreeResponse{}, ErrNotFound
	}
	m.mu.RUnlock()
	var preserved *PreservedWorktreeBranch
	if req.ExecuteGit {
		result, err := removeLocalGitWorktree(ctx, project, worktree, req.Force, req.ForceBranchDelete)
		if err != nil {
			return DeleteWorktreeResponse{}, err
		}
		preserved = result
	}
	m.mu.Lock()
	worktree, ok = m.worktrees[id]
	if !ok {
		m.mu.Unlock()
		return DeleteWorktreeResponse{}, ErrNotFound
	}
	delete(m.worktrees, id)
	err := m.saveLocked()
	m.mu.Unlock()
	if err != nil {
		return DeleteWorktreeResponse{}, err
	}
	m.emit("worktree.changed", map[string]interface{}{"deleted": worktree})
	return DeleteWorktreeResponse{Worktree: worktree, PreservedBranch: preserved}, nil
}

// removeLocalGitWorktree detaches the worktree directory, then cleans up its
// local branch. It mirrors the Electron main-process semantics: `git branch -d`
// (safe delete) refuses to drop a branch with commits not merged into its
// upstream or HEAD, so unpublished work is preserved and returned instead of
// discarded. forceBranchDelete opts into `-D` for failed-creation rollback.
//
// Why the git-local subset only: Electron additionally recovers squash-merged
// branches by diffing against provider base refs (remote/PR merge status). That
// machinery is not available in the Go runtime, so a branch whose changes only
// landed via squash merge is preserved here rather than auto-deleted; the caller
// can still force-delete it explicitly.
func removeLocalGitWorktree(
	ctx context.Context,
	project Project,
	worktree Worktree,
	force bool,
	forceBranchDelete bool,
) (*PreservedWorktreeBranch, error) {
	if project.LocationKind != "local" {
		return nil, ErrRemoteNeedsRelay
	}
	repoPath, err := normalizeLocalPath(project.Path)
	if err != nil {
		return nil, err
	}
	worktreePath, err := normalizeLocalPath(worktree.Path)
	if err != nil {
		return nil, err
	}
	if repoPath == worktreePath {
		return nil, errors.New("refusing to remove the project root as a worktree")
	}
	branchName := normalizeLocalBranchRef(worktree.Branch)
	// Capture the branch head before removal so a later force-delete can compare
	// against the exact commit that Git preserved.
	branchHead := gitBranchHead(ctx, repoPath, branchName)

	args := []string{"-C", repoPath, "worktree", "remove"}
	if force {
		args = append(args, "--force")
	}
	args = append(args, worktreePath)
	gitCtx, cancel := context.WithTimeout(ctx, gitWorktreeCommandLimit)
	defer cancel()
	if output, err := exec.CommandContext(gitCtx, "git", args...).CombinedOutput(); err != nil {
		message := strings.TrimSpace(string(output))
		if message == "" {
			message = err.Error()
		} else {
			message += ": " + err.Error()
		}
		return nil, errors.New(message)
	}

	if branchName == "" {
		return nil, nil
	}
	return deleteLocalBranchAfterWorktreeRemoval(ctx, repoPath, branchName, branchHead, forceBranchDelete), nil
}

// deleteLocalBranchAfterWorktreeRemoval drops the worktree's local branch with
// the safe `-d` flag (or `-D` when forceBranchDelete). If Git refuses because the
// branch still holds unmerged commits, the branch is preserved and returned so
// the renderer can offer an explicit force-delete follow-up.
func deleteLocalBranchAfterWorktreeRemoval(
	ctx context.Context,
	repoPath string,
	branchName string,
	branchHead string,
	forceBranchDelete bool,
) *PreservedWorktreeBranch {
	deleteFlag := "-d"
	if forceBranchDelete {
		deleteFlag = "-D"
	}
	if runGitBranchDelete(ctx, repoPath, deleteFlag, branchName) == nil {
		return nil
	}
	// Why: `branch -d` is the cheap live-checkout guard. Only pay for
	// `worktree prune` when a stale admin record may still be blocking it.
	pruneCtx, cancelPrune := context.WithTimeout(ctx, gitCommandTimeout)
	_, _ = exec.CommandContext(pruneCtx, "git", "-C", repoPath, "worktree", "prune").CombinedOutput()
	cancelPrune()
	if runGitBranchDelete(ctx, repoPath, deleteFlag, branchName) == nil {
		return nil
	}
	// The branch still refuses safe deletion (unmerged/unpublished commits) or is
	// checked out elsewhere: keep it. Deleting a worktree must never silently
	// discard commits.
	preserved := &PreservedWorktreeBranch{BranchName: branchName}
	if branchHead != "" {
		preserved.Head = branchHead
	}
	return preserved
}

func runGitBranchDelete(ctx context.Context, repoPath, deleteFlag, branchName string) error {
	cmdCtx, cancel := context.WithTimeout(ctx, gitCommandTimeout)
	defer cancel()
	_, err := exec.CommandContext(cmdCtx, "git", "-C", repoPath, "branch", deleteFlag, "--", branchName).CombinedOutput()
	return err
}

// gitBranchHead resolves a local branch to its commit sha, or "" when the branch
// is missing or git errors.
func gitBranchHead(ctx context.Context, repoPath, branchName string) string {
	if branchName == "" {
		return ""
	}
	cmdCtx, cancel := context.WithTimeout(ctx, gitCommandTimeout)
	defer cancel()
	output, err := exec.CommandContext(cmdCtx, "git", "-C", repoPath, "rev-parse", "--verify", "--quiet", "refs/heads/"+branchName).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(output))
}

func normalizeLocalBranchRef(branch string) string {
	return strings.TrimPrefix(strings.TrimSpace(branch), "refs/heads/")
}

// ForceDeletePreservedBranch force-deletes a local branch that a prior worktree
// removal preserved. It errors with ErrBranchNotFound when the branch is absent,
// and refuses when the branch is checked out or moved past ExpectedHead so a
// stale force-delete cannot discard newer commits (mirrors Electron's
// update-ref compare-and-swap).
func (m *Manager) ForceDeletePreservedBranch(
	ctx context.Context,
	req ForceDeletePreservedBranchRequest,
) (ForceDeletePreservedBranchResponse, error) {
	projectID := strings.TrimSpace(req.ProjectID)
	branchName := normalizeLocalBranchRef(req.BranchName)
	if projectID == "" {
		return ForceDeletePreservedBranchResponse{}, ErrProjectRequired
	}
	if branchName == "" || strings.ContainsRune(branchName, '\x00') {
		return ForceDeletePreservedBranchResponse{}, errors.New("invalid branch name")
	}
	m.mu.RLock()
	project, ok := m.projects[projectID]
	m.mu.RUnlock()
	if !ok {
		return ForceDeletePreservedBranchResponse{}, ErrNotFound
	}
	if project.LocationKind != "local" {
		return ForceDeletePreservedBranchResponse{}, ErrRemoteNeedsRelay
	}
	repoPath, err := normalizeLocalPath(project.Path)
	if err != nil {
		return ForceDeletePreservedBranchResponse{}, err
	}
	if gitBranchHead(ctx, repoPath, branchName) == "" {
		return ForceDeletePreservedBranchResponse{}, ErrBranchNotFound
	}
	if gitBranchIsCheckedOut(ctx, repoPath, branchName) {
		return ForceDeletePreservedBranchResponse{}, errors.New("local branch is checked out in another worktree")
	}
	expectedHead := strings.TrimSpace(req.ExpectedHead)
	if expectedHead != "" {
		// Compare-and-swap: delete only if the ref still points at expectedHead so
		// a stale action cannot discard commits added after preservation.
		cmdCtx, cancel := context.WithTimeout(ctx, gitCommandTimeout)
		_, err := exec.CommandContext(cmdCtx, "git", "-C", repoPath, "update-ref", "-d", "refs/heads/"+branchName, expectedHead).CombinedOutput()
		cancel()
		if err != nil {
			return ForceDeletePreservedBranchResponse{}, errors.New("local branch changed after it was preserved; review it before deleting")
		}
		return ForceDeletePreservedBranchResponse{Deleted: true}, nil
	}
	cmdCtx, cancel := context.WithTimeout(ctx, gitCommandTimeout)
	defer cancel()
	if output, err := exec.CommandContext(cmdCtx, "git", "-C", repoPath, "branch", "-D", "--", branchName).CombinedOutput(); err != nil {
		message := strings.TrimSpace(string(output))
		if message == "" {
			message = err.Error()
		}
		return ForceDeletePreservedBranchResponse{}, errors.New(message)
	}
	return ForceDeletePreservedBranchResponse{Deleted: true}, nil
}

func gitBranchIsCheckedOut(ctx context.Context, repoPath, branchName string) bool {
	cmdCtx, cancel := context.WithTimeout(ctx, gitCommandTimeout)
	defer cancel()
	output, err := exec.CommandContext(cmdCtx, "git", "-C", repoPath, "worktree", "list", "--porcelain").Output()
	if err != nil {
		return false
	}
	target := "branch refs/heads/" + branchName
	for _, line := range strings.Split(string(output), "\n") {
		if strings.TrimSpace(line) == target {
			return true
		}
	}
	return false
}

func wouldCreateWorktreeLineageCycleLocked(
	worktrees map[string]Worktree,
	childID string,
	parentID string,
) bool {
	cursor := parentID
	for cursor != "" {
		if cursor == childID {
			return true
		}
		current, ok := worktrees[cursor]
		if !ok || current.Lineage == nil {
			return false
		}
		if current.Lineage.WorktreeInstanceID != current.InstanceID {
			return false
		}
		parent, ok := worktrees[current.Lineage.ParentWorktreeID]
		if !ok || parent.InstanceID != current.Lineage.ParentWorktreeInstanceID {
			return false
		}
		cursor = parent.ID
	}
	return false
}

func worktreeWorkspaceKey(worktreeID string) string {
	return "worktree:" + worktreeID
}

func isWorkspaceLineageCurrentLocked(
	worktrees map[string]Worktree,
	worktree Worktree,
	lineage *WorkspaceLineage,
) bool {
	if lineage == nil {
		return false
	}
	if lineage.ChildWorkspaceKey != worktreeWorkspaceKey(worktree.ID) {
		return false
	}
	if lineage.ChildInstanceID != "" && lineage.ChildInstanceID != worktree.InstanceID {
		return false
	}
	if strings.HasPrefix(lineage.ParentWorkspaceKey, "worktree:") {
		parentID := strings.TrimPrefix(lineage.ParentWorkspaceKey, "worktree:")
		parent, ok := worktrees[parentID]
		return ok && (lineage.ParentInstanceID == "" || lineage.ParentInstanceID == parent.InstanceID)
	}
	return strings.HasPrefix(lineage.ParentWorkspaceKey, "folder:") && lineage.ParentWorkspaceKey != "folder:"
}

func normalizeWorktreeLineageMetadata(req UpdateWorktreeRequest) (string, WorktreeLineageCapture) {
	origin := strings.TrimSpace(req.Origin)
	switch origin {
	case "orchestration", "cli", "manual":
	default:
		origin = "manual"
	}
	source := strings.TrimSpace(req.Capture.Source)
	if source == "" {
		if origin == "cli" {
			source = "explicit-cli-flag"
		} else {
			source = "manual-action"
		}
	}
	confidence := strings.TrimSpace(req.Capture.Confidence)
	if confidence != "explicit" && confidence != "inferred" {
		confidence = "explicit"
	}
	return origin, WorktreeLineageCapture{Source: source, Confidence: confidence}
}

func (m *Manager) StartSession(ctx context.Context, req StartSessionRequest) (Session, error) {
	if err := ctx.Err(); err != nil {
		return Session{}, err
	}
	resolvedReq, err := m.resolveSessionStartRequest(req)
	if err != nil {
		return Session{}, err
	}
	session, err := startProcessSession(context.Background(), resolvedReq, m.emit)
	if err != nil {
		return Session{}, err
	}
	m.mu.Lock()
	m.sessions[session.id] = session
	m.mu.Unlock()
	m.emit("session.status", session.snapshot())
	return session.snapshot(), nil
}

func (m *Manager) ListSessions() []Session {
	m.mu.RLock()
	sessions := make([]*processSession, 0, len(m.sessions))
	for _, session := range m.sessions {
		sessions = append(sessions, session)
	}
	m.mu.RUnlock()
	result := make([]Session, 0, len(sessions))
	for _, session := range sessions {
		result = append(result, session.snapshot())
	}
	sort.Slice(result, func(i, j int) bool {
		return result[i].StartedAt.Before(result[j].StartedAt)
	})
	return result
}

func (m *Manager) WriteSession(id string, req SessionInputRequest) error {
	m.mu.RLock()
	session, ok := m.sessions[id]
	m.mu.RUnlock()
	if !ok {
		return ErrSessionNotFound
	}
	return session.write(req)
}

func (m *Manager) ResizeSession(id string, req SessionResizeRequest) (Session, error) {
	m.mu.RLock()
	session, ok := m.sessions[id]
	m.mu.RUnlock()
	if !ok {
		return Session{}, ErrSessionNotFound
	}
	snapshot, err := session.resize(req)
	if err != nil {
		return Session{}, err
	}
	m.emit("session.status", snapshot)
	return snapshot, nil
}

func (m *Manager) TailSession(id string, limit int) (TailSessionResponse, error) {
	m.mu.RLock()
	session, ok := m.sessions[id]
	m.mu.RUnlock()
	if !ok {
		return TailSessionResponse{}, ErrSessionNotFound
	}
	return TailSessionResponse{SessionID: id, Chunks: session.tail(limit)}, nil
}

func (m *Manager) ClearSessionBuffer(id string) (Session, error) {
	m.mu.RLock()
	session, ok := m.sessions[id]
	m.mu.RUnlock()
	if !ok {
		return Session{}, ErrSessionNotFound
	}
	snapshot := session.clearBuffer()
	m.emit("session.status", snapshot)
	return snapshot, nil
}

func (m *Manager) StopSession(id string) (Session, error) {
	m.mu.RLock()
	session, ok := m.sessions[id]
	m.mu.RUnlock()
	if !ok {
		return Session{}, ErrSessionNotFound
	}
	snapshot, err := session.stop()
	if err != nil {
		return Session{}, err
	}
	m.emit("session.status", snapshot)
	return snapshot, nil
}

func (m *Manager) CreateAgentProfile(req CreateAgentProfileRequest) (AgentProfile, error) {
	name := strings.TrimSpace(req.Name)
	kind := strings.TrimSpace(req.Kind)
	if name == "" {
		return AgentProfile{}, errors.New("agent name is required")
	}
	if kind == "" {
		kind = strings.ToLower(strings.ReplaceAll(name, " ", "-"))
	}
	if len(req.Command) == 0 || strings.TrimSpace(req.Command[0]) == "" {
		return AgentProfile{}, errors.New("agent command is required")
	}
	mode := req.PromptInjectionMode
	if mode == "" {
		mode = PromptArgv
	}
	if !isPromptInjectionMode(mode) {
		return AgentProfile{}, errors.New("invalid prompt injection mode")
	}
	now := time.Now().UTC()
	profile := AgentProfile{
		ID:                  newID("agent"),
		Name:                name,
		Kind:                kind,
		Command:             trimStringSlice(req.Command),
		PromptInjectionMode: mode,
		PromptFlag:          strings.TrimSpace(req.PromptFlag),
		CreatedAt:           now,
		UpdatedAt:           now,
	}
	m.mu.Lock()
	m.agents[profile.ID] = profile
	err := m.saveLocked()
	m.mu.Unlock()
	if err != nil {
		return AgentProfile{}, err
	}
	m.emit("agent.changed", profile)
	return profile, nil
}

func (m *Manager) ListAgentProfiles() []AgentProfile {
	m.mu.RLock()
	defer m.mu.RUnlock()
	agents := make([]AgentProfile, 0, len(m.agents))
	for _, agent := range m.agents {
		agents = append(agents, agent)
	}
	sort.Slice(agents, func(i, j int) bool {
		return agents[i].CreatedAt.Before(agents[j].CreatedAt)
	})
	return agents
}

func (m *Manager) UpdateAgentProfile(id string, req UpdateAgentProfileRequest) (AgentProfile, error) {
	mode := req.PromptInjectionMode
	if mode != "" && !isPromptInjectionMode(mode) {
		return AgentProfile{}, errors.New("invalid prompt injection mode")
	}
	m.mu.Lock()
	profile, ok := m.agents[id]
	if !ok {
		m.mu.Unlock()
		return AgentProfile{}, ErrNotFound
	}
	if name := strings.TrimSpace(req.Name); name != "" {
		profile.Name = name
	}
	if kind := strings.TrimSpace(req.Kind); kind != "" {
		profile.Kind = kind
	}
	if len(req.Command) > 0 {
		if strings.TrimSpace(req.Command[0]) == "" {
			m.mu.Unlock()
			return AgentProfile{}, errors.New("agent command is required")
		}
		profile.Command = trimStringSlice(req.Command)
	}
	if mode != "" {
		profile.PromptInjectionMode = mode
	}
	if promptFlag := strings.TrimSpace(req.PromptFlag); promptFlag != "" {
		profile.PromptFlag = promptFlag
	}
	profile.UpdatedAt = time.Now().UTC()
	m.agents[id] = profile
	err := m.saveLocked()
	m.mu.Unlock()
	if err != nil {
		return AgentProfile{}, err
	}
	m.emit("agent.changed", profile)
	return profile, nil
}

func (m *Manager) DeleteAgentProfile(id string) (AgentProfile, error) {
	m.mu.Lock()
	profile, ok := m.agents[id]
	if !ok {
		m.mu.Unlock()
		return AgentProfile{}, ErrNotFound
	}
	delete(m.agents, id)
	err := m.saveLocked()
	m.mu.Unlock()
	if err != nil {
		return AgentProfile{}, err
	}
	m.emit("agent.changed", map[string]interface{}{"deleted": profile})
	return profile, nil
}

func (m *Manager) StartAgentRun(ctx context.Context, req StartAgentRunRequest) (AgentRun, error) {
	profileID := strings.TrimSpace(req.ProfileID)
	if profileID == "" {
		return AgentRun{}, errors.New("agent profile id is required")
	}
	m.mu.RLock()
	profile, ok := m.agents[profileID]
	m.mu.RUnlock()
	if !ok {
		return AgentRun{}, ErrNotFound
	}
	command, stdinPrompt := buildAgentCommand(profile, req.Prompt)
	session, err := m.StartSession(ctx, StartSessionRequest{
		ProjectID:  req.ProjectID,
		WorktreeID: req.WorktreeID,
		Cwd:        req.Cwd,
		Command:    command,
		AgentKind:  profile.Kind,
		Prompt:     stdinPrompt,
	})
	if err != nil {
		return AgentRun{}, err
	}
	now := time.Now().UTC()
	run := AgentRun{
		ID:         newID("arun"),
		ProfileID:  profile.ID,
		SessionID:  session.ID,
		ProjectID:  req.ProjectID,
		WorktreeID: req.WorktreeID,
		Status:     agentStatusFromSession(session.Status),
		Prompt:     strings.TrimSpace(req.Prompt),
		CreatedAt:  now,
		UpdatedAt:  now,
	}
	m.mu.Lock()
	m.agentRuns[run.ID] = run
	err = m.saveLocked()
	m.mu.Unlock()
	if err != nil {
		return AgentRun{}, err
	}
	m.emit("agent.changed", run)
	return run, nil
}

func (m *Manager) ListAgentRuns() []AgentRun {
	m.mu.RLock()
	defer m.mu.RUnlock()
	runs := make([]AgentRun, 0, len(m.agentRuns))
	for _, run := range m.agentRuns {
		if session, ok := m.sessions[run.SessionID]; ok {
			run.Status = agentStatusFromSession(session.snapshot().Status)
		}
		runs = append(runs, run)
	}
	sort.Slice(runs, func(i, j int) bool {
		return runs[i].CreatedAt.Before(runs[j].CreatedAt)
	})
	return runs
}

func (m *Manager) StopAgentRun(id string) (AgentRun, error) {
	m.mu.RLock()
	run, ok := m.agentRuns[id]
	m.mu.RUnlock()
	if !ok {
		return AgentRun{}, ErrNotFound
	}
	if run.SessionID != "" {
		if _, err := m.StopSession(run.SessionID); err != nil && !errors.Is(err, ErrSessionNotFound) {
			return AgentRun{}, err
		}
	}
	m.mu.Lock()
	run, ok = m.agentRuns[id]
	if !ok {
		m.mu.Unlock()
		return AgentRun{}, ErrNotFound
	}
	run.Status = AgentRunStopped
	run.UpdatedAt = time.Now().UTC()
	m.agentRuns[id] = run
	err := m.saveLocked()
	m.mu.Unlock()
	if err != nil {
		return AgentRun{}, err
	}
	m.emit("agent.changed", run)
	return run, nil
}

func (m *Manager) CreateTask(req CreateTaskRequest) (Task, error) {
	title := strings.TrimSpace(req.Title)
	if title == "" {
		return Task{}, errors.New("task title is required")
	}
	now := time.Now().UTC()
	task := Task{
		ID:        newID("task"),
		Title:     title,
		Body:      strings.TrimSpace(req.Body),
		Status:    TaskReady,
		Assignee:  strings.TrimSpace(req.Assignee),
		ParentID:  strings.TrimSpace(req.ParentID),
		CreatedAt: now,
		UpdatedAt: now,
	}
	m.mu.Lock()
	m.tasks[task.ID] = task
	err := m.saveLocked()
	m.mu.Unlock()
	if err != nil {
		return Task{}, err
	}
	m.emit("orchestration.changed", task)
	return task, nil
}

func (m *Manager) UpdateTask(id string, req UpdateTaskRequest) (Task, error) {
	status := req.Status
	if !isTaskStatus(status) {
		return Task{}, errors.New("invalid task status")
	}
	m.mu.Lock()
	task, ok := m.tasks[id]
	if !ok {
		m.mu.Unlock()
		return Task{}, ErrNotFound
	}
	now := time.Now().UTC()
	task.Status = status
	task.UpdatedAt = now
	if strings.TrimSpace(req.Assignee) != "" {
		task.Assignee = strings.TrimSpace(req.Assignee)
	}
	if status == TaskCompleted {
		task.CompletedAt = &now
	} else {
		task.CompletedAt = nil
	}
	m.tasks[id] = task
	err := m.saveLocked()
	m.mu.Unlock()
	if err != nil {
		return Task{}, err
	}
	m.emit("orchestration.changed", task)
	return task, nil
}

func (m *Manager) ListTasks() []Task {
	m.mu.RLock()
	defer m.mu.RUnlock()
	tasks := make([]Task, 0, len(m.tasks))
	for _, task := range m.tasks {
		tasks = append(tasks, task)
	}
	sort.Slice(tasks, func(i, j int) bool {
		return tasks[i].CreatedAt.Before(tasks[j].CreatedAt)
	})
	return tasks
}

func (m *Manager) SendMessage(req SendMessageRequest) (Message, error) {
	to := strings.TrimSpace(req.To)
	subject := strings.TrimSpace(req.Subject)
	if to == "" {
		return Message{}, errors.New("message recipient is required")
	}
	if subject == "" {
		return Message{}, errors.New("message subject is required")
	}
	from := strings.TrimSpace(req.From)
	if from == "" {
		from = "runtime"
	}
	threadID := strings.TrimSpace(req.ThreadID)
	if threadID == "" {
		threadID = newID("thread")
	}
	messageType := req.Type
	if messageType == "" {
		messageType = MessageStatus
	}
	if !isMessageType(messageType) {
		return Message{}, errors.New("invalid message type")
	}
	now := time.Now().UTC()
	message := Message{
		ID:        newID("msg"),
		ThreadID:  threadID,
		From:      from,
		To:        to,
		Subject:   subject,
		Body:      strings.TrimSpace(req.Body),
		Type:      messageType,
		Priority:  strings.TrimSpace(req.Priority),
		ReplyToID: strings.TrimSpace(req.ReplyToID),
		CreatedAt: now,
	}
	m.mu.Lock()
	m.messages[message.ID] = message
	err := m.saveLocked()
	m.mu.Unlock()
	if err != nil {
		return Message{}, err
	}
	m.emit("orchestration.changed", message)
	return message, nil
}

func (m *Manager) ReplyMessage(parentID string, req SendMessageRequest) (Message, error) {
	m.mu.RLock()
	parent, ok := m.messages[parentID]
	m.mu.RUnlock()
	if !ok {
		return Message{}, ErrNotFound
	}
	if strings.TrimSpace(req.To) == "" {
		req.To = parent.From
	}
	if strings.TrimSpace(req.From) == "" {
		req.From = parent.To
	}
	if strings.TrimSpace(req.Subject) == "" {
		req.Subject = "Re: " + parent.Subject
	}
	req.ThreadID = parent.ThreadID
	req.ReplyToID = parent.ID
	return m.SendMessage(req)
}

func (m *Manager) ListMessages(to string, unreadOnly bool) []Message {
	m.mu.RLock()
	defer m.mu.RUnlock()
	messages := make([]Message, 0, len(m.messages))
	for _, message := range m.messages {
		if to != "" && message.To != to {
			continue
		}
		if unreadOnly && message.Read {
			continue
		}
		messages = append(messages, message)
	}
	sort.Slice(messages, func(i, j int) bool {
		return messages[i].CreatedAt.Before(messages[j].CreatedAt)
	})
	return messages
}

func (m *Manager) DispatchTask(req DispatchTaskRequest) (Dispatch, error) {
	taskID := strings.TrimSpace(req.TaskID)
	assignee := strings.TrimSpace(req.Assignee)
	if taskID == "" {
		return Dispatch{}, errors.New("task id is required")
	}
	if assignee == "" {
		return Dispatch{}, errors.New("assignee is required")
	}
	m.mu.Lock()
	task, ok := m.tasks[taskID]
	if !ok {
		m.mu.Unlock()
		return Dispatch{}, ErrNotFound
	}
	now := time.Now().UTC()
	dispatch := Dispatch{
		ID:        newID("disp"),
		TaskID:    taskID,
		Assignee:  assignee,
		SessionID: strings.TrimSpace(req.SessionID),
		Status:    DispatchCreated,
		CreatedAt: now,
		UpdatedAt: now,
	}
	if req.Inject {
		dispatch.Status = DispatchInjected
		dispatch.Preamble = buildDispatchPreamble(task, dispatch)
	}
	task.Status = TaskDispatched
	task.Assignee = assignee
	task.UpdatedAt = now
	m.tasks[task.ID] = task
	m.dispatches[dispatch.ID] = dispatch
	err := m.saveLocked()
	m.mu.Unlock()
	if err != nil {
		return Dispatch{}, err
	}
	m.emit("orchestration.changed", map[string]interface{}{
		"task":     task,
		"dispatch": dispatch,
	})
	return dispatch, nil
}

func (m *Manager) ListDispatches(taskID string) []Dispatch {
	m.mu.RLock()
	defer m.mu.RUnlock()
	dispatches := make([]Dispatch, 0, len(m.dispatches))
	for _, dispatch := range m.dispatches {
		if taskID == "" || dispatch.TaskID == taskID {
			dispatches = append(dispatches, dispatch)
		}
	}
	sort.Slice(dispatches, func(i, j int) bool {
		return dispatches[i].CreatedAt.Before(dispatches[j].CreatedAt)
	})
	return dispatches
}

func (m *Manager) UpdateDispatch(id string, req UpdateDispatchRequest) (Dispatch, error) {
	if !isDispatchStatus(req.Status) {
		return Dispatch{}, errors.New("invalid dispatch status")
	}
	m.mu.Lock()
	dispatch, ok := m.dispatches[id]
	if !ok {
		m.mu.Unlock()
		return Dispatch{}, ErrNotFound
	}
	now := time.Now().UTC()
	dispatch.Status = req.Status
	dispatch.UpdatedAt = now
	m.dispatches[id] = dispatch
	task := m.tasks[dispatch.TaskID]
	switch req.Status {
	case DispatchCompleted:
		task.Status = TaskCompleted
		task.CompletedAt = &now
	case DispatchFailed:
		task.Status = TaskFailed
		task.CompletedAt = nil
	}
	task.UpdatedAt = now
	m.tasks[task.ID] = task
	err := m.saveLocked()
	m.mu.Unlock()
	if err != nil {
		return Dispatch{}, err
	}
	m.emit("orchestration.changed", map[string]interface{}{
		"task":     task,
		"dispatch": dispatch,
	})
	return dispatch, nil
}

func (m *Manager) CreateBrowserTab(req CreateBrowserTabRequest) (BrowserTab, error) {
	url := strings.TrimSpace(req.URL)
	if url == "" {
		return BrowserTab{}, errors.New("browser url is required")
	}
	title := strings.TrimSpace(req.Title)
	if title == "" {
		title = url
	}
	now := time.Now().UTC()
	tab := BrowserTab{
		ID:         newID("bt"),
		ProjectID:  strings.TrimSpace(req.ProjectID),
		WorktreeID: strings.TrimSpace(req.WorktreeID),
		ProfileID:  strings.TrimSpace(req.ProfileID),
		Title:      title,
		URL:        url,
		Status:     BrowserTabLoading,
		CreatedAt:  now,
		UpdatedAt:  now,
	}
	m.mu.Lock()
	m.browserTabs[tab.ID] = tab
	err := m.saveLocked()
	m.mu.Unlock()
	if err != nil {
		return BrowserTab{}, err
	}
	m.emit("browser.changed", tab)
	return tab, nil
}

func (m *Manager) UpdateBrowserTab(id string, req UpdateBrowserTabRequest) (BrowserTab, error) {
	m.mu.Lock()
	tab, ok := m.browserTabs[id]
	if !ok {
		m.mu.Unlock()
		return BrowserTab{}, ErrNotFound
	}
	if strings.TrimSpace(req.Title) != "" {
		tab.Title = strings.TrimSpace(req.Title)
	}
	if strings.TrimSpace(req.URL) != "" {
		tab.URL = strings.TrimSpace(req.URL)
	}
	if req.Status != "" {
		if !isBrowserTabStatus(req.Status) {
			m.mu.Unlock()
			return BrowserTab{}, errors.New("invalid browser tab status")
		}
		tab.Status = req.Status
	}
	if screenshotURI := strings.TrimSpace(req.ScreenshotURI); screenshotURI != "" {
		tab.ScreenshotURI = screenshotURI
		capturedAt := time.Now().UTC()
		if req.ScreenshotCapturedAt != nil {
			capturedAt = req.ScreenshotCapturedAt.UTC()
		}
		tab.ScreenshotCapturedAt = &capturedAt
	}
	tab.Error = strings.TrimSpace(req.Error)
	tab.UpdatedAt = time.Now().UTC()
	m.browserTabs[id] = tab
	err := m.saveLocked()
	m.mu.Unlock()
	if err != nil {
		return BrowserTab{}, err
	}
	m.emit("browser.changed", tab)
	return tab, nil
}

func (m *Manager) DeleteBrowserTab(id string) (BrowserTab, error) {
	m.mu.Lock()
	tab, ok := m.browserTabs[id]
	if !ok {
		m.mu.Unlock()
		return BrowserTab{}, ErrNotFound
	}
	delete(m.browserTabs, id)
	err := m.saveLocked()
	m.mu.Unlock()
	if err != nil {
		return BrowserTab{}, err
	}
	m.emit("browser.changed", map[string]interface{}{"deleted": tab})
	return tab, nil
}

func (m *Manager) ListBrowserTabs() []BrowserTab {
	m.mu.RLock()
	defer m.mu.RUnlock()
	tabs := make([]BrowserTab, 0, len(m.browserTabs))
	for _, tab := range m.browserTabs {
		tabs = append(tabs, tab)
	}
	sort.Slice(tabs, func(i, j int) bool {
		return tabs[i].CreatedAt.Before(tabs[j].CreatedAt)
	})
	return tabs
}

func (m *Manager) QueueBrowserCommand(tabID string, req BrowserCommandRequest) (ComputerAction, error) {
	cleanTabID := strings.TrimSpace(tabID)
	if cleanTabID == "" {
		return ComputerAction{}, ErrNotFound
	}
	command := strings.TrimSpace(req.Command)
	if !isBrowserCommand(command) {
		return ComputerAction{}, errors.New("unsupported browser command")
	}
	m.mu.RLock()
	_, ok := m.browserTabs[cleanTabID]
	m.mu.RUnlock()
	if !ok {
		return ComputerAction{}, ErrNotFound
	}
	payload := cloneMap(req.Payload)
	if payload == nil {
		payload = make(map[string]interface{})
	}
	payload["tabId"] = cleanTabID
	payload["command"] = command
	return m.CreateComputerAction(CreateComputerActionRequest{
		Kind:    "browser." + command,
		Target:  cleanTabID,
		Payload: payload,
	})
}

func (m *Manager) CreateBrowserProfile(req CreateBrowserProfileRequest) (BrowserProfile, error) {
	name := strings.TrimSpace(req.Name)
	if name == "" {
		name = "Default"
	}
	now := time.Now().UTC()
	profile := BrowserProfile{
		ID:         newID("bprof"),
		Name:       name,
		Persistent: req.Persistent,
		CreatedAt:  now,
		UpdatedAt:  now,
	}
	m.mu.Lock()
	m.browserProfiles[profile.ID] = profile
	err := m.saveLocked()
	m.mu.Unlock()
	if err != nil {
		return BrowserProfile{}, err
	}
	m.emit("browser.changed", profile)
	return profile, nil
}

func (m *Manager) ListBrowserProfiles() []BrowserProfile {
	m.mu.RLock()
	defer m.mu.RUnlock()
	profiles := make([]BrowserProfile, 0, len(m.browserProfiles))
	for _, profile := range m.browserProfiles {
		profiles = append(profiles, profile)
	}
	sort.Slice(profiles, func(i, j int) bool {
		return profiles[i].CreatedAt.Before(profiles[j].CreatedAt)
	})
	return profiles
}

func (m *Manager) DeleteBrowserProfile(id string) (BrowserProfile, error) {
	cleanID := strings.TrimSpace(id)
	if cleanID == "" {
		return BrowserProfile{}, ErrNotFound
	}
	m.mu.Lock()
	profile, ok := m.browserProfiles[cleanID]
	if !ok {
		m.mu.Unlock()
		return BrowserProfile{}, ErrNotFound
	}
	delete(m.browserProfiles, cleanID)
	for permissionID, permission := range m.browserPermissions {
		if permission.ProfileID == cleanID {
			delete(m.browserPermissions, permissionID)
		}
	}
	for tabID, tab := range m.browserTabs {
		if tab.ProfileID == cleanID {
			tab.ProfileID = ""
			tab.UpdatedAt = time.Now().UTC()
			m.browserTabs[tabID] = tab
		}
	}
	err := m.saveLocked()
	m.mu.Unlock()
	if err != nil {
		return BrowserProfile{}, err
	}
	m.emit("browser.changed", map[string]interface{}{"deleted": profile})
	return profile, nil
}

func (m *Manager) SetBrowserPermission(req SetBrowserPermissionRequest) (BrowserPermission, error) {
	origin := strings.TrimSpace(req.Origin)
	name := strings.TrimSpace(req.Name)
	state := req.State
	if origin == "" || name == "" {
		return BrowserPermission{}, errors.New("browser permission origin and name are required")
	}
	if !isBrowserPermissionState(state) {
		return BrowserPermission{}, errors.New("invalid browser permission state")
	}
	profileID := strings.TrimSpace(req.ProfileID)
	now := time.Now().UTC()
	id := browserPermissionID(profileID, origin, name)
	permission := BrowserPermission{
		ID:        id,
		ProfileID: profileID,
		Origin:    origin,
		Name:      name,
		State:     state,
		UpdatedAt: now,
	}
	m.mu.Lock()
	m.browserPermissions[id] = permission
	err := m.saveLocked()
	m.mu.Unlock()
	if err != nil {
		return BrowserPermission{}, err
	}
	m.emit("browser.changed", permission)
	return permission, nil
}

func (m *Manager) ListBrowserPermissions(profileID string, origin string) []BrowserPermission {
	m.mu.RLock()
	defer m.mu.RUnlock()
	profileID = strings.TrimSpace(profileID)
	origin = strings.TrimSpace(origin)
	permissions := make([]BrowserPermission, 0, len(m.browserPermissions))
	for _, permission := range m.browserPermissions {
		if profileID != "" && permission.ProfileID != profileID {
			continue
		}
		if origin != "" && permission.Origin != origin {
			continue
		}
		permissions = append(permissions, permission)
	}
	sort.Slice(permissions, func(i, j int) bool {
		if permissions[i].Origin == permissions[j].Origin {
			return permissions[i].Name < permissions[j].Name
		}
		return permissions[i].Origin < permissions[j].Origin
	})
	return permissions
}

func (m *Manager) CreateBrowserDownload(req CreateBrowserDownloadRequest) (BrowserDownload, error) {
	downloadURL := strings.TrimSpace(req.URL)
	if downloadURL == "" {
		return BrowserDownload{}, errors.New("browser download url is required")
	}
	status := req.Status
	if status == "" {
		status = BrowserDownloadQueued
	}
	if !isBrowserDownloadStatus(status) {
		return BrowserDownload{}, errors.New("invalid browser download status")
	}
	if err := validateBrowserDownloadProgress(req.BytesReceived, req.TotalBytes); err != nil {
		return BrowserDownload{}, err
	}
	now := time.Now().UTC()
	download := BrowserDownload{
		ID:            newID("bdl"),
		TabID:         strings.TrimSpace(req.TabID),
		URL:           downloadURL,
		Filename:      strings.TrimSpace(req.Filename),
		Path:          strings.TrimSpace(req.Path),
		Status:        status,
		BytesReceived: req.BytesReceived,
		TotalBytes:    req.TotalBytes,
		CreatedAt:     now,
		UpdatedAt:     now,
	}
	m.mu.Lock()
	m.browserDownloads[download.ID] = download
	err := m.saveLocked()
	m.mu.Unlock()
	if err != nil {
		return BrowserDownload{}, err
	}
	m.emit("browser.changed", download)
	return download, nil
}

func (m *Manager) QueueBrowserDownload(id string) (ComputerAction, error) {
	downloadID := strings.TrimSpace(id)
	if downloadID == "" {
		return ComputerAction{}, ErrNotFound
	}
	m.mu.RLock()
	download, ok := m.browserDownloads[downloadID]
	if !ok {
		m.mu.RUnlock()
		return ComputerAction{}, ErrNotFound
	}
	tabID := strings.TrimSpace(download.TabID)
	if tabID != "" {
		if _, tabOK := m.browserTabs[tabID]; !tabOK {
			m.mu.RUnlock()
			return ComputerAction{}, ErrNotFound
		}
	}
	m.mu.RUnlock()
	switch download.Status {
	case BrowserDownloadQueued, BrowserDownloadInProgress:
	default:
		return ComputerAction{}, errors.New("browser download is not startable")
	}
	payload := map[string]interface{}{
		"command":    "download",
		"downloadId": download.ID,
		"url":        download.URL,
		"filename":   download.Filename,
		"path":       download.Path,
		"status":     string(download.Status),
	}
	if tabID != "" {
		payload["tabId"] = tabID
	}
	return m.CreateComputerAction(CreateComputerActionRequest{
		Kind:    "browser.download",
		Target:  download.ID,
		Payload: payload,
	})
}

func (m *Manager) UpdateBrowserDownload(id string, req UpdateBrowserDownloadRequest) (BrowserDownload, error) {
	if req.Status != "" && !isBrowserDownloadStatus(req.Status) {
		return BrowserDownload{}, errors.New("invalid browser download status")
	}
	m.mu.Lock()
	download, ok := m.browserDownloads[id]
	if !ok {
		m.mu.Unlock()
		return BrowserDownload{}, ErrNotFound
	}
	if filename := strings.TrimSpace(req.Filename); filename != "" {
		download.Filename = filename
	}
	if path := strings.TrimSpace(req.Path); path != "" {
		download.Path = path
	}
	if req.Status != "" {
		download.Status = req.Status
	}
	if req.BytesReceived != nil {
		download.BytesReceived = *req.BytesReceived
	}
	if req.TotalBytes != nil {
		download.TotalBytes = *req.TotalBytes
	}
	if err := validateBrowserDownloadProgress(download.BytesReceived, download.TotalBytes); err != nil {
		m.mu.Unlock()
		return BrowserDownload{}, err
	}
	download.Error = strings.TrimSpace(req.Error)
	download.UpdatedAt = time.Now().UTC()
	m.browserDownloads[id] = download
	err := m.saveLocked()
	m.mu.Unlock()
	if err != nil {
		return BrowserDownload{}, err
	}
	m.emit("browser.changed", download)
	return download, nil
}

func (m *Manager) ListBrowserDownloads(tabID string) []BrowserDownload {
	m.mu.RLock()
	defer m.mu.RUnlock()
	tabID = strings.TrimSpace(tabID)
	downloads := make([]BrowserDownload, 0, len(m.browserDownloads))
	for _, download := range m.browserDownloads {
		if tabID != "" && download.TabID != tabID {
			continue
		}
		downloads = append(downloads, download)
	}
	sort.Slice(downloads, func(i, j int) bool {
		return downloads[i].CreatedAt.Before(downloads[j].CreatedAt)
	})
	return downloads
}

func validateBrowserDownloadProgress(bytesReceived int64, totalBytes int64) error {
	if bytesReceived < 0 || totalBytes < 0 {
		return errors.New("browser download byte counts must be non-negative")
	}
	if totalBytes > 0 && bytesReceived > totalBytes {
		return errors.New("browser download bytes received cannot exceed total bytes")
	}

	return nil
}

func (m *Manager) CreateComputerAction(req CreateComputerActionRequest) (ComputerAction, error) {
	kind := strings.TrimSpace(req.Kind)
	if kind == "" {
		return ComputerAction{}, errors.New("computer action kind is required")
	}
	now := time.Now().UTC()
	action := ComputerAction{
		ID:        newID("cact"),
		Kind:      kind,
		Target:    strings.TrimSpace(req.Target),
		Payload:   cloneMap(req.Payload),
		Status:    ComputerActionQueued,
		CreatedAt: now,
		UpdatedAt: now,
	}
	m.mu.Lock()
	m.computerActions[action.ID] = action
	err := m.saveLocked()
	m.mu.Unlock()
	if err != nil {
		return ComputerAction{}, err
	}
	m.emit("computer.changed", action)
	return action, nil
}

func (m *Manager) UpdateComputerAction(id string, req UpdateComputerActionRequest) (ComputerAction, error) {
	if !isComputerActionStatus(req.Status) {
		return ComputerAction{}, errors.New("invalid computer action status")
	}
	m.mu.Lock()
	action, ok := m.computerActions[id]
	if !ok {
		m.mu.Unlock()
		return ComputerAction{}, ErrNotFound
	}
	action.Status = req.Status
	action.Result = cloneMap(req.Result)
	action.Error = strings.TrimSpace(req.Error)
	action.UpdatedAt = time.Now().UTC()
	m.computerActions[id] = action
	err := m.saveLocked()
	m.mu.Unlock()
	if err != nil {
		return ComputerAction{}, err
	}
	m.emit("computer.changed", action)
	return action, nil
}

func (m *Manager) ListComputerActions(status ComputerActionStatus, kindPrefix string) []ComputerAction {
	m.mu.RLock()
	defer m.mu.RUnlock()
	actions := make([]ComputerAction, 0, len(m.computerActions))
	for _, action := range m.computerActions {
		if status != "" && action.Status != status {
			continue
		}
		if kindPrefix != "" && !strings.HasPrefix(action.Kind, kindPrefix) {
			continue
		}
		actions = append(actions, action)
	}
	sort.Slice(actions, func(i, j int) bool {
		return actions[i].CreatedAt.Before(actions[j].CreatedAt)
	})
	return actions
}

func (m *Manager) ClaimComputerActions(req ClaimComputerActionsRequest) ([]ComputerAction, error) {
	kindPrefix := strings.TrimSpace(req.KindPrefix)
	limit := req.Limit
	if limit <= 0 {
		limit = 25
	}
	if limit > 100 {
		limit = 100
	}
	now := time.Now().UTC()
	m.mu.Lock()
	candidates := make([]ComputerAction, 0, len(m.computerActions))
	for _, action := range m.computerActions {
		if action.Status != ComputerActionQueued {
			continue
		}
		if kindPrefix != "" && !strings.HasPrefix(action.Kind, kindPrefix) {
			continue
		}
		candidates = append(candidates, action)
	}
	sort.Slice(candidates, func(i, j int) bool {
		return candidates[i].CreatedAt.Before(candidates[j].CreatedAt)
	})
	if len(candidates) > limit {
		candidates = candidates[:limit]
	}
	claimed := make([]ComputerAction, 0, len(candidates))
	for _, action := range candidates {
		action.Status = ComputerActionRunning
		action.UpdatedAt = now
		m.computerActions[action.ID] = action
		claimed = append(claimed, action)
	}
	if len(claimed) == 0 {
		m.mu.Unlock()
		return []ComputerAction{}, nil
	}
	err := m.saveLocked()
	m.mu.Unlock()
	if err != nil {
		return nil, err
	}
	for _, action := range claimed {
		m.emit("computer.changed", action)
	}
	return claimed, nil
}

func (m *Manager) RegisterEmulatorDevice(req RegisterEmulatorDeviceRequest) (EmulatorDevice, error) {
	name := strings.TrimSpace(req.Name)
	platform := strings.TrimSpace(req.Platform)
	if name == "" {
		return EmulatorDevice{}, errors.New("emulator name is required")
	}
	if platform == "" {
		return EmulatorDevice{}, errors.New("emulator platform is required")
	}
	if !isEmulatorPlatform(platform) {
		return EmulatorDevice{}, errors.New("emulator platform must be ios or android")
	}
	status := req.Status
	if status == "" {
		status = EmulatorDeviceAvailable
	}
	if !isEmulatorDeviceStatus(status) {
		return EmulatorDevice{}, errors.New("invalid emulator device status")
	}
	now := time.Now().UTC()
	device := EmulatorDevice{
		ID:        newID("emu"),
		Name:      name,
		Platform:  platform,
		Runtime:   strings.TrimSpace(req.Runtime),
		Status:    status,
		CreatedAt: now,
		UpdatedAt: now,
	}
	m.mu.Lock()
	m.emulatorDevices[device.ID] = device
	err := m.saveLocked()
	m.mu.Unlock()
	if err != nil {
		return EmulatorDevice{}, err
	}
	m.emit("emulator.changed", device)
	return device, nil
}

func (m *Manager) ListEmulatorDevices() []EmulatorDevice {
	m.mu.RLock()
	defer m.mu.RUnlock()
	devices := make([]EmulatorDevice, 0, len(m.emulatorDevices))
	for _, device := range m.emulatorDevices {
		devices = append(devices, device)
	}
	sort.Slice(devices, func(i, j int) bool {
		return devices[i].CreatedAt.Before(devices[j].CreatedAt)
	})
	return devices
}

func (m *Manager) UpdateEmulatorDevice(id string, req UpdateEmulatorDeviceRequest) (EmulatorDevice, error) {
	status := req.Status
	if status != "" && !isEmulatorDeviceStatus(status) {
		return EmulatorDevice{}, errors.New("invalid emulator device status")
	}
	m.mu.Lock()
	device, ok := m.emulatorDevices[id]
	if !ok {
		m.mu.Unlock()
		return EmulatorDevice{}, ErrNotFound
	}
	if name := strings.TrimSpace(req.Name); name != "" {
		device.Name = name
	}
	if runtime := strings.TrimSpace(req.Runtime); runtime != "" {
		device.Runtime = runtime
	}
	if status != "" {
		device.Status = status
	}
	device.Error = strings.TrimSpace(req.Error)
	device.UpdatedAt = time.Now().UTC()
	m.emulatorDevices[id] = device
	err := m.saveLocked()
	m.mu.Unlock()
	if err != nil {
		return EmulatorDevice{}, err
	}
	m.emit("emulator.changed", device)
	return device, nil
}

func (m *Manager) AttachEmulator(req AttachEmulatorRequest) (EmulatorSession, error) {
	deviceID := strings.TrimSpace(req.DeviceID)
	if deviceID == "" {
		return EmulatorSession{}, errors.New("emulator device id is required")
	}
	m.mu.Lock()
	device, ok := m.emulatorDevices[deviceID]
	if !ok {
		m.mu.Unlock()
		return EmulatorSession{}, ErrNotFound
	}
	now := time.Now().UTC()
	device.Status = EmulatorDeviceRunning
	device.UpdatedAt = now
	session := EmulatorSession{
		ID:         newID("emus"),
		DeviceID:   deviceID,
		ProjectID:  strings.TrimSpace(req.ProjectID),
		WorktreeID: strings.TrimSpace(req.WorktreeID),
		Active:     true,
		CreatedAt:  now,
		UpdatedAt:  now,
	}
	m.emulatorDevices[deviceID] = device
	m.emulatorSessions[session.ID] = session
	err := m.saveLocked()
	m.mu.Unlock()
	if err != nil {
		return EmulatorSession{}, err
	}
	m.emit("emulator.changed", map[string]interface{}{
		"device":  device,
		"session": session,
	})
	return session, nil
}

func (m *Manager) DetachEmulatorSession(id string) (EmulatorSession, error) {
	m.mu.Lock()
	session, ok := m.emulatorSessions[id]
	if !ok {
		m.mu.Unlock()
		return EmulatorSession{}, ErrNotFound
	}
	session.Active = false
	session.UpdatedAt = time.Now().UTC()
	m.emulatorSessions[id] = session
	err := m.saveLocked()
	m.mu.Unlock()
	if err != nil {
		return EmulatorSession{}, err
	}
	m.emit("emulator.changed", session)
	return session, nil
}

func (m *Manager) ListEmulatorSessions() []EmulatorSession {
	m.mu.RLock()
	defer m.mu.RUnlock()
	sessions := make([]EmulatorSession, 0, len(m.emulatorSessions))
	for _, session := range m.emulatorSessions {
		sessions = append(sessions, session)
	}
	sort.Slice(sessions, func(i, j int) bool {
		return sessions[i].CreatedAt.Before(sessions[j].CreatedAt)
	})
	return sessions
}

func (m *Manager) QueueEmulatorCommand(sessionID string, req EmulatorCommandRequest) (ComputerAction, error) {
	cleanSessionID := strings.TrimSpace(sessionID)
	if cleanSessionID == "" {
		return ComputerAction{}, ErrNotFound
	}
	command := strings.TrimSpace(req.Command)
	if !isEmulatorCommand(command) {
		return ComputerAction{}, errors.New("unsupported emulator command")
	}
	m.mu.RLock()
	session, ok := m.emulatorSessions[cleanSessionID]
	m.mu.RUnlock()
	if !ok {
		return ComputerAction{}, ErrNotFound
	}
	if !session.Active {
		return ComputerAction{}, errors.New("emulator session is not active")
	}
	payload := cloneMap(req.Payload)
	if payload == nil {
		payload = make(map[string]interface{})
	}
	payload["sessionId"] = cleanSessionID
	payload["deviceId"] = session.DeviceID
	payload["command"] = command
	return m.CreateComputerAction(CreateComputerActionRequest{
		Kind:    "emulator." + command,
		Target:  cleanSessionID,
		Payload: payload,
	})
}

func (m *Manager) GitStatus(ctx context.Context, projectID string) (GitStatus, error) {
	m.mu.RLock()
	project, ok := m.projects[projectID]
	m.mu.RUnlock()
	if !ok {
		return GitStatus{}, ErrNotFound
	}
	if project.LocationKind != "local" {
		return GitStatus{}, ErrRemoteNeedsRelay
	}
	gitCtx, cancel := context.WithTimeout(ctx, gitCommandTimeout)
	defer cancel()
	output, err := exec.CommandContext(gitCtx, "git", "-C", project.Path, "status", "--short").CombinedOutput()
	if err != nil {
		return GitStatus{}, errors.New(strings.TrimSpace(string(output)) + ": " + err.Error())
	}
	lines := strings.Split(strings.TrimRight(string(output), "\n"), "\n")
	if len(lines) == 1 && lines[0] == "" {
		lines = nil
	}
	return GitStatus{ProjectID: projectID, Path: project.Path, Lines: lines}, nil
}

func (m *Manager) GitDiff(ctx context.Context, projectID string, filePath string, cached bool) (GitDiff, error) {
	m.mu.RLock()
	project, ok := m.projects[projectID]
	m.mu.RUnlock()
	if !ok {
		return GitDiff{}, ErrNotFound
	}
	if project.LocationKind != "local" {
		return GitDiff{}, ErrRemoteNeedsRelay
	}
	cleanFilePath := strings.TrimSpace(filePath)
	if cleanFilePath != "" {
		var err error
		cleanFilePath, err = cleanWorkspaceRelativePath(cleanFilePath)
		if err != nil {
			return GitDiff{}, err
		}
		cleanFilePath = filepath.ToSlash(cleanFilePath)
	}
	args := []string{"-C", project.Path, "diff"}
	if cached {
		args = append(args, "--cached")
	}
	args = append(args, "--")
	if cleanFilePath != "" {
		args = append(args, cleanFilePath)
	}
	gitCtx, cancel := context.WithTimeout(ctx, gitCommandTimeout)
	defer cancel()
	output, err := exec.CommandContext(gitCtx, "git", args...).CombinedOutput()
	if err != nil {
		return GitDiff{}, errors.New(strings.TrimSpace(string(output)) + ": " + err.Error())
	}
	return GitDiff{
		ProjectID: projectID,
		Path:      project.Path,
		FilePath:  cleanFilePath,
		Cached:    cached,
		Patch:     string(output),
	}, nil
}

func (m *Manager) GitFileDiff(ctx context.Context, req GitFileDiffRequest) (GitFileDiffResult, error) {
	base, err := m.resolveWorkspacePath(req.ProjectID, req.WorktreeID)
	if err != nil {
		return GitFileDiffResult{}, err
	}
	cleanFilePath, err := cleanRequiredWorkspaceRelativePath(req.FilePath)
	if err != nil {
		return GitFileDiffResult{}, err
	}
	cleanFilePath = filepath.ToSlash(cleanFilePath)
	originalRef := ":" + cleanFilePath
	if req.Staged || req.CompareAgainstHead {
		originalRef = "HEAD:" + cleanFilePath
	}
	original, _ := readGitBlob(ctx, base, originalRef)
	if len(original) == 0 && !req.Staged {
		original, _ = readGitBlob(ctx, base, "HEAD:"+cleanFilePath)
	}
	var modified []byte
	if req.Staged {
		modified, _ = readGitBlob(ctx, base, ":"+cleanFilePath)
	} else {
		if readPath, info, err := resolveExistingWorkspaceFilePath(base, filepath.Join(base, filepath.FromSlash(cleanFilePath))); err == nil && !info.IsDir() {
			modified, _ = os.ReadFile(readPath)
		}
	}
	originalBinary := isLikelyBinary(original)
	modifiedBinary := isLikelyBinary(modified)
	if originalBinary || modifiedBinary {
		return GitFileDiffResult{
			Kind:             "binary",
			OriginalContent:  base64.StdEncoding.EncodeToString(original),
			ModifiedContent:  base64.StdEncoding.EncodeToString(modified),
			OriginalIsBinary: originalBinary,
			ModifiedIsBinary: modifiedBinary,
		}, nil
	}
	return GitFileDiffResult{
		Kind:             "text",
		OriginalContent:  string(original),
		ModifiedContent:  string(modified),
		OriginalIsBinary: false,
		ModifiedIsBinary: false,
	}, nil
}

func readGitBlob(ctx context.Context, repoPath string, spec string) ([]byte, error) {
	gitCtx, cancel := context.WithTimeout(ctx, gitCommandTimeout)
	defer cancel()
	output, err := exec.CommandContext(gitCtx, "git", "-C", repoPath, "show", spec).CombinedOutput()
	if err != nil {
		return nil, errors.New(strings.TrimSpace(string(output)) + ": " + err.Error())
	}
	return output, nil
}

func (m *Manager) MutateGit(ctx context.Context, req GitMutationRequest) (GitCommitResult, error) {
	base, err := m.resolveWorkspacePath(req.ProjectID, req.WorktreeID)
	if err != nil {
		return GitCommitResult{}, err
	}
	switch strings.TrimSpace(req.Operation) {
	case "stage":
		return GitCommitResult{Success: true}, runGitPathCommand(ctx, base, []string{"add", "--"}, []string{req.FilePath})
	case "bulkStage":
		return GitCommitResult{Success: true}, runGitPathCommand(ctx, base, []string{"add", "--"}, req.FilePaths)
	case "unstage":
		return GitCommitResult{Success: true}, runGitPathCommand(ctx, base, []string{"restore", "--staged", "--"}, []string{req.FilePath})
	case "bulkUnstage":
		return GitCommitResult{Success: true}, runGitPathCommand(ctx, base, []string{"restore", "--staged", "--"}, req.FilePaths)
	case "discard":
		return GitCommitResult{Success: true}, discardGitPaths(ctx, base, []string{req.FilePath})
	case "bulkDiscard":
		return GitCommitResult{Success: true}, discardGitPaths(ctx, base, req.FilePaths)
	case "commit":
		return commitGit(ctx, base, req.Message), nil
	case "fetch":
		return GitCommitResult{Success: true}, fetchGit(ctx, base, req)
	case "pull":
		return GitCommitResult{Success: true}, pullGit(ctx, base, req)
	case "push":
		return GitCommitResult{Success: true}, pushGit(ctx, base, req)
	case "fastForward":
		return GitCommitResult{Success: true}, fastForwardGit(ctx, base, req)
	case "rebaseFromBase":
		return GitCommitResult{Success: true}, rebaseGitFromBase(ctx, base, req.BaseRef)
	case "abortMerge":
		return GitCommitResult{Success: true}, runBoundedGitCommand(ctx, []string{"-C", base, "merge", "--abort"})
	case "abortRebase":
		return GitCommitResult{Success: true}, runBoundedGitCommand(ctx, []string{"-C", base, "rebase", "--abort"})
	default:
		return GitCommitResult{}, errors.New("unsupported git operation")
	}
}

func (m *Manager) GitBaseStatus(ctx context.Context, req GitBaseStatusRequest) (GitBaseStatusResult, error) {
	base, err := m.resolveWorkspacePath(req.ProjectID, req.WorktreeID)
	if err != nil {
		return GitBaseStatusResult{}, err
	}
	baseRef := strings.TrimSpace(req.BaseRef)
	createdBaseSHA := strings.TrimSpace(req.CreatedBaseSHA)
	remote, branch := parseRemoteTrackingBaseRef(ctx, base, baseRef)
	result := GitBaseStatusResult{
		Status: "unknown",
		Base:   baseRef,
		Remote: remote,
	}
	if baseRef == "" || createdBaseSHA == "" {
		return result, nil
	}
	if remote != "" && branch != "" {
		if err := fetchGit(ctx, base, GitMutationRequest{RemoteName: remote, BranchName: branch}); err != nil {
			return result, nil
		}
	}
	postFetchSHA, err := readGitOutput(ctx, base, "rev-parse", "--verify", baseRef+"^{commit}")
	if err != nil {
		return result, nil
	}
	conflict := checkGitRemoteBranchConflict(ctx, base, remote, strings.TrimSpace(req.BranchName))
	result.Conflict = conflict
	if postFetchSHA == createdBaseSHA {
		result.Status = "current"
		return result, nil
	}
	if _, err := readGitOutput(ctx, base, "merge-base", "--is-ancestor", createdBaseSHA, postFetchSHA); err != nil {
		result.Status = "base_changed"
		return result, nil
	}
	count, err := readGitOutput(ctx, base, "rev-list", "--count", createdBaseSHA+".."+postFetchSHA)
	if err != nil {
		return result, nil
	}
	behind := parsePositiveInt(count)
	if behind <= 0 {
		result.Status = "current"
		return result, nil
	}
	result.Status = "drift"
	result.Behind = behind
	if subjects, err := readGitOutput(ctx, base, "log", "--format=%s", "-n", "5", createdBaseSHA+".."+postFetchSHA); err == nil {
		for _, line := range strings.Split(subjects, "\n") {
			if trimmed := strings.TrimSpace(line); trimmed != "" {
				result.RecentSubjects = append(result.RecentSubjects, trimmed)
			}
		}
	}
	return result, nil
}

func (m *Manager) GitCheckIgnored(ctx context.Context, req GitCheckIgnoredRequest) ([]string, error) {
	base, err := m.resolveWorkspacePath(req.ProjectID, req.WorktreeID)
	if err != nil {
		return nil, err
	}
	cleanPaths, err := cleanGitPathspecs(req.Paths)
	if err != nil {
		return nil, err
	}
	gitCtx, cancel := context.WithTimeout(ctx, gitCommandTimeout)
	defer cancel()
	command := exec.CommandContext(gitCtx, "git", "-C", base, "check-ignore", "--stdin")
	command.Stdin = strings.NewReader(strings.Join(cleanPaths, "\n") + "\n")
	output, err := command.CombinedOutput()
	text := strings.TrimSpace(string(output))
	if err != nil {
		if text == "" {
			return []string{}, nil
		}
		return nil, errors.New(text + ": " + err.Error())
	}
	if text == "" {
		return []string{}, nil
	}
	return strings.Split(text, "\n"), nil
}

func (m *Manager) GitSubmoduleStatus(ctx context.Context, req GitSubmoduleStatusRequest) (GitStatusResult, error) {
	base, err := m.resolveWorkspacePath(req.ProjectID, req.WorktreeID)
	if err != nil {
		return GitStatusResult{}, err
	}
	submodulePath, err := cleanRequiredWorkspaceRelativePath(req.SubmodulePath)
	if err != nil {
		return GitStatusResult{}, err
	}
	submoduleRepo, info, err := resolveExistingWorkspaceFilePath(base, filepath.Join(base, submodulePath))
	if err != nil {
		return GitStatusResult{}, err
	}
	if !info.IsDir() {
		return GitStatusResult{}, errors.New("submodule path is not a directory")
	}
	output, err := readGitOutputRaw(ctx, submoduleRepo, "status", "--short")
	if err != nil {
		return GitStatusResult{}, err
	}
	return GitStatusResult{
		Entries:           parseGitStatusEntries(output, strings.TrimSpace(req.Area)),
		ConflictOperation: "unknown",
	}, nil
}

func (m *Manager) GitRemoteFileURL(ctx context.Context, req GitRemoteFileURLRequest) (GitRemoteURLResult, error) {
	base, err := m.resolveWorkspacePath(req.ProjectID, req.WorktreeID)
	if err != nil {
		return GitRemoteURLResult{}, err
	}
	relativePath, err := cleanRequiredWorkspaceRelativePath(req.RelativePath)
	if err != nil {
		return GitRemoteURLResult{}, err
	}
	line := req.Line
	if line <= 0 {
		line = 1
	}
	remoteURL, err := readPrimaryGitRemoteURL(ctx, base)
	if err != nil {
		return GitRemoteURLResult{}, nil
	}
	branch, err := readGitOutput(ctx, base, "symbolic-ref", "--quiet", "--short", "HEAD")
	if err != nil || branch == "" {
		branch, err = readGitOutput(ctx, base, "rev-parse", "--verify", "HEAD")
		if err != nil {
			return GitRemoteURLResult{}, nil
		}
	}
	url := buildHostedRemoteFileURL(remoteURL, filepath.ToSlash(relativePath), branch, line)
	return nullableGitURL(url), nil
}

func (m *Manager) GitRemoteCommitURL(ctx context.Context, req GitRemoteCommitURLRequest) (GitRemoteURLResult, error) {
	base, err := m.resolveWorkspacePath(req.ProjectID, req.WorktreeID)
	if err != nil {
		return GitRemoteURLResult{}, err
	}
	sha := strings.TrimSpace(req.SHA)
	if !isFullGitObjectID(sha) {
		return GitRemoteURLResult{}, errors.New("sha must be a full git object id")
	}
	remoteURL, err := readPrimaryGitRemoteURL(ctx, base)
	if err != nil {
		return GitRemoteURLResult{}, nil
	}
	url := buildHostedRemoteCommitURL(remoteURL, sha)
	return nullableGitURL(url), nil
}

func (m *Manager) GitForkSync(ctx context.Context, req GitForkSyncRequest) (GitForkSyncResult, error) {
	base, err := m.resolveWorkspacePath(req.ProjectID, req.WorktreeID)
	if err != nil {
		return GitForkSyncResult{}, err
	}
	const originRemote = "origin"
	const upstreamRemote = "upstream"
	result := GitForkSyncResult{Status: "blocked", OriginRemote: originRemote, UpstreamRemote: upstreamRemote}
	if !gitRemoteExists(ctx, base, originRemote) {
		result.Reason = "missing-origin"
		return result, nil
	}
	if !gitRemoteExists(ctx, base, upstreamRemote) {
		result.Reason = "missing-upstream"
		return result, nil
	}
	if !gitRemoteMatchesExpectedUpstream(ctx, base, upstreamRemote, req.ExpectedUpstream) {
		result.Reason = "upstream-mismatch"
		return result, nil
	}
	branchName := resolveGitRemoteDefaultBranch(ctx, base, upstreamRemote)
	if branchName == "" {
		result.Reason = "missing-upstream-default-branch"
		return result, nil
	}
	result.BranchName = branchName
	if !fetchGitRemoteBranch(ctx, base, upstreamRemote, branchName) {
		result.Reason = "missing-upstream-default-branch"
		return result, nil
	}
	if !fetchGitRemoteBranch(ctx, base, originRemote, branchName) {
		result.Reason = "missing-origin-branch"
		return result, nil
	}
	upstreamOid, err := readGitOutput(ctx, base, "rev-parse", "--verify", "refs/remotes/"+upstreamRemote+"/"+branchName+"^{commit}")
	if err != nil {
		result.Reason = "missing-upstream-default-branch"
		return result, nil
	}
	originOid, err := readGitOutput(ctx, base, "rev-parse", "--verify", "refs/remotes/"+originRemote+"/"+branchName+"^{commit}")
	if err != nil {
		result.Reason = "missing-origin-branch"
		return result, nil
	}
	result.Ahead, result.Behind = readGitAheadBehind(ctx, base, originOid+"..."+upstreamOid)
	if result.Ahead > 0 || !gitIsAncestor(ctx, base, originOid, upstreamOid) {
		result.Reason = "diverged"
		return result, nil
	}
	if result.Behind == 0 {
		result.Status = "up-to-date"
		result.Reason = ""
		return result, nil
	}
	if err := runBoundedGitCommand(ctx, []string{"-C", base, "push", originRemote, upstreamOid + ":refs/heads/" + branchName}); err != nil {
		return GitForkSyncResult{}, err
	}
	_ = fetchGitRemoteBranch(ctx, base, originRemote, branchName)
	result.Status = "synced"
	result.Reason = ""
	return result, nil
}

func runGitPathCommand(ctx context.Context, repoPath string, prefix []string, paths []string) error {
	cleanPaths, err := cleanGitPathspecs(paths)
	if err != nil {
		return err
	}
	args := append([]string{"-C", repoPath}, prefix...)
	args = append(args, cleanPaths...)
	return runBoundedGitCommand(ctx, args)
}

func discardGitPaths(ctx context.Context, repoPath string, paths []string) error {
	cleanPaths, err := cleanGitPathspecs(paths)
	if err != nil {
		return err
	}
	restoreArgs := append([]string{"-C", repoPath, "restore", "--worktree", "--"}, cleanPaths...)
	if err := runBoundedGitCommand(ctx, restoreArgs); err == nil {
		return nil
	}
	cleanArgs := append([]string{"-C", repoPath, "clean", "-fd", "--"}, cleanPaths...)
	return runBoundedGitCommand(ctx, cleanArgs)
}

func commitGit(ctx context.Context, repoPath string, message string) GitCommitResult {
	message = strings.TrimSpace(message)
	if message == "" {
		return GitCommitResult{Success: false, Error: "commit message is required"}
	}
	err := runBoundedGitCommand(ctx, []string{"-C", repoPath, "commit", "-m", message})
	if err != nil {
		return GitCommitResult{Success: false, Error: err.Error()}
	}
	return GitCommitResult{Success: true}
}

func fetchGit(ctx context.Context, repoPath string, req GitMutationRequest) error {
	remoteName := strings.TrimSpace(req.RemoteName)
	branchName := strings.TrimSpace(req.BranchName)
	if remoteName != "" && branchName != "" {
		return runBoundedGitCommand(ctx, []string{"-C", repoPath, "fetch", "--prune", remoteName, branchName})
	}
	return runBoundedGitCommand(ctx, []string{"-C", repoPath, "fetch", "--all", "--prune"})
}

func resolveGitCommitQuiet(ctx context.Context, repoPath string, ref string) string {
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return ""
	}
	commit, err := readGitOutput(ctx, repoPath, "rev-parse", "--verify", ref+"^{commit}")
	if err != nil {
		return ""
	}
	return commit
}

func parseRemoteTrackingBaseRef(ctx context.Context, repoPath string, baseRef string) (string, string) {
	normalized := strings.TrimPrefix(strings.TrimSpace(baseRef), "refs/remotes/")
	if normalized == "" || strings.HasPrefix(normalized, "refs/") {
		return "", ""
	}
	remotesOutput, err := readGitOutputRaw(ctx, repoPath, "remote")
	if err != nil {
		return "", ""
	}
	bestRemote := ""
	for _, line := range strings.Split(remotesOutput, "\n") {
		remote := strings.TrimSpace(line)
		if remote == "" {
			continue
		}
		if (normalized == remote || strings.HasPrefix(normalized, remote+"/")) && len(remote) > len(bestRemote) {
			bestRemote = remote
		}
	}
	if bestRemote == "" || normalized == bestRemote {
		return "", ""
	}
	return bestRemote, strings.TrimPrefix(normalized, bestRemote+"/")
}

func checkGitRemoteBranchConflict(ctx context.Context, repoPath string, baseRemote string, branchName string) *GitRemoteBranchConflict {
	branchName = normalizeLocalBranchRef(branchName)
	if branchName == "" {
		return nil
	}
	publishRemote := resolveGitPublishRemote(ctx, repoPath, branchName, baseRemote)
	if publishRemote == "" {
		return nil
	}
	if publishRemote != baseRemote {
		_ = fetchGit(ctx, repoPath, GitMutationRequest{RemoteName: publishRemote, BranchName: branchName})
	}
	if _, err := readGitOutput(ctx, repoPath, "rev-parse", "--verify", "refs/remotes/"+publishRemote+"/"+branchName+"^{commit}"); err != nil {
		return nil
	}
	return &GitRemoteBranchConflict{Remote: publishRemote, BranchName: branchName}
}

func resolveGitPublishRemote(ctx context.Context, repoPath string, branchName string, baseRemote string) string {
	for _, key := range []string{"branch." + branchName + ".pushRemote", "remote.pushDefault", "branch." + branchName + ".remote"} {
		if value, err := readGitOutput(ctx, repoPath, "config", "--get", key); err == nil && strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	if strings.TrimSpace(baseRemote) != "" {
		return strings.TrimSpace(baseRemote)
	}
	return "origin"
}

func pullGit(ctx context.Context, repoPath string, req GitMutationRequest) error {
	remoteName := strings.TrimSpace(req.RemoteName)
	branchName := strings.TrimSpace(req.BranchName)
	if remoteName != "" && branchName != "" {
		return runBoundedGitCommand(ctx, []string{"-C", repoPath, "pull", "--ff-only", remoteName, branchName})
	}
	return runBoundedGitCommand(ctx, []string{"-C", repoPath, "pull", "--ff-only"})
}

func pushGit(ctx context.Context, repoPath string, req GitMutationRequest) error {
	args := []string{"-C", repoPath, "push"}
	if req.ForceWithLease {
		args = append(args, "--force-with-lease")
	}
	remoteName := strings.TrimSpace(req.RemoteName)
	branchName := strings.TrimSpace(req.BranchName)
	if remoteName != "" && branchName != "" {
		if req.Publish {
			args = append(args, "-u")
		}
		args = append(args, remoteName, "HEAD:"+branchName)
	}
	return runBoundedGitCommand(ctx, args)
}

func fastForwardGit(ctx context.Context, repoPath string, req GitMutationRequest) error {
	remoteName := strings.TrimSpace(req.RemoteName)
	branchName := strings.TrimSpace(req.BranchName)
	if remoteName != "" && branchName != "" {
		if err := runBoundedGitCommand(ctx, []string{"-C", repoPath, "fetch", "--prune", remoteName, branchName}); err != nil {
			return err
		}
		return runBoundedGitCommand(ctx, []string{"-C", repoPath, "merge", "--ff-only", "FETCH_HEAD"})
	}
	return runBoundedGitCommand(ctx, []string{"-C", repoPath, "pull", "--ff-only"})
}

func rebaseGitFromBase(ctx context.Context, repoPath string, baseRef string) error {
	baseRef = strings.TrimSpace(baseRef)
	if baseRef == "" {
		return errors.New("base ref is required")
	}
	return runBoundedGitCommand(ctx, []string{"-C", repoPath, "rebase", baseRef})
}

func cleanGitPathspecs(paths []string) ([]string, error) {
	cleanPaths := make([]string, 0, len(paths))
	for _, path := range paths {
		cleanPath, err := cleanRequiredWorkspaceRelativePath(path)
		if err != nil {
			return nil, err
		}
		cleanPaths = append(cleanPaths, filepath.ToSlash(cleanPath))
	}
	if len(cleanPaths) == 0 {
		return nil, errors.New("at least one git path is required")
	}
	return cleanPaths, nil
}

func runBoundedGitCommand(ctx context.Context, args []string) error {
	gitCtx, cancel := context.WithTimeout(ctx, gitCommandTimeout)
	defer cancel()
	output, err := exec.CommandContext(gitCtx, "git", args...).CombinedOutput()
	if err != nil {
		return errors.New(strings.TrimSpace(string(output)) + ": " + err.Error())
	}
	return nil
}

func (m *Manager) GitBranchCompare(ctx context.Context, req GitBranchCompareRequest) (GitBranchCompareResult, error) {
	base, err := m.resolveWorkspacePath(req.ProjectID, req.WorktreeID)
	if err != nil {
		return GitBranchCompareResult{}, err
	}
	baseRef := strings.TrimSpace(req.BaseRef)
	result := GitBranchCompareResult{
		Summary: GitBranchCompareSummary{
			BaseRef:    baseRef,
			CompareRef: "HEAD",
			Status:     "loading",
		},
		Entries: []GitBranchChangeEntry{},
	}
	headOid, err := readGitOutput(ctx, base, "rev-parse", "--verify", "HEAD^{commit}")
	if err != nil {
		result.Summary.Status = "unborn-head"
		result.Summary.ErrorMessage = "This branch does not have a committed HEAD yet, so compare-to-base is unavailable."
		return result, nil
	}
	result.Summary.HeadOid = headOid
	baseOid, err := readGitOutput(ctx, base, "rev-parse", "--verify", baseRef+"^{commit}")
	if err != nil {
		result.Summary.Status = "invalid-base"
		result.Summary.ErrorMessage = "Base ref " + baseRef + " could not be resolved in this repository."
		return result, nil
	}
	result.Summary.BaseOid = baseOid
	mergeBase, err := readGitOutput(ctx, base, "merge-base", baseOid, headOid)
	if err != nil {
		result.Summary.Status = "no-merge-base"
		result.Summary.ErrorMessage = "This branch and " + baseRef + " do not share a merge base, so compare-to-base is unavailable."
		return result, nil
	}
	result.Summary.MergeBase = mergeBase
	entries, err := readBranchCompareEntries(ctx, base, mergeBase, headOid)
	if err != nil {
		result.Summary.Status = "error"
		result.Summary.ErrorMessage = err.Error()
		return result, nil
	}
	result.Entries = entries
	result.Summary.ChangedFiles = len(entries)
	if count, err := readGitOutput(ctx, base, "rev-list", "--count", baseOid+".."+headOid); err == nil {
		result.Summary.CommitsAhead = parsePositiveInt(count)
	}
	result.Summary.Status = "ready"
	return result, nil
}

func (m *Manager) GitRefFileDiff(ctx context.Context, req GitRefFileDiffRequest) (GitFileDiffResult, error) {
	base, err := m.resolveWorkspacePath(req.ProjectID, req.WorktreeID)
	if err != nil {
		return GitFileDiffResult{}, err
	}
	filePath, err := cleanRequiredWorkspaceRelativePath(req.FilePath)
	if err != nil {
		return GitFileDiffResult{}, err
	}
	leftRef := strings.TrimSpace(req.LeftRef)
	rightRef := strings.TrimSpace(req.RightRef)
	if leftRef == "" || rightRef == "" {
		return GitFileDiffResult{}, errors.New("git diff refs are required")
	}
	leftPath := filePath
	if strings.TrimSpace(req.OldPath) != "" {
		leftPath, err = cleanRequiredWorkspaceRelativePath(req.OldPath)
		if err != nil {
			return GitFileDiffResult{}, err
		}
	}
	left, _ := readGitBlob(ctx, base, leftRef+":"+filepath.ToSlash(leftPath))
	right, _ := readGitBlob(ctx, base, rightRef+":"+filepath.ToSlash(filePath))
	originalBinary := isLikelyBinary(left)
	modifiedBinary := isLikelyBinary(right)
	if originalBinary || modifiedBinary {
		return GitFileDiffResult{
			Kind:             "binary",
			OriginalContent:  base64.StdEncoding.EncodeToString(left),
			ModifiedContent:  base64.StdEncoding.EncodeToString(right),
			OriginalIsBinary: originalBinary,
			ModifiedIsBinary: modifiedBinary,
		}, nil
	}
	return GitFileDiffResult{
		Kind:             "text",
		OriginalContent:  string(left),
		ModifiedContent:  string(right),
		OriginalIsBinary: false,
		ModifiedIsBinary: false,
	}, nil
}

func (m *Manager) GitCommitCompare(ctx context.Context, req GitCommitCompareRequest) (GitCommitCompareResult, error) {
	base, err := m.resolveWorkspacePath(req.ProjectID, req.WorktreeID)
	if err != nil {
		return GitCommitCompareResult{}, err
	}
	commitID := strings.TrimSpace(req.CommitID)
	result := GitCommitCompareResult{
		Summary: GitCommitCompareSummary{
			CompareRef: commitID,
			BaseRef:    "empty tree",
			Status:     "ready",
		},
		Entries: []GitBranchChangeEntry{},
	}
	commitOid, err := readGitOutput(ctx, base, "rev-parse", "--verify", commitID+"^{commit}")
	if err != nil {
		result.Summary.Status = "invalid-commit"
		result.Summary.ErrorMessage = "Commit " + commitID + " could not be resolved in this repository."
		return result, nil
	}
	result.Summary.CommitOid = commitOid
	result.Summary.CompareRef = shortOid(commitOid)
	parentOid := ""
	if line, err := readGitOutput(ctx, base, "rev-list", "--parents", "-n", "1", commitOid); err == nil {
		parts := strings.Fields(line)
		if len(parts) > 1 {
			parentOid = parts[1]
			result.Summary.ParentOid = parentOid
			result.Summary.BaseRef = shortOid(parentOid)
		}
	}
	entries, err := readCommitCompareEntries(ctx, base, parentOid, commitOid)
	if err != nil {
		result.Summary.Status = "error"
		result.Summary.ErrorMessage = err.Error()
		return result, nil
	}
	result.Entries = entries
	result.Summary.ChangedFiles = len(entries)
	return result, nil
}

func (m *Manager) GitHistory(ctx context.Context, req GitHistoryRequest) (GitHistoryResult, error) {
	base, err := m.resolveWorkspacePath(req.ProjectID, req.WorktreeID)
	if err != nil {
		return GitHistoryResult{}, err
	}
	limit := req.Limit
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}
	result := GitHistoryResult{Items: []GitHistoryItem{}, Limit: limit}
	output, err := readGitOutputRaw(
		ctx,
		base,
		"log",
		"--date=unix",
		"--pretty=format:%H%x00%P%x00%an%x00%ae%x00%at%x00%s%x1e",
		"-n",
		stringFromPositiveInt(limit),
	)
	if err != nil {
		return result, nil
	}
	result.Items = parseGitHistoryItems(output)
	result.HasMore = len(result.Items) >= limit
	if headOid, err := readGitOutput(ctx, base, "rev-parse", "--verify", "HEAD^{commit}"); err == nil {
		result.CurrentRef = readCurrentHistoryRef(ctx, base, headOid)
	}
	baseRef := strings.TrimSpace(req.BaseRef)
	if baseRef != "" {
		if baseOid, err := readGitOutput(ctx, base, "rev-parse", "--verify", baseRef+"^{commit}"); err == nil {
			result.BaseRef = &GitHistoryItemRef{
				ID:       baseRef,
				Name:     baseRef,
				Revision: baseOid,
				Category: "branches",
			}
			if result.CurrentRef != nil {
				if mergeBase, err := readGitOutput(ctx, base, "merge-base", baseOid, result.CurrentRef.Revision); err == nil {
					result.MergeBase = mergeBase
				}
				result.HasOutgoingChanges = readGitCommitCount(ctx, base, baseOid+".."+result.CurrentRef.Revision) > 0
				result.HasIncomingChanges = readGitCommitCount(ctx, base, result.CurrentRef.Revision+".."+baseOid) > 0
			}
		}
	}
	return result, nil
}

func parseGitHistoryItems(output string) []GitHistoryItem {
	records := strings.Split(output, "\x1e")
	items := make([]GitHistoryItem, 0, len(records))
	for _, record := range records {
		record = strings.Trim(record, "\r\n")
		if record == "" {
			continue
		}
		parts := strings.Split(record, "\x00")
		if len(parts) < 6 {
			continue
		}
		id := strings.TrimSpace(parts[0])
		if id == "" {
			continue
		}
		items = append(items, GitHistoryItem{
			ID:          id,
			ParentIDs:   strings.Fields(parts[1]),
			Subject:     parts[5],
			Message:     parts[5],
			DisplayID:   shortOid(id),
			Author:      parts[2],
			AuthorEmail: parts[3],
			Timestamp:   int64(parsePositiveInt(parts[4])) * 1000,
		})
	}
	return items
}

func readCurrentHistoryRef(ctx context.Context, repoPath string, headOid string) *GitHistoryItemRef {
	branchName, err := readGitOutput(ctx, repoPath, "symbolic-ref", "--quiet", "--short", "HEAD")
	if err == nil && branchName != "" {
		return &GitHistoryItemRef{
			ID:       "refs/heads/" + branchName,
			Name:     branchName,
			Revision: headOid,
			Category: "branches",
		}
	}
	return &GitHistoryItemRef{ID: headOid, Name: shortOid(headOid), Revision: headOid, Category: "commits"}
}

func readGitCommitCount(ctx context.Context, repoPath string, rangeSpec string) int {
	count, err := readGitOutput(ctx, repoPath, "rev-list", "--count", rangeSpec)
	if err != nil {
		return 0
	}
	return parsePositiveInt(count)
}

func gitRemoteExists(ctx context.Context, repoPath string, remoteName string) bool {
	output, err := readGitOutputRaw(ctx, repoPath, "remote")
	if err != nil {
		return false
	}
	for _, line := range strings.Split(output, "\n") {
		if strings.TrimSpace(line) == remoteName {
			return true
		}
	}
	return false
}

func gitRemoteMatchesExpectedUpstream(ctx context.Context, repoPath string, remoteName string, expected GitForkSyncExpectedUpstream) bool {
	owner := strings.ToLower(strings.TrimSpace(expected.Owner))
	repo := strings.ToLower(strings.TrimSpace(expected.Repo))
	if owner == "" || repo == "" {
		return false
	}
	remoteURL, err := readGitOutput(ctx, repoPath, "remote", "get-url", remoteName)
	if err != nil {
		return false
	}
	remote, ok := parseHostedRemote(remoteURL)
	if !ok {
		return false
	}
	return strings.ToLower(remote.Path) == owner+"/"+repo
}

func resolveGitRemoteDefaultBranch(ctx context.Context, repoPath string, remoteName string) string {
	output, err := readGitOutputRaw(ctx, repoPath, "ls-remote", "--symref", remoteName, "HEAD")
	if err == nil {
		for _, line := range strings.Split(output, "\n") {
			line = strings.TrimSpace(line)
			const prefix = "ref: refs/heads/"
			const suffix = " HEAD"
			if strings.HasPrefix(line, prefix) && strings.HasSuffix(line, suffix) {
				return strings.TrimSuffix(strings.TrimPrefix(line, prefix), suffix)
			}
		}
	}
	for _, branch := range []string{"main", "master"} {
		if fetchGitRemoteBranch(ctx, repoPath, remoteName, branch) {
			return branch
		}
	}
	return ""
}

func fetchGitRemoteBranch(ctx context.Context, repoPath string, remoteName string, branchName string) bool {
	err := runBoundedGitCommand(ctx, []string{"-C", repoPath, "fetch", remoteName, branchName})
	return err == nil
}

func readGitAheadBehind(ctx context.Context, repoPath string, rangeSpec string) (int, int) {
	output, err := readGitOutput(ctx, repoPath, "rev-list", "--left-right", "--count", rangeSpec)
	if err != nil {
		return 0, 0
	}
	fields := strings.Fields(output)
	if len(fields) < 2 {
		return 0, 0
	}
	return parsePositiveInt(fields[0]), parsePositiveInt(fields[1])
}

func gitIsAncestor(ctx context.Context, repoPath string, ancestorOid string, descendantOid string) bool {
	err := runBoundedGitCommand(ctx, []string{"-C", repoPath, "merge-base", "--is-ancestor", ancestorOid, descendantOid})
	return err == nil
}

func stringFromPositiveInt(value int) string {
	if value <= 0 {
		return "0"
	}
	var digits [20]byte
	index := len(digits)
	for value > 0 {
		index--
		digits[index] = byte('0' + value%10)
		value /= 10
	}
	return string(digits[index:])
}

func readCommitCompareEntries(ctx context.Context, repoPath string, parentOid string, commitOid string) ([]GitBranchChangeEntry, error) {
	if parentOid == "" {
		output, err := readGitOutputRaw(ctx, repoPath, "diff-tree", "--root", "--name-status", "-r", commitOid)
		if err != nil {
			return nil, err
		}
		return parseNameStatusEntries(output), nil
	}
	return readBranchCompareEntries(ctx, repoPath, parentOid, commitOid)
}

func readBranchCompareEntries(ctx context.Context, repoPath string, mergeBase string, headOid string) ([]GitBranchChangeEntry, error) {
	output, err := readGitOutputRaw(ctx, repoPath, "diff", "--name-status", "--find-renames", mergeBase, headOid, "--")
	if err != nil {
		return nil, err
	}
	return parseNameStatusEntries(output), nil
}

func parseNameStatusEntries(output string) []GitBranchChangeEntry {
	lines := strings.Split(strings.TrimSpace(output), "\n")
	entries := make([]GitBranchChangeEntry, 0, len(lines))
	for _, line := range lines {
		if strings.TrimSpace(line) == "" {
			continue
		}
		fields := strings.Split(line, "\t")
		if len(fields) < 2 {
			continue
		}
		status := branchChangeStatus(fields[0])
		if status == "" {
			continue
		}
		entry := GitBranchChangeEntry{Path: fields[len(fields)-1], Status: status}
		if len(fields) >= 3 && strings.HasPrefix(fields[0], "R") {
			entry.OldPath = fields[1]
		}
		entries = append(entries, entry)
	}
	return entries
}

func parseGitStatusEntries(output string, requestedArea string) []GitStatusEntry {
	lines := strings.Split(strings.TrimRight(output, "\n"), "\n")
	entries := make([]GitStatusEntry, 0, len(lines))
	for _, line := range lines {
		if len(line) < 3 {
			continue
		}
		code := line[:2]
		rawPath := strings.TrimSpace(line[3:])
		if rawPath == "" {
			continue
		}
		area := "unstaged"
		statusCode := code[1]
		if code == "??" {
			area = "untracked"
			statusCode = '?'
		} else if code[0] != ' ' {
			area = "staged"
			statusCode = code[0]
		}
		if requestedArea != "" && requestedArea != area {
			continue
		}
		path := rawPath
		oldPath := ""
		if strings.Contains(rawPath, " -> ") {
			parts := strings.SplitN(rawPath, " -> ", 2)
			oldPath = strings.TrimSpace(parts[0])
			path = strings.TrimSpace(parts[1])
		}
		status := gitStatusCodeToStatus(statusCode)
		if status == "" {
			continue
		}
		entry := GitStatusEntry{Path: path, Status: status, Area: area}
		if oldPath != "" {
			entry.OldPath = oldPath
		}
		entries = append(entries, entry)
	}
	return entries
}

func gitStatusCodeToStatus(code byte) string {
	switch code {
	case '?':
		return "untracked"
	case 'A':
		return "added"
	case 'D':
		return "deleted"
	case 'R':
		return "renamed"
	case 'C':
		return "copied"
	case 'M', 'T':
		return "modified"
	default:
		return ""
	}
}

func branchChangeStatus(status string) string {
	switch {
	case strings.HasPrefix(status, "A"):
		return "added"
	case strings.HasPrefix(status, "D"):
		return "deleted"
	case strings.HasPrefix(status, "R"):
		return "renamed"
	case strings.HasPrefix(status, "C"):
		return "copied"
	case strings.HasPrefix(status, "M"):
		return "modified"
	default:
		return ""
	}
}

func readGitOutput(ctx context.Context, repoPath string, args ...string) (string, error) {
	output, err := readGitOutputRaw(ctx, repoPath, args...)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(output), nil
}

func readGitOutputRaw(ctx context.Context, repoPath string, args ...string) (string, error) {
	gitCtx, cancel := context.WithTimeout(ctx, gitCommandTimeout)
	defer cancel()
	commandArgs := append([]string{"-C", repoPath}, args...)
	output, err := exec.CommandContext(gitCtx, "git", commandArgs...).CombinedOutput()
	if err != nil {
		return "", errors.New(strings.TrimSpace(string(output)) + ": " + err.Error())
	}
	return string(output), nil
}

func shortOid(oid string) string {
	if len(oid) <= 7 {
		return oid
	}
	return oid[:7]
}

func (m *Manager) SubsystemStatus(name string) SubsystemStatus {
	switch name {
	case "browser":
		if status := m.nativeProviderSubsystemStatus("browser"); status.Status != "missing" {
			return status
		}
		return SubsystemStatus{
			Name:         "browser",
			Status:       "missing",
			Configured:   false,
			Capabilities: []string{"tabs", "profiles", "screencast", "automation", "downloads", "permissions"},
			Message:      "No browser provider is currently registered.",
		}
	case "computer":
		if status := m.nativeProviderSubsystemStatus("computer"); status.Status != "missing" {
			return status
		}
		return SubsystemStatus{
			Name:         "computer",
			Status:       "missing",
			Configured:   false,
			Capabilities: []string{"accessibility-tree", "screenshot", "click", "type", "scroll", "drag"},
			Message:      "No computer provider is currently registered.",
		}
	case "emulator":
		if status := m.nativeProviderSubsystemStatus("emulator"); status.Status != "missing" {
			return status
		}
		return SubsystemStatus{
			Name:         "emulator",
			Status:       "missing",
			Configured:   false,
			Capabilities: []string{"ios", "android", "gestures", "logs", "install", "launch"},
			Message:      "No emulator provider is currently registered.",
		}
	case "mobile-relay":
		status := m.MobileRelayStatus()
		return SubsystemStatus{
			Name:         "mobile-relay",
			Status:       subsystemStatusFromConfigured(status.Configured),
			Configured:   status.Configured,
			Capabilities: status.Capabilities,
			Message:      status.Message,
		}
	default:
		return SubsystemStatus{Name: name, Status: "missing", Configured: false}
	}
}

func (m *Manager) RegisterNativeProvider(req RegisterNativeProviderRequest) (NativeProviderRegistration, error) {
	subsystem := strings.TrimSpace(req.Subsystem)
	name := strings.TrimSpace(req.Name)
	if subsystem == "" || name == "" {
		return NativeProviderRegistration{}, errors.New("native provider subsystem and name are required")
	}
	if !isNativeProviderSubsystem(subsystem) {
		return NativeProviderRegistration{}, errors.New("invalid native provider subsystem")
	}
	status := strings.TrimSpace(req.Status)
	if status == "" {
		status = "ready"
	}
	if !isNativeProviderStatus(status) {
		return NativeProviderRegistration{}, errors.New("invalid native provider status")
	}
	id := strings.TrimSpace(req.ID)
	if id == "" {
		id = subsystem + ":" + name
	}
	if !strings.HasPrefix(id, subsystem+":") {
		return NativeProviderRegistration{}, errors.New("native provider id must be scoped to subsystem")
	}
	provider := NativeProviderRegistration{
		ID:           id,
		Subsystem:    subsystem,
		Name:         name,
		Status:       status,
		Capabilities: normalizeStringList(req.Capabilities),
		Message:      strings.TrimSpace(req.Message),
		LastSeenAt:   time.Now().UTC(),
	}
	m.mu.Lock()
	m.nativeProviders[id] = provider
	err := m.saveLocked()
	m.mu.Unlock()
	if err != nil {
		return NativeProviderRegistration{}, err
	}
	m.emit("provider.changed", provider)
	return provider, nil
}

func isNativeProviderSubsystem(subsystem string) bool {
	switch subsystem {
	case "browser", "computer", "emulator":
		return true
	default:
		return false
	}
}

func isNativeProviderStatus(status string) bool {
	switch status {
	case "ready", "running", "degraded", "error":
		return true
	default:
		return false
	}
}

func isNativeProviderLive(provider NativeProviderRegistration, now time.Time) bool {
	if provider.LastSeenAt.IsZero() || provider.LastSeenAt.After(now.Add(time.Minute)) {
		return false
	}
	return now.Sub(provider.LastSeenAt) <= nativeProviderLivenessTTL
}

func (m *Manager) ListNativeProviders(subsystem string) []NativeProviderRegistration {
	m.mu.RLock()
	defer m.mu.RUnlock()
	subsystem = strings.TrimSpace(subsystem)
	now := time.Now().UTC()
	providers := make([]NativeProviderRegistration, 0, len(m.nativeProviders))
	for _, provider := range m.nativeProviders {
		if subsystem != "" && provider.Subsystem != subsystem {
			continue
		}
		if !isNativeProviderLive(provider, now) {
			continue
		}
		providers = append(providers, provider)
	}
	sort.Slice(providers, func(i, j int) bool {
		if providers[i].Subsystem == providers[j].Subsystem {
			return providers[i].Name < providers[j].Name
		}
		return providers[i].Subsystem < providers[j].Subsystem
	})
	return providers
}

func (m *Manager) nativeProviderSubsystemStatus(subsystem string) SubsystemStatus {
	providers := m.ListNativeProviders(subsystem)
	if len(providers) == 0 {
		return SubsystemStatus{Name: subsystem, Status: "missing", Configured: false}
	}
	capabilitySet := make(map[string]bool)
	var capabilities []string
	status := "error"
	for _, provider := range providers {
		status = combinedProviderStatus(status, provider.Status)
		for _, capability := range provider.Capabilities {
			if capabilitySet[capability] {
				continue
			}
			capabilitySet[capability] = true
			capabilities = append(capabilities, capability)
		}
	}
	sort.Strings(capabilities)
	return SubsystemStatus{
		Name:         subsystem,
		Status:       status,
		Configured:   status == "ready" || status == "running" || status == "degraded",
		Capabilities: capabilities,
		Message:      providers[0].Message,
	}
}

func combinedProviderStatus(current string, next string) string {
	rank := map[string]int{
		"missing":  0,
		"error":    1,
		"degraded": 2,
		"ready":    3,
		"running":  4,
	}
	if rank[next] > rank[current] {
		return next
	}
	return current
}

func subsystemStatusFromConfigured(configured bool) string {
	if configured {
		return "ready"
	}
	return "missing"
}

func (m *Manager) Subscribe(buffer int) (uint64, <-chan RuntimeEvent) {
	if buffer <= 0 {
		buffer = 64
	}
	ch := make(chan RuntimeEvent, buffer)
	m.mu.Lock()
	m.nextSubscriber++
	id := m.nextSubscriber
	m.subscribers[id] = ch
	m.mu.Unlock()
	return id, ch
}

func (m *Manager) Unsubscribe(id uint64) {
	m.mu.Lock()
	ch, ok := m.subscribers[id]
	if ok {
		delete(m.subscribers, id)
		close(ch)
	}
	m.mu.Unlock()
}

func (m *Manager) Shutdown() {
	m.mu.RLock()
	sessions := make([]*processSession, 0, len(m.sessions))
	for _, session := range m.sessions {
		sessions = append(sessions, session)
	}
	m.mu.RUnlock()
	for _, session := range sessions {
		_, _ = session.stop()
	}
}

func (m *Manager) saveLocked() error {
	state := persistedState{
		RelayID:            m.relayID,
		Projects:           make([]Project, 0, len(m.projects)),
		Worktrees:          make([]Worktree, 0, len(m.worktrees)),
		Agents:             make([]AgentProfile, 0, len(m.agents)),
		AgentRuns:          make([]AgentRun, 0, len(m.agentRuns)),
		Tasks:              make([]Task, 0, len(m.tasks)),
		Messages:           make([]Message, 0, len(m.messages)),
		Dispatches:         make([]Dispatch, 0, len(m.dispatches)),
		Automations:        make([]Automation, 0, len(m.automations)),
		AutomationRuns:     make([]AutomationRun, 0, len(m.automationRuns)),
		ExternalWorkItems:  make([]ExternalWorkItem, 0, len(m.externalWorkItems)),
		SourceControl:      make([]SourceControlProjection, 0, len(m.sourceControlProjections)),
		Releases:           make([]ReleasePlan, 0, len(m.releases)),
		RemoteFileTrees:    make([]RemoteFileTreeSnapshot, 0, len(m.remoteFileTrees)),
		RemoteFileContents: make([]RemoteFileContentSnapshot, 0, len(m.remoteFileContents)),
		Settings:           make([]RuntimeSetting, 0, len(m.settings)),
		Keybindings:        make([]Keybinding, 0, len(m.keybindings)),
		BrowserTabs:        make([]BrowserTab, 0, len(m.browserTabs)),
		BrowserProfiles:    make([]BrowserProfile, 0, len(m.browserProfiles)),
		BrowserPerms:       make([]BrowserPermission, 0, len(m.browserPermissions)),
		BrowserDownloads:   make([]BrowserDownload, 0, len(m.browserDownloads)),
		ComputerActions:    make([]ComputerAction, 0, len(m.computerActions)),
		EmulatorDevices:    make([]EmulatorDevice, 0, len(m.emulatorDevices)),
		EmulatorSessions:   make([]EmulatorSession, 0, len(m.emulatorSessions)),
		NativeProviders:    make([]NativeProviderRegistration, 0, len(m.nativeProviders)),
		MobilePairings:     make([]MobileRelayPairingRecord, 0, len(m.mobilePairings)),
	}
	for _, project := range m.projects {
		state.Projects = append(state.Projects, project)
	}
	for _, worktree := range m.worktrees {
		state.Worktrees = append(state.Worktrees, worktree)
	}
	for _, agent := range m.agents {
		state.Agents = append(state.Agents, agent)
	}
	for _, run := range m.agentRuns {
		state.AgentRuns = append(state.AgentRuns, run)
	}
	for _, task := range m.tasks {
		state.Tasks = append(state.Tasks, task)
	}
	for _, message := range m.messages {
		state.Messages = append(state.Messages, message)
	}
	for _, dispatch := range m.dispatches {
		state.Dispatches = append(state.Dispatches, dispatch)
	}
	for _, automation := range m.automations {
		state.Automations = append(state.Automations, automation)
	}
	for _, run := range m.automationRuns {
		state.AutomationRuns = append(state.AutomationRuns, run)
	}
	for _, item := range m.externalWorkItems {
		state.ExternalWorkItems = append(state.ExternalWorkItems, item)
	}
	for _, projection := range m.sourceControlProjections {
		state.SourceControl = append(state.SourceControl, projection)
	}
	for _, release := range m.releases {
		state.Releases = append(state.Releases, release)
	}
	for _, snapshot := range m.remoteFileTrees {
		state.RemoteFileTrees = append(state.RemoteFileTrees, snapshot)
	}
	for _, snapshot := range m.remoteFileContents {
		state.RemoteFileContents = append(state.RemoteFileContents, snapshot)
	}
	for _, setting := range m.settings {
		state.Settings = append(state.Settings, setting)
	}
	for _, keybinding := range m.keybindings {
		state.Keybindings = append(state.Keybindings, keybinding)
	}
	for _, tab := range m.browserTabs {
		state.BrowserTabs = append(state.BrowserTabs, tab)
	}
	for _, profile := range m.browserProfiles {
		state.BrowserProfiles = append(state.BrowserProfiles, profile)
	}
	for _, permission := range m.browserPermissions {
		state.BrowserPerms = append(state.BrowserPerms, permission)
	}
	for _, download := range m.browserDownloads {
		state.BrowserDownloads = append(state.BrowserDownloads, download)
	}
	for _, action := range m.computerActions {
		state.ComputerActions = append(state.ComputerActions, action)
	}
	for _, device := range m.emulatorDevices {
		state.EmulatorDevices = append(state.EmulatorDevices, device)
	}
	for _, session := range m.emulatorSessions {
		state.EmulatorSessions = append(state.EmulatorSessions, session)
	}
	now := time.Now().UTC()
	for _, provider := range m.nativeProviders {
		if !isNativeProviderLive(provider, now) {
			continue
		}
		state.NativeProviders = append(state.NativeProviders, provider)
	}
	for _, pairing := range m.mobilePairings {
		state.MobilePairings = append(state.MobilePairings, pairing)
	}
	return m.store.save(state)
}

func (m *Manager) emit(topic string, payload interface{}) {
	event := RuntimeEvent{
		Version:   "pebble.events.v1",
		ID:        newID("evt"),
		Timestamp: time.Now().UTC(),
		Topic:     topic,
		Payload:   payload,
	}
	m.mu.RLock()
	subscribers := make([]chan RuntimeEvent, 0, len(m.subscribers))
	for _, subscriber := range m.subscribers {
		subscribers = append(subscribers, subscriber)
	}
	m.mu.RUnlock()
	for _, subscriber := range subscribers {
		select {
		case subscriber <- event:
		default:
		}
	}
}

func allCapabilities() []Capability {
	return []Capability{
		CapabilityProjects,
		CapabilityWorktrees,
		CapabilitySessions,
		CapabilityAgents,
		CapabilityOrchestration,
		CapabilityAutomations,
		CapabilityExternalTasks,
		CapabilitySourceControl,
		CapabilityFiles,
		CapabilityReleases,
		CapabilitySettings,
		CapabilityBrowser,
		CapabilityComputer,
		CapabilityEmulator,
		CapabilityMobileRelay,
	}
}

func newID(prefix string) string {
	var bytes [12]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return prefix + "_" + hex.EncodeToString([]byte(time.Now().UTC().Format("20060102150405.000000000")))
	}
	return prefix + "_" + hex.EncodeToString(bytes[:])
}

func pathBase(path string) string {
	cleaned := strings.TrimRight(path, `/\`)
	if cleaned == "" {
		return "project"
	}
	for i := len(cleaned) - 1; i >= 0; i-- {
		if cleaned[i] == '/' || cleaned[i] == '\\' {
			return cleaned[i+1:]
		}
	}
	return cleaned
}

func cloneProjectNameFromURL(remoteURL string) (string, error) {
	source := strings.TrimRight(strings.TrimSpace(remoteURL), `/\`)
	source = strings.TrimSuffix(source, ".git")
	name := pathBase(source)
	if name == "" || name == "." || name == ".." {
		return "", errors.New("invalid repository name derived from URL")
	}
	if strings.ContainsAny(name, `/\`) {
		return "", errors.New("invalid repository name derived from URL")
	}
	return name, nil
}

func isTaskStatus(status TaskStatus) bool {
	switch status {
	case TaskPending, TaskReady, TaskDispatched, TaskCompleted, TaskFailed, TaskBlocked:
		return true
	default:
		return false
	}
}

func isDispatchStatus(status DispatchStatus) bool {
	switch status {
	case DispatchCreated, DispatchInjected, DispatchCompleted, DispatchFailed:
		return true
	default:
		return false
	}
}

func isMessageType(messageType MessageType) bool {
	switch messageType {
	case MessageStatus, MessageDispatch, MessageWorkerDone, MessageMergeReady, MessageEscalation, MessageHandoff, MessageDecisionGate, MessageHeartbeat:
		return true
	default:
		return false
	}
}

func buildDispatchPreamble(task Task, dispatch Dispatch) string {
	return "Pebble dispatch\n" +
		"taskId: " + task.ID + "\n" +
		"dispatchId: " + dispatch.ID + "\n" +
		"assignee: " + dispatch.Assignee + "\n" +
		"title: " + task.Title + "\n" +
		"body: " + task.Body + "\n"
}

func isPromptInjectionMode(mode PromptInjectionMode) bool {
	switch mode {
	case PromptArgv, PromptFlagPrompt, PromptFlagInteractive, PromptStdinAfterStart, PromptNone:
		return true
	default:
		return false
	}
}

func trimStringSlice(values []string) []string {
	result := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value != "" {
			result = append(result, value)
		}
	}
	return result
}

func buildAgentCommand(profile AgentProfile, prompt string) ([]string, string) {
	command := append([]string(nil), profile.Command...)
	prompt = strings.TrimSpace(prompt)
	if prompt == "" {
		return command, ""
	}
	switch profile.PromptInjectionMode {
	case PromptArgv:
		command = append(command, prompt)
	case PromptFlagPrompt, PromptFlagInteractive:
		flag := profile.PromptFlag
		if flag == "" {
			flag = "--prompt"
		}
		command = append(command, flag, prompt)
	case PromptStdinAfterStart:
		return command, prompt
	case PromptNone:
		return command, ""
	}
	return command, ""
}

func agentStatusFromSession(status SessionStatus) AgentRunStatus {
	switch status {
	case SessionStarting:
		return AgentRunStarting
	case SessionRunning:
		return AgentRunRunning
	case SessionExited:
		return AgentRunExited
	case SessionStopped:
		return AgentRunStopped
	default:
		return AgentRunFailed
	}
}

func isBrowserTabStatus(status BrowserTabStatus) bool {
	switch status {
	case BrowserTabLoading, BrowserTabReady, BrowserTabError:
		return true
	default:
		return false
	}
}

func isBrowserCommand(command string) bool {
	switch command {
	case "reload", "goBack", "goForward", "stop", "screenshot":
		return true
	default:
		return false
	}
}

func isBrowserPermissionState(state BrowserPermissionState) bool {
	switch state {
	case BrowserPermissionPrompt, BrowserPermissionGranted, BrowserPermissionDenied:
		return true
	default:
		return false
	}
}

func isBrowserDownloadStatus(status BrowserDownloadStatus) bool {
	switch status {
	case BrowserDownloadQueued, BrowserDownloadInProgress, BrowserDownloadCompleted, BrowserDownloadFailed, BrowserDownloadCanceled:
		return true
	default:
		return false
	}
}

func browserPermissionID(profileID string, origin string, name string) string {
	encoded := hex.EncodeToString([]byte(strings.TrimSpace(profileID) + "\x00" + strings.TrimSpace(origin) + "\x00" + strings.TrimSpace(name)))
	return "bperm_" + encoded
}

func normalizeStringList(input []string) []string {
	seen := make(map[string]bool, len(input))
	var output []string
	for _, value := range input {
		value = strings.TrimSpace(value)
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		output = append(output, value)
	}
	sort.Strings(output)
	return output
}

func isComputerActionStatus(status ComputerActionStatus) bool {
	switch status {
	case ComputerActionQueued, ComputerActionRunning, ComputerActionCompleted, ComputerActionFailed:
		return true
	default:
		return false
	}
}

func isEmulatorDeviceStatus(status EmulatorDeviceStatus) bool {
	switch status {
	case EmulatorDeviceAvailable, EmulatorDeviceBooting, EmulatorDeviceRunning, EmulatorDeviceStopped, EmulatorDeviceError:
		return true
	default:
		return false
	}
}

func isEmulatorPlatform(platform string) bool {
	switch platform {
	case "ios", "android":
		return true
	default:
		return false
	}
}

func isEmulatorCommand(command string) bool {
	switch command {
	case "tap", "swipe", "type", "install", "launch", "screenshot", "logs", "pressKey", "rotate":
		return true
	default:
		return false
	}
}

func cloneMap(input map[string]interface{}) map[string]interface{} {
	if len(input) == 0 {
		return nil
	}
	output := make(map[string]interface{}, len(input))
	for key, value := range input {
		output[key] = value
	}
	return output
}
