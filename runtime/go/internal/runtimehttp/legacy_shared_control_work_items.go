package runtimehttp

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/nebutra/pebble/runtime/go/internal/providercli"
	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
)

type legacySharedControlWorkItemParams struct {
	Repo                   string                        `json:"repo"`
	RepoID                 string                        `json:"repoId"`
	ProjectID              string                        `json:"projectId"`
	RepoPath               string                        `json:"repoPath"`
	Worktree               string                        `json:"worktree"`
	WorktreeID             string                        `json:"worktreeId"`
	WorktreePath           string                        `json:"worktreePath"`
	Limit                  int                           `json:"limit"`
	Page                   int                           `json:"page"`
	PerPage                int                           `json:"perPage"`
	Query                  string                        `json:"query"`
	Before                 string                        `json:"before"`
	State                  string                        `json:"state"`
	Assignee               string                        `json:"assignee"`
	Number                 int                           `json:"number"`
	IID                    int                           `json:"iid"`
	Type                   string                        `json:"type"`
	Owner                  string                        `json:"owner"`
	OwnerRepo              string                        `json:"ownerRepo"`
	Title                  string                        `json:"title"`
	Body                   string                        `json:"body"`
	Labels                 []string                      `json:"labels"`
	Assignees              []string                      `json:"assignees"`
	Updates                json.RawMessage               `json:"updates"`
	ProjectRef             *providercli.GitLabProjectRef `json:"projectRef"`
	Host                   string                        `json:"host"`
	Path                   string                        `json:"path"`
	Provider               string                        `json:"provider"`
	Force                  bool                          `json:"force"`
	Branch                 string                        `json:"branch"`
	LinkedPRNumber         *int                          `json:"linkedPRNumber"`
	FallbackPRNumber       *int                          `json:"fallbackPRNumber"`
	AcceptMergedFallbackPR bool                          `json:"acceptMergedFallbackPR"`
	CurrentHeadOID         *string                       `json:"currentHeadOid"`
	OldPath                string                        `json:"oldPath"`
	Status                 string                        `json:"status"`
	HeadSHA                string                        `json:"headSha"`
	BaseSHA                string                        `json:"baseSha"`
	JobID                  int64                         `json:"jobId"`
}

func (s *Server) runLegacySharedControlWorkItemMethod(method string, raw json.RawMessage) (interface{}, bool, error) {
	if !legacySharedControlWorkItemMethod(method) {
		return nil, false, nil
	}
	var params legacySharedControlWorkItemParams
	if json.Unmarshal(raw, &params) != nil {
		return nil, true, errors.New("invalid work item parameters")
	}
	ctx := context.Background()
	switch method {
	case "github.rateLimit":
		return s.manager.GetGitHubRateLimit(ctx, params.Force), true, nil
	case "github.viewer":
		return s.manager.GetGitHubViewer(ctx), true, nil
	case "github.diagnoseAuth":
		return s.manager.DiagnoseGitHubAuth(ctx), true, nil
	case "gitlab.rateLimit":
		return s.manager.GetGitLabRateLimit(ctx, params.Force, strings.TrimSpace(params.Host)), true, nil
	case "gitlab.viewer":
		return s.manager.GetGitLabViewer(ctx), true, nil
	case "gitlab.diagnoseAuth":
		return s.manager.DiagnoseGitLabAuth(ctx), true, nil
	}
	project, worktree, err := s.resolveLegacySharedControlWorkItemScope(params)
	if err != nil {
		return nil, true, err
	}
	switch method {
	case "providerReview.listWorkItems":
		result, callErr := s.manager.ListReviewWorkItems(ctx, project.ID, worktree.ID, strings.TrimSpace(params.Provider), strings.TrimSpace(params.State), positiveLegacyLimit(params.Limit, 24))
		return result, true, callErr
	case "github.listIssues":
		limit := positiveLegacyLimit(params.Limit, 20)
		result, callErr := s.manager.ListGitHubIssues(ctx, project.ID, worktree.ID, limit)
		return result.Items, true, callErr
	case "github.listWorkItems":
		result, callErr := s.manager.ListGitHubWorkItems(ctx, project.ID, worktree.ID, positiveLegacyLimit(params.Limit, 24), strings.TrimSpace(params.Query), strings.TrimSpace(params.Before))
		return result, true, callErr
	case "github.countWorkItems":
		count, callErr := s.manager.CountGitHubWorkItems(ctx, project.ID, worktree.ID, strings.TrimSpace(params.Query))
		return count, true, callErr
	case "github.listLabels":
		result, callErr := s.manager.ListGitHubLabels(ctx, project.ID, worktree.ID)
		return result, true, callErr
	case "github.listAssignableUsers":
		result, callErr := s.manager.ListGitHubAssignableUsers(ctx, project.ID, worktree.ID)
		return result, true, callErr
	case "github.workItem", "github.workItemByOwnerRepo":
		result, callErr := s.manager.GetGitHubWorkItem(ctx, project.ID, worktree.ID, params.Number, params.Type, params.Owner, params.OwnerRepo)
		return result, true, callErr
	case "github.issue":
		result, callErr := s.manager.GetGitHubWorkItem(ctx, project.ID, worktree.ID, params.Number, "issue", params.Owner, params.OwnerRepo)
		if callErr != nil || result == nil {
			return nil, true, callErr
		}
		state := "closed"
		if result.State == "open" {
			state = "open"
		}
		return map[string]interface{}{"number": result.Number, "title": result.Title, "state": state, "url": result.URL, "labels": result.Labels}, true, nil
	case "github.workItemDetails":
		result, callErr := s.manager.GetGitHubWorkItemDetails(ctx, project.ID, worktree.ID, params.Number, params.Type)
		return result, true, callErr
	case "github.prComments":
		result, callErr := s.manager.ListGitHubPRComments(ctx, project.ID, worktree.ID, params.Number)
		return result, true, callErr
	case "github.prForBranch":
		fallback := params.FallbackPRNumber
		if params.LinkedPRNumber != nil {
			fallback = nil
		}
		result, callErr := s.manager.GetGitHubPRForBranch(ctx, project.ID, worktree.ID, providercli.GitHubPRForBranchRequest{
			Branch: params.Branch, LinkedPRNumber: params.LinkedPRNumber, FallbackPRNumber: fallback,
			AcceptMergedFallbackPR: params.AcceptMergedFallbackPR, CurrentHeadOID: params.CurrentHeadOID,
		})
		return result, true, callErr
	case "github.prFileContents":
		status := strings.TrimSpace(params.Status)
		if status == "" {
			status = "modified"
		}
		result, callErr := s.manager.GetGitHubPRFileContents(ctx, project.ID, worktree.ID, providercli.GitHubPRFileContentsRequest{
			Path: params.Path, OldPath: params.OldPath, Status: status, HeadSHA: params.HeadSHA, BaseSHA: params.BaseSHA,
		})
		return result, true, callErr
	case "github.createIssue":
		result, callErr := s.manager.CreateGitHubIssue(ctx, project.ID, worktree.ID, params.Title, params.Body, params.Labels, params.Assignees)
		return result, true, callErr
	case "github.updateIssue":
		var update providercli.GitHubIssueUpdate
		if len(params.Updates) > 0 && json.Unmarshal(params.Updates, &update) != nil {
			return nil, true, errors.New("invalid GitHub issue update")
		}
		result, callErr := s.manager.UpdateGitHubIssue(ctx, project.ID, worktree.ID, params.Number, update)
		return result, true, callErr
	case "gitlab.listIssues":
		result, callErr := s.manager.ListGitLabIssues(ctx, project.ID, worktree.ID, params.State, params.Assignee, positiveLegacyLimit(params.Limit, 20))
		return result, true, callErr
	case "gitlab.listWorkItems":
		page, perPage := positiveLegacyLimit(params.Page, 1), positiveLegacyLimit(params.PerPage, 20)
		result, callErr := s.manager.ListGitLabWorkItems(ctx, project.ID, worktree.ID, params.State, page, perPage, params.Query)
		if callErr != nil {
			return nil, true, callErr
		}
		items := make([]map[string]interface{}, 0, len(result.Items))
		for _, item := range result.Items {
			encoded, _ := json.Marshal(item)
			var projected map[string]interface{}
			_ = json.Unmarshal(encoded, &projected)
			projected["repoId"] = project.ID
			items = append(items, projected)
		}
		totalPages := page + 1
		if len(items) < perPage {
			totalPages = page
		}
		response := map[string]interface{}{"items": items, "page": page, "perPage": perPage, "totalCount": len(items), "totalPages": totalPages}
		if result.Error != nil {
			response["error"] = result.Error
		}
		return response, true, nil
	case "gitlab.listLabels":
		result, callErr := s.manager.ListGitLabLabels(ctx, project.ID, worktree.ID)
		return result, true, callErr
	case "gitlab.todos":
		result, callErr := s.manager.ListGitLabTodos(ctx, project.ID, worktree.ID)
		return result, true, callErr
	case "gitlab.workItemDetails":
		result, callErr := s.manager.GetGitLabWorkItemDetails(ctx, project.ID, worktree.ID, params.IID, params.Type, params.ProjectRef)
		return result, true, callErr
	case "gitlab.workItemByPath":
		result, callErr := s.manager.GetGitLabWorkItemByPath(ctx, project.ID, worktree.ID, params.IID, params.Type, providercli.GitLabProjectRef{Host: params.Host, Path: params.Path})
		return result, true, callErr
	case "gitlab.createIssue":
		result, callErr := s.manager.CreateGitLabIssue(ctx, project.ID, worktree.ID, params.Title, params.Body)
		return result, true, callErr
	case "gitlab.updateIssue":
		var update providercli.GitLabIssueUpdate
		if len(params.Updates) > 0 && json.Unmarshal(params.Updates, &update) != nil {
			return nil, true, errors.New("invalid GitLab issue update")
		}
		result, callErr := s.manager.UpdateGitLabIssue(ctx, project.ID, worktree.ID, params.Number, update, params.ProjectRef)
		return result, true, callErr
	case "gitlab.addIssueComment":
		result, callErr := s.manager.AddGitLabIssueComment(ctx, project.ID, worktree.ID, params.Number, params.Body, params.ProjectRef)
		return result, true, callErr
	case "gitlab.jobTrace":
		if params.JobID <= 0 {
			return nil, true, errors.New("GitLab job request requires a positive jobId")
		}
		result, callErr := s.manager.GetGitLabJobTrace(ctx, project.ID, worktree.ID, params.JobID, params.ProjectRef)
		return result, true, callErr
	case "gitlab.retryJob":
		if params.JobID <= 0 {
			return nil, true, errors.New("GitLab job request requires a positive jobId")
		}
		result, callErr := s.manager.RetryGitLabJob(ctx, project.ID, worktree.ID, params.JobID, params.ProjectRef)
		return result, true, callErr
	}
	return nil, false, nil
}

func legacySharedControlWorkItemMethod(method string) bool {
	switch method {
	case "github.rateLimit", "github.viewer", "github.diagnoseAuth", "gitlab.rateLimit", "gitlab.viewer", "gitlab.diagnoseAuth", "providerReview.listWorkItems",
		"github.listIssues", "github.listWorkItems", "github.countWorkItems", "github.listLabels", "github.listAssignableUsers", "github.workItem", "github.workItemByOwnerRepo", "github.issue", "github.workItemDetails", "github.prComments", "github.prForBranch", "github.prFileContents", "github.createIssue", "github.updateIssue",
		"gitlab.listIssues", "gitlab.listWorkItems", "gitlab.listLabels", "gitlab.todos", "gitlab.workItemDetails", "gitlab.workItemByPath", "gitlab.createIssue", "gitlab.updateIssue", "gitlab.addIssueComment", "gitlab.jobTrace", "gitlab.retryJob":
		return true
	default:
		return false
	}
}

func (s *Server) resolveLegacySharedControlWorkItemScope(params legacySharedControlWorkItemParams) (runtimecore.Project, runtimecore.Worktree, error) {
	project, found := s.findLegacySharedControlProject(firstNonEmpty(params.Repo, params.RepoID, params.ProjectID, params.RepoPath))
	if !found {
		return runtimecore.Project{}, runtimecore.Worktree{}, runtimecore.ErrNotFound
	}
	selector := firstNonEmpty(params.Worktree, params.WorktreeID, params.WorktreePath)
	if selector == "" {
		return project, runtimecore.Worktree{}, nil
	}
	worktree, found := s.findLegacySharedControlWorktree(strings.TrimPrefix(selector, "path:"))
	if !found || worktree.ProjectID != project.ID {
		return runtimecore.Project{}, runtimecore.Worktree{}, runtimecore.ErrNotFound
	}
	return project, worktree, nil
}

func positiveLegacyLimit(value, fallback int) int {
	if value > 0 {
		return value
	}
	return fallback
}
