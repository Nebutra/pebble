package runtimecore

import "time"

const ProtocolVersion = "pebble.runtime.v1"

type Capability string

const (
	CapabilityProjects      Capability = "projects"
	CapabilityWorktrees     Capability = "worktrees"
	CapabilitySessions      Capability = "sessions"
	CapabilityAgents        Capability = "agents"
	CapabilityOrchestration Capability = "orchestration"
	CapabilityAutomations   Capability = "automations"
	CapabilityExternalTasks Capability = "external-tasks"
	CapabilitySourceControl Capability = "source-control"
	CapabilityFiles         Capability = "files"
	CapabilityReleases      Capability = "releases"
	CapabilitySettings      Capability = "settings"
	CapabilityBrowser       Capability = "browser"
	CapabilityComputer      Capability = "computer"
	CapabilityEmulator      Capability = "emulator"
	CapabilityMobileRelay   Capability = "mobile-relay"
)

type RuntimeStatus struct {
	Version          string       `json:"version"`
	StartedAt        time.Time    `json:"startedAt"`
	UptimeSeconds    int64        `json:"uptimeSeconds"`
	ProjectCount     int          `json:"projectCount"`
	WorktreeCount    int          `json:"worktreeCount"`
	SessionCount     int          `json:"sessionCount"`
	AgentRunCount    int          `json:"agentRunCount"`
	TaskCount        int          `json:"taskCount"`
	Capabilities     []Capability `json:"capabilities"`
	UnavailableTools []string     `json:"unavailableTools,omitempty"`
}

type Project struct {
	ID           string    `json:"id"`
	Name         string    `json:"name"`
	Path         string    `json:"path"`
	LocationKind string    `json:"locationKind"`
	HostID       string    `json:"hostId,omitempty"`
	Provider     string    `json:"provider,omitempty"`
	CreatedAt    time.Time `json:"createdAt"`
	UpdatedAt    time.Time `json:"updatedAt"`
}

type CreateProjectRequest struct {
	Name         string `json:"name"`
	Path         string `json:"path"`
	LocationKind string `json:"locationKind,omitempty"`
	HostID       string `json:"hostId,omitempty"`
	Provider     string `json:"provider,omitempty"`
}

type UpdateProjectRequest struct {
	Name         string `json:"name,omitempty"`
	Path         string `json:"path,omitempty"`
	LocationKind string `json:"locationKind,omitempty"`
	HostID       string `json:"hostId,omitempty"`
	Provider     string `json:"provider,omitempty"`
}

type Worktree struct {
	ID         string    `json:"id"`
	ProjectID  string    `json:"projectId"`
	Path       string    `json:"path"`
	Branch     string    `json:"branch,omitempty"`
	Base       string    `json:"base,omitempty"`
	ReviewKind string    `json:"reviewKind,omitempty"`
	ReviewID   string    `json:"reviewId,omitempty"`
	CreatedAt  time.Time `json:"createdAt"`
	UpdatedAt  time.Time `json:"updatedAt"`
}

type CreateWorktreeRequest struct {
	ProjectID    string `json:"projectId"`
	Path         string `json:"path"`
	Branch       string `json:"branch,omitempty"`
	Base         string `json:"base,omitempty"`
	ReviewKind   string `json:"reviewKind,omitempty"`
	ReviewID     string `json:"reviewId,omitempty"`
	ExecuteGit   bool   `json:"executeGit,omitempty"`
	SkipCheckout bool   `json:"skipCheckout,omitempty"`
}

type SessionStatus string

const (
	SessionStarting SessionStatus = "starting"
	SessionRunning  SessionStatus = "running"
	SessionExited   SessionStatus = "exited"
	SessionFailed   SessionStatus = "failed"
	SessionStopped  SessionStatus = "stopped"
)

type Session struct {
	ID           string        `json:"id"`
	ProjectID    string        `json:"projectId"`
	WorktreeID   string        `json:"worktreeId,omitempty"`
	Cwd          string        `json:"cwd"`
	Command      []string      `json:"command"`
	AgentKind    string        `json:"agentKind,omitempty"`
	Status       SessionStatus `json:"status"`
	ExitCode     *int          `json:"exitCode,omitempty"`
	StartedAt    time.Time     `json:"startedAt"`
	UpdatedAt    time.Time     `json:"updatedAt"`
	OutputChunks int           `json:"outputChunks"`
}

type StartSessionRequest struct {
	ProjectID  string   `json:"projectId"`
	WorktreeID string   `json:"worktreeId,omitempty"`
	Cwd        string   `json:"cwd,omitempty"`
	Command    []string `json:"command,omitempty"`
	AgentKind  string   `json:"agentKind,omitempty"`
	Prompt     string   `json:"prompt,omitempty"`
}

type SessionInputRequest struct {
	Text          string `json:"text"`
	AppendNewline bool   `json:"appendNewline,omitempty"`
}

type OutputChunk struct {
	At      time.Time `json:"at"`
	Stream  string    `json:"stream"`
	Content string    `json:"content"`
}

type TailSessionResponse struct {
	SessionID string        `json:"sessionId"`
	Chunks    []OutputChunk `json:"chunks"`
}

type PromptInjectionMode string

const (
	PromptArgv            PromptInjectionMode = "argv"
	PromptFlagPrompt      PromptInjectionMode = "flag-prompt"
	PromptFlagInteractive PromptInjectionMode = "flag-prompt-interactive"
	PromptStdinAfterStart PromptInjectionMode = "stdin-after-start"
	PromptNone            PromptInjectionMode = "none"
)

type AgentProfile struct {
	ID                  string              `json:"id"`
	Name                string              `json:"name"`
	Kind                string              `json:"kind"`
	Command             []string            `json:"command"`
	PromptInjectionMode PromptInjectionMode `json:"promptInjectionMode"`
	PromptFlag          string              `json:"promptFlag,omitempty"`
	CreatedAt           time.Time           `json:"createdAt"`
	UpdatedAt           time.Time           `json:"updatedAt"`
}

type CreateAgentProfileRequest struct {
	Name                string              `json:"name"`
	Kind                string              `json:"kind"`
	Command             []string            `json:"command"`
	PromptInjectionMode PromptInjectionMode `json:"promptInjectionMode,omitempty"`
	PromptFlag          string              `json:"promptFlag,omitempty"`
}

type UpdateAgentProfileRequest struct {
	Name                string              `json:"name,omitempty"`
	Kind                string              `json:"kind,omitempty"`
	Command             []string            `json:"command,omitempty"`
	PromptInjectionMode PromptInjectionMode `json:"promptInjectionMode,omitempty"`
	PromptFlag          string              `json:"promptFlag,omitempty"`
}

type AgentRunStatus string

const (
	AgentRunStarting AgentRunStatus = "starting"
	AgentRunRunning  AgentRunStatus = "running"
	AgentRunExited   AgentRunStatus = "exited"
	AgentRunFailed   AgentRunStatus = "failed"
	AgentRunStopped  AgentRunStatus = "stopped"
)

type AgentRun struct {
	ID         string         `json:"id"`
	ProfileID  string         `json:"profileId"`
	SessionID  string         `json:"sessionId"`
	ProjectID  string         `json:"projectId"`
	WorktreeID string         `json:"worktreeId,omitempty"`
	Status     AgentRunStatus `json:"status"`
	Prompt     string         `json:"prompt,omitempty"`
	CreatedAt  time.Time      `json:"createdAt"`
	UpdatedAt  time.Time      `json:"updatedAt"`
}

type StartAgentRunRequest struct {
	ProfileID  string `json:"profileId"`
	ProjectID  string `json:"projectId"`
	WorktreeID string `json:"worktreeId,omitempty"`
	Cwd        string `json:"cwd,omitempty"`
	Prompt     string `json:"prompt,omitempty"`
}

type TaskStatus string

const (
	TaskPending    TaskStatus = "pending"
	TaskReady      TaskStatus = "ready"
	TaskDispatched TaskStatus = "dispatched"
	TaskCompleted  TaskStatus = "completed"
	TaskFailed     TaskStatus = "failed"
	TaskBlocked    TaskStatus = "blocked"
)

type Task struct {
	ID          string     `json:"id"`
	Title       string     `json:"title"`
	Body        string     `json:"body,omitempty"`
	Status      TaskStatus `json:"status"`
	Assignee    string     `json:"assignee,omitempty"`
	ParentID    string     `json:"parentId,omitempty"`
	CreatedAt   time.Time  `json:"createdAt"`
	UpdatedAt   time.Time  `json:"updatedAt"`
	CompletedAt *time.Time `json:"completedAt,omitempty"`
}

type CreateTaskRequest struct {
	Title    string `json:"title"`
	Body     string `json:"body,omitempty"`
	Assignee string `json:"assignee,omitempty"`
	ParentID string `json:"parentId,omitempty"`
}

type UpdateTaskRequest struct {
	Status   TaskStatus `json:"status"`
	Assignee string     `json:"assignee,omitempty"`
}

type MessageType string

const (
	MessageStatus       MessageType = "status"
	MessageDispatch     MessageType = "dispatch"
	MessageWorkerDone   MessageType = "worker_done"
	MessageMergeReady   MessageType = "merge_ready"
	MessageEscalation   MessageType = "escalation"
	MessageHandoff      MessageType = "handoff"
	MessageDecisionGate MessageType = "decision_gate"
	MessageHeartbeat    MessageType = "heartbeat"
)

type Message struct {
	ID        string      `json:"id"`
	ThreadID  string      `json:"threadId"`
	From      string      `json:"from"`
	To        string      `json:"to"`
	Subject   string      `json:"subject"`
	Body      string      `json:"body,omitempty"`
	Type      MessageType `json:"type"`
	Priority  string      `json:"priority,omitempty"`
	Read      bool        `json:"read"`
	ReplyToID string      `json:"replyToId,omitempty"`
	CreatedAt time.Time   `json:"createdAt"`
}

type SendMessageRequest struct {
	From      string      `json:"from,omitempty"`
	To        string      `json:"to"`
	Subject   string      `json:"subject"`
	Body      string      `json:"body,omitempty"`
	Type      MessageType `json:"type,omitempty"`
	Priority  string      `json:"priority,omitempty"`
	ThreadID  string      `json:"threadId,omitempty"`
	ReplyToID string      `json:"replyToId,omitempty"`
}

type DispatchStatus string

const (
	DispatchCreated   DispatchStatus = "created"
	DispatchInjected  DispatchStatus = "injected"
	DispatchCompleted DispatchStatus = "completed"
	DispatchFailed    DispatchStatus = "failed"
)

type Dispatch struct {
	ID        string         `json:"id"`
	TaskID    string         `json:"taskId"`
	Assignee  string         `json:"assignee"`
	SessionID string         `json:"sessionId,omitempty"`
	Status    DispatchStatus `json:"status"`
	Preamble  string         `json:"preamble,omitempty"`
	CreatedAt time.Time      `json:"createdAt"`
	UpdatedAt time.Time      `json:"updatedAt"`
}

type DispatchTaskRequest struct {
	TaskID    string `json:"taskId"`
	Assignee  string `json:"assignee"`
	SessionID string `json:"sessionId,omitempty"`
	Inject    bool   `json:"inject,omitempty"`
}

type UpdateDispatchRequest struct {
	Status DispatchStatus `json:"status"`
}

type BrowserTabStatus string

const (
	BrowserTabLoading BrowserTabStatus = "loading"
	BrowserTabReady   BrowserTabStatus = "ready"
	BrowserTabError   BrowserTabStatus = "error"
)

type BrowserTab struct {
	ID                   string           `json:"id"`
	ProjectID            string           `json:"projectId,omitempty"`
	WorktreeID           string           `json:"worktreeId,omitempty"`
	ProfileID            string           `json:"profileId,omitempty"`
	Title                string           `json:"title"`
	URL                  string           `json:"url"`
	Status               BrowserTabStatus `json:"status"`
	ScreenshotURI        string           `json:"screenshotUri,omitempty"`
	ScreenshotCapturedAt *time.Time       `json:"screenshotCapturedAt,omitempty"`
	Error                string           `json:"error,omitempty"`
	CreatedAt            time.Time        `json:"createdAt"`
	UpdatedAt            time.Time        `json:"updatedAt"`
}

type CreateBrowserTabRequest struct {
	ProjectID  string `json:"projectId,omitempty"`
	WorktreeID string `json:"worktreeId,omitempty"`
	ProfileID  string `json:"profileId,omitempty"`
	Title      string `json:"title,omitempty"`
	URL        string `json:"url"`
}

type UpdateBrowserTabRequest struct {
	Title                string           `json:"title,omitempty"`
	URL                  string           `json:"url,omitempty"`
	Status               BrowserTabStatus `json:"status,omitempty"`
	ScreenshotURI        string           `json:"screenshotUri,omitempty"`
	ScreenshotCapturedAt *time.Time       `json:"screenshotCapturedAt,omitempty"`
	Error                string           `json:"error,omitempty"`
}

type BrowserCommandRequest struct {
	Command string                 `json:"command"`
	Payload map[string]interface{} `json:"payload,omitempty"`
}

type BrowserProfile struct {
	ID         string    `json:"id"`
	Name       string    `json:"name"`
	Persistent bool      `json:"persistent"`
	CreatedAt  time.Time `json:"createdAt"`
	UpdatedAt  time.Time `json:"updatedAt"`
}

type CreateBrowserProfileRequest struct {
	Name       string `json:"name"`
	Persistent bool   `json:"persistent,omitempty"`
}

type BrowserPermissionState string

const (
	BrowserPermissionPrompt  BrowserPermissionState = "prompt"
	BrowserPermissionGranted BrowserPermissionState = "granted"
	BrowserPermissionDenied  BrowserPermissionState = "denied"
)

type BrowserPermission struct {
	ID        string                 `json:"id"`
	ProfileID string                 `json:"profileId,omitempty"`
	Origin    string                 `json:"origin"`
	Name      string                 `json:"name"`
	State     BrowserPermissionState `json:"state"`
	UpdatedAt time.Time              `json:"updatedAt"`
}

type SetBrowserPermissionRequest struct {
	ProfileID string                 `json:"profileId,omitempty"`
	Origin    string                 `json:"origin"`
	Name      string                 `json:"name"`
	State     BrowserPermissionState `json:"state"`
}

type BrowserDownloadStatus string

const (
	BrowserDownloadQueued     BrowserDownloadStatus = "queued"
	BrowserDownloadInProgress BrowserDownloadStatus = "inProgress"
	BrowserDownloadCompleted  BrowserDownloadStatus = "completed"
	BrowserDownloadFailed     BrowserDownloadStatus = "failed"
	BrowserDownloadCanceled   BrowserDownloadStatus = "canceled"
)

type BrowserDownload struct {
	ID            string                `json:"id"`
	TabID         string                `json:"tabId,omitempty"`
	URL           string                `json:"url"`
	Filename      string                `json:"filename,omitempty"`
	Path          string                `json:"path,omitempty"`
	Status        BrowserDownloadStatus `json:"status"`
	BytesReceived int64                 `json:"bytesReceived,omitempty"`
	TotalBytes    int64                 `json:"totalBytes,omitempty"`
	Error         string                `json:"error,omitempty"`
	CreatedAt     time.Time             `json:"createdAt"`
	UpdatedAt     time.Time             `json:"updatedAt"`
}

type CreateBrowserDownloadRequest struct {
	TabID         string                `json:"tabId,omitempty"`
	URL           string                `json:"url"`
	Filename      string                `json:"filename,omitempty"`
	Path          string                `json:"path,omitempty"`
	Status        BrowserDownloadStatus `json:"status,omitempty"`
	BytesReceived int64                 `json:"bytesReceived,omitempty"`
	TotalBytes    int64                 `json:"totalBytes,omitempty"`
}

type UpdateBrowserDownloadRequest struct {
	Filename      string                `json:"filename,omitempty"`
	Path          string                `json:"path,omitempty"`
	Status        BrowserDownloadStatus `json:"status,omitempty"`
	BytesReceived *int64                `json:"bytesReceived,omitempty"`
	TotalBytes    *int64                `json:"totalBytes,omitempty"`
	Error         string                `json:"error,omitempty"`
}

type ComputerActionStatus string

const (
	ComputerActionQueued    ComputerActionStatus = "queued"
	ComputerActionRunning   ComputerActionStatus = "running"
	ComputerActionCompleted ComputerActionStatus = "completed"
	ComputerActionFailed    ComputerActionStatus = "failed"
)

type ComputerAction struct {
	ID        string                 `json:"id"`
	Kind      string                 `json:"kind"`
	Target    string                 `json:"target,omitempty"`
	Payload   map[string]interface{} `json:"payload,omitempty"`
	Status    ComputerActionStatus   `json:"status"`
	Result    map[string]interface{} `json:"result,omitempty"`
	Error     string                 `json:"error,omitempty"`
	CreatedAt time.Time              `json:"createdAt"`
	UpdatedAt time.Time              `json:"updatedAt"`
}

type CreateComputerActionRequest struct {
	Kind    string                 `json:"kind"`
	Target  string                 `json:"target,omitempty"`
	Payload map[string]interface{} `json:"payload,omitempty"`
}

type UpdateComputerActionRequest struct {
	Status ComputerActionStatus   `json:"status"`
	Result map[string]interface{} `json:"result,omitempty"`
	Error  string                 `json:"error,omitempty"`
}

type ClaimComputerActionsRequest struct {
	KindPrefix string `json:"kindPrefix,omitempty"`
	Limit      int    `json:"limit,omitempty"`
}

type EmulatorDeviceStatus string

const (
	EmulatorDeviceAvailable EmulatorDeviceStatus = "available"
	EmulatorDeviceBooting   EmulatorDeviceStatus = "booting"
	EmulatorDeviceRunning   EmulatorDeviceStatus = "running"
	EmulatorDeviceStopped   EmulatorDeviceStatus = "stopped"
	EmulatorDeviceError     EmulatorDeviceStatus = "error"
)

type EmulatorDevice struct {
	ID        string               `json:"id"`
	Name      string               `json:"name"`
	Platform  string               `json:"platform"`
	Runtime   string               `json:"runtime,omitempty"`
	Status    EmulatorDeviceStatus `json:"status"`
	Error     string               `json:"error,omitempty"`
	CreatedAt time.Time            `json:"createdAt"`
	UpdatedAt time.Time            `json:"updatedAt"`
}

type RegisterEmulatorDeviceRequest struct {
	Name     string               `json:"name"`
	Platform string               `json:"platform"`
	Runtime  string               `json:"runtime,omitempty"`
	Status   EmulatorDeviceStatus `json:"status,omitempty"`
}

type UpdateEmulatorDeviceRequest struct {
	Name    string               `json:"name,omitempty"`
	Runtime string               `json:"runtime,omitempty"`
	Status  EmulatorDeviceStatus `json:"status,omitempty"`
	Error   string               `json:"error,omitempty"`
}

type EmulatorSession struct {
	ID         string    `json:"id"`
	DeviceID   string    `json:"deviceId"`
	ProjectID  string    `json:"projectId,omitempty"`
	WorktreeID string    `json:"worktreeId,omitempty"`
	Active     bool      `json:"active"`
	CreatedAt  time.Time `json:"createdAt"`
	UpdatedAt  time.Time `json:"updatedAt"`
}

type AttachEmulatorRequest struct {
	DeviceID   string `json:"deviceId"`
	ProjectID  string `json:"projectId,omitempty"`
	WorktreeID string `json:"worktreeId,omitempty"`
}

type EmulatorCommandRequest struct {
	Command string                 `json:"command"`
	Payload map[string]interface{} `json:"payload,omitempty"`
}

type GitStatus struct {
	ProjectID string   `json:"projectId"`
	Path      string   `json:"path"`
	Lines     []string `json:"lines"`
}

type GitDiff struct {
	ProjectID string `json:"projectId"`
	Path      string `json:"path"`
	FilePath  string `json:"filePath,omitempty"`
	Cached    bool   `json:"cached"`
	Patch     string `json:"patch"`
}

type RuntimeEvent struct {
	Version   string      `json:"version"`
	ID        string      `json:"id"`
	Timestamp time.Time   `json:"timestamp"`
	Topic     string      `json:"topic"`
	Payload   interface{} `json:"payload"`
}

type SubsystemStatus struct {
	Name         string   `json:"name"`
	Status       string   `json:"status"`
	Configured   bool     `json:"configured"`
	Capabilities []string `json:"capabilities"`
	Message      string   `json:"message,omitempty"`
}

type NativeProviderRegistration struct {
	ID           string    `json:"id"`
	Subsystem    string    `json:"subsystem"`
	Name         string    `json:"name"`
	Status       string    `json:"status"`
	Capabilities []string  `json:"capabilities"`
	Message      string    `json:"message,omitempty"`
	LastSeenAt   time.Time `json:"lastSeenAt"`
}

type RegisterNativeProviderRequest struct {
	ID           string   `json:"id,omitempty"`
	Subsystem    string   `json:"subsystem"`
	Name         string   `json:"name"`
	Status       string   `json:"status,omitempty"`
	Capabilities []string `json:"capabilities,omitempty"`
	Message      string   `json:"message,omitempty"`
}
