package runtimecore

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
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
	for _, worktree := range state.Worktrees {
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

func (m *Manager) ListProjects() []Project {
	m.mu.RLock()
	defer m.mu.RUnlock()
	projects := make([]Project, 0, len(m.projects))
	for _, project := range m.projects {
		projects = append(projects, project)
	}
	sort.Slice(projects, func(i, j int) bool {
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
	}
	now := time.Now().UTC()
	worktree := Worktree{
		ID:         newID("wt"),
		ProjectID:  project.ID,
		Path:       path,
		Branch:     strings.TrimSpace(req.Branch),
		Base:       strings.TrimSpace(req.Base),
		ReviewKind: strings.TrimSpace(req.ReviewKind),
		ReviewID:   strings.TrimSpace(req.ReviewID),
		CreatedAt:  now,
		UpdatedAt:  now,
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

func (m *Manager) DeleteWorktree(id string) (Worktree, error) {
	m.mu.Lock()
	worktree, ok := m.worktrees[id]
	if !ok {
		m.mu.Unlock()
		return Worktree{}, ErrNotFound
	}
	delete(m.worktrees, id)
	err := m.saveLocked()
	m.mu.Unlock()
	if err != nil {
		return Worktree{}, err
	}
	m.emit("worktree.changed", map[string]interface{}{"deleted": worktree})
	return worktree, nil
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

func (m *Manager) TailSession(id string, limit int) (TailSessionResponse, error) {
	m.mu.RLock()
	session, ok := m.sessions[id]
	m.mu.RUnlock()
	if !ok {
		return TailSessionResponse{}, ErrSessionNotFound
	}
	return TailSessionResponse{SessionID: id, Chunks: session.tail(limit)}, nil
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
