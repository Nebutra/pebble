package runtimehttp

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/nebutra/pebble/runtime/go/internal/providercli"
)

type legacySharedControlGitHubProjectParams struct {
	Input         string          `json:"input"`
	Owner         string          `json:"owner"`
	OwnerType     string          `json:"ownerType"`
	Repo          string          `json:"repo"`
	ProjectNumber int             `json:"projectNumber"`
	ViewID        string          `json:"viewId"`
	ViewNumber    int             `json:"viewNumber"`
	ViewName      string          `json:"viewName"`
	QueryOverride *string         `json:"queryOverride"`
	Number        int             `json:"number"`
	Type          string          `json:"type"`
	Updates       json.RawMessage `json:"updates"`
	CommentID     int             `json:"commentId"`
	Body          string          `json:"body"`
	ProjectID     string          `json:"projectId"`
	ItemID        string          `json:"itemId"`
	FieldID       string          `json:"fieldId"`
	Value         json.RawMessage `json:"value"`
	IssueTypeID   *string         `json:"issueTypeId"`
}

func (s *Server) runLegacySharedControlGitHubProjectMethod(method string, raw json.RawMessage) (interface{}, bool, error) {
	if !legacySharedControlGitHubProjectMethod(method) {
		return nil, false, nil
	}
	var params legacySharedControlGitHubProjectParams
	if json.Unmarshal(raw, &params) != nil {
		return nil, true, errors.New("invalid GitHub Project parameters")
	}
	ctx := context.Background()
	switch method {
	case "github.project.resolveRef":
		return s.manager.ResolveGitHubProjectRef(ctx, params.Input), true, nil
	case "github.project.listAccessible":
		return s.manager.ListAccessibleGitHubProjects(ctx), true, nil
	case "github.project.listViews":
		return s.manager.ListGitHubProjectViews(ctx, params.Owner, params.OwnerType, params.ProjectNumber), true, nil
	case "github.project.viewTable":
		return s.manager.GetGitHubProjectViewTable(ctx, providercli.GitHubProjectTableRequest{Owner: params.Owner, OwnerType: params.OwnerType, ProjectNumber: params.ProjectNumber, ViewID: params.ViewID, ViewNumber: params.ViewNumber, ViewName: params.ViewName, QueryOverride: params.QueryOverride}), true, nil
	case "github.project.listLabelsBySlug":
		return s.manager.ListGitHubLabelsBySlug(ctx, params.Owner, params.Repo), true, nil
	case "github.project.listAssignableUsersBySlug":
		return s.manager.ListGitHubAssignableUsersBySlug(ctx, params.Owner, params.Repo), true, nil
	case "github.project.listIssueTypesBySlug":
		return s.manager.ListGitHubIssueTypesBySlug(ctx, params.Owner, params.Repo), true, nil
	case "github.project.workItemDetailsBySlug":
		result, err := s.manager.GetGitHubWorkItemDetailsBySlug(ctx, params.Owner, params.Repo, params.Number, params.Type)
		return result, true, err
	case "github.project.updateIssueBySlug":
		var update providercli.GitHubIssueUpdate
		if len(params.Updates) > 0 && json.Unmarshal(params.Updates, &update) != nil {
			return nil, true, errors.New("invalid GitHub Project issue update")
		}
		return s.manager.UpdateGitHubIssueBySlug(ctx, params.Owner, params.Repo, params.Number, update), true, nil
	case "github.project.updatePullRequestBySlug":
		var update providercli.GitHubProjectPullRequestUpdate
		if len(params.Updates) > 0 && json.Unmarshal(params.Updates, &update) != nil {
			return nil, true, errors.New("invalid GitHub Project pull request update")
		}
		return s.manager.UpdateGitHubPullRequestBySlug(ctx, params.Owner, params.Repo, params.Number, update), true, nil
	case "github.project.addIssueCommentBySlug":
		return s.manager.AddGitHubIssueCommentBySlug(ctx, params.Owner, params.Repo, params.Number, params.Body), true, nil
	case "github.project.updateIssueCommentBySlug":
		return s.manager.UpdateGitHubIssueCommentBySlug(ctx, params.Owner, params.Repo, params.CommentID, params.Body), true, nil
	case "github.project.deleteIssueCommentBySlug":
		return s.manager.DeleteGitHubIssueCommentBySlug(ctx, params.Owner, params.Repo, params.CommentID), true, nil
	case "github.project.updateItemField":
		var value providercli.GitHubProjectFieldMutationValue
		if len(params.Value) > 0 && json.Unmarshal(params.Value, &value) != nil {
			return nil, true, errors.New("invalid GitHub Project field value")
		}
		return s.manager.UpdateGitHubProjectItemField(ctx, params.ProjectID, params.ItemID, params.FieldID, value), true, nil
	case "github.project.clearItemField":
		return s.manager.ClearGitHubProjectItemField(ctx, params.ProjectID, params.ItemID, params.FieldID), true, nil
	case "github.project.updateIssueTypeBySlug":
		return s.manager.UpdateGitHubIssueTypeBySlug(ctx, params.Owner, params.Repo, params.Number, params.IssueTypeID), true, nil
	}
	return nil, false, nil
}

func legacySharedControlGitHubProjectMethod(method string) bool {
	switch method {
	case "github.project.resolveRef", "github.project.listAccessible", "github.project.listViews", "github.project.viewTable", "github.project.listLabelsBySlug", "github.project.listAssignableUsersBySlug", "github.project.listIssueTypesBySlug", "github.project.workItemDetailsBySlug", "github.project.updateIssueBySlug", "github.project.updatePullRequestBySlug", "github.project.addIssueCommentBySlug", "github.project.updateIssueCommentBySlug", "github.project.deleteIssueCommentBySlug", "github.project.updateItemField", "github.project.clearItemField", "github.project.updateIssueTypeBySlug":
		return true
	default:
		return false
	}
}
