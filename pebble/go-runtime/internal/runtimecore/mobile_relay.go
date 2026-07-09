package runtimecore

import (
	"crypto/rand"
	"crypto/subtle"
	"errors"
	"fmt"
	"math/big"
	"net/url"
	"sort"
	"strings"
	"time"
)

const MobileRelayProtocolVersion = "pebble.mobile-relay.v1"

type ProjectionKind string

const (
	ProjectionTerminal      ProjectionKind = "terminal"
	ProjectionSourceControl ProjectionKind = "source-control"
	ProjectionBrowser       ProjectionKind = "browser"
	ProjectionAgents        ProjectionKind = "agents"
	ProjectionFiles         ProjectionKind = "files"
	ProjectionOrchestration ProjectionKind = "orchestration"
	ProjectionAutomations   ProjectionKind = "automations"
	ProjectionExternalTasks ProjectionKind = "external-tasks"
	ProjectionReleases      ProjectionKind = "releases"
	ProjectionProviders     ProjectionKind = "providers"
	ProjectionComputer      ProjectionKind = "computer"
	ProjectionEmulator      ProjectionKind = "emulator"
	ProjectionSettings      ProjectionKind = "settings"
)

type MobileRelayDeviceIdentity struct {
	DeviceID   string `json:"deviceId"`
	DeviceName string `json:"deviceName"`
	Platform   string `json:"platform"`
}

type CreateMobileRelayPairingCodeRequest struct {
	Endpoint      string `json:"endpoint,omitempty"`
	WorkspaceName string `json:"workspaceName,omitempty"`
	TTLSeconds    int    `json:"ttlSeconds,omitempty"`
}

type MobileRelayPairingCode struct {
	Code          string    `json:"code"`
	ChallengeID   string    `json:"challengeId"`
	Endpoint      string    `json:"endpoint,omitempty"`
	WorkspaceName string    `json:"workspaceName,omitempty"`
	ExpiresAt     time.Time `json:"expiresAt"`
	CreatedAt     time.Time `json:"createdAt"`
}

type PairMobileRelayDeviceRequest struct {
	Endpoint    string                    `json:"endpoint,omitempty"`
	PairingCode string                    `json:"pairingCode"`
	Device      MobileRelayDeviceIdentity `json:"device"`
}

type MobileRelayPairingRecord struct {
	RelayID          string     `json:"relayId"`
	DeviceID         string     `json:"deviceId"`
	DeviceName       string     `json:"deviceName"`
	Platform         string     `json:"platform"`
	Endpoint         string     `json:"endpoint,omitempty"`
	WorkspaceName    string     `json:"workspaceName,omitempty"`
	PairingSecretRef string     `json:"pairingSecretRef"`
	CreatedAt        time.Time  `json:"createdAt"`
	LastConnectedAt  *time.Time `json:"lastConnectedAt,omitempty"`
}

type MobileRelayStatus struct {
	Name               string   `json:"name"`
	Configured         bool     `json:"configured"`
	ProtocolVersion    string   `json:"protocolVersion"`
	RelayID            string   `json:"relayId"`
	Capabilities       []string `json:"capabilities"`
	PairingCount       int      `json:"pairingCount"`
	ActivePairingCodes int      `json:"activePairingCodes"`
	Message            string   `json:"message,omitempty"`
}

type TerminalOutputLine struct {
	ID        string    `json:"id"`
	Stream    string    `json:"stream"`
	Text      string    `json:"text"`
	Timestamp time.Time `json:"timestamp"`
}

type TerminalProjection struct {
	Kind         string               `json:"kind"`
	SessionID    string               `json:"sessionId"`
	WorkspaceID  string               `json:"workspaceId"`
	Title        string               `json:"title"`
	Cwd          string               `json:"cwd,omitempty"`
	Status       string               `json:"status"`
	IsRemote     bool                 `json:"isRemote"`
	InputEnabled bool                 `json:"inputEnabled"`
	Output       []TerminalOutputLine `json:"output"`
	LastExitCode *int                 `json:"lastExitCode,omitempty"`
	UpdatedAt    time.Time            `json:"updatedAt"`
}

type AgentProjection struct {
	Kind        string    `json:"kind"`
	RunID       string    `json:"runId"`
	ProfileID   string    `json:"profileId"`
	SessionID   string    `json:"sessionId,omitempty"`
	WorkspaceID string    `json:"workspaceId"`
	Name        string    `json:"name"`
	AgentKind   string    `json:"agentKind"`
	Status      string    `json:"status"`
	Prompt      string    `json:"prompt,omitempty"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

type BrowserProjection struct {
	Kind         string `json:"kind"`
	TabID        string `json:"tabId"`
	WorkspaceID  string `json:"workspaceId"`
	Title        string `json:"title"`
	URL          string `json:"url"`
	Status       string `json:"status"`
	CanGoBack    bool   `json:"canGoBack"`
	CanGoForward bool   `json:"canGoForward"`
	Permissions  []struct {
		Name  string `json:"name"`
		State string `json:"state"`
	} `json:"permissions"`
	Screenshot   *BrowserScreenshotRef `json:"screenshot,omitempty"`
	ErrorMessage string                `json:"errorMessage,omitempty"`
	UpdatedAt    time.Time             `json:"updatedAt"`
}

type BrowserScreenshotRef struct {
	URI        string    `json:"uri"`
	CapturedAt time.Time `json:"capturedAt"`
}

type BrowserDownloadProjection struct {
	Kind          string    `json:"kind"`
	DownloadID    string    `json:"downloadId"`
	TabID         string    `json:"tabId,omitempty"`
	URL           string    `json:"url"`
	Filename      string    `json:"filename,omitempty"`
	Path          string    `json:"path,omitempty"`
	Status        string    `json:"status"`
	BytesReceived int64     `json:"bytesReceived,omitempty"`
	TotalBytes    int64     `json:"totalBytes,omitempty"`
	Error         string    `json:"error,omitempty"`
	UpdatedAt     time.Time `json:"updatedAt"`
}

type FileProjection struct {
	Kind        string    `json:"kind"`
	ProjectID   string    `json:"projectId"`
	WorktreeID  string    `json:"worktreeId,omitempty"`
	WorkspaceID string    `json:"workspaceId"`
	Path        string    `json:"path"`
	Name        string    `json:"name"`
	EntryKind   string    `json:"entryKind"`
	Size        int64     `json:"size,omitempty"`
	IsRemote    bool      `json:"isRemote"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

type AutomationProjection struct {
	Kind            string     `json:"kind"`
	AutomationID    string     `json:"automationId"`
	Name            string     `json:"name"`
	Description     string     `json:"description,omitempty"`
	Enabled         bool       `json:"enabled"`
	ScheduleKind    string     `json:"scheduleKind"`
	ActionKind      string     `json:"actionKind"`
	LastTriggeredAt *time.Time `json:"lastTriggeredAt,omitempty"`
	NextRunAt       *time.Time `json:"nextRunAt,omitempty"`
	UpdatedAt       time.Time  `json:"updatedAt"`
}

type ExternalTaskProjection struct {
	Kind         string     `json:"kind"`
	ItemID       string     `json:"itemId"`
	Provider     string     `json:"provider"`
	ItemKind     string     `json:"itemKind"`
	ExternalID   string     `json:"externalId"`
	URL          string     `json:"url,omitempty"`
	Title        string     `json:"title"`
	Status       string     `json:"status"`
	Assignee     string     `json:"assignee,omitempty"`
	ProjectID    string     `json:"projectId,omitempty"`
	TaskID       string     `json:"taskId,omitempty"`
	RepositoryID string     `json:"repositoryId,omitempty"`
	WorkspaceID  string     `json:"workspaceId,omitempty"`
	ReviewKind   string     `json:"reviewKind,omitempty"`
	LastSyncedAt *time.Time `json:"lastSyncedAt,omitempty"`
	UpdatedAt    time.Time  `json:"updatedAt"`
}

type ReleaseProjection struct {
	Kind              string     `json:"kind"`
	ReleaseID         string     `json:"releaseId"`
	Version           string     `json:"version"`
	Channel           string     `json:"channel"`
	Status            string     `json:"status"`
	RequiredCount     int        `json:"requiredCount"`
	ArtifactCount     int        `json:"artifactCount"`
	CheckCount        int        `json:"checkCount"`
	PassedCheckCount  int        `json:"passedCheckCount"`
	FailedCheckCount  int        `json:"failedCheckCount"`
	Ready             bool       `json:"ready"`
	UpdateManifestURI string     `json:"updateManifestUri,omitempty"`
	BlockedReason     string     `json:"blockedReason,omitempty"`
	PublishedAt       *time.Time `json:"publishedAt,omitempty"`
	UpdatedAt         time.Time  `json:"updatedAt"`
}

type EmulatorDeviceProjection struct {
	Kind      string    `json:"kind"`
	DeviceID  string    `json:"deviceId"`
	Name      string    `json:"name"`
	Platform  string    `json:"platform"`
	Runtime   string    `json:"runtime,omitempty"`
	Status    string    `json:"status"`
	Error     string    `json:"error,omitempty"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type EmulatorSessionProjection struct {
	Kind        string    `json:"kind"`
	SessionID   string    `json:"sessionId"`
	DeviceID    string    `json:"deviceId"`
	WorkspaceID string    `json:"workspaceId"`
	Active      bool      `json:"active"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

type TaskProjection struct {
	Kind        string     `json:"kind"`
	TaskID      string     `json:"taskId"`
	Title       string     `json:"title"`
	Status      string     `json:"status"`
	Assignee    string     `json:"assignee,omitempty"`
	ParentID    string     `json:"parentId,omitempty"`
	CompletedAt *time.Time `json:"completedAt,omitempty"`
	UpdatedAt   time.Time  `json:"updatedAt"`
}

type MessageProjection struct {
	Kind      string    `json:"kind"`
	MessageID string    `json:"messageId"`
	ThreadID  string    `json:"threadId"`
	From      string    `json:"from"`
	To        string    `json:"to"`
	Subject   string    `json:"subject"`
	Type      string    `json:"type"`
	Priority  string    `json:"priority,omitempty"`
	Read      bool      `json:"read"`
	CreatedAt time.Time `json:"createdAt"`
}

type DispatchProjection struct {
	Kind       string    `json:"kind"`
	DispatchID string    `json:"dispatchId"`
	TaskID     string    `json:"taskId"`
	Assignee   string    `json:"assignee"`
	SessionID  string    `json:"sessionId,omitempty"`
	Status     string    `json:"status"`
	UpdatedAt  time.Time `json:"updatedAt"`
}

type ProviderProjection struct {
	Kind         string    `json:"kind"`
	ProviderID   string    `json:"providerId"`
	Subsystem    string    `json:"subsystem"`
	Name         string    `json:"name"`
	Status       string    `json:"status"`
	Capabilities []string  `json:"capabilities"`
	Message      string    `json:"message,omitempty"`
	LastSeenAt   time.Time `json:"lastSeenAt"`
}

type ComputerActionProjection struct {
	Kind       string                 `json:"kind"`
	ActionID   string                 `json:"actionId"`
	ActionKind string                 `json:"actionKind"`
	Target     string                 `json:"target,omitempty"`
	Status     string                 `json:"status"`
	Payload    map[string]interface{} `json:"payload,omitempty"`
	Result     map[string]interface{} `json:"result,omitempty"`
	Error      string                 `json:"error,omitempty"`
	CreatedAt  time.Time              `json:"createdAt"`
	UpdatedAt  time.Time              `json:"updatedAt"`
}

type SettingProjection struct {
	Kind        string    `json:"kind"`
	SettingID   string    `json:"settingId"`
	Scope       string    `json:"scope"`
	ProjectID   string    `json:"projectId,omitempty"`
	WorkspaceID string    `json:"workspaceId,omitempty"`
	Key         string    `json:"key"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

type KeybindingProjection struct {
	Kind         string    `json:"kind"`
	KeybindingID string    `json:"keybindingId"`
	Command      string    `json:"command"`
	Accelerator  string    `json:"accelerator"`
	Platform     string    `json:"platform,omitempty"`
	Context      string    `json:"context,omitempty"`
	Enabled      bool      `json:"enabled"`
	UpdatedAt    time.Time `json:"updatedAt"`
}

type MobileRelayProjectionSnapshot struct {
	Terminals        []TerminalProjection        `json:"terminals"`
	Agents           []AgentProjection           `json:"agents"`
	SourceControl    []SourceControlProjection   `json:"sourceControl"`
	Browser          []BrowserProjection         `json:"browser"`
	BrowserDownloads []BrowserDownloadProjection `json:"browserDownloads"`
	Files            []FileProjection            `json:"files"`
	Tasks            []TaskProjection            `json:"tasks"`
	Messages         []MessageProjection         `json:"messages"`
	Dispatches       []DispatchProjection        `json:"dispatches"`
	Automations      []AutomationProjection      `json:"automations"`
	ExternalTasks    []ExternalTaskProjection    `json:"externalTasks"`
	Releases         []ReleaseProjection         `json:"releases"`
	Providers        []ProviderProjection        `json:"providers"`
	ComputerActions  []ComputerActionProjection  `json:"computerActions"`
	EmulatorDevices  []EmulatorDeviceProjection  `json:"emulatorDevices"`
	EmulatorSessions []EmulatorSessionProjection `json:"emulatorSessions"`
	Settings         []SettingProjection         `json:"settings"`
	Keybindings      []KeybindingProjection      `json:"keybindings"`
	ReceivedAt       time.Time                   `json:"receivedAt"`
}

func NormalizeMobileProjectionKinds(kinds []ProjectionKind) []ProjectionKind {
	if len(kinds) == 0 {
		return defaultMobileProjectionKinds()
	}
	seen := make(map[ProjectionKind]bool, len(kinds))
	var normalized []ProjectionKind
	for _, kind := range kinds {
		if !isProjectionKind(kind) || seen[kind] {
			continue
		}
		seen[kind] = true
		normalized = append(normalized, kind)
	}
	if len(normalized) == 0 {
		return defaultMobileProjectionKinds()
	}
	return normalized
}

func defaultMobileProjectionKinds() []ProjectionKind {
	return []ProjectionKind{
		ProjectionTerminal,
		ProjectionAgents,
		ProjectionSourceControl,
		ProjectionBrowser,
		ProjectionFiles,
		ProjectionOrchestration,
		ProjectionAutomations,
		ProjectionExternalTasks,
		ProjectionReleases,
		ProjectionProviders,
		ProjectionComputer,
		ProjectionEmulator,
		ProjectionSettings,
	}
}

func (m *Manager) MobileRelayStatus() MobileRelayStatus {
	m.mu.Lock()
	m.expireMobilePairingCodesLocked(time.Now().UTC())
	status := MobileRelayStatus{
		Name:            "mobile-relay",
		Configured:      true,
		ProtocolVersion: MobileRelayProtocolVersion,
		RelayID:         m.relayID,
		Capabilities: []string{
			"pairing",
			"pairing-secret-auth",
			"x25519",
			"aes-256-gcm",
			"websocket",
			"event-projection",
			"runtime-object-projection",
			"browser-download-projection",
			"provider-projection",
			"computer-action-projection",
			"emulator-projection",
			"settings-projection",
			"file-read",
			"file-write",
		},
		PairingCount:       len(m.mobilePairings),
		ActivePairingCodes: len(m.mobilePairingCodes),
		Message:            "Go runtime mobile relay accepts paired websocket clients, encrypted envelopes, and projected runtime state.",
	}
	m.mu.Unlock()
	return status
}

func (m *Manager) CreateMobileRelayPairingCode(req CreateMobileRelayPairingCodeRequest) (MobileRelayPairingCode, error) {
	now := time.Now().UTC()
	ttl := time.Duration(req.TTLSeconds) * time.Second
	if ttl <= 0 {
		ttl = 5 * time.Minute
	}
	if ttl < 30*time.Second {
		ttl = 30 * time.Second
	}
	if ttl > time.Hour {
		ttl = time.Hour
	}
	code, err := randomPairingCode()
	if err != nil {
		return MobileRelayPairingCode{}, err
	}
	pairingCode := MobileRelayPairingCode{
		Code:          code,
		ChallengeID:   newID("mpc"),
		Endpoint:      strings.TrimSpace(req.Endpoint),
		WorkspaceName: strings.TrimSpace(req.WorkspaceName),
		ExpiresAt:     now.Add(ttl),
		CreatedAt:     now,
	}
	m.mu.Lock()
	m.expireMobilePairingCodesLocked(now)
	for m.mobilePairingCodes[pairingCode.Code].Code != "" {
		pairingCode.Code, err = randomPairingCode()
		if err != nil {
			m.mu.Unlock()
			return MobileRelayPairingCode{}, err
		}
	}
	m.mobilePairingCodes[pairingCode.Code] = pairingCode
	m.mu.Unlock()
	m.emit("mobile-relay.changed", map[string]interface{}{
		"pairingCode": pairingCode,
		"status":      m.MobileRelayStatus(),
	})
	return pairingCode, nil
}

func (m *Manager) PairMobileRelayDevice(req PairMobileRelayDeviceRequest) (MobileRelayPairingRecord, error) {
	code := strings.TrimSpace(req.PairingCode)
	if code == "" {
		return MobileRelayPairingRecord{}, errors.New("pairing code is required")
	}
	device := normalizeMobileDevice(req.Device)
	if device.DeviceID == "" {
		return MobileRelayPairingRecord{}, errors.New("device id is required")
	}
	now := time.Now().UTC()
	m.mu.Lock()
	m.expireMobilePairingCodesLocked(now)
	pairingCode, ok := m.mobilePairingCodes[code]
	if !ok {
		m.mu.Unlock()
		return MobileRelayPairingRecord{}, errors.New("pairing code is invalid or expired")
	}
	delete(m.mobilePairingCodes, code)
	endpoint := strings.TrimSpace(req.Endpoint)
	if endpoint == "" {
		endpoint = pairingCode.Endpoint
	}
	record := MobileRelayPairingRecord{
		RelayID:          m.relayID,
		DeviceID:         device.DeviceID,
		DeviceName:       device.DeviceName,
		Platform:         device.Platform,
		Endpoint:         endpoint,
		WorkspaceName:    pairingCode.WorkspaceName,
		PairingSecretRef: "mrelay:" + newID("secret"),
		CreatedAt:        now,
		LastConnectedAt:  &now,
	}
	m.mobilePairings[record.DeviceID] = record
	err := m.saveLocked()
	m.mu.Unlock()
	if err != nil {
		return MobileRelayPairingRecord{}, err
	}
	m.emit("mobile-relay.changed", map[string]interface{}{
		"pairing": record,
		"status":  m.MobileRelayStatus(),
	})
	return record, nil
}

func (m *Manager) TouchMobileRelayPairing(deviceID string, secretRef string) (MobileRelayPairingRecord, bool) {
	deviceID = strings.TrimSpace(deviceID)
	if deviceID == "" {
		return MobileRelayPairingRecord{}, false
	}
	now := time.Now().UTC()
	m.mu.Lock()
	record, ok := m.mobilePairings[deviceID]
	if !ok {
		m.mu.Unlock()
		return MobileRelayPairingRecord{}, false
	}
	secretRef = strings.TrimSpace(secretRef)
	if !sameMobileRelaySecret(record.PairingSecretRef, secretRef) {
		m.mu.Unlock()
		return MobileRelayPairingRecord{}, false
	}
	record.LastConnectedAt = &now
	m.mobilePairings[deviceID] = record
	err := m.saveLocked()
	m.mu.Unlock()
	if err != nil {
		return MobileRelayPairingRecord{}, false
	}
	m.emit("mobile-relay.changed", map[string]interface{}{"pairing": record})
	return record, true
}

func sameMobileRelaySecret(expected string, got string) bool {
	if expected == "" || got == "" || len(expected) != len(got) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(expected), []byte(got)) == 1
}

func (m *Manager) ListMobileRelayPairings() []MobileRelayPairingRecord {
	m.mu.RLock()
	defer m.mu.RUnlock()
	pairings := make([]MobileRelayPairingRecord, 0, len(m.mobilePairings))
	for _, pairing := range m.mobilePairings {
		pairings = append(pairings, pairing)
	}
	sort.Slice(pairings, func(i, j int) bool {
		return pairings[i].CreatedAt.Before(pairings[j].CreatedAt)
	})
	return pairings
}

func (m *Manager) DeleteMobileRelayPairing(deviceID string) (bool, error) {
	deviceID = strings.TrimSpace(deviceID)
	if deviceID == "" {
		return false, errors.New("device id is required")
	}
	m.mu.Lock()
	record, ok := m.mobilePairings[deviceID]
	if !ok {
		m.mu.Unlock()
		return false, nil
	}
	delete(m.mobilePairings, deviceID)
	err := m.saveLocked()
	m.mu.Unlock()
	if err != nil {
		return false, err
	}
	m.emit("mobile-relay.changed", map[string]interface{}{"revokedPairing": record})
	return true, nil
}

func (m *Manager) MobileRelaySnapshot(kinds []ProjectionKind, outputLimit int) MobileRelayProjectionSnapshot {
	kinds = NormalizeMobileProjectionKinds(kinds)
	snapshot := MobileRelayProjectionSnapshot{
		Terminals:        []TerminalProjection{},
		Agents:           []AgentProjection{},
		SourceControl:    []SourceControlProjection{},
		Browser:          []BrowserProjection{},
		BrowserDownloads: []BrowserDownloadProjection{},
		Files:            []FileProjection{},
		Tasks:            []TaskProjection{},
		Messages:         []MessageProjection{},
		Dispatches:       []DispatchProjection{},
		Automations:      []AutomationProjection{},
		ExternalTasks:    []ExternalTaskProjection{},
		Releases:         []ReleaseProjection{},
		Providers:        []ProviderProjection{},
		ComputerActions:  []ComputerActionProjection{},
		EmulatorDevices:  []EmulatorDeviceProjection{},
		EmulatorSessions: []EmulatorSessionProjection{},
		Settings:         []SettingProjection{},
		Keybindings:      []KeybindingProjection{},
		ReceivedAt:       time.Now().UTC(),
	}
	if hasProjectionKind(kinds, ProjectionTerminal) {
		snapshot.Terminals = m.mobileTerminalProjections(outputLimit)
	}
	if hasProjectionKind(kinds, ProjectionAgents) {
		snapshot.Agents = m.mobileAgentProjections()
	}
	if hasProjectionKind(kinds, ProjectionSourceControl) {
		snapshot.SourceControl = m.mobileSourceControlProjections()
	}
	if hasProjectionKind(kinds, ProjectionBrowser) {
		snapshot.Browser = m.mobileBrowserProjections()
		snapshot.BrowserDownloads = m.mobileBrowserDownloadProjections()
	}
	if hasProjectionKind(kinds, ProjectionFiles) {
		snapshot.Files = m.mobileFileProjections()
	}
	if hasProjectionKind(kinds, ProjectionOrchestration) {
		snapshot.Tasks = m.mobileTaskProjections()
		snapshot.Messages = m.mobileMessageProjections()
		snapshot.Dispatches = m.mobileDispatchProjections()
	}
	if hasProjectionKind(kinds, ProjectionAutomations) {
		snapshot.Automations = m.mobileAutomationProjections()
	}
	if hasProjectionKind(kinds, ProjectionExternalTasks) {
		snapshot.ExternalTasks = m.mobileExternalTaskProjections()
	}
	if hasProjectionKind(kinds, ProjectionReleases) {
		snapshot.Releases = m.mobileReleaseProjections()
	}
	if hasProjectionKind(kinds, ProjectionProviders) {
		snapshot.Providers = m.mobileProviderProjections()
	}
	if hasProjectionKind(kinds, ProjectionComputer) {
		snapshot.ComputerActions = m.mobileComputerActionProjections()
	}
	if hasProjectionKind(kinds, ProjectionEmulator) {
		snapshot.EmulatorDevices = m.mobileEmulatorDeviceProjections()
		snapshot.EmulatorSessions = m.mobileEmulatorSessionProjections()
	}
	if hasProjectionKind(kinds, ProjectionSettings) {
		snapshot.Settings = m.mobileSettingProjections()
		snapshot.Keybindings = m.mobileKeybindingProjections()
	}
	return snapshot
}

func (m *Manager) MobileRelayEvent(event RuntimeEvent, kinds []ProjectionKind) (RuntimeEvent, bool) {
	kinds = NormalizeMobileProjectionKinds(kinds)
	switch event.Topic {
	case "session.output":
		if !hasProjectionKind(kinds, ProjectionTerminal) {
			return RuntimeEvent{}, false
		}
		payload, ok := m.mobileSessionOutputEventPayload(event)
		if !ok {
			return RuntimeEvent{}, false
		}
		event.Payload = payload
		return event, true
	case "session.status":
		if !hasProjectionKind(kinds, ProjectionTerminal) {
			return RuntimeEvent{}, false
		}
		session, ok := event.Payload.(Session)
		if !ok {
			return RuntimeEvent{}, false
		}
		event.Payload = terminalEventPayload(session, nil, event.Timestamp)
		return event, true
	case "agent.changed":
		if !hasProjectionKind(kinds, ProjectionAgents) {
			return RuntimeEvent{}, false
		}
		snapshot := m.MobileRelaySnapshot([]ProjectionKind{ProjectionAgents}, 0)
		event.Payload = map[string]interface{}{"agents": snapshot.Agents}
		return event, true
	case "project.changed", "worktree.changed", "source-control.changed":
		if !hasProjectionKind(kinds, ProjectionSourceControl) {
			return RuntimeEvent{}, false
		}
		snapshot := m.MobileRelaySnapshot([]ProjectionKind{ProjectionSourceControl}, 0)
		event.Topic = "source-control.changed"
		event.Payload = map[string]interface{}{"sourceControl": snapshot.SourceControl}
		return event, true
	case "browser.changed":
		if !hasProjectionKind(kinds, ProjectionBrowser) {
			return RuntimeEvent{}, false
		}
		snapshot := m.MobileRelaySnapshot([]ProjectionKind{ProjectionBrowser}, 0)
		event.Payload = map[string]interface{}{
			"browser":          snapshot.Browser,
			"browserDownloads": snapshot.BrowserDownloads,
		}
		return event, true
	case "file.changed":
		if !hasProjectionKind(kinds, ProjectionFiles) {
			return RuntimeEvent{}, false
		}
		snapshot := m.MobileRelaySnapshot([]ProjectionKind{ProjectionFiles}, 0)
		event.Payload = map[string]interface{}{"files": snapshot.Files}
		return event, true
	case "orchestration.changed":
		if !hasProjectionKind(kinds, ProjectionOrchestration) {
			return RuntimeEvent{}, false
		}
		snapshot := m.MobileRelaySnapshot([]ProjectionKind{ProjectionOrchestration}, 0)
		event.Payload = map[string]interface{}{
			"tasks":      snapshot.Tasks,
			"messages":   snapshot.Messages,
			"dispatches": snapshot.Dispatches,
		}
		return event, true
	case "automation.changed":
		if !hasProjectionKind(kinds, ProjectionAutomations) {
			return RuntimeEvent{}, false
		}
		snapshot := m.MobileRelaySnapshot([]ProjectionKind{ProjectionAutomations}, 0)
		event.Payload = map[string]interface{}{"automations": snapshot.Automations}
		return event, true
	case "external-task.changed":
		if !hasProjectionKind(kinds, ProjectionExternalTasks) {
			return RuntimeEvent{}, false
		}
		snapshot := m.MobileRelaySnapshot([]ProjectionKind{ProjectionExternalTasks}, 0)
		event.Payload = map[string]interface{}{"externalTasks": snapshot.ExternalTasks}
		return event, true
	case "release.changed":
		if !hasProjectionKind(kinds, ProjectionReleases) {
			return RuntimeEvent{}, false
		}
		snapshot := m.MobileRelaySnapshot([]ProjectionKind{ProjectionReleases}, 0)
		event.Payload = map[string]interface{}{"releases": snapshot.Releases}
		return event, true
	case "provider.changed":
		if !hasProjectionKind(kinds, ProjectionProviders) {
			return RuntimeEvent{}, false
		}
		snapshot := m.MobileRelaySnapshot([]ProjectionKind{ProjectionProviders}, 0)
		event.Payload = map[string]interface{}{"providers": snapshot.Providers}
		return event, true
	case "computer.changed":
		if !hasProjectionKind(kinds, ProjectionComputer) {
			return RuntimeEvent{}, false
		}
		snapshot := m.MobileRelaySnapshot([]ProjectionKind{ProjectionComputer}, 0)
		event.Payload = map[string]interface{}{"computerActions": snapshot.ComputerActions}
		return event, true
	case "emulator.changed":
		if !hasProjectionKind(kinds, ProjectionEmulator) {
			return RuntimeEvent{}, false
		}
		snapshot := m.MobileRelaySnapshot([]ProjectionKind{ProjectionEmulator}, 0)
		event.Payload = map[string]interface{}{
			"emulatorDevices":  snapshot.EmulatorDevices,
			"emulatorSessions": snapshot.EmulatorSessions,
		}
		return event, true
	case "settings.changed":
		if !hasProjectionKind(kinds, ProjectionSettings) {
			return RuntimeEvent{}, false
		}
		snapshot := m.MobileRelaySnapshot([]ProjectionKind{ProjectionSettings}, 0)
		event.Payload = map[string]interface{}{
			"settings":    snapshot.Settings,
			"keybindings": snapshot.Keybindings,
		}
		return event, true
	default:
		return RuntimeEvent{}, false
	}
}

func (m *Manager) mobileTerminalProjections(outputLimit int) []TerminalProjection {
	if outputLimit <= 0 {
		outputLimit = 200
	}
	sessions := m.ListSessions()
	projections := make([]TerminalProjection, 0, len(sessions))
	for _, session := range sessions {
		tail, err := m.TailSession(session.ID, outputLimit)
		if err != nil {
			continue
		}
		projections = append(projections, terminalProjectionFromSession(session, tail.Chunks))
	}
	return projections
}

func (m *Manager) mobileAgentProjections() []AgentProjection {
	profiles := m.ListAgentProfiles()
	profileByID := make(map[string]AgentProfile, len(profiles))
	for _, profile := range profiles {
		profileByID[profile.ID] = profile
	}
	runs := m.ListAgentRuns()
	projections := make([]AgentProjection, 0, len(runs))
	for _, run := range runs {
		profile := profileByID[run.ProfileID]
		name := profile.Name
		if name == "" {
			name = run.ProfileID
		}
		kind := profile.Kind
		if kind == "" {
			kind = "agent"
		}
		projections = append(projections, AgentProjection{
			Kind:        "agent",
			RunID:       run.ID,
			ProfileID:   run.ProfileID,
			SessionID:   run.SessionID,
			WorkspaceID: workspaceID(run.ProjectID, run.WorktreeID),
			Name:        name,
			AgentKind:   kind,
			Status:      string(run.Status),
			Prompt:      run.Prompt,
			UpdatedAt:   run.UpdatedAt,
		})
	}
	return projections
}

func (m *Manager) mobileBrowserProjections() []BrowserProjection {
	tabs := m.ListBrowserTabs()
	projections := make([]BrowserProjection, 0, len(tabs))
	for _, tab := range tabs {
		projections = append(projections, browserProjectionFromTab(tab, m.browserPermissionsForTab(tab)))
	}
	return projections
}

func (m *Manager) mobileBrowserDownloadProjections() []BrowserDownloadProjection {
	downloads := m.ListBrowserDownloads("")
	projections := make([]BrowserDownloadProjection, 0, len(downloads))
	for _, download := range downloads {
		projections = append(projections, BrowserDownloadProjection{
			Kind:          "browser-download",
			DownloadID:    download.ID,
			TabID:         download.TabID,
			URL:           download.URL,
			Filename:      download.Filename,
			Path:          download.Path,
			Status:        string(download.Status),
			BytesReceived: download.BytesReceived,
			TotalBytes:    download.TotalBytes,
			Error:         download.Error,
			UpdatedAt:     download.UpdatedAt,
		})
	}
	return projections
}

func (m *Manager) mobileFileProjections() []FileProjection {
	projects := m.ListProjects()
	worktrees := m.ListWorktrees("")
	worktreesByProject := make(map[string][]Worktree)
	for _, worktree := range worktrees {
		worktreesByProject[worktree.ProjectID] = append(worktreesByProject[worktree.ProjectID], worktree)
	}
	var projections []FileProjection
	for _, project := range projects {
		projectWorktrees := worktreesByProject[project.ID]
		if len(projectWorktrees) == 0 {
			entries, err := m.ListFiles(ListFilesRequest{ProjectID: project.ID, MaxDepth: 1})
			if err == nil {
				projections = append(projections, fileProjectionsFromEntries(project, Worktree{}, entries)...)
			}
			continue
		}
		for _, worktree := range projectWorktrees {
			entries, err := m.ListFiles(ListFilesRequest{ProjectID: project.ID, WorktreeID: worktree.ID, MaxDepth: 1})
			if err == nil {
				projections = append(projections, fileProjectionsFromEntries(project, worktree, entries)...)
			}
		}
	}
	sort.Slice(projections, func(i, j int) bool {
		if projections[i].WorkspaceID == projections[j].WorkspaceID {
			return projections[i].Path < projections[j].Path
		}
		return projections[i].WorkspaceID < projections[j].WorkspaceID
	})
	return projections
}

func (m *Manager) mobileAutomationProjections() []AutomationProjection {
	automations := m.ListAutomations()
	projections := make([]AutomationProjection, 0, len(automations))
	for _, automation := range automations {
		projections = append(projections, AutomationProjection{
			Kind:            "automation",
			AutomationID:    automation.ID,
			Name:            automation.Name,
			Description:     automation.Description,
			Enabled:         automation.Enabled,
			ScheduleKind:    string(automation.Schedule.Kind),
			ActionKind:      string(automation.Action.Kind),
			LastTriggeredAt: automation.LastTriggeredAt,
			NextRunAt:       automation.NextRunAt,
			UpdatedAt:       automation.UpdatedAt,
		})
	}
	return projections
}

func (m *Manager) mobileTaskProjections() []TaskProjection {
	tasks := m.ListTasks()
	projections := make([]TaskProjection, 0, len(tasks))
	for _, task := range tasks {
		projections = append(projections, TaskProjection{
			Kind:        "task",
			TaskID:      task.ID,
			Title:       task.Title,
			Status:      string(task.Status),
			Assignee:    task.Assignee,
			ParentID:    task.ParentID,
			CompletedAt: task.CompletedAt,
			UpdatedAt:   task.UpdatedAt,
		})
	}
	return projections
}

func (m *Manager) mobileMessageProjections() []MessageProjection {
	messages := m.ListMessages("", false)
	projections := make([]MessageProjection, 0, len(messages))
	for _, message := range messages {
		projections = append(projections, MessageProjection{
			Kind:      "message",
			MessageID: message.ID,
			ThreadID:  message.ThreadID,
			From:      message.From,
			To:        message.To,
			Subject:   message.Subject,
			Type:      string(message.Type),
			Priority:  message.Priority,
			Read:      message.Read,
			CreatedAt: message.CreatedAt,
		})
	}
	return projections
}

func (m *Manager) mobileDispatchProjections() []DispatchProjection {
	dispatches := m.ListDispatches("")
	projections := make([]DispatchProjection, 0, len(dispatches))
	for _, dispatch := range dispatches {
		projections = append(projections, DispatchProjection{
			Kind:       "dispatch",
			DispatchID: dispatch.ID,
			TaskID:     dispatch.TaskID,
			Assignee:   dispatch.Assignee,
			SessionID:  dispatch.SessionID,
			Status:     string(dispatch.Status),
			UpdatedAt:  dispatch.UpdatedAt,
		})
	}
	return projections
}

func (m *Manager) mobileExternalTaskProjections() []ExternalTaskProjection {
	items := m.ListExternalWorkItems(ExternalWorkItemFilter{})
	projections := make([]ExternalTaskProjection, 0, len(items))
	for _, item := range items {
		projections = append(projections, ExternalTaskProjection{
			Kind:         "external-task",
			ItemID:       item.ID,
			Provider:     item.Provider,
			ItemKind:     string(item.Kind),
			ExternalID:   item.ExternalID,
			URL:          item.URL,
			Title:        item.Title,
			Status:       string(item.Status),
			Assignee:     item.Assignee,
			ProjectID:    item.ProjectID,
			TaskID:       item.TaskID,
			RepositoryID: item.RepositoryID,
			WorkspaceID:  item.WorkspaceID,
			ReviewKind:   item.ReviewKind,
			LastSyncedAt: item.LastSyncedAt,
			UpdatedAt:    item.UpdatedAt,
		})
	}
	return projections
}

func (m *Manager) mobileReleaseProjections() []ReleaseProjection {
	plans := m.ListReleasePlans()
	projections := make([]ReleaseProjection, 0, len(plans))
	for _, plan := range plans {
		passedChecks := 0
		failedChecks := 0
		for _, check := range plan.Checks {
			switch check.Status {
			case ReleaseCheckPassed:
				passedChecks++
			case ReleaseCheckFailed:
				failedChecks++
			}
		}
		status, reason := releaseReadiness(plan)
		if status == ReleasePlanReady {
			reason = ""
		}
		projections = append(projections, ReleaseProjection{
			Kind:              "release",
			ReleaseID:         plan.ID,
			Version:           plan.Version,
			Channel:           plan.Channel,
			Status:            string(plan.Status),
			RequiredCount:     len(plan.RequiredArtifacts),
			ArtifactCount:     len(plan.Artifacts),
			CheckCount:        len(plan.Checks),
			PassedCheckCount:  passedChecks,
			FailedCheckCount:  failedChecks,
			Ready:             status == ReleasePlanReady,
			UpdateManifestURI: plan.UpdateManifestURI,
			BlockedReason:     reason,
			PublishedAt:       plan.PublishedAt,
			UpdatedAt:         plan.UpdatedAt,
		})
	}
	return projections
}

func (m *Manager) mobileProviderProjections() []ProviderProjection {
	providers := m.ListNativeProviders("")
	projections := make([]ProviderProjection, 0, len(providers))
	for _, provider := range providers {
		projections = append(projections, ProviderProjection{
			Kind:         "provider",
			ProviderID:   provider.ID,
			Subsystem:    provider.Subsystem,
			Name:         provider.Name,
			Status:       provider.Status,
			Capabilities: append([]string(nil), provider.Capabilities...),
			Message:      provider.Message,
			LastSeenAt:   provider.LastSeenAt,
		})
	}
	return projections
}

func (m *Manager) mobileComputerActionProjections() []ComputerActionProjection {
	actions := m.ListComputerActions("", "")
	projections := make([]ComputerActionProjection, 0, len(actions))
	for _, action := range actions {
		projections = append(projections, ComputerActionProjection{
			Kind:       "computer-action",
			ActionID:   action.ID,
			ActionKind: action.Kind,
			Target:     action.Target,
			Status:     string(action.Status),
			Payload:    cloneMap(action.Payload),
			Result:     cloneMap(action.Result),
			Error:      action.Error,
			CreatedAt:  action.CreatedAt,
			UpdatedAt:  action.UpdatedAt,
		})
	}
	return projections
}

func (m *Manager) mobileEmulatorDeviceProjections() []EmulatorDeviceProjection {
	devices := m.ListEmulatorDevices()
	projections := make([]EmulatorDeviceProjection, 0, len(devices))
	for _, device := range devices {
		projections = append(projections, EmulatorDeviceProjection{
			Kind:      "emulator-device",
			DeviceID:  device.ID,
			Name:      device.Name,
			Platform:  device.Platform,
			Runtime:   device.Runtime,
			Status:    string(device.Status),
			Error:     device.Error,
			UpdatedAt: device.UpdatedAt,
		})
	}
	return projections
}

func (m *Manager) mobileEmulatorSessionProjections() []EmulatorSessionProjection {
	sessions := m.ListEmulatorSessions()
	projections := make([]EmulatorSessionProjection, 0, len(sessions))
	for _, session := range sessions {
		projections = append(projections, EmulatorSessionProjection{
			Kind:        "emulator-session",
			SessionID:   session.ID,
			DeviceID:    session.DeviceID,
			WorkspaceID: workspaceID(session.ProjectID, session.WorktreeID),
			Active:      session.Active,
			UpdatedAt:   session.UpdatedAt,
		})
	}
	return projections
}

func (m *Manager) mobileSettingProjections() []SettingProjection {
	settings := m.ListRuntimeSettings(RuntimeSettingFilter{})
	projections := make([]SettingProjection, 0, len(settings))
	for _, setting := range settings {
		projections = append(projections, SettingProjection{
			Kind:        "setting",
			SettingID:   setting.ID,
			Scope:       string(setting.Scope),
			ProjectID:   setting.ProjectID,
			WorkspaceID: setting.WorkspaceID,
			Key:         setting.Key,
			UpdatedAt:   setting.UpdatedAt,
		})
	}
	return projections
}

func (m *Manager) mobileKeybindingProjections() []KeybindingProjection {
	keybindings := m.ListKeybindings(KeybindingFilter{})
	projections := make([]KeybindingProjection, 0, len(keybindings))
	for _, keybinding := range keybindings {
		projections = append(projections, KeybindingProjection{
			Kind:         "keybinding",
			KeybindingID: keybinding.ID,
			Command:      keybinding.Command,
			Accelerator:  keybinding.Accelerator,
			Platform:     keybinding.Platform,
			Context:      keybinding.Context,
			Enabled:      keybinding.Enabled,
			UpdatedAt:    keybinding.UpdatedAt,
		})
	}
	return projections
}

func (m *Manager) mobileSessionOutputEventPayload(event RuntimeEvent) (map[string]interface{}, bool) {
	payload, ok := event.Payload.(map[string]interface{})
	if !ok {
		return nil, false
	}
	session, ok := payload["session"].(Session)
	if !ok {
		return nil, false
	}
	chunk, ok := payload["chunk"].(OutputChunk)
	if !ok {
		return nil, false
	}
	return terminalEventPayload(session, &chunk, event.Timestamp), true
}

func (m *Manager) expireMobilePairingCodesLocked(now time.Time) {
	for code, pairingCode := range m.mobilePairingCodes {
		if !pairingCode.ExpiresAt.After(now) {
			delete(m.mobilePairingCodes, code)
		}
	}
}

func terminalProjectionFromSession(session Session, chunks []OutputChunk) TerminalProjection {
	lines := make([]TerminalOutputLine, 0, len(chunks))
	for index, chunk := range chunks {
		lines = append(lines, TerminalOutputLine{
			ID:        fmt.Sprintf("%s:%d", session.ID, index),
			Stream:    terminalStream(chunk.Stream),
			Text:      chunk.Content,
			Timestamp: chunk.At,
		})
	}
	return TerminalProjection{
		Kind:         "terminal",
		SessionID:    session.ID,
		WorkspaceID:  workspaceID(session.ProjectID, session.WorktreeID),
		Title:        terminalTitle(session),
		Cwd:          session.Cwd,
		Status:       terminalStatus(session.Status),
		IsRemote:     false,
		InputEnabled: session.Status == SessionRunning,
		Output:       lines,
		LastExitCode: cloneExitCode(session.ExitCode),
		UpdatedAt:    session.UpdatedAt,
	}
}

func terminalEventPayload(session Session, chunk *OutputChunk, timestamp time.Time) map[string]interface{} {
	payload := map[string]interface{}{
		"sessionId":    session.ID,
		"workspaceId":  workspaceID(session.ProjectID, session.WorktreeID),
		"title":        terminalTitle(session),
		"cwd":          session.Cwd,
		"status":       terminalStatus(session.Status),
		"isRemote":     false,
		"inputEnabled": session.Status == SessionRunning,
		"lastExitCode": session.ExitCode,
		"updatedAt":    timestamp,
	}
	if chunk != nil {
		payload["lineId"] = fmt.Sprintf("%s:%d", session.ID, timestamp.UnixNano())
		payload["stream"] = terminalStream(chunk.Stream)
		payload["text"] = chunk.Content
	}
	return payload
}

func browserProjectionFromTab(tab BrowserTab, permissions []BrowserPermission) BrowserProjection {
	permissionStates := make([]struct {
		Name  string `json:"name"`
		State string `json:"state"`
	}, 0, len(permissions))
	for _, permission := range permissions {
		permissionStates = append(permissionStates, struct {
			Name  string `json:"name"`
			State string `json:"state"`
		}{
			Name:  permission.Name,
			State: string(permission.State),
		})
	}
	var screenshot *BrowserScreenshotRef
	if tab.ScreenshotURI != "" && tab.ScreenshotCapturedAt != nil {
		screenshot = &BrowserScreenshotRef{
			URI:        tab.ScreenshotURI,
			CapturedAt: *tab.ScreenshotCapturedAt,
		}
	}
	return BrowserProjection{
		Kind:         "browser",
		TabID:        tab.ID,
		WorkspaceID:  workspaceID(tab.ProjectID, tab.WorktreeID),
		Title:        tab.Title,
		URL:          tab.URL,
		Status:       string(tab.Status),
		CanGoBack:    false,
		CanGoForward: false,
		Permissions:  permissionStates,
		Screenshot:   screenshot,
		ErrorMessage: tab.Error,
		UpdatedAt:    tab.UpdatedAt,
	}
}

func (m *Manager) browserPermissionsForTab(tab BrowserTab) []BrowserPermission {
	origin := browserOrigin(tab.URL)
	if origin == "" {
		return []BrowserPermission{}
	}
	m.mu.RLock()
	defer m.mu.RUnlock()
	permissions := make([]BrowserPermission, 0)
	for _, permission := range m.browserPermissions {
		if permission.ProfileID == tab.ProfileID && permission.Origin == origin {
			permissions = append(permissions, permission)
		}
	}
	sort.Slice(permissions, func(i, j int) bool {
		return permissions[i].Name < permissions[j].Name
	})
	return permissions
}

func fileProjectionsFromEntries(project Project, worktree Worktree, entries []FileEntry) []FileProjection {
	projections := make([]FileProjection, 0, len(entries))
	for _, entry := range entries {
		projections = append(projections, FileProjection{
			Kind:        "file",
			ProjectID:   project.ID,
			WorktreeID:  worktree.ID,
			WorkspaceID: workspaceID(project.ID, worktree.ID),
			Path:        entry.Path,
			Name:        entry.Name,
			EntryKind:   string(entry.Kind),
			Size:        entry.Size,
			IsRemote:    project.LocationKind == "ssh",
			UpdatedAt:   entry.ModifiedAt,
		})
	}
	return projections
}

func browserOrigin(rawURL string) string {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return ""
	}
	return parsed.Scheme + "://" + parsed.Host
}

func workspaceID(projectID string, worktreeID string) string {
	if strings.TrimSpace(worktreeID) != "" {
		return worktreeID
	}
	if strings.TrimSpace(projectID) != "" {
		return projectID
	}
	return "unknown"
}

func terminalTitle(session Session) string {
	if strings.TrimSpace(session.AgentKind) != "" {
		return session.AgentKind
	}
	if len(session.Command) > 0 && strings.TrimSpace(session.Command[0]) != "" {
		return pathBase(session.Command[0])
	}
	return pathBase(session.Cwd)
}

func terminalStatus(status SessionStatus) string {
	switch status {
	case SessionExited, SessionFailed:
		return "exited"
	case SessionStopped:
		return "detached"
	case SessionStarting, SessionRunning:
		return "running"
	default:
		return "idle"
	}
}

func terminalStream(stream string) string {
	switch stream {
	case "stderr", "system":
		return stream
	default:
		return "stdout"
	}
}

func normalizeMobileDevice(device MobileRelayDeviceIdentity) MobileRelayDeviceIdentity {
	device.DeviceID = strings.TrimSpace(device.DeviceID)
	device.DeviceName = strings.TrimSpace(device.DeviceName)
	device.Platform = strings.TrimSpace(device.Platform)
	if device.DeviceName == "" {
		device.DeviceName = "Mobile device"
	}
	if device.Platform == "" {
		device.Platform = "unknown"
	}
	return device
}

func gitProviderKind(provider string) string {
	switch strings.ToLower(strings.TrimSpace(provider)) {
	case "github":
		return "github"
	case "gitlab":
		return "gitlab"
	case "bitbucket":
		return "bitbucket"
	case "azure-devops", "azuredevops", "azure":
		return "azure-devops"
	case "generic":
		return "generic"
	case "", "git":
		return "git"
	default:
		return "unknown"
	}
}

func reviewKind(kind string) string {
	normalized := strings.NewReplacer("_", "-", " ", "-").Replace(strings.ToLower(strings.TrimSpace(kind)))
	switch normalized {
	case "pull-request", "pr":
		return "pull-request"
	case "merge-request", "mr":
		return "merge-request"
	case "change-request":
		return "change-request"
	default:
		return "none"
	}
}

func randomPairingCode() (string, error) {
	value, err := rand.Int(rand.Reader, big.NewInt(1000000))
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%06d", value.Int64()), nil
}

func hasProjectionKind(kinds []ProjectionKind, kind ProjectionKind) bool {
	for _, current := range kinds {
		if current == kind {
			return true
		}
	}
	return false
}

func isProjectionKind(kind ProjectionKind) bool {
	switch kind {
	case ProjectionTerminal,
		ProjectionAgents,
		ProjectionSourceControl,
		ProjectionBrowser,
		ProjectionFiles,
		ProjectionOrchestration,
		ProjectionAutomations,
		ProjectionExternalTasks,
		ProjectionReleases,
		ProjectionProviders,
		ProjectionComputer,
		ProjectionEmulator,
		ProjectionSettings:
		return true
	default:
		return false
	}
}
