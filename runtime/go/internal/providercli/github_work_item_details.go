package providercli

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
)

type githubCommentRaw struct {
	ID        int64  `json:"id"`
	Body      string `json:"body"`
	CreatedAt string `json:"created_at"`
	HTMLURL   string `json:"html_url"`
	Path      string `json:"path"`
	Line      *int   `json:"line"`
	StartLine *int   `json:"start_line"`
	User      *struct {
		Login     string `json:"login"`
		AvatarURL string `json:"avatar_url"`
		Type      string `json:"type"`
	} `json:"user"`
}

type githubTimelineRaw struct {
	ID        int64  `json:"id"`
	NodeID    string `json:"node_id"`
	Event     string `json:"event"`
	CreatedAt string `json:"created_at"`
	Actor     *struct {
		Login     string `json:"login"`
		AvatarURL string `json:"avatar_url"`
	} `json:"actor"`
	Assignee *ghAPIUser `json:"assignee"`
	Source   *struct {
		Issue *githubTimelineTargetRaw `json:"issue"`
	} `json:"source"`
	Closer             *githubTimelineTargetRaw `json:"closer"`
	StateReason        *string                  `json:"state_reason"`
	PreviousColumnName *string                  `json:"previous_column_name"`
	ProjectColumnName  *string                  `json:"project_column_name"`
	Project            *struct {
		Name string `json:"name"`
	} `json:"project"`
}

type githubTimelineTargetRaw struct {
	Number      int       `json:"number"`
	Title       string    `json:"title"`
	HTMLURL     string    `json:"html_url"`
	PullRequest *struct{} `json:"pull_request"`
	Repository  *struct {
		Name  string     `json:"name"`
		Owner *ghAPIUser `json:"owner"`
	} `json:"repository"`
}

type githubFileRaw struct {
	Filename         string  `json:"filename"`
	PreviousFilename string  `json:"previous_filename"`
	Status           string  `json:"status"`
	Additions        int     `json:"additions"`
	Deletions        int     `json:"deletions"`
	Patch            *string `json:"patch"`
}

func GetGitHubWorkItemDetails(ctx context.Context, workdir string, number int, itemType, preference string) (*GitHubWorkItemDetails, error) {
	sources, err := ResolveGitHubWorkItemSources(ctx, workdir, preference)
	if err != nil || sources.Issues == nil || sources.PRs == nil {
		return nil, err
	}
	item := GetGitHubWorkItemWithPreference(ctx, workdir, number, itemType, "", "", preference)
	if item == nil {
		return nil, nil
	}
	if item.Type == "issue" {
		return getGitHubIssueDetails(ctx, workdir, *item, *sources.Issues)
	}
	return getGitHubPRDetails(ctx, workdir, *item, *sources.PRs)
}

func GetGitHubWorkItemDetailsBySlug(ctx context.Context, owner, repo string, number int, itemType string) (*GitHubWorkItemDetails, error) {
	if !validGitHubRepoSlug(owner, repo) || number < 1 || (itemType != "issue" && itemType != "pr") {
		return nil, fmt.Errorf("valid owner, repository, number, and type are required")
	}
	item := GetGitHubWorkItemWithPreference(ctx, "", number, itemType, owner, repo, "")
	if item == nil {
		return nil, nil
	}
	source := GitHubOwnerRepo{Owner: owner, Repo: repo}
	if itemType == "issue" {
		return getGitHubIssueDetails(ctx, "", *item, source)
	}
	return getGitHubPRDetails(ctx, "", *item, source)
}

func getGitHubIssueDetails(ctx context.Context, workdir string, item GitHubWorkItem, source GitHubOwnerRepo) (*GitHubWorkItemDetails, error) {
	raw, err := readGitHubIssue(ctx, workdir, source.Owner, source.Repo, item.Number)
	if err != nil {
		return nil, err
	}
	comments, err := readGitHubComments(ctx, workdir, source, item.Number)
	if err != nil {
		return nil, err
	}
	timeline := readGitHubIssueTimeline(ctx, workdir, source, item.Number)
	assignees := make([]string, 0, len(raw.Assignees))
	for _, assignee := range raw.Assignees {
		if assignee.Login != "" {
			assignees = append(assignees, assignee.Login)
		}
	}
	participants := hydrateGitHubParticipants(ctx, workdir, githubDetailParticipants(item, comments, raw.Assignees))
	return &GitHubWorkItemDetails{
		Item: item, Body: raw.Body, Comments: comments, TimelineItems: timeline,
		Participants: participants, Assignees: assignees,
	}, nil
}

func getGitHubPRDetails(ctx context.Context, workdir string, item GitHubWorkItem, source GitHubOwnerRepo) (*GitHubWorkItemDetails, error) {
	raw, err := readGitHubPR(ctx, workdir, source.Owner, source.Repo, item.Number)
	if err != nil {
		return nil, err
	}
	comments, err := readGitHubComments(ctx, workdir, source, item.Number)
	if err != nil {
		return nil, err
	}
	files := readGitHubPRFiles(ctx, workdir, source, item.Number)
	var checks []PRCheckDetail
	if workdir == "" {
		checks, _ = GetGitHubPRChecksForRepo(ctx, source.Owner, source.Repo, item.Number)
	} else {
		checks, _ = GetGitHubPRChecks(ctx, workdir, item.Number)
	}
	participants := hydrateGitHubParticipants(ctx, workdir, githubDetailParticipants(item, comments, nil))
	details := &GitHubWorkItemDetails{
		Item: item, Body: raw.Body, Comments: comments, PullRequestID: raw.NodeID,
		Checks: checks, Files: files, Participants: participants,
	}
	if raw.Head != nil {
		details.HeadSHA = raw.Head.SHA
	}
	if raw.Base != nil {
		details.BaseSHA = raw.Base.SHA
	}
	return details, nil
}

func readGitHubComments(ctx context.Context, workdir string, source GitHubOwnerRepo, number int) ([]GitHubComment, error) {
	var raw []githubCommentRaw
	if err := readPaginatedGitHubArray(ctx, workdir, fmt.Sprintf("repos/%s/%s/issues/%d/comments?per_page=100", source.Owner, source.Repo, number), &raw); err != nil {
		return nil, err
	}
	comments := make([]GitHubComment, 0, len(raw))
	for _, row := range raw {
		comment := GitHubComment{ID: row.ID, Body: row.Body, CreatedAt: row.CreatedAt, URL: row.HTMLURL, Path: row.Path, Line: row.Line, StartLine: row.StartLine}
		if row.User != nil {
			comment.Author, comment.AuthorAvatarURL = row.User.Login, row.User.AvatarURL
			isBot := row.User.Type == "Bot"
			comment.IsBot = &isBot
		}
		comments = append(comments, comment)
	}
	return comments, nil
}

func readGitHubIssueTimeline(ctx context.Context, workdir string, source GitHubOwnerRepo, number int) []GitHubIssueTimelineItem {
	var raw []githubTimelineRaw
	if readPaginatedGitHubArray(ctx, workdir, fmt.Sprintf("repos/%s/%s/issues/%d/timeline?per_page=100", source.Owner, source.Repo, number), &raw) != nil {
		return []GitHubIssueTimelineItem{}
	}
	allowed := map[string]bool{"assigned": true, "unassigned": true, "mentioned": true, "cross-referenced": true, "closed": true, "reopened": true, "moved_columns_in_project": true}
	items := make([]GitHubIssueTimelineItem, 0, len(raw))
	for _, row := range raw {
		if !allowed[row.Event] {
			continue
		}
		id := row.NodeID
		if id == "" {
			id = strconv.FormatInt(row.ID, 10)
		}
		item := GitHubIssueTimelineItem{ID: id, Event: row.Event, CreatedAt: row.CreatedAt, StateReason: row.StateReason, PreviousColumnName: row.PreviousColumnName, ColumnName: row.ProjectColumnName}
		if row.Actor != nil {
			item.Actor, item.ActorAvatarURL = row.Actor.Login, row.Actor.AvatarURL
		}
		if row.Assignee != nil {
			item.Assignee = row.Assignee.Login
		}
		if row.Source != nil {
			item.Source = mapGitHubTimelineTarget(row.Source.Issue)
		}
		item.Closer = mapGitHubTimelineTarget(row.Closer)
		if row.Project != nil {
			item.ProjectName = optionalString(row.Project.Name)
		}
		items = append(items, item)
	}
	return items
}

func mapGitHubTimelineTarget(raw *githubTimelineTargetRaw) *GitHubIssueTimelineTarget {
	if raw == nil || raw.Number < 1 {
		return nil
	}
	typeName := "issue"
	if raw.PullRequest != nil {
		typeName = "pr"
	}
	repository := ""
	if raw.Repository != nil && raw.Repository.Owner != nil {
		repository = raw.Repository.Owner.Login + "/" + raw.Repository.Name
	}
	return &GitHubIssueTimelineTarget{Type: typeName, Number: raw.Number, Title: raw.Title, URL: raw.HTMLURL, Repository: repository}
}

func readGitHubPRFiles(ctx context.Context, workdir string, source GitHubOwnerRepo, number int) []GitHubPRFile {
	var raw []githubFileRaw
	if readPaginatedGitHubArray(ctx, workdir, fmt.Sprintf("repos/%s/%s/pulls/%d/files?per_page=100", source.Owner, source.Repo, number), &raw) != nil {
		return []GitHubPRFile{}
	}
	files := make([]GitHubPRFile, 0, len(raw))
	for _, row := range raw {
		files = append(files, GitHubPRFile{Path: row.Filename, OldPath: row.PreviousFilename, Status: row.Status, Additions: row.Additions, Deletions: row.Deletions, IsBinary: row.Patch == nil})
	}
	return files
}

func readPaginatedGitHubArray(ctx context.Context, workdir, endpoint string, target interface{}) error {
	out, err := runCLI(ctx, "gh", workdir, "api", "--paginate", "--slurp", endpoint, "--jq", "flatten")
	if err != nil {
		return err
	}
	return json.Unmarshal(out, target)
}

func githubDetailParticipants(item GitHubWorkItem, comments []GitHubComment, assignees []ghAPIUser) []GitHubAssignableUser {
	byLogin := map[string]GitHubAssignableUser{}
	if item.Author != nil && *item.Author != "" {
		byLogin[*item.Author] = GitHubAssignableUser{Login: *item.Author}
	}
	for _, assignee := range assignees {
		if assignee.Login != "" {
			byLogin[assignee.Login] = GitHubAssignableUser{Login: assignee.Login}
		}
	}
	for _, comment := range comments {
		if comment.Author != "" {
			byLogin[comment.Author] = GitHubAssignableUser{Login: comment.Author, AvatarURL: comment.AuthorAvatarURL}
		}
	}
	logins := make([]string, 0, len(byLogin))
	for login := range byLogin {
		logins = append(logins, login)
	}
	sort.Strings(logins)
	users := make([]GitHubAssignableUser, 0, len(logins))
	for _, login := range logins {
		users = append(users, byLogin[login])
	}
	return users
}
