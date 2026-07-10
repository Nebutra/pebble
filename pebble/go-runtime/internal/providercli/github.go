package providercli

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

// ghPRListFields mirrors WORK_ITEM_PR_LIST_JSON_FIELDS in src/main/github/client.ts.
// gh infers owner/repo from the git remotes in workdir, matching Electron's
// cwd-based resolution.
const ghPRListFields = "number,title,state,url,labels,updatedAt,author,isDraft,headRefName,baseRefName,headRefOid,isCrossRepository"

// ghPRRaw is the subset of `gh pr list/view --json` output this package maps.
type ghPRRaw struct {
	Number      int              `json:"number"`
	Title       string           `json:"title"`
	State       string           `json:"state"`
	URL         string           `json:"url"`
	Labels      []ghLabel        `json:"labels"`
	UpdatedAt   string           `json:"updatedAt"`
	Author      *ghAuthor        `json:"author"`
	IsDraft     bool             `json:"isDraft"`
	HeadRefName string           `json:"headRefName"`
	BaseRefName string           `json:"baseRefName"`
	HeadRefOid  string           `json:"headRefOid"`
	Merged      bool             `json:"merged"`
	MergedAt    *json.RawMessage `json:"mergedAt"`
	// IsCrossRepository is a *bool (not bool) so its absence in older gh
	// responses stays distinguishable from an explicit false.
	IsCrossRepository *bool `json:"isCrossRepository"`
}

type ghLabel struct {
	Name string `json:"name"`
}

type ghAuthor struct {
	Login string `json:"login"`
	// gh returns login-less bot authors as {is_bot:true,name:...}; fall back to name.
	Name string `json:"name"`
}

// ListGitHubPRs runs `gh pr list` and maps to GitHubWorkItem[] (type "pr"),
// mirroring the PR side of listWorkItems in src/main/github/client.ts.
func ListGitHubPRs(ctx context.Context, workdir string, limit int) ([]GitHubWorkItem, error) {
	if limit <= 0 {
		limit = 24
	}
	out, err := runCLI(ctx, "gh", workdir,
		"pr", "list", "--limit", strconv.Itoa(limit), "--json", ghPRListFields)
	if err != nil {
		return nil, err
	}
	var raw []ghPRRaw
	if err := json.Unmarshal(out, &raw); err != nil {
		return nil, fmt.Errorf("parse gh pr list output: %w", err)
	}
	items := make([]GitHubWorkItem, 0, len(raw))
	for i := range raw {
		items = append(items, mapGitHubPR(&raw[i]))
	}
	return items, nil
}

// GetGitHubPR runs `gh pr view <n>` and maps to a single GitHubWorkItem,
// matching the `item` shape the renderer expects for detail views.
func GetGitHubPR(ctx context.Context, workdir string, number int) (GitHubWorkItem, error) {
	out, err := runCLI(ctx, "gh", workdir,
		"pr", "view", strconv.Itoa(number), "--json", ghPRListFields)
	if err != nil {
		return GitHubWorkItem{}, err
	}
	var raw ghPRRaw
	if err := json.Unmarshal(out, &raw); err != nil {
		return GitHubWorkItem{}, fmt.Errorf("parse gh pr view output: %w", err)
	}
	return mapGitHubPR(&raw), nil
}

// GetGitHubPRChecks mirrors the `gh pr checks --json name,state,link` fallback
// path in getPRChecks (src/main/github/client.ts). A PR with no check runs makes
// gh exit non-zero with "no checks reported"; that is an empty section, not a
// failure, exactly as Electron treats it.
func GetGitHubPRChecks(ctx context.Context, workdir string, number int) ([]PRCheckDetail, error) {
	out, err := runCLI(ctx, "gh", workdir,
		"pr", "checks", strconv.Itoa(number), "--json", "name,state,link")
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "no checks reported") {
			return []PRCheckDetail{}, nil
		}
		return nil, err
	}
	var raw []struct {
		Name  string `json:"name"`
		State string `json:"state"`
		Link  string `json:"link"`
	}
	if err := json.Unmarshal(out, &raw); err != nil {
		return nil, fmt.Errorf("parse gh pr checks output: %w", err)
	}
	checks := make([]PRCheckDetail, 0, len(raw))
	for _, d := range raw {
		conclusion := mapCheckConclusion(d.State)
		var url *string
		if d.Link != "" {
			link := d.Link
			url = &link
		}
		checks = append(checks, PRCheckDetail{
			Name:       d.Name,
			Status:     mapCheckStatus(d.State),
			Conclusion: conclusion,
			URL:        url,
		})
	}
	return checks, nil
}

func mapGitHubPR(raw *ghPRRaw) GitHubWorkItem {
	labels := make([]string, 0, len(raw.Labels))
	for _, l := range raw.Labels {
		if l.Name != "" {
			labels = append(labels, l.Name)
		}
	}
	item := GitHubWorkItem{
		ID:                fmt.Sprintf("pr:%d", raw.Number),
		Type:              "pr",
		Number:            raw.Number,
		Title:             raw.Title,
		State:             mapPRState(raw),
		URL:               raw.URL,
		Labels:            labels,
		UpdatedAt:         raw.UpdatedAt,
		Author:            ghAuthorLogin(raw.Author),
		BranchName:        raw.HeadRefName,
		BaseRefName:       raw.BaseRefName,
		HeadSha:           raw.HeadRefOid,
		IsCrossRepository: raw.IsCrossRepository,
	}
	return item
}

// mapPRState mirrors the state derivation in mapPullRequestWorkItem: merged wins,
// then closed, then draft, then open. gh reports state as MERGED/CLOSED/OPEN.
func mapPRState(raw *ghPRRaw) string {
	switch strings.ToUpper(raw.State) {
	case "MERGED":
		return "merged"
	case "CLOSED":
		return "closed"
	}
	if raw.Merged || raw.MergedAt != nil {
		return "merged"
	}
	if raw.IsDraft {
		return "draft"
	}
	return "open"
}

func ghAuthorLogin(author *ghAuthor) *string {
	if author == nil {
		return nil
	}
	login := author.Login
	if login == "" {
		login = author.Name
	}
	if login == "" {
		return nil
	}
	return &login
}

// mapCheckStatus mirrors mapCheckStatus in src/main/github/mappers.ts.
func mapCheckStatus(state string) string {
	switch strings.ToUpper(state) {
	case "PENDING", "QUEUED":
		return "queued"
	case "IN_PROGRESS":
		return "in_progress"
	default:
		return "completed"
	}
}

// mapCheckConclusion mirrors mapCheckConclusion in src/main/github/mappers.ts.
func mapCheckConclusion(state string) *string {
	var result string
	switch strings.ToUpper(state) {
	case "SUCCESS", "PASS":
		result = "success"
	case "FAILURE", "FAIL", "STALE", "STARTUP_FAILURE":
		result = "failure"
	case "ACTION_REQUIRED":
		result = "action_required"
	case "CANCELLED":
		result = "cancelled"
	case "TIMED_OUT":
		result = "timed_out"
	case "SKIPPED":
		result = "skipped"
	case "PENDING", "QUEUED", "IN_PROGRESS":
		result = "pending"
	case "NEUTRAL":
		result = "neutral"
	default:
		return nil
	}
	return &result
}
