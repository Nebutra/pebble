package runtimehttp

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/nebutra/pebble/runtime/go/internal/providercli"
	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
)

type legacySharedControlHostedReviewParams struct {
	Repo                  string  `json:"repo"`
	RepoID                string  `json:"repoId"`
	ProjectID             string  `json:"projectId"`
	RepoPath              string  `json:"repoPath"`
	Worktree              string  `json:"worktree"`
	WorktreeID            string  `json:"worktreeId"`
	WorktreePath          string  `json:"worktreePath"`
	Branch                string  `json:"branch"`
	Base                  string  `json:"base"`
	Head                  string  `json:"head"`
	Title                 string  `json:"title"`
	Body                  string  `json:"body"`
	Provider              string  `json:"provider"`
	Draft                 bool    `json:"draft"`
	UseTemplate           bool    `json:"useTemplate"`
	HasUncommittedChanges bool    `json:"hasUncommittedChanges"`
	HasUpstream           *bool   `json:"hasUpstream"`
	Ahead                 float64 `json:"ahead"`
	Behind                float64 `json:"behind"`
	LinkedGitHubPR        *int    `json:"linkedGitHubPR"`
	FallbackGitHubPR      *int    `json:"fallbackGitHubPR"`
	LinkedGitLabMR        *int    `json:"linkedGitLabMR"`
	CurrentHeadOID        *string `json:"currentHeadOid"`
	PRNumber              int     `json:"prNumber"`
	CheckRunID            int64   `json:"checkRunId"`
	WorkflowRunID         int64   `json:"workflowRunId"`
	CheckName             string  `json:"checkName"`
	URL                   string  `json:"url"`
	PRRepo                struct {
		Owner string `json:"owner"`
		Repo  string `json:"repo"`
	} `json:"prRepo"`
	HeadSHA       string                     `json:"headSha"`
	FailedOnly    bool                       `json:"failedOnly"`
	State         string                     `json:"state"`
	Page          int                        `json:"page"`
	PerPage       int                        `json:"perPage"`
	Query         string                     `json:"query"`
	Number        int                        `json:"number"`
	IID           int                        `json:"iid"`
	Method        string                     `json:"method"`
	Enabled       bool                       `json:"enabled"`
	Updates       map[string]json.RawMessage `json:"updates"`
	Reviewers     []string                   `json:"reviewers"`
	ReviewerIDs   []int                      `json:"reviewerIds"`
	ThreadID      string                     `json:"threadId"`
	DiscussionID  string                     `json:"discussionId"`
	Resolve       *bool                      `json:"resolve"`
	Resolved      *bool                      `json:"resolved"`
	CommentID     int                        `json:"commentId"`
	Path          string                     `json:"path"`
	Line          int                        `json:"line"`
	PullRequestID string                     `json:"pullRequestId"`
	Viewed        bool                       `json:"viewed"`
	Input         json.RawMessage            `json:"input"`
	OldPath       string                     `json:"oldPath"`
	StartLine     int                        `json:"startLine"`
	CommitID      string                     `json:"commitId"`
	BaseSHA       string                     `json:"baseSha"`
	StartSHA      string                     `json:"startSha"`
}

func (s *Server) runLegacySharedControlHostedReviewMethod(method string, raw json.RawMessage) (interface{}, bool, error) {
	if !legacySharedControlHostedReviewMethod(method) {
		return nil, false, nil
	}
	var params legacySharedControlHostedReviewParams
	if json.Unmarshal(raw, &params) != nil {
		return nil, true, errors.New("invalid hosted review parameters")
	}
	project, worktree, err := s.resolveLegacySharedControlProviderScope(params)
	if err != nil {
		return nil, true, err
	}
	ctx := context.Background()
	switch method {
	case "github.updatePR", "github.updatePRTitle", "github.updatePRState", "github.requestPRReviewers", "github.removePRReviewers", "gitlab.updateMR", "gitlab.updateMRState", "gitlab.updateMRReviewers":
		result, updateErr := s.updateLegacySharedControlHostedReview(ctx, method, project.ID, worktree.ID, params)
		return result, true, updateErr
	case "github.mergePR", "gitlab.mergeMR":
		provider := "github"
		defaultMethod := "squash"
		if method == "gitlab.mergeMR" {
			provider, defaultMethod = "gitlab", "merge"
		}
		mergeMethod := firstNonEmpty(params.Method, defaultMethod)
		result, mergeErr := s.manager.MergeHostedReview(ctx, project.ID, worktree.ID, providercli.MergeReviewRequest{Provider: provider, Number: legacySharedControlReviewNumber(params), Method: mergeMethod})
		return result, true, mergeErr
	case "github.setPRAutoMerge":
		mergeMethod := firstNonEmpty(params.Method, "squash")
		result, autoMergeErr := s.manager.SetHostedReviewAutoMerge(ctx, project.ID, worktree.ID, providercli.SetAutoMergeRequest{Number: legacySharedControlReviewNumber(params), Enabled: params.Enabled, Method: mergeMethod})
		return result, true, autoMergeErr
	case "github.addIssueComment", "gitlab.addMRComment":
		provider := "github"
		if method == "gitlab.addMRComment" {
			provider = "gitlab"
		}
		result, commentErr := s.manager.AddHostedReviewComment(ctx, project.ID, worktree.ID, providercli.AddReviewCommentRequest{Provider: provider, Number: legacySharedControlReviewNumber(params), Body: params.Body, Owner: params.PRRepo.Owner, Repo: params.PRRepo.Repo})
		return result, true, commentErr
	case "github.addPRReviewComment", "gitlab.addMRInlineComment":
		provider := "github"
		if method == "gitlab.addMRInlineComment" {
			provider = "gitlab"
		}
		inline := params
		if len(params.Input) > 0 {
			_ = json.Unmarshal(params.Input, &inline)
		}
		result, inlineErr := s.manager.AddHostedInlineReviewComment(ctx, project.ID, worktree.ID, providercli.AddInlineReviewCommentRequest{Provider: provider, Number: legacySharedControlReviewNumber(params), Body: inline.Body, Path: inline.Path, OldPath: inline.OldPath, Line: inline.Line, StartLine: inline.StartLine, CommitID: inline.CommitID, BaseSHA: inline.BaseSHA, StartSHA: inline.StartSHA, HeadSHA: inline.HeadSHA})
		return result, true, inlineErr
	case "github.addPRReviewCommentReply":
		result, replyErr := s.manager.ReplyHostedReviewComment(ctx, project.ID, worktree.ID, providercli.ReplyReviewCommentRequest{Number: legacySharedControlReviewNumber(params), CommentID: params.CommentID, Body: params.Body, ThreadID: params.ThreadID, Path: params.Path, Line: params.Line, Owner: params.PRRepo.Owner, Repo: params.PRRepo.Repo})
		return result, true, replyErr
	case "github.resolveReviewThread", "gitlab.resolveMRDiscussion":
		provider := "github"
		if method == "gitlab.resolveMRDiscussion" {
			provider = "gitlab"
		}
		resolved := false
		if params.Resolve != nil {
			resolved = *params.Resolve
		} else if params.Resolved != nil {
			resolved = *params.Resolved
		}
		result, resolveErr := s.manager.ResolveHostedReviewThread(ctx, project.ID, worktree.ID, providercli.ResolveReviewThreadRequest{Provider: provider, Number: legacySharedControlReviewNumber(params), ThreadID: firstNonEmpty(params.ThreadID, params.DiscussionID), Resolved: resolved})
		return result, true, resolveErr
	case "github.setPRFileViewed":
		result, viewedErr := s.manager.SetHostedReviewFileViewed(ctx, project.ID, worktree.ID, providercli.SetReviewFileViewedRequest{PullRequestID: params.PullRequestID, Path: params.Path, Viewed: params.Viewed})
		return result, true, viewedErr
	case "github.prChecks":
		if params.PRNumber <= 0 {
			return nil, true, errors.New("missing pull request number")
		}
		checks, checkErr := s.manager.GetGitHubPRChecks(ctx, project.ID, worktree.ID, params.PRNumber)
		return checks, true, checkErr
	case "github.prCheckDetails":
		details, detailsErr := s.manager.GetGitHubPRCheckDetails(ctx, project.ID, worktree.ID, providercli.GitHubPRCheckDetailsOptions{CheckRunID: params.CheckRunID, WorkflowRunID: params.WorkflowRunID, CheckName: params.CheckName, URL: params.URL, Owner: params.PRRepo.Owner, Repo: params.PRRepo.Repo})
		return details, true, detailsErr
	case "github.rerunPRChecks":
		if params.PRNumber <= 0 {
			return map[string]interface{}{"ok": false, "error": "Invalid pull request number"}, true, nil
		}
		result, rerunErr := s.manager.RerunGitHubPRChecks(ctx, project.ID, worktree.ID, params.PRNumber, params.HeadSHA, params.FailedOnly)
		return result, true, rerunErr
	case "gitlab.listMRs":
		page := params.Page
		if page <= 0 {
			page = 1
		}
		perPage := params.PerPage
		if perPage <= 0 {
			perPage = 20
		}
		items, listErr := s.manager.ListGitLabMRs(ctx, project.ID, worktree.ID, params.State, perPage, params.Query)
		if listErr != nil {
			return nil, true, listErr
		}
		totalPages := page + 1
		if len(items) < perPage {
			totalPages = page
		}
		return map[string]interface{}{"items": items, "page": page, "perPage": perPage, "totalCount": len(items), "totalPages": totalPages}, true, nil
	case "hostedReview.forBranch":
		review := s.findLegacySharedControlHostedReview(ctx, project.ID, worktree.ID, params)
		return review, true, nil
	case "hostedReview.getCreationEligibility":
		if review := s.findLegacySharedControlHostedReview(ctx, project.ID, worktree.ID, params); review != nil {
			return map[string]interface{}{"provider": review["provider"], "review": map[string]interface{}{"number": review["number"], "url": review["url"]}, "canCreate": false, "blockedReason": "existing_review", "nextAction": "open_existing_review"}, true, nil
		}
		capabilities, capabilityErr := s.manager.HostedReviewCapabilities(ctx, project.ID, worktree.ID)
		if capabilityErr != nil {
			return nil, true, capabilityErr
		}
		return legacySharedControlHostedReviewEligibility(params, capabilities), true, nil
	case "hostedReview.create":
		if strings.TrimSpace(params.Base) == "" || strings.TrimSpace(params.Title) == "" {
			return map[string]interface{}{"ok": false, "code": "validation", "error": "Create review failed: repository, base branch, and title are required."}, true, nil
		}
		result, createErr := s.manager.CreateHostedReview(ctx, project.ID, worktree.ID, providercli.CreateReviewRequest{Provider: strings.TrimSpace(params.Provider), Base: strings.TrimSpace(params.Base), Head: strings.TrimSpace(params.Head), Title: strings.TrimSpace(params.Title), Body: params.Body, Draft: params.Draft, UseTemplate: params.UseTemplate})
		return result, true, createErr
	}
	return nil, false, nil
}

func legacySharedControlHostedReviewMethod(method string) bool {
	switch method {
	case "hostedReview.forBranch", "hostedReview.getCreationEligibility", "hostedReview.create", "github.prChecks", "github.prCheckDetails", "github.rerunPRChecks", "gitlab.listMRs",
		"github.updatePR", "github.updatePRTitle", "github.updatePRState", "github.requestPRReviewers", "github.removePRReviewers", "github.mergePR", "github.setPRAutoMerge", "github.addIssueComment", "github.addPRReviewComment", "github.addPRReviewCommentReply", "github.resolveReviewThread", "github.setPRFileViewed",
		"gitlab.updateMR", "gitlab.updateMRState", "gitlab.updateMRReviewers", "gitlab.mergeMR", "gitlab.addMRComment", "gitlab.addMRInlineComment", "gitlab.resolveMRDiscussion":
		return true
	default:
		return false
	}
}

func (s *Server) updateLegacySharedControlHostedReview(ctx context.Context, method, projectID, worktreeID string, params legacySharedControlHostedReviewParams) (providercli.UpdateReviewResult, error) {
	provider := "github"
	if strings.HasPrefix(method, "gitlab.") {
		provider = "gitlab"
	}
	request := providercli.UpdateReviewRequest{Provider: provider, Number: legacySharedControlReviewNumber(params)}
	decodeString := func(raw json.RawMessage) *string {
		if len(raw) == 0 {
			return nil
		}
		var value string
		if json.Unmarshal(raw, &value) != nil {
			return nil
		}
		return &value
	}
	request.Title = decodeString(params.Updates["title"])
	request.Body = decodeString(params.Updates["body"])
	if state := decodeString(params.Updates["state"]); state != nil {
		request.State = *state
	}
	if method == "github.updatePRTitle" {
		request.Title = &params.Title
	}
	if method == "gitlab.updateMRState" {
		request.State = params.State
	}
	if method == "github.requestPRReviewers" {
		request.AddReviewers = params.Reviewers
	}
	if method == "github.removePRReviewers" {
		request.RemoveReviewers = params.Reviewers
	}
	if method == "gitlab.updateMRReviewers" {
		request.ReviewerIDs = &params.ReviewerIDs
	}
	return s.manager.UpdateHostedReview(ctx, projectID, worktreeID, request)
}

func legacySharedControlReviewNumber(params legacySharedControlHostedReviewParams) int {
	if params.PRNumber > 0 {
		return params.PRNumber
	}
	if params.IID > 0 {
		return params.IID
	}
	return params.Number
}

func (s *Server) resolveLegacySharedControlProviderScope(params legacySharedControlHostedReviewParams) (runtimecore.Project, runtimecore.Worktree, error) {
	projectSelector := firstNonEmpty(params.Repo, params.RepoID, params.ProjectID, params.RepoPath)
	project, found := s.findLegacySharedControlProject(projectSelector)
	if !found {
		return runtimecore.Project{}, runtimecore.Worktree{}, runtimecore.ErrNotFound
	}
	worktreeSelector := firstNonEmpty(params.Worktree, params.WorktreeID, params.WorktreePath)
	if worktreeSelector != "" {
		worktree, found := s.findLegacySharedControlWorktree(strings.TrimPrefix(worktreeSelector, "path:"))
		if !found || worktree.ProjectID != project.ID {
			return runtimecore.Project{}, runtimecore.Worktree{}, runtimecore.ErrNotFound
		}
		return project, worktree, nil
	}
	for _, worktree := range s.manager.ListWorktrees(project.ID) {
		if worktree.Path == params.RepoPath || worktree.Path == project.Path {
			return project, worktree, nil
		}
	}
	return project, runtimecore.Worktree{}, nil
}

func (s *Server) findLegacySharedControlHostedReview(ctx context.Context, projectID, worktreeID string, params legacySharedControlHostedReviewParams) map[string]interface{} {
	branch := strings.TrimPrefix(strings.TrimSpace(params.Branch), "refs/heads/")
	if branch == "" {
		return nil
	}
	linkedGitHub := params.LinkedGitHubPR
	if linkedGitHub == nil {
		linkedGitHub = params.FallbackGitHubPR
	}
	github, err := s.manager.GetGitHubPRForBranch(ctx, projectID, worktreeID, providercli.GitHubPRForBranchRequest{Branch: branch, LinkedPRNumber: linkedGitHub, CurrentHeadOID: params.CurrentHeadOID})
	if err == nil && github != nil {
		state := legacySharedControlReviewState(github.State)
		return map[string]interface{}{"provider": "github", "number": github.Number, "title": github.Title, "state": state, "url": github.URL, "status": github.ChecksStatus, "updatedAt": github.UpdatedAt, "mergeable": github.Mergeable, "reviewDecision": github.ReviewDecision, "autoMergeEnabled": github.AutoMergeEnabled, "mergeStateStatus": github.MergeStateStatus, "headSha": github.HeadSHA, "confirmedContainedHeadOid": github.ConfirmedHeadOID, "baseRefName": github.BaseRefName, "conflictSummary": github.ConflictSummary}
	}
	linkedGitLab := 0
	if params.LinkedGitLabMR != nil {
		linkedGitLab = *params.LinkedGitLabMR
	}
	gitlab, err := s.manager.GetGitLabMergeRequestForBranch(ctx, projectID, worktreeID, branch, linkedGitLab)
	if err != nil || gitlab == nil {
		return nil
	}
	return map[string]interface{}{"provider": "gitlab", "number": gitlab.Number, "title": gitlab.Title, "state": legacySharedControlReviewState(gitlab.State), "url": gitlab.URL, "status": gitlab.PipelineStatus, "updatedAt": gitlab.UpdatedAt, "mergeable": gitlab.Mergeable, "headSha": gitlab.HeadSHA, "baseRefName": gitlab.BaseRefName}
}

func legacySharedControlHostedReviewEligibility(params legacySharedControlHostedReviewParams, capabilities runtimecore.HostedReviewCapabilities) map[string]interface{} {
	provider := capabilities.Provider
	if provider != "github" && provider != "gitlab" {
		provider = "unsupported"
	}
	branch := strings.TrimPrefix(strings.TrimSpace(firstNonEmpty(params.Branch, capabilities.CurrentBranch)), "refs/heads/")
	base := strings.TrimPrefix(strings.TrimSpace(firstNonEmpty(params.Base, capabilities.DefaultBaseRef)), "refs/heads/")
	result := map[string]interface{}{"provider": provider, "review": nil, "canCreate": false, "blockedReason": nil, "nextAction": nil, "defaultBaseRef": nullableLegacyString(base), "head": nullableLegacyString(branch)}
	setBlocked := func(reason string, action interface{}) map[string]interface{} {
		result["blockedReason"] = reason
		result["nextAction"] = action
		return result
	}
	if branch == "" || branch == "HEAD" {
		return setBlocked("detached_head", nil)
	}
	if provider == "unsupported" {
		return setBlocked("unsupported_provider", nil)
	}
	if base != "" && strings.EqualFold(branch, base) {
		return setBlocked("default_branch", nil)
	}
	if params.HasUncommittedChanges {
		return setBlocked("dirty", "commit")
	}
	if params.HasUpstream != nil && !*params.HasUpstream {
		return setBlocked("no_upstream", "publish")
	}
	if params.HasUpstream == nil {
		return result
	}
	if params.Behind > 0 {
		return setBlocked("needs_sync", "sync")
	}
	if !capabilities.Authenticated {
		return setBlocked("auth_required", "authenticate")
	}
	if params.Ahead > 0 {
		return setBlocked("needs_push", "push")
	}
	result["canCreate"] = base != ""
	return result
}

func legacySharedControlReviewState(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "closed", "merged", "draft":
		return strings.ToLower(strings.TrimSpace(value))
	default:
		return "open"
	}
}

func nullableLegacyString(value string) interface{} {
	if value == "" {
		return nil
	}
	return value
}
