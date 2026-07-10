package providercli

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// glabMRRaw is the subset of `glab mr list --output json` output this package
// maps. glab infers the project from the git remotes in workdir, matching the
// cwd-inferred fallback path in listMergeRequests (src/main/gitlab/client.ts).
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
	Username string `json:"username"`
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

// glabMRListStateFlags mirrors mrListStateFlags in src/main/gitlab/client.ts.
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

// mapMRState mirrors mapMRState in src/main/gitlab/mappers.ts.
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
