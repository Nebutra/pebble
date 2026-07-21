package providercli

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"strings"
)

type GitLabMRInfo struct {
	Number          int     `json:"number"`
	Title           string  `json:"title"`
	State           string  `json:"state"`
	URL             string  `json:"url"`
	PipelineStatus  string  `json:"pipelineStatus"`
	UpdatedAt       string  `json:"updatedAt"`
	Mergeable       string  `json:"mergeable"`
	Description     *string `json:"description,omitempty"`
	Author          *string `json:"author,omitempty"`
	AuthorAvatarURL *string `json:"authorAvatarUrl,omitempty"`
	HeadSHA         string  `json:"headSha,omitempty"`
	BaseRefName     string  `json:"baseRefName,omitempty"`
}

type gitLabMRInfoRaw struct {
	IID                 int             `json:"iid"`
	Title               string          `json:"title"`
	State               string          `json:"state"`
	Draft               bool            `json:"draft"`
	WebURL              string          `json:"web_url"`
	UpdatedAt           string          `json:"updated_at"`
	SHA                 string          `json:"sha"`
	HasConflicts        bool            `json:"has_conflicts"`
	DetailedMergeStatus string          `json:"detailed_merge_status"`
	Description         *string         `json:"description"`
	TargetBranch        string          `json:"target_branch"`
	SourceProjectID     int             `json:"source_project_id"`
	Author              *glabDetailUser `json:"author"`
	HeadPipeline        *struct {
		Status string `json:"status"`
	} `json:"head_pipeline"`
	Pipeline *struct {
		Status string `json:"status"`
	} `json:"pipeline"`
}

func GetGitLabProjectRef(ctx context.Context, workdir string) *GitLabProjectRef {
	project, err := resolveGitLabProjectRef(ctx, workdir, nil)
	if err != nil {
		return nil
	}
	return &project
}

func GetGitLabMergeRequest(ctx context.Context, workdir string, iid int) *GitLabMRInfo {
	if iid < 1 {
		return nil
	}
	project, err := resolveGitLabProjectRef(ctx, workdir, nil)
	if err != nil {
		return nil
	}
	return fetchGitLabMRInfo(ctx, workdir, project, fmt.Sprintf("projects/%s/merge_requests/%d", encodeGitLabProjectPath(project.Path), iid))
}

func GetGitLabMergeRequestForBranch(ctx context.Context, workdir, branch string, linkedMRIID int) *GitLabMRInfo {
	project, err := resolveGitLabProjectRef(ctx, workdir, nil)
	if err != nil {
		return nil
	}
	candidates := gitLabReviewProjectCandidates(ctx, workdir, project)
	branch = strings.TrimPrefix(strings.TrimSpace(branch), "refs/heads/")
	if branch != "" {
		for _, candidate := range candidates {
			if review := findGitLabMergeRequestForBranch(ctx, workdir, candidate, branch); review != nil {
				return review
			}
		}
	}
	// Why: MR-created parallel universes can rename the local branch; the
	// persisted iid remains the durable review identity.
	if linkedMRIID > 0 {
		for _, candidate := range candidates {
			if review := fetchGitLabMRInfoForCandidate(ctx, workdir, candidate, linkedMRIID); review != nil {
				return review
			}
		}
	}
	return nil
}

func fetchGitLabMRInfoForCandidate(ctx context.Context, workdir string, candidate gitLabReviewProjectCandidate, iid int) *GitLabMRInfo {
	resource := fmt.Sprintf(
		"projects/%s/merge_requests/%d",
		encodeGitLabProjectPath(candidate.Project.Path),
		iid,
	)
	out, err := runCLI(ctx, "glab", workdir, gitLabAPIArgs(candidate.Project, resource)...)
	if err != nil {
		return nil
	}
	var raw gitLabMRInfoRaw
	if json.Unmarshal(out, &raw) != nil ||
		(candidate.SourceProjectID > 0 && raw.SourceProjectID != candidate.SourceProjectID) {
		return nil
	}
	return mapGitLabMRInfo(&raw)
}

type gitLabReviewProjectCandidate struct {
	Project         GitLabProjectRef
	SourceProjectID int
}

func gitLabReviewProjectCandidates(ctx context.Context, workdir string, project GitLabProjectRef) []gitLabReviewProjectCandidate {
	if parent := resolveGitLabForkParent(ctx, workdir, project); parent != nil {
		// Why: an MR number and branch are scoped to the target project, so the
		// fork parent must be searched before the contributor fork.
		return []gitLabReviewProjectCandidate{
			{Project: parent.Project, SourceProjectID: parent.SourceProjectID},
			{Project: project},
		}
	}
	return []gitLabReviewProjectCandidate{{Project: project}}
}

func findGitLabMergeRequestForBranch(ctx context.Context, workdir string, candidate gitLabReviewProjectCandidate, branch string) *GitLabMRInfo {
	perPage := 1
	if candidate.SourceProjectID > 0 {
		// GitLab does not expose source_project_id as a list filter. Inspect a
		// bounded page so same-named branches from another fork are not selected.
		perPage = 20
	}
	resource := fmt.Sprintf(
		"projects/%s/merge_requests?source_branch=%s&order_by=updated_at&sort=desc&per_page=%d",
		encodeGitLabProjectPath(candidate.Project.Path),
		url.QueryEscape(branch),
		perPage,
	)
	out, err := runCLI(ctx, "glab", workdir, gitLabAPIArgs(candidate.Project, resource)...)
	if err != nil {
		return nil
	}
	var rows []gitLabMRInfoRaw
	if json.Unmarshal(out, &rows) != nil {
		return nil
	}
	for index := range rows {
		if candidate.SourceProjectID == 0 || rows[index].SourceProjectID == candidate.SourceProjectID {
			return mapGitLabMRInfo(&rows[index])
		}
	}
	return nil
}

func GetGitLabIssue(ctx context.Context, workdir string, iid int) *GitLabIssueInfo {
	if iid < 1 {
		return nil
	}
	project, err := resolveGitLabProjectRef(ctx, workdir, nil)
	if err != nil {
		return nil
	}
	out, err := runCLI(ctx, "glab", workdir, gitLabAPIArgs(project, fmt.Sprintf("projects/%s/issues/%d", encodeGitLabProjectPath(project.Path), iid))...)
	if err != nil {
		return nil
	}
	var raw glabIssueRaw
	if json.Unmarshal(out, &raw) != nil {
		return nil
	}
	item := mapGitLabIssueInfo(&raw)
	return &item
}

func ListGitLabAssignableUsers(ctx context.Context, workdir string) []GitLabAssignableUser {
	project, err := resolveGitLabProjectRef(ctx, workdir, nil)
	if err != nil {
		return []GitLabAssignableUser{}
	}
	resource := fmt.Sprintf("projects/%s/members/all?per_page=100", encodeGitLabProjectPath(project.Path))
	args := []string{"api"}
	if project.Host != "" && project.Host != "gitlab.com" {
		args = append(args, "--hostname", project.Host)
	}
	args = append(args, "--paginate", resource)
	out, err := runCLI(ctx, "glab", workdir, args...)
	if err != nil {
		return []GitLabAssignableUser{}
	}
	type memberRow struct {
		ID        int     `json:"id"`
		Username  string  `json:"username"`
		Name      *string `json:"name"`
		AvatarURL string  `json:"avatar_url"`
		State     *string `json:"state"`
	}
	rows := make([]memberRow, 0)
	decoder := json.NewDecoder(strings.NewReader(string(out)))
	for {
		var page []memberRow
		decodeErr := decoder.Decode(&page)
		if decodeErr == io.EOF {
			break
		}
		if decodeErr != nil {
			return []GitLabAssignableUser{}
		}
		rows = append(rows, page...)
	}
	if len(rows) == 0 && len(strings.TrimSpace(string(out))) > 0 {
		return []GitLabAssignableUser{}
	}
	users := make([]GitLabAssignableUser, 0, len(rows))
	for _, row := range rows {
		if row.Username != "" {
			id := row.ID
			users = append(users, GitLabAssignableUser{ID: &id, Username: row.Username, Name: row.Name, AvatarURL: row.AvatarURL, State: row.State})
		}
	}
	return users
}

func fetchGitLabMRInfo(ctx context.Context, workdir string, project GitLabProjectRef, resource string) *GitLabMRInfo {
	out, err := runCLI(ctx, "glab", workdir, gitLabAPIArgs(project, resource)...)
	if err != nil {
		return nil
	}
	var raw gitLabMRInfoRaw
	if json.Unmarshal(out, &raw) != nil {
		return nil
	}
	return mapGitLabMRInfo(&raw)
}

func mapGitLabMRInfo(raw *gitLabMRInfoRaw) *GitLabMRInfo {
	pipelineStatus := "neutral"
	if raw.HeadPipeline != nil {
		pipelineStatus = gitLabPipelineStatus(raw.HeadPipeline.Status)
	} else if raw.Pipeline != nil {
		pipelineStatus = gitLabPipelineStatus(raw.Pipeline.Status)
	}
	mergeable := "UNKNOWN"
	if raw.HasConflicts || raw.DetailedMergeStatus == "broken_status" || raw.DetailedMergeStatus == "conflict" {
		mergeable = "CONFLICTING"
	} else if raw.DetailedMergeStatus == "mergeable" {
		mergeable = "MERGEABLE"
	}
	item := &GitLabMRInfo{Number: raw.IID, Title: raw.Title, State: mapMRState(raw.State, raw.Draft, raw.Title), URL: raw.WebURL, PipelineStatus: pipelineStatus, UpdatedAt: raw.UpdatedAt, Mergeable: mergeable, Description: raw.Description, HeadSHA: raw.SHA, BaseRefName: raw.TargetBranch}
	if raw.Author != nil && raw.Author.Username != "" {
		item.Author, item.AuthorAvatarURL = &raw.Author.Username, &raw.Author.AvatarURL
	}
	return item
}

func gitLabPipelineStatus(status string) string {
	switch strings.ToLower(status) {
	case "success":
		return "success"
	case "failed", "failure", "canceled", "cancelled", "skipped", "manual":
		return "failure"
	case "created", "waiting_for_resource", "preparing", "pending", "running", "scheduled":
		return "pending"
	default:
		return "neutral"
	}
}
