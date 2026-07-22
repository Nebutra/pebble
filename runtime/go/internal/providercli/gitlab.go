package providercli

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

const maxGitLabJobTraceBytes = 16 * 1024 * 1024

func GetGitLabJobTrace(ctx context.Context, workdir string, jobID int64, projectRef *GitLabProjectRef) GitLabJobTraceResult {
	project, err := resolveGitLabProjectRef(ctx, workdir, projectRef)
	if err != nil {
		return GitLabJobTraceResult{Error: err.Error()}
	}
	args := []string{"api"}
	if project.Host != "" && project.Host != "gitlab.com" {
		args = append(args, "--hostname", project.Host)
	}
	args = append(args, fmt.Sprintf("projects/%s/jobs/%d/trace", encodeGitLabProjectPath(project.Path), jobID))
	out, err := runCLI(ctx, "glab", workdir, args...)
	if err != nil {
		return GitLabJobTraceResult{Error: err.Error()}
	}
	// Why: a pathological job log must not allocate an unbounded renderer string.
	if len(out) > maxGitLabJobTraceBytes {
		out = append([]byte("[Pebble truncated earlier job output]\n"), out[len(out)-maxGitLabJobTraceBytes:]...)
	}
	return GitLabJobTraceResult{OK: true, Trace: string(out)}
}

func RetryGitLabJob(ctx context.Context, workdir string, jobID int64, projectRef *GitLabProjectRef) GitLabRetryJobResult {
	project, err := resolveGitLabProjectRef(ctx, workdir, projectRef)
	if err != nil {
		return GitLabRetryJobResult{Error: err.Error()}
	}
	args := []string{"api"}
	if project.Host != "" && project.Host != "gitlab.com" {
		args = append(args, "--hostname", project.Host)
	}
	args = append(args, "-X", "POST", fmt.Sprintf("projects/%s/jobs/%d/retry", encodeGitLabProjectPath(project.Path), jobID))
	out, err := runCLI(ctx, "glab", workdir, args...)
	if err != nil {
		return GitLabRetryJobResult{Error: err.Error()}
	}
	if strings.TrimSpace(string(out)) == "" {
		return GitLabRetryJobResult{OK: true}
	}
	var raw struct {
		ID       int      `json:"id"`
		Name     string   `json:"name"`
		Stage    string   `json:"stage"`
		Status   string   `json:"status"`
		WebURL   string   `json:"web_url"`
		Duration *float64 `json:"duration"`
		Pipeline *struct {
			ID int `json:"id"`
		} `json:"pipeline"`
	}
	if err := json.Unmarshal(out, &raw); err != nil {
		return GitLabRetryJobResult{Error: fmt.Sprintf("parse retried GitLab job: %v", err)}
	}
	if raw.ID == 0 {
		raw.ID = int(jobID)
	}
	job := &GitLabPipelineJob{ID: raw.ID, Name: raw.Name, Stage: raw.Stage, Status: raw.Status, WebURL: raw.WebURL, Duration: raw.Duration}
	if raw.Pipeline != nil && raw.Pipeline.ID > 0 {
		job.PipelineID = &raw.Pipeline.ID
	}
	return GitLabRetryJobResult{OK: true, Job: job}
}

func resolveGitLabProjectRef(ctx context.Context, workdir string, supplied *GitLabProjectRef) (GitLabProjectRef, error) {
	if supplied != nil && strings.TrimSpace(supplied.Path) != "" {
		return GitLabProjectRef{Host: strings.TrimSpace(supplied.Host), Path: strings.TrimSpace(supplied.Path)}, nil
	}
	out, err := runCLI(ctx, "glab", workdir, "repo", "view", "--output", "json")
	if err != nil {
		return GitLabProjectRef{}, err
	}
	var raw struct {
		Path   string `json:"path_with_namespace"`
		WebURL string `json:"web_url"`
	}
	if err := json.Unmarshal(out, &raw); err != nil {
		return GitLabProjectRef{}, fmt.Errorf("parse glab repo view output: %w", err)
	}
	if strings.TrimSpace(raw.Path) == "" {
		return GitLabProjectRef{}, fmt.Errorf("could not resolve GitLab project for this repository")
	}
	host := "gitlab.com"
	if match := regexp.MustCompile(`^https?://([^/]+)`).FindStringSubmatch(raw.WebURL); len(match) == 2 {
		host = match[1]
	}
	return GitLabProjectRef{Host: host, Path: raw.Path}, nil
}

func encodeGitLabProjectPath(path string) string {
	return strings.ReplaceAll(strings.TrimSpace(path), "/", "%2F")
}

// glabMRRaw is the subset of `glab mr list --output json` output this package
// maps. glab infers the project from the git remotes in workdir.
type glabMRRaw struct {
	ID              int         `json:"id"`
	IID             int         `json:"iid"`
	Title           string      `json:"title"`
	State           string      `json:"state"`
	WebURL          string      `json:"web_url"`
	URL             string      `json:"url"`
	UpdatedAt       string      `json:"updated_at"`
	Author          *glabUser   `json:"author"`
	Labels          []glabLabel `json:"labels"`
	Draft           bool        `json:"draft"`
	SourceBranch    string      `json:"source_branch"`
	TargetBranch    string      `json:"target_branch"`
	SourceProjectID *int        `json:"source_project_id"`
	TargetProjectID *int        `json:"target_project_id"`
}

type glabUser struct {
	Username  string `json:"username"`
	AvatarURL string `json:"avatar_url"`
}

// glabLabel handles glab returning labels as either bare strings or {name}
// objects, mirroring mapMRToWorkItem's label coercion.
type glabLabel struct {
	Name string
}

func (l *glabLabel) UnmarshalJSON(data []byte) error {
	var s string
	if err := json.Unmarshal(data, &s); err == nil {
		l.Name = s
		return nil
	}
	var obj struct {
		Name string `json:"name"`
	}
	if err := json.Unmarshal(data, &obj); err != nil {
		return err
	}
	l.Name = obj.Name
	return nil
}

var draftTitlePattern = regexp.MustCompile(`(?i)^(draft|wip):\s*`)

// glabMRListStateFlags maps the shared state filter to glab flags.
func glabMRListStateFlags(state string) []string {
	switch state {
	case "merged":
		return []string{"--merged"}
	case "closed":
		return []string{"--closed"}
	case "all":
		return []string{"--all"}
	default: // "opened"
		return nil
	}
}

// ListGitLabMRs runs `glab mr list` and maps to GitLabWorkItem[] (type "mr"),
// mirroring the cwd-inferred fallback in listMergeRequests.
func ListGitLabMRs(ctx context.Context, workdir string, state string, perPage int, query string) ([]GitLabWorkItem, error) {
	if perPage <= 0 {
		perPage = 20
	}
	if state == "" {
		state = "opened"
	}
	args := []string{
		"mr", "list", "--output", "json",
		"--per-page", strconv.Itoa(perPage),
		"--order", "updated_at", "--sort", "desc",
	}
	args = append(args, glabMRListStateFlags(state)...)
	if q := strings.TrimSpace(query); q != "" {
		args = append(args, "--search", q)
	}
	out, err := runCLI(ctx, "glab", workdir, args...)
	if err != nil {
		return nil, err
	}
	var raw []glabMRRaw
	if err := json.Unmarshal(out, &raw); err != nil {
		return nil, fmt.Errorf("parse glab mr list output: %w", err)
	}
	items := make([]GitLabWorkItem, 0, len(raw))
	for i := range raw {
		items = append(items, mapGitLabMR(&raw[i]))
	}
	return items, nil
}

func mapGitLabMR(raw *glabMRRaw) GitLabWorkItem {
	labels := make([]string, 0, len(raw.Labels))
	for _, l := range raw.Labels {
		if l.Name != "" {
			labels = append(labels, l.Name)
		}
	}
	url := raw.WebURL
	if url == "" {
		url = raw.URL
	}
	// Why: id must be unique across providers in the picker; the 'gitlab-mr-'
	// prefix and id-or-fallback mirror mapMRToWorkItem so GitHub PR #5 and
	// GitLab MR !5 never collide.
	idPart := strconv.Itoa(raw.ID)
	if raw.ID == 0 {
		idPart = fmt.Sprintf("unknown-%d", raw.IID)
	}
	return GitLabWorkItem{
		ID:                "gitlab-mr-" + idPart,
		Type:              "mr",
		Number:            raw.IID,
		Title:             raw.Title,
		State:             mapMRState(raw.State, raw.Draft, raw.Title),
		URL:               url,
		Labels:            labels,
		UpdatedAt:         raw.UpdatedAt,
		Author:            glabAuthorUsername(raw.Author),
		BranchName:        raw.SourceBranch,
		BaseRefName:       raw.TargetBranch,
		IsCrossRepository: glabIsCrossRepository(raw.SourceProjectID, raw.TargetProjectID),
	}
}

// glabIsCrossRepository mirrors mapMRToWorkItem: a fork MR is one where
// source_project_id !== target_project_id. Nil when either id is missing so
// callers can't mistake "unknown" for "same repo".
func glabIsCrossRepository(sourceProjectID, targetProjectID *int) *bool {
	if sourceProjectID == nil || targetProjectID == nil {
		return nil
	}
	isCrossRepository := *sourceProjectID != *targetProjectID
	return &isCrossRepository
}

func glabAuthorUsername(user *glabUser) *string {
	if user == nil || user.Username == "" {
		return nil
	}
	username := user.Username
	return &username
}

// mapMRState normalizes GitLab merge-request state for the shared review contract.
func mapMRState(state string, isDraft bool, title string) string {
	switch strings.ToLower(state) {
	case "merged":
		return "merged"
	case "closed":
		return "closed"
	case "locked":
		return "locked"
	}
	if isDraft || draftTitlePattern.MatchString(title) {
		return "draft"
	}
	return "opened"
}
