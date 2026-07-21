package providercli

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"sync"
)

type glabDiscussionRaw struct {
	ID    string `json:"id"`
	Notes []struct {
		ID         int64  `json:"id"`
		Body       string `json:"body"`
		CreatedAt  string `json:"created_at"`
		System     bool   `json:"system"`
		Resolvable bool   `json:"resolvable"`
		Resolved   bool   `json:"resolved"`
		Author     *struct {
			Username  string `json:"username"`
			AvatarURL string `json:"avatar_url"`
			State     string `json:"state"`
		} `json:"author"`
		Position *struct {
			NewPath string `json:"new_path"`
			NewLine int    `json:"new_line"`
		} `json:"position"`
	} `json:"notes"`
}

type glabMRDetailsRaw struct {
	glabMRRaw
	Description string `json:"description"`
	SHA         string `json:"sha"`
	DiffRefs    *struct {
		BaseSHA  string `json:"base_sha"`
		HeadSHA  string `json:"head_sha"`
		StartSHA string `json:"start_sha"`
	} `json:"diff_refs"`
	HeadPipeline *struct {
		ID int `json:"id"`
	} `json:"head_pipeline"`
	Reviewers []glabDetailUser `json:"reviewers"`
}

type glabDetailUser struct {
	ID        int     `json:"id"`
	Username  string  `json:"username"`
	Name      *string `json:"name"`
	AvatarURL string  `json:"avatar_url"`
	State     *string `json:"state"`
}

func GetGitLabWorkItemByPath(ctx context.Context, workdir string, project GitLabProjectRef, iid int, itemType string) *GitLabWorkItem {
	if iid < 1 || (itemType != "issue" && itemType != "mr") || project.Path == "" {
		return nil
	}
	resource := "issues"
	if itemType == "mr" {
		resource = "merge_requests"
	}
	out, err := runCLI(ctx, "glab", workdir, gitLabAPIArgs(project, "projects/"+encodeGitLabProjectPath(project.Path)+"/"+resource+"/"+strconv.Itoa(iid))...)
	if err != nil {
		return nil
	}
	if itemType == "mr" {
		var raw glabMRRaw
		if json.Unmarshal(out, &raw) != nil {
			return nil
		}
		item := mapGitLabMR(&raw)
		ref := project
		item.ProjectRef = &ref
		return &item
	}
	var raw glabIssueRaw
	if json.Unmarshal(out, &raw) != nil {
		return nil
	}
	item := mapGitLabIssueWorkItem(&raw, project)
	return &item
}

func GetGitLabWorkItemDetails(ctx context.Context, workdir string, iid int, itemType string, override *GitLabProjectRef) *GitLabWorkItemDetails {
	project, err := resolveGitLabProjectRef(ctx, workdir, override)
	if err != nil || iid < 1 || (itemType != "issue" && itemType != "mr") {
		return nil
	}
	if itemType == "issue" {
		return getGitLabIssueDetails(ctx, workdir, project, iid)
	}
	return getGitLabMRDetails(ctx, workdir, project, iid)
}

func getGitLabIssueDetails(ctx context.Context, workdir string, project GitLabProjectRef, iid int) *GitLabWorkItemDetails {
	var raw glabIssueRaw
	var discussions []glabDiscussionRaw
	var itemErr, discussionErr error
	var wait sync.WaitGroup
	wait.Add(2)
	go func() {
		defer wait.Done()
		out, err := runCLI(ctx, "glab", workdir, gitLabAPIArgs(project, gitLabItemResource(project, "issues", iid))...)
		itemErr = err
		if err == nil {
			itemErr = json.Unmarshal(out, &raw)
		}
	}()
	go func() {
		defer wait.Done()
		discussions, discussionErr = fetchGitLabDiscussions(ctx, workdir, project, "issues", iid)
	}()
	wait.Wait()
	if itemErr != nil || discussionErr != nil {
		return nil
	}
	item := mapGitLabIssueWorkItem(&raw, project)
	assignees := make([]string, 0, len(raw.Assignees))
	for _, assignee := range raw.Assignees {
		if assignee.Username != "" {
			assignees = append(assignees, assignee.Username)
		}
	}
	body := ""
	if raw.Description != nil {
		body = *raw.Description
	}
	return &GitLabWorkItemDetails{Item: item, Body: body, Comments: flattenGitLabDiscussions(discussions), Assignees: assignees}
}

func getGitLabMRDetails(ctx context.Context, workdir string, project GitLabProjectRef, iid int) *GitLabWorkItemDetails {
	var raw glabMRDetailsRaw
	var discussions []glabDiscussionRaw
	var itemErr, discussionErr error
	var wait sync.WaitGroup
	wait.Add(2)
	go func() {
		defer wait.Done()
		out, err := runCLI(ctx, "glab", workdir, gitLabAPIArgs(project, gitLabItemResource(project, "merge_requests", iid))...)
		itemErr = err
		if err == nil {
			itemErr = json.Unmarshal(out, &raw)
		}
	}()
	go func() {
		defer wait.Done()
		discussions, discussionErr = fetchGitLabDiscussions(ctx, workdir, project, "merge_requests", iid)
	}()
	wait.Wait()
	if itemErr != nil || discussionErr != nil {
		return nil
	}
	item := mapGitLabMR(&raw.glabMRRaw)
	ref := project
	item.ProjectRef = &ref
	details := &GitLabWorkItemDetails{Item: item, Body: raw.Description, Comments: flattenGitLabDiscussions(discussions), HeadSHA: raw.SHA}
	if raw.DiffRefs != nil {
		details.BaseSHA, details.StartSHA = raw.DiffRefs.BaseSHA, raw.DiffRefs.StartSHA
	}
	var supplemental sync.WaitGroup
	supplemental.Add(3)
	go func() {
		defer supplemental.Done()
		details.Reviewers = fetchGitLabReviewers(ctx, workdir, project, iid, raw.Reviewers)
	}()
	go func() {
		defer supplemental.Done()
		details.ApprovalState = fetchGitLabApprovalState(ctx, workdir, project, iid)
	}()
	go func() {
		defer supplemental.Done()
		details.Files = fetchGitLabMRFiles(ctx, workdir, project, iid)
	}()
	if raw.HeadPipeline != nil && raw.HeadPipeline.ID > 0 {
		supplemental.Add(1)
		go func() {
			defer supplemental.Done()
			details.PipelineJobs = fetchGitLabPipelineJobs(ctx, workdir, project, raw.HeadPipeline.ID)
		}()
	}
	supplemental.Wait()
	return details
}

func fetchGitLabDiscussions(ctx context.Context, workdir string, project GitLabProjectRef, resource string, iid int) ([]glabDiscussionRaw, error) {
	out, err := runCLI(ctx, "glab", workdir, gitLabAPIArgs(project, gitLabItemResource(project, resource, iid)+"/discussions?per_page=100")...)
	if err != nil {
		return nil, err
	}
	var raw []glabDiscussionRaw
	if err := json.Unmarshal(out, &raw); err != nil {
		return nil, err
	}
	return raw, nil
}

func flattenGitLabDiscussions(raw []glabDiscussionRaw) []ReviewComment {
	comments := make([]ReviewComment, 0)
	for _, discussion := range raw {
		for _, note := range discussion.Notes {
			if note.System {
				continue
			}
			comment := ReviewComment{ID: note.ID, Author: "unknown", Body: note.Body, CreatedAt: note.CreatedAt, ThreadID: discussion.ID, IsResolved: note.Resolvable && note.Resolved}
			if note.Author != nil {
				comment.Author, comment.AuthorAvatarURL, comment.IsBot = note.Author.Username, note.Author.AvatarURL, note.Author.State == "bot"
			}
			if note.Position != nil {
				comment.Path, comment.Line = note.Position.NewPath, note.Position.NewLine
			}
			comments = append(comments, comment)
		}
	}
	sortReviewComments(comments)
	return comments
}

func sortReviewComments(comments []ReviewComment) {
	for i := 1; i < len(comments); i++ {
		for j := i; j > 0 && comments[j].CreatedAt < comments[j-1].CreatedAt; j-- {
			comments[j], comments[j-1] = comments[j-1], comments[j]
		}
	}
}

func fetchGitLabPipelineJobs(ctx context.Context, workdir string, project GitLabProjectRef, pipelineID int) []GitLabPipelineJob {
	resource := "projects/" + encodeGitLabProjectPath(project.Path) + "/pipelines/" + strconv.Itoa(pipelineID) + "/jobs?per_page=100"
	out, err := runCLI(ctx, "glab", workdir, gitLabAPIArgs(project, resource)...)
	if err != nil {
		return []GitLabPipelineJob{}
	}
	var raw []struct {
		ID       int      `json:"id"`
		Name     string   `json:"name"`
		Stage    string   `json:"stage"`
		Status   string   `json:"status"`
		WebURL   string   `json:"web_url"`
		Duration *float64 `json:"duration"`
	}
	if json.Unmarshal(out, &raw) != nil {
		return []GitLabPipelineJob{}
	}
	items := make([]GitLabPipelineJob, 0, len(raw))
	for _, job := range raw {
		id := pipelineID
		items = append(items, GitLabPipelineJob{ID: job.ID, PipelineID: &id, Name: job.Name, Stage: job.Stage, Status: job.Status, WebURL: job.WebURL, Duration: job.Duration})
	}
	return items
}

func fetchGitLabReviewers(ctx context.Context, workdir string, project GitLabProjectRef, iid int, fallback []glabDetailUser) []GitLabAssignableUser {
	out, err := runCLI(ctx, "glab", workdir, gitLabAPIArgs(project, gitLabItemResource(project, "merge_requests", iid)+"/reviewers")...)
	if err == nil {
		var response []struct {
			User glabDetailUser `json:"user"`
		}
		if json.Unmarshal(out, &response) == nil {
			fallback = fallback[:0]
			for _, entry := range response {
				fallback = append(fallback, entry.User)
			}
		}
	}
	return mapGitLabDetailUsers(fallback)
}

func mapGitLabDetailUsers(raw []glabDetailUser) []GitLabAssignableUser {
	users := make([]GitLabAssignableUser, 0, len(raw))
	for _, user := range raw {
		if user.Username == "" {
			continue
		}
		var id *int
		if user.ID > 0 {
			value := user.ID
			id = &value
		}
		users = append(users, GitLabAssignableUser{ID: id, Username: user.Username, Name: user.Name, AvatarURL: user.AvatarURL, State: user.State})
	}
	return users
}

func fetchGitLabApprovalState(ctx context.Context, workdir string, project GitLabProjectRef, iid int) *GitLabMRApprovalState {
	base := gitLabItemResource(project, "merge_requests", iid)
	var approvalsOut, stateOut []byte
	var approvalsErr, stateErr error
	var wait sync.WaitGroup
	wait.Add(2)
	go func() {
		defer wait.Done()
		approvalsOut, approvalsErr = runCLI(ctx, "glab", workdir, gitLabAPIArgs(project, base+"/approvals")...)
	}()
	go func() {
		defer wait.Done()
		stateOut, stateErr = runCLI(ctx, "glab", workdir, gitLabAPIArgs(project, base+"/approval_state")...)
	}()
	wait.Wait()
	if approvalsErr != nil && stateErr != nil {
		return nil
	}
	result := &GitLabMRApprovalState{ApprovedBy: []GitLabAssignableUser{}, Rules: []GitLabMRApprovalRule{}}
	if approvalsErr == nil {
		var raw struct {
			ApprovalsRequired *int `json:"approvals_required"`
			ApprovalsLeft     *int `json:"approvals_left"`
			ApprovedBy        []struct {
				User glabDetailUser `json:"user"`
			} `json:"approved_by"`
		}
		if json.Unmarshal(approvalsOut, &raw) == nil {
			result.ApprovalsRequired, result.ApprovalsLeft = raw.ApprovalsRequired, raw.ApprovalsLeft
			for _, entry := range raw.ApprovedBy {
				result.ApprovedBy = append(result.ApprovedBy, mapGitLabDetailUsers([]glabDetailUser{entry.User})...)
			}
		}
	}
	if stateErr == nil {
		var raw struct {
			Rules []struct {
				ID                int    `json:"id"`
				Name              string `json:"name"`
				ApprovalsRequired int    `json:"approvals_required"`
				Approved          bool   `json:"approved"`
			} `json:"rules"`
		}
		if json.Unmarshal(stateOut, &raw) == nil {
			for _, rule := range raw.Rules {
				result.Rules = append(result.Rules, GitLabMRApprovalRule{ID: rule.ID, Name: firstNonEmpty(rule.Name, "Approval rule"), ApprovalsRequired: rule.ApprovalsRequired, Approved: rule.Approved})
			}
		}
	}
	return result
}

func fetchGitLabMRFiles(ctx context.Context, workdir string, project GitLabProjectRef, iid int) []GitLabMRFile {
	out, err := runCLI(ctx, "glab", workdir, gitLabAPIArgs(project, gitLabItemResource(project, "merge_requests", iid)+"/diffs?per_page=100")...)
	if err != nil {
		return []GitLabMRFile{}
	}
	var raw []struct {
		NewPath     string `json:"new_path"`
		OldPath     string `json:"old_path"`
		Diff        string `json:"diff"`
		NewFile     bool   `json:"new_file"`
		DeletedFile bool   `json:"deleted_file"`
		RenamedFile bool   `json:"renamed_file"`
		Binary      bool   `json:"binary"`
		TooLarge    bool   `json:"too_large"`
	}
	if json.Unmarshal(out, &raw) != nil {
		return []GitLabMRFile{}
	}
	files := make([]GitLabMRFile, 0, len(raw))
	for _, entry := range raw {
		path := firstNonEmpty(entry.NewPath, entry.OldPath)
		if path == "" {
			continue
		}
		status := "modified"
		if entry.NewFile {
			status = "added"
		} else if entry.DeletedFile {
			status = "removed"
		} else if entry.RenamedFile {
			status = "renamed"
		}
		additions, deletions := countGitLabDiffLines(entry.Diff)
		file := GitLabMRFile{Path: path, Status: status, Additions: additions, Deletions: deletions, IsBinary: entry.Binary || entry.TooLarge || entry.Diff == "", Diff: entry.Diff}
		if entry.OldPath != "" && entry.OldPath != entry.NewPath {
			file.OldPath = entry.OldPath
		}
		files = append(files, file)
	}
	return files
}

func countGitLabDiffLines(diff string) (int, int) {
	additions, deletions := 0, 0
	for _, line := range strings.Split(diff, "\n") {
		if strings.HasPrefix(line, "+++") || strings.HasPrefix(line, "---") {
			continue
		}
		if strings.HasPrefix(line, "+") {
			additions++
		} else if strings.HasPrefix(line, "-") {
			deletions++
		}
	}
	return additions, deletions
}

func gitLabItemResource(project GitLabProjectRef, resource string, iid int) string {
	return "projects/" + encodeGitLabProjectPath(project.Path) + "/" + resource + "/" + strconv.Itoa(iid)
}
