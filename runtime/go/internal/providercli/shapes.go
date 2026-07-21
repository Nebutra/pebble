// Package providercli runs the gh / glab CLIs locally and maps their JSON
// output into the exact renderer-facing shapes (GitHubWorkItem, PRCheckDetail,
// GitLabWorkItem, GitLabPipelineJob). These mirror packages/product-core/shared/types.ts and
// packages/product-core/shared/gitlab-types.ts field-for-field so the desktop app's provider
// flows work against the local runtime without pairing a remote environment.
package providercli

// GitHubWorkItem mirrors packages/product-core/shared/types.ts GitHubWorkItem (repoId is stamped
// by the renderer, so it is omitted here). Only the fields the list/detail CLI
// paths can populate faithfully are emitted; optional GraphQL-only fields stay
// absent rather than guessed.
type GitHubWorkItem struct {
	ID          string   `json:"id"`
	Type        string   `json:"type"`
	Number      int      `json:"number"`
	Title       string   `json:"title"`
	State       string   `json:"state"`
	URL         string   `json:"url"`
	Labels      []string `json:"labels"`
	UpdatedAt   string   `json:"updatedAt"`
	Author      *string  `json:"author"`
	BranchName  string   `json:"branchName,omitempty"`
	BaseRefName string   `json:"baseRefName,omitempty"`
	HeadSha     string   `json:"headSha,omitempty"`
	// IsCrossRepository mirrors GitHub's PullRequest.isCrossRepository: true when
	// the PR's head branch lives in a different repo (fork) than the base repo.
	// Pointer + omitempty so unknown (older gh responses without the field) stays
	// absent instead of falsely reporting false, mirroring the TS side's `?: boolean`.
	IsCrossRepository *bool `json:"isCrossRepository,omitempty"`
}

type GitHubOwnerRepo struct {
	Owner string `json:"owner"`
	Repo  string `json:"repo"`
}

type GitHubIssueInfo struct {
	Number int      `json:"number"`
	Title  string   `json:"title"`
	State  string   `json:"state"`
	URL    string   `json:"url"`
	Labels []string `json:"labels"`
}

type GitHubIssueListResult struct {
	Items []GitHubIssueInfo        `json:"items"`
	Error *ProviderClassifiedError `json:"error,omitempty"`
}

type GitHubIssueCreateResult struct {
	OK     bool   `json:"ok"`
	Number int    `json:"number,omitempty"`
	URL    string `json:"url,omitempty"`
	Error  string `json:"error,omitempty"`
}

type GitHubAssignableUser struct {
	Login     string  `json:"login"`
	Name      *string `json:"name"`
	AvatarURL string  `json:"avatarUrl"`
}

type GitHubComment struct {
	ID              int64  `json:"id"`
	Author          string `json:"author"`
	AuthorAvatarURL string `json:"authorAvatarUrl"`
	Body            string `json:"body"`
	CreatedAt       string `json:"createdAt"`
	URL             string `json:"url"`
	Path            string `json:"path,omitempty"`
	Line            *int   `json:"line,omitempty"`
	StartLine       *int   `json:"startLine,omitempty"`
	IsBot           *bool  `json:"isBot,omitempty"`
}

type GitHubIssueTimelineTarget struct {
	Type       string `json:"type"`
	Number     int    `json:"number"`
	Title      string `json:"title"`
	URL        string `json:"url"`
	Repository string `json:"repository,omitempty"`
}

type GitHubIssueTimelineItem struct {
	ID                 string                     `json:"id"`
	Event              string                     `json:"event"`
	Actor              string                     `json:"actor"`
	ActorAvatarURL     string                     `json:"actorAvatarUrl"`
	CreatedAt          string                     `json:"createdAt"`
	Assignee           string                     `json:"assignee,omitempty"`
	Source             *GitHubIssueTimelineTarget `json:"source,omitempty"`
	Closer             *GitHubIssueTimelineTarget `json:"closer,omitempty"`
	StateReason        *string                    `json:"stateReason,omitempty"`
	PreviousColumnName *string                    `json:"previousColumnName,omitempty"`
	ColumnName         *string                    `json:"columnName,omitempty"`
	ProjectName        *string                    `json:"projectName,omitempty"`
}

type GitHubPRFile struct {
	Path                     string `json:"path"`
	OldPath                  string `json:"oldPath,omitempty"`
	Status                   string `json:"status"`
	Additions                int    `json:"additions"`
	Deletions                int    `json:"deletions"`
	IsBinary                 bool   `json:"isBinary"`
	ReviewCommentLineNumbers []int  `json:"reviewCommentLineNumbers,omitempty"`
}

type GitHubWorkItemDetails struct {
	Item          GitHubWorkItem            `json:"item"`
	Body          string                    `json:"body"`
	Comments      []GitHubComment           `json:"comments"`
	TimelineItems []GitHubIssueTimelineItem `json:"timelineItems,omitempty"`
	HeadSHA       string                    `json:"headSha,omitempty"`
	BaseSHA       string                    `json:"baseSha,omitempty"`
	PullRequestID string                    `json:"pullRequestId,omitempty"`
	Checks        []PRCheckDetail           `json:"checks,omitempty"`
	Files         []GitHubPRFile            `json:"files,omitempty"`
	Participants  []GitHubAssignableUser    `json:"participants,omitempty"`
	Assignees     []string                  `json:"assignees,omitempty"`
}

type GitHubWorkItemSources struct {
	Issues            *GitHubOwnerRepo `json:"issues"`
	PRs               *GitHubOwnerRepo `json:"prs"`
	OriginCandidate   *GitHubOwnerRepo `json:"originCandidate"`
	UpstreamCandidate *GitHubOwnerRepo `json:"upstreamCandidate"`
}

type GitHubWorkItemErrors struct {
	Issues *ProviderClassifiedError `json:"issues,omitempty"`
}

type GitHubWorkItemsResult struct {
	Items   []GitHubWorkItem      `json:"items"`
	Sources GitHubWorkItemSources `json:"sources"`
	Errors  *GitHubWorkItemErrors `json:"errors,omitempty"`
}

// PRCheckDetail mirrors packages/product-core/shared/types.ts PRCheckDetail. Status and conclusion
// use the same enum spaces the renderer's check pills expect.
type PRCheckDetail struct {
	Name          string  `json:"name"`
	Status        string  `json:"status"`
	Conclusion    *string `json:"conclusion"`
	URL           *string `json:"url"`
	CheckRunID    *int64  `json:"checkRunId,omitempty"`
	WorkflowRunID *int64  `json:"workflowRunId,omitempty"`
}

type PRCheckAnnotation struct {
	Path            *string `json:"path"`
	StartLine       *int64  `json:"startLine"`
	EndLine         *int64  `json:"endLine"`
	AnnotationLevel *string `json:"annotationLevel"`
	Title           *string `json:"title"`
	Message         string  `json:"message"`
	RawDetails      *string `json:"rawDetails"`
}

type PRCheckStep struct {
	Name        string  `json:"name"`
	Status      *string `json:"status"`
	Conclusion  *string `json:"conclusion"`
	StartedAt   *string `json:"startedAt"`
	CompletedAt *string `json:"completedAt"`
}

type PRCheckJob struct {
	ID          *int64        `json:"id"`
	Name        string        `json:"name"`
	Status      *string       `json:"status"`
	Conclusion  *string       `json:"conclusion"`
	StartedAt   *string       `json:"startedAt"`
	CompletedAt *string       `json:"completedAt"`
	URL         *string       `json:"url"`
	LogTail     *string       `json:"logTail"`
	Steps       []PRCheckStep `json:"steps"`
}

type PRCheckRunDetails struct {
	Name        string              `json:"name"`
	Status      *string             `json:"status"`
	Conclusion  *string             `json:"conclusion"`
	URL         *string             `json:"url"`
	DetailsURL  *string             `json:"detailsUrl"`
	StartedAt   *string             `json:"startedAt"`
	CompletedAt *string             `json:"completedAt"`
	Title       *string             `json:"title"`
	Summary     *string             `json:"summary"`
	Text        *string             `json:"text"`
	Annotations []PRCheckAnnotation `json:"annotations"`
	Jobs        []PRCheckJob        `json:"jobs"`
}

type GitHubRerunPRChecksResult struct {
	OK    bool   `json:"ok"`
	Count int    `json:"count,omitempty"`
	Error string `json:"error,omitempty"`
}

type GitHubRateLimitBucket struct {
	Limit     int64 `json:"limit"`
	Remaining int64 `json:"remaining"`
	ResetAt   int64 `json:"resetAt"`
}

type GitHubRateLimitSnapshot struct {
	Core      GitHubRateLimitBucket `json:"core"`
	Search    GitHubRateLimitBucket `json:"search"`
	GraphQL   GitHubRateLimitBucket `json:"graphql"`
	FetchedAt int64                 `json:"fetchedAt"`
}

type GitHubRateLimitResult struct {
	OK       bool                     `json:"ok"`
	Snapshot *GitHubRateLimitSnapshot `json:"snapshot,omitempty"`
	Error    string                   `json:"error,omitempty"`
}

type GitHubViewer struct {
	Login string  `json:"login"`
	Email *string `json:"email"`
}

type GitHubAuthAccount struct {
	Host     string   `json:"host"`
	User     string   `json:"user"`
	Active   bool     `json:"active"`
	EnvToken *string  `json:"envToken"`
	Source   string   `json:"source"`
	Scopes   []string `json:"scopes"`
}

type GitHubAuthDiagnostic struct {
	GHAvailable        bool                `json:"ghAvailable"`
	ActiveAccount      *GitHubAuthAccount  `json:"activeAccount"`
	Accounts           []GitHubAuthAccount `json:"accounts"`
	EnvTokenInProcess  *string             `json:"envTokenInProcess"`
	MissingScopes      []string            `json:"missingScopes"`
	RequiredScopes     []string            `json:"requiredScopes"`
	HasKeyringFallback bool                `json:"hasKeyringFallback"`
}

// GitLabWorkItem mirrors packages/product-core/shared/gitlab-types.ts GitLabWorkItem (repoId is
// stamped by the renderer, so it is omitted here).
type GitLabWorkItem struct {
	ID          string   `json:"id"`
	Type        string   `json:"type"`
	Number      int      `json:"number"`
	Title       string   `json:"title"`
	State       string   `json:"state"`
	URL         string   `json:"url"`
	Labels      []string `json:"labels"`
	UpdatedAt   string   `json:"updatedAt"`
	Author      *string  `json:"author"`
	BranchName  string   `json:"branchName,omitempty"`
	BaseRefName string   `json:"baseRefName,omitempty"`
	// IsCrossRepository mirrors mapMRToWorkItem's fork check: true when the MR's
	// source_project_id differs from its target_project_id (a fork MR).
	IsCrossRepository *bool             `json:"isCrossRepository,omitempty"`
	ProjectRef        *GitLabProjectRef `json:"projectRef,omitempty"`
}

type ProviderClassifiedError struct {
	Type    string `json:"type"`
	Message string `json:"message"`
}

type GitLabIssueInfo struct {
	Number          int      `json:"number"`
	Title           string   `json:"title"`
	State           string   `json:"state"`
	URL             string   `json:"url"`
	Labels          []string `json:"labels"`
	UpdatedAt       string   `json:"updatedAt,omitempty"`
	Description     *string  `json:"description,omitempty"`
	Author          *string  `json:"author,omitempty"`
	AuthorAvatarURL *string  `json:"authorAvatarUrl,omitempty"`
}

type GitLabIssueListResult struct {
	Items []GitLabIssueInfo        `json:"items"`
	Error *ProviderClassifiedError `json:"error,omitempty"`
}

type GitLabIssueMutationResult struct {
	OK     bool   `json:"ok"`
	Number int    `json:"number,omitempty"`
	URL    string `json:"url,omitempty"`
	Error  string `json:"error,omitempty"`
}

type GitLabIssueUpdate struct {
	State           string   `json:"state,omitempty"`
	Title           *string  `json:"title,omitempty"`
	Body            *string  `json:"body,omitempty"`
	AddLabels       []string `json:"addLabels,omitempty"`
	RemoveLabels    []string `json:"removeLabels,omitempty"`
	AddAssignees    []string `json:"addAssignees,omitempty"`
	RemoveAssignees []string `json:"removeAssignees,omitempty"`
}

type GitLabWorkItemsResult struct {
	Items []GitLabWorkItem         `json:"items"`
	Error *ProviderClassifiedError `json:"error,omitempty"`
}

// GitLabPipelineJob mirrors packages/product-core/shared/gitlab-types.ts GitLabPipelineJob.
type GitLabPipelineJob struct {
	ID         int      `json:"id"`
	PipelineID *int     `json:"pipelineId,omitempty"`
	Name       string   `json:"name"`
	Stage      string   `json:"stage"`
	Status     string   `json:"status"`
	WebURL     string   `json:"webUrl"`
	Duration   *float64 `json:"duration"`
}

type GitLabTodo struct {
	ID              int    `json:"id"`
	ActionName      string `json:"actionName"`
	TargetType      string `json:"targetType"`
	TargetIID       *int   `json:"targetIid"`
	TargetTitle     string `json:"targetTitle"`
	TargetURL       string `json:"targetUrl"`
	ProjectPath     string `json:"projectPath"`
	AuthorUsername  string `json:"authorUsername"`
	AuthorAvatarURL string `json:"authorAvatarUrl"`
	UpdatedAt       string `json:"updatedAt"`
	State           string `json:"state"`
}

type GitLabAssignableUser struct {
	ID        *int    `json:"id,omitempty"`
	Username  string  `json:"username"`
	Name      *string `json:"name"`
	AvatarURL string  `json:"avatarUrl"`
	State     *string `json:"state,omitempty"`
}

type GitLabMRApprovalRule struct {
	ID                int    `json:"id"`
	Name              string `json:"name"`
	ApprovalsRequired int    `json:"approvalsRequired"`
	Approved          bool   `json:"approved"`
}

type GitLabMRApprovalState struct {
	ApprovalsRequired *int                   `json:"approvalsRequired"`
	ApprovalsLeft     *int                   `json:"approvalsLeft"`
	ApprovedBy        []GitLabAssignableUser `json:"approvedBy"`
	Rules             []GitLabMRApprovalRule `json:"rules"`
}

type GitLabMRFile struct {
	Path      string `json:"path"`
	OldPath   string `json:"oldPath,omitempty"`
	Status    string `json:"status"`
	Additions int    `json:"additions"`
	Deletions int    `json:"deletions"`
	IsBinary  bool   `json:"isBinary"`
	Diff      string `json:"diff,omitempty"`
}

type GitLabWorkItemDetails struct {
	Item          GitLabWorkItem         `json:"item"`
	Body          string                 `json:"body"`
	Comments      []ReviewComment        `json:"comments"`
	HeadSHA       string                 `json:"headSha,omitempty"`
	BaseSHA       string                 `json:"baseSha,omitempty"`
	StartSHA      string                 `json:"startSha,omitempty"`
	Files         []GitLabMRFile         `json:"files,omitempty"`
	PipelineJobs  []GitLabPipelineJob    `json:"pipelineJobs,omitempty"`
	Reviewers     []GitLabAssignableUser `json:"reviewers,omitempty"`
	ApprovalState *GitLabMRApprovalState `json:"approvalState,omitempty"`
	Participants  []GitLabAssignableUser `json:"participants,omitempty"`
	Assignees     []string               `json:"assignees,omitempty"`
}

type GitLabProjectRef struct {
	Host string `json:"host"`
	Path string `json:"path"`
}

type GitLabJobTraceResult struct {
	OK    bool   `json:"ok"`
	Trace string `json:"trace,omitempty"`
	Error string `json:"error,omitempty"`
}

type GitLabRetryJobResult struct {
	OK    bool               `json:"ok"`
	Job   *GitLabPipelineJob `json:"job,omitempty"`
	Error string             `json:"error,omitempty"`
}

type GitLabRateLimitBucket struct {
	Limit     int64  `json:"limit"`
	Remaining int64  `json:"remaining"`
	ResetAt   *int64 `json:"resetAt"`
}

type GitLabRateLimitSnapshot struct {
	Rest      *GitLabRateLimitBucket `json:"rest"`
	Host      *string                `json:"host"`
	FetchedAt int64                  `json:"fetchedAt"`
}

type GitLabRateLimitResult struct {
	OK       bool                     `json:"ok"`
	Snapshot *GitLabRateLimitSnapshot `json:"snapshot,omitempty"`
	Error    string                   `json:"error,omitempty"`
}

type GitLabViewer struct {
	Username string  `json:"username"`
	Email    *string `json:"email"`
}

type GitLabAuthDiagnostic struct {
	GlabAvailable     bool     `json:"glabAvailable"`
	Authenticated     bool     `json:"authenticated"`
	Hosts             []string `json:"hosts"`
	ActiveHost        *string  `json:"activeHost"`
	EnvTokenInProcess *string  `json:"envTokenInProcess"`
	Error             *string  `json:"error"`
}
