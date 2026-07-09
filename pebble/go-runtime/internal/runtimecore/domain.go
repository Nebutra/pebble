package runtimecore

import (
	"encoding/json"
	"time"
)

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
	SortOrder    int64     `json:"sortOrder,omitempty"`
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

type CloneProjectRequest struct {
	URL         string `json:"url"`
	Destination string `json:"destination"`
}

type UpdateProjectRequest struct {
	Name         string `json:"name,omitempty"`
	Path         string `json:"path,omitempty"`
	LocationKind string `json:"locationKind,omitempty"`
	HostID       string `json:"hostId,omitempty"`
	Provider     string `json:"provider,omitempty"`
}

type PersistProjectSortOrderRequest struct {
	OrderedIDs []string `json:"orderedIds"`
}

type Worktree struct {
	ID             string `json:"id"`
	InstanceID     string `json:"instanceId,omitempty"`
	ProjectID      string `json:"projectId"`
	Path           string `json:"path"`
	Branch         string `json:"branch,omitempty"`
	Base           string `json:"base,omitempty"`
	CreatedBaseSHA string `json:"createdBaseSha,omitempty"`
	ReviewKind     string `json:"reviewKind,omitempty"`
	ReviewID       string `json:"reviewId,omitempty"`
	DisplayName    string `json:"displayName,omitempty"`
	Comment        string `json:"comment,omitempty"`
	// Linked work-item references round-trip losslessly for the desktop renderer.
	// Pointers preserve the null-vs-unset distinction the renderer relies on.
	LinkedIssue       *int64            `json:"linkedIssue,omitempty"`
	LinkedPR          *int64            `json:"linkedPR,omitempty"`
	LinkedLinearIssue *string           `json:"linkedLinearIssue,omitempty"`
	IsArchived        bool              `json:"isArchived,omitempty"`
	IsUnread          bool              `json:"isUnread,omitempty"`
	IsPinned          bool              `json:"isPinned,omitempty"`
	SortOrder         int64             `json:"sortOrder,omitempty"`
	ManualOrder       *int64            `json:"manualOrder,omitempty"`
	LastActivityAt    int64             `json:"lastActivityAt,omitempty"`
	WorkspaceStatus   string            `json:"workspaceStatus,omitempty"`
	Lineage           *WorktreeLineage  `json:"lineage,omitempty"`
	WorkspaceLineage  *WorkspaceLineage `json:"workspaceLineage,omitempty"`
	CreatedAt         time.Time         `json:"createdAt"`
	UpdatedAt         time.Time         `json:"updatedAt"`
}

type CreateWorktreeRequest struct {
	ProjectID      string `json:"projectId"`
	Path           string `json:"path"`
	Branch         string `json:"branch,omitempty"`
	Base           string `json:"base,omitempty"`
	CreatedBaseSHA string `json:"createdBaseSha,omitempty"`
	ReviewKind     string `json:"reviewKind,omitempty"`
	ReviewID       string `json:"reviewId,omitempty"`
	ExecuteGit     bool   `json:"executeGit,omitempty"`
	SkipCheckout   bool   `json:"skipCheckout,omitempty"`
}

type UpdateWorktreeRequest struct {
	ParentWorktreeID string                 `json:"parentWorktreeId,omitempty"`
	ParentWorkspace  string                 `json:"parentWorkspace,omitempty"`
	NoParent         bool                   `json:"noParent,omitempty"`
	Origin           string                 `json:"origin,omitempty"`
	Capture          WorktreeLineageCapture `json:"capture,omitempty"`
	DisplayName      *string                `json:"displayName,omitempty"`
	Comment          *string                `json:"comment,omitempty"`
	IsArchived       *bool                  `json:"isArchived,omitempty"`
	IsUnread         *bool                  `json:"isUnread,omitempty"`
	IsPinned         *bool                  `json:"isPinned,omitempty"`
	SortOrder        *int64                 `json:"sortOrder,omitempty"`
	ManualOrder      *int64                 `json:"manualOrder,omitempty"`
	WorkspaceStatus  *string                `json:"workspaceStatus,omitempty"`
	// Raw pointers distinguish absent (leave untouched) from explicit null
	// (clear the link) so the renderer can both set and clear these fields.
	LinkedIssue       *json.RawMessage `json:"linkedIssue,omitempty"`
	LinkedPR          *json.RawMessage `json:"linkedPR,omitempty"`
	LinkedLinearIssue *json.RawMessage `json:"linkedLinearIssue,omitempty"`
}

type DeleteWorktreeRequest struct {
	ExecuteGit bool `json:"executeGit,omitempty"`
	Force      bool `json:"force,omitempty"`
	// ForceBranchDelete opts into `git branch -D` for failed-creation rollback,
	// where the fresh branch has no user work to protect. User-initiated deletes
	// leave it false so unmerged commits are preserved instead of discarded.
	ForceBranchDelete bool `json:"forceBranchDelete,omitempty"`
}

// PreservedWorktreeBranch names a local branch that a worktree removal kept
// because it still held unmerged/unpushed commits. Head is the commit the
// branch pointed at, so a later force-delete can compare-and-swap safely.
type PreservedWorktreeBranch struct {
	BranchName string `json:"branchName"`
	Head       string `json:"head,omitempty"`
}

// DeleteWorktreeResponse mirrors the desktop worktree record but adds the
// preserved-branch info the renderer needs to offer a force-delete follow-up.
// PreservedBranch is null when the branch was cleaned up (or never existed).
type DeleteWorktreeResponse struct {
	Worktree
	PreservedBranch *PreservedWorktreeBranch `json:"preservedBranch"`
}

// ForceDeletePreservedBranchRequest force-deletes a branch that a prior worktree
// removal preserved. ExpectedHead guards against deleting a branch that moved
// after preservation.
type ForceDeletePreservedBranchRequest struct {
	ProjectID    string `json:"projectId"`
	BranchName   string `json:"branchName"`
	ExpectedHead string `json:"expectedHead,omitempty"`
}

type ForceDeletePreservedBranchResponse struct {
	Deleted bool `json:"deleted"`
}

type PersistWorktreeSortOrderRequest struct {
	OrderedIDs []string `json:"orderedIds"`
}

type WorktreeLineageCapture struct {
	Source     string `json:"source"`
	Confidence string `json:"confidence"`
}

type WorktreeLineage struct {
	WorktreeID               string                 `json:"worktreeId"`
	WorktreeInstanceID       string                 `json:"worktreeInstanceId"`
	ParentWorktreeID         string                 `json:"parentWorktreeId"`
	ParentWorktreeInstanceID string                 `json:"parentWorktreeInstanceId"`
	Origin                   string                 `json:"origin"`
	Capture                  WorktreeLineageCapture `json:"capture"`
	CreatedAt                int64                  `json:"createdAt"`
}

type WorkspaceLineage struct {
	ChildWorkspaceKey  string                 `json:"childWorkspaceKey"`
	ChildInstanceID    string                 `json:"childInstanceId,omitempty"`
	ParentWorkspaceKey string                 `json:"parentWorkspaceKey"`
	ParentInstanceID   string                 `json:"parentInstanceId,omitempty"`
	Origin             string                 `json:"origin"`
	Capture            WorktreeLineageCapture `json:"capture"`
	CreatedAt          int64                  `json:"createdAt"`
}

type WorktreeLineageListResponse struct {
	Lineage          map[string]WorktreeLineage  `json:"lineage"`
	WorkspaceLineage map[string]WorkspaceLineage `json:"workspaceLineage"`
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
	TabID        string        `json:"tabId,omitempty"`
	LeafID       string        `json:"leafId,omitempty"`
	LaunchToken  string        `json:"launchToken,omitempty"`
	Prompt       string        `json:"prompt,omitempty"`
	Status       SessionStatus `json:"status"`
	ExitCode     *int          `json:"exitCode,omitempty"`
	StartedAt    time.Time     `json:"startedAt"`
	UpdatedAt    time.Time     `json:"updatedAt"`
	OutputChunks int           `json:"outputChunks"`
	Cols         int           `json:"cols,omitempty"`
	Rows         int           `json:"rows,omitempty"`
}

type StartSessionRequest struct {
	ProjectID   string   `json:"projectId"`
	WorktreeID  string   `json:"worktreeId,omitempty"`
	Cwd         string   `json:"cwd,omitempty"`
	Command     []string `json:"command,omitempty"`
	AgentKind   string   `json:"agentKind,omitempty"`
	TabID       string   `json:"tabId,omitempty"`
	LeafID      string   `json:"leafId,omitempty"`
	LaunchToken string   `json:"launchToken,omitempty"`
	Prompt      string   `json:"prompt,omitempty"`
	Cols        int      `json:"cols,omitempty"`
	Rows        int      `json:"rows,omitempty"`
}

type SessionInputRequest struct {
	Text          string `json:"text"`
	AppendNewline bool   `json:"appendNewline,omitempty"`
}

type SessionResizeRequest struct {
	Cols int `json:"cols"`
	Rows int `json:"rows"`
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

type GitFileDiffRequest struct {
	ProjectID          string `json:"projectId"`
	WorktreeID         string `json:"worktreeId,omitempty"`
	FilePath           string `json:"filePath"`
	Staged             bool   `json:"staged,omitempty"`
	CompareAgainstHead bool   `json:"compareAgainstHead,omitempty"`
}

type GitFileDiffResult struct {
	Kind             string `json:"kind"`
	OriginalContent  string `json:"originalContent"`
	ModifiedContent  string `json:"modifiedContent"`
	OriginalIsBinary bool   `json:"originalIsBinary"`
	ModifiedIsBinary bool   `json:"modifiedIsBinary"`
}

type GitMutationRequest struct {
	ProjectID      string   `json:"projectId"`
	WorktreeID     string   `json:"worktreeId,omitempty"`
	Operation      string   `json:"operation"`
	FilePath       string   `json:"filePath,omitempty"`
	FilePaths      []string `json:"filePaths,omitempty"`
	Message        string   `json:"message,omitempty"`
	RemoteName     string   `json:"remoteName,omitempty"`
	BranchName     string   `json:"branchName,omitempty"`
	Publish        bool     `json:"publish,omitempty"`
	ForceWithLease bool     `json:"forceWithLease,omitempty"`
	BaseRef        string   `json:"baseRef,omitempty"`
}

type GitBaseStatusRequest struct {
	ProjectID      string `json:"projectId"`
	WorktreeID     string `json:"worktreeId,omitempty"`
	BaseRef        string `json:"baseRef"`
	CreatedBaseSHA string `json:"createdBaseSha"`
	BranchName     string `json:"branchName,omitempty"`
}

type GitBaseStatusResult struct {
	Status         string                   `json:"status"`
	Base           string                   `json:"base"`
	Remote         string                   `json:"remote,omitempty"`
	Behind         int                      `json:"behind,omitempty"`
	RecentSubjects []string                 `json:"recentSubjects,omitempty"`
	Conflict       *GitRemoteBranchConflict `json:"conflict,omitempty"`
}

type GitRemoteBranchConflict struct {
	Remote     string `json:"remote"`
	BranchName string `json:"branchName"`
}

type GitCheckIgnoredRequest struct {
	ProjectID  string   `json:"projectId"`
	WorktreeID string   `json:"worktreeId,omitempty"`
	Paths      []string `json:"paths"`
}

type GitCommitResult struct {
	Success bool   `json:"success"`
	Error   string `json:"error,omitempty"`
}

type GitStatusEntry struct {
	Path    string `json:"path"`
	Status  string `json:"status"`
	Area    string `json:"area"`
	Added   int    `json:"added,omitempty"`
	Removed int    `json:"removed,omitempty"`
	OldPath string `json:"oldPath,omitempty"`
}

type GitStatusResult struct {
	Entries           []GitStatusEntry `json:"entries"`
	ConflictOperation string           `json:"conflictOperation"`
}

type GitSubmoduleStatusRequest struct {
	ProjectID     string `json:"projectId"`
	WorktreeID    string `json:"worktreeId,omitempty"`
	SubmodulePath string `json:"submodulePath"`
	Area          string `json:"area,omitempty"`
}

type GitRemoteFileURLRequest struct {
	ProjectID    string `json:"projectId"`
	WorktreeID   string `json:"worktreeId,omitempty"`
	RelativePath string `json:"relativePath"`
	Line         int    `json:"line"`
}

type GitRemoteCommitURLRequest struct {
	ProjectID  string `json:"projectId"`
	WorktreeID string `json:"worktreeId,omitempty"`
	SHA        string `json:"sha"`
}

type GitRemoteURLResult struct {
	URL *string `json:"url"`
}

type GitForkSyncExpectedUpstream struct {
	Owner string `json:"owner"`
	Repo  string `json:"repo"`
}

type GitForkSyncRequest struct {
	ProjectID        string                      `json:"projectId"`
	WorktreeID       string                      `json:"worktreeId,omitempty"`
	ExpectedUpstream GitForkSyncExpectedUpstream `json:"expectedUpstream"`
}

type GitForkSyncResult struct {
	Status         string `json:"status"`
	Reason         string `json:"reason,omitempty"`
	OriginRemote   string `json:"originRemote"`
	UpstreamRemote string `json:"upstreamRemote"`
	BranchName     string `json:"branchName,omitempty"`
	Ahead          int    `json:"ahead"`
	Behind         int    `json:"behind"`
}

type GitBranchCompareRequest struct {
	ProjectID  string `json:"projectId"`
	WorktreeID string `json:"worktreeId,omitempty"`
	BaseRef    string `json:"baseRef"`
}

type GitBranchChangeEntry struct {
	Path    string `json:"path"`
	Status  string `json:"status"`
	OldPath string `json:"oldPath,omitempty"`
}

type GitBranchCompareSummary struct {
	BaseRef      string `json:"baseRef"`
	BaseOid      string `json:"baseOid,omitempty"`
	CompareRef   string `json:"compareRef"`
	HeadOid      string `json:"headOid,omitempty"`
	MergeBase    string `json:"mergeBase,omitempty"`
	ChangedFiles int    `json:"changedFiles"`
	CommitsAhead int    `json:"commitsAhead,omitempty"`
	Status       string `json:"status"`
	ErrorMessage string `json:"errorMessage,omitempty"`
}

type GitBranchCompareResult struct {
	Summary GitBranchCompareSummary `json:"summary"`
	Entries []GitBranchChangeEntry  `json:"entries"`
}

type GitCommitCompareRequest struct {
	ProjectID  string `json:"projectId"`
	WorktreeID string `json:"worktreeId,omitempty"`
	CommitID   string `json:"commitId"`
}

type GitCommitCompareSummary struct {
	CommitOid    string `json:"commitOid"`
	ParentOid    string `json:"parentOid,omitempty"`
	CompareRef   string `json:"compareRef"`
	BaseRef      string `json:"baseRef"`
	ChangedFiles int    `json:"changedFiles"`
	Status       string `json:"status"`
	ErrorMessage string `json:"errorMessage,omitempty"`
}

type GitCommitCompareResult struct {
	Summary GitCommitCompareSummary `json:"summary"`
	Entries []GitBranchChangeEntry  `json:"entries"`
}

type GitRefFileDiffRequest struct {
	ProjectID  string `json:"projectId"`
	WorktreeID string `json:"worktreeId,omitempty"`
	LeftRef    string `json:"leftRef"`
	RightRef   string `json:"rightRef"`
	FilePath   string `json:"filePath"`
	OldPath    string `json:"oldPath,omitempty"`
}

type GitHistoryRequest struct {
	ProjectID  string `json:"projectId"`
	WorktreeID string `json:"worktreeId,omitempty"`
	Limit      int    `json:"limit,omitempty"`
	BaseRef    string `json:"baseRef,omitempty"`
}

type GitHistoryItemRef struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Revision string `json:"revision,omitempty"`
	Category string `json:"category,omitempty"`
}

type GitHistoryItem struct {
	ID          string              `json:"id"`
	ParentIDs   []string            `json:"parentIds"`
	Subject     string              `json:"subject"`
	Message     string              `json:"message"`
	DisplayID   string              `json:"displayId,omitempty"`
	Author      string              `json:"author,omitempty"`
	AuthorEmail string              `json:"authorEmail,omitempty"`
	Timestamp   int64               `json:"timestamp,omitempty"`
	References  []GitHistoryItemRef `json:"references,omitempty"`
}

type GitHistoryResult struct {
	Items              []GitHistoryItem   `json:"items"`
	CurrentRef         *GitHistoryItemRef `json:"currentRef,omitempty"`
	BaseRef            *GitHistoryItemRef `json:"baseRef,omitempty"`
	MergeBase          string             `json:"mergeBase,omitempty"`
	HasIncomingChanges bool               `json:"hasIncomingChanges"`
	HasOutgoingChanges bool               `json:"hasOutgoingChanges"`
	HasMore            bool               `json:"hasMore"`
	Limit              int                `json:"limit"`
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
