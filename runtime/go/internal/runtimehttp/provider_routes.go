package runtimehttp

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/nebutra/pebble/runtime/go/internal/providercli"
	"github.com/nebutra/pebble/runtime/go/internal/providerrest"
	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
)

// Provider routes expose local gh / glab flows so the desktop app gets PR/MR +
// review data without pairing a remote environment. Paths are provider-neutral
// (/v1/providers/<provider>/...) with the provider as a path discriminator.

func (s *Server) handleProviderGitHubPRs(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	projectID, worktreeID := providerSelector(r)
	limit := providerIntQuery(r, "limit", 24)
	items, err := s.manager.ListGitHubPRs(r.Context(), projectID, worktreeID, limit)
	if err != nil {
		writeProviderError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"items": items})
}

type providerGitHubPRForBranchRequest struct {
	ProjectID  string `json:"projectId"`
	WorktreeID string `json:"worktreeId"`
	providercli.GitHubPRForBranchRequest
}

func (s *Server) handleProviderGitHubPRForBranch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var input providerGitHubPRForBranchRequest
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&input) != nil || input.ProjectID == "" {
		writeError(w, http.StatusBadRequest, "valid project and branch lookup are required")
		return
	}
	result, err := s.manager.GetGitHubPRForBranch(r.Context(), input.ProjectID, input.WorktreeID, input.GitHubPRForBranchRequest)
	if err != nil {
		writeProviderError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"pr": result})
}

func (s *Server) handleProviderGitHubIssues(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	projectID, worktreeID := providerSelector(r)
	result, err := s.manager.ListGitHubIssues(r.Context(), projectID, worktreeID, providerIntQuery(r, "limit", 20))
	if err != nil {
		writeProviderError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleProviderGitHubWorkItems(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	projectID, worktreeID := providerSelector(r)
	result, err := s.manager.ListGitHubWorkItems(r.Context(), projectID, worktreeID, providerIntQuery(r, "limit", 24), r.URL.Query().Get("query"), r.URL.Query().Get("before"))
	if err != nil {
		writeProviderError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleProviderGitHubWorkItem(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	number := providerIntQuery(r, "number", 0)
	itemType := r.URL.Query().Get("type")
	if number < 1 || (itemType != "" && itemType != "issue" && itemType != "pr") {
		writeError(w, http.StatusBadRequest, "positive number and optional issue/pr type are required")
		return
	}
	projectID, worktreeID := providerSelector(r)
	item, err := s.manager.GetGitHubWorkItem(r.Context(), projectID, worktreeID, number, itemType, r.URL.Query().Get("owner"), r.URL.Query().Get("repo"))
	if err != nil {
		writeProviderError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, item)
}

type providerGitHubIssueCreateRequest struct {
	ProjectID  string   `json:"projectId"`
	WorktreeID string   `json:"worktreeId"`
	Title      string   `json:"title"`
	Body       string   `json:"body"`
	Labels     []string `json:"labels"`
	Assignees  []string `json:"assignees"`
}

func (s *Server) handleProviderGitHubIssueCreate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var input providerGitHubIssueCreateRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&input); err != nil || strings.TrimSpace(input.Title) == "" || (input.ProjectID == "" && input.WorktreeID == "") {
		writeError(w, http.StatusBadRequest, "project/worktree and title are required")
		return
	}
	result, err := s.manager.CreateGitHubIssue(r.Context(), input.ProjectID, input.WorktreeID, input.Title, input.Body, input.Labels, input.Assignees)
	if err != nil {
		writeProviderError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

type providerGitHubIssueUpdateRequest struct {
	ProjectID  string                        `json:"projectId"`
	WorktreeID string                        `json:"worktreeId"`
	Number     int                           `json:"number"`
	Updates    providercli.GitHubIssueUpdate `json:"updates"`
}

func (s *Server) handleProviderGitHubIssueUpdate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var input providerGitHubIssueUpdateRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&input); err != nil || input.Number < 1 || (input.ProjectID == "" && input.WorktreeID == "") {
		writeError(w, http.StatusBadRequest, "project/worktree and positive number are required")
		return
	}
	result, err := s.manager.UpdateGitHubIssue(r.Context(), input.ProjectID, input.WorktreeID, input.Number, input.Updates)
	if err != nil {
		writeProviderError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleProviderGitHubWorkItemCount(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	projectID, worktreeID := providerSelector(r)
	count, err := s.manager.CountGitHubWorkItems(r.Context(), projectID, worktreeID, r.URL.Query().Get("query"))
	if err != nil {
		writeProviderError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]int{"count": count})
}

func (s *Server) handleProviderGitHubLabels(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	projectID, worktreeID := providerSelector(r)
	labels, err := s.manager.ListGitHubLabels(r.Context(), projectID, worktreeID)
	if err != nil {
		writeProviderError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"labels": labels})
}

func (s *Server) handleProviderGitHubAssignableUsers(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	projectID, worktreeID := providerSelector(r)
	users, err := s.manager.ListGitHubAssignableUsers(r.Context(), projectID, worktreeID)
	if err != nil {
		writeProviderError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"users": users})
}

func (s *Server) handleProviderGitHubWorkItemDetails(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	number := providerIntQuery(r, "number", 0)
	itemType := r.URL.Query().Get("type")
	if number < 1 || (itemType != "" && itemType != "issue" && itemType != "pr") {
		writeError(w, http.StatusBadRequest, "positive number and optional issue/pr type are required")
		return
	}
	projectID, worktreeID := providerSelector(r)
	details, err := s.manager.GetGitHubWorkItemDetails(r.Context(), projectID, worktreeID, number, itemType)
	if err != nil {
		writeProviderError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, details)
}

type providerGitHubPRFileContentsRequest struct {
	ProjectID  string                                  `json:"projectId"`
	WorktreeID string                                  `json:"worktreeId"`
	File       providercli.GitHubPRFileContentsRequest `json:"file"`
}

func (s *Server) handleProviderGitHubPRFileContents(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var input providerGitHubPRFileContentsRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&input); err != nil || (input.ProjectID == "" && input.WorktreeID == "") || strings.TrimSpace(input.File.Path) == "" {
		writeError(w, http.StatusBadRequest, "project/worktree and file path are required")
		return
	}
	result, err := s.manager.GetGitHubPRFileContents(r.Context(), input.ProjectID, input.WorktreeID, input.File)
	if err != nil {
		writeProviderError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleProviderGitHubPRComments(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	number := providerIntQuery(r, "number", 0)
	if number < 1 {
		writeError(w, http.StatusBadRequest, "positive number is required")
		return
	}
	projectID, worktreeID := providerSelector(r)
	comments, err := s.manager.ListGitHubPRComments(r.Context(), projectID, worktreeID, number)
	if err != nil {
		writeProviderError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, comments)
}

func (s *Server) handleProviderGitHubRateLimit(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	writeJSON(w, http.StatusOK, s.manager.GetGitHubRateLimit(r.Context(), providerBoolQuery(r, "force")))
}

func (s *Server) handleProviderGitHubViewer(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	writeJSON(w, http.StatusOK, s.manager.GetGitHubViewer(r.Context()))
}

func (s *Server) handleProviderGitHubAuthDiagnostic(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	writeJSON(w, http.StatusOK, s.manager.DiagnoseGitHubAuth(r.Context()))
}

func (s *Server) handleProviderGitHubProjectResolve(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	writeJSON(w, http.StatusOK, s.manager.ResolveGitHubProjectRef(r.Context(), r.URL.Query().Get("input")))
}

func (s *Server) handleProviderGitHubProjects(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	writeJSON(w, http.StatusOK, s.manager.ListAccessibleGitHubProjects(r.Context()))
}

func (s *Server) handleProviderGitHubProjectViews(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	writeJSON(w, http.StatusOK, s.manager.ListGitHubProjectViews(
		r.Context(),
		r.URL.Query().Get("owner"),
		r.URL.Query().Get("ownerType"),
		providerIntQuery(r, "projectNumber", 0),
	))
}

func (s *Server) handleProviderGitHubProjectViewTable(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var input providercli.GitHubProjectTableRequest
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&input) != nil {
		writeError(w, http.StatusBadRequest, "invalid request")
		return
	}
	writeJSON(w, http.StatusOK, s.manager.GetGitHubProjectViewTable(r.Context(), input))
}

func (s *Server) handleProviderGitHubProjectLabels(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	writeJSON(w, http.StatusOK, s.manager.ListGitHubLabelsBySlug(r.Context(), r.URL.Query().Get("owner"), r.URL.Query().Get("repo")))
}

func (s *Server) handleProviderGitHubProjectAssignees(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	writeJSON(w, http.StatusOK, s.manager.ListGitHubAssignableUsersBySlug(r.Context(), r.URL.Query().Get("owner"), r.URL.Query().Get("repo")))
}

func (s *Server) handleProviderGitHubProjectIssueTypes(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	writeJSON(w, http.StatusOK, s.manager.ListGitHubIssueTypesBySlug(r.Context(), r.URL.Query().Get("owner"), r.URL.Query().Get("repo")))
}

func (s *Server) handleProviderGitHubProjectWorkItemDetails(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	number, itemType := providerIntQuery(r, "number", 0), r.URL.Query().Get("type")
	if number < 1 || (itemType != "issue" && itemType != "pr") {
		writeError(w, http.StatusBadRequest, "positive number and issue/pr type are required")
		return
	}
	details, err := s.manager.GetGitHubWorkItemDetailsBySlug(r.Context(), r.URL.Query().Get("owner"), r.URL.Query().Get("repo"), number, itemType)
	if err != nil {
		writeProviderError(w, err)
		return
	}
	if details == nil {
		writeError(w, http.StatusNotFound, "work item not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"ok": true, "details": details})
}

type providerGitHubProjectMutationRequest struct {
	Owner       string                                      `json:"owner"`
	Repo        string                                      `json:"repo"`
	Number      int                                         `json:"number"`
	CommentID   int                                         `json:"commentId"`
	Body        string                                      `json:"body"`
	Action      string                                      `json:"action"`
	Updates     providercli.GitHubIssueUpdate               `json:"updates"`
	PullUpdates providercli.GitHubProjectPullRequestUpdate  `json:"pullUpdates"`
	ProjectID   string                                      `json:"projectId"`
	ItemID      string                                      `json:"itemId"`
	FieldID     string                                      `json:"fieldId"`
	Value       providercli.GitHubProjectFieldMutationValue `json:"value"`
	IssueTypeID *string                                     `json:"issueTypeId"`
}

func (s *Server) handleProviderGitHubProjectFields(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var input providerGitHubProjectMutationRequest
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&input) != nil {
		writeError(w, http.StatusBadRequest, "invalid request")
		return
	}
	if input.Action == "clear" {
		writeJSON(w, http.StatusOK, s.manager.ClearGitHubProjectItemField(r.Context(), input.ProjectID, input.ItemID, input.FieldID))
		return
	}
	if input.Action != "update" {
		writeError(w, http.StatusBadRequest, "valid field action is required")
		return
	}
	writeJSON(w, http.StatusOK, s.manager.UpdateGitHubProjectItemField(r.Context(), input.ProjectID, input.ItemID, input.FieldID, input.Value))
}

func (s *Server) handleProviderGitHubProjectIssueTypeUpdate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var input providerGitHubProjectMutationRequest
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&input) != nil {
		writeError(w, http.StatusBadRequest, "invalid request")
		return
	}
	writeJSON(w, http.StatusOK, s.manager.UpdateGitHubIssueTypeBySlug(r.Context(), input.Owner, input.Repo, input.Number, input.IssueTypeID))
}

func (s *Server) handleProviderGitHubProjectPullUpdate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var input providerGitHubProjectMutationRequest
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&input) != nil {
		writeError(w, http.StatusBadRequest, "invalid request")
		return
	}
	writeJSON(w, http.StatusOK, s.manager.UpdateGitHubPullRequestBySlug(r.Context(), input.Owner, input.Repo, input.Number, input.PullUpdates))
}

func (s *Server) handleProviderGitHubProjectIssueUpdate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var input providerGitHubProjectMutationRequest
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&input) != nil {
		writeError(w, http.StatusBadRequest, "invalid request")
		return
	}
	writeJSON(w, http.StatusOK, s.manager.UpdateGitHubIssueBySlug(r.Context(), input.Owner, input.Repo, input.Number, input.Updates))
}

func (s *Server) handleProviderGitHubProjectComments(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var input providerGitHubProjectMutationRequest
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&input) != nil {
		writeError(w, http.StatusBadRequest, "invalid request")
		return
	}
	switch input.Action {
	case "add":
		writeJSON(w, http.StatusOK, s.manager.AddGitHubIssueCommentBySlug(r.Context(), input.Owner, input.Repo, input.Number, input.Body))
	case "update":
		writeJSON(w, http.StatusOK, s.manager.UpdateGitHubIssueCommentBySlug(r.Context(), input.Owner, input.Repo, input.CommentID, input.Body))
	case "delete":
		writeJSON(w, http.StatusOK, s.manager.DeleteGitHubIssueCommentBySlug(r.Context(), input.Owner, input.Repo, input.CommentID))
	default:
		writeError(w, http.StatusBadRequest, "valid comment action is required")
	}
}

func (s *Server) handleProviderGitHubPRDetail(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	number := providerIntQuery(r, "number", 0)
	if number <= 0 {
		writeError(w, http.StatusBadRequest, "number query parameter is required")
		return
	}
	projectID, worktreeID := providerSelector(r)
	item, err := s.manager.GetGitHubPR(r.Context(), projectID, worktreeID, number)
	if err != nil {
		writeProviderError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"item": item})
}

func (s *Server) handleProviderGitHubPRChecks(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	number := providerIntQuery(r, "number", 0)
	if number <= 0 {
		writeError(w, http.StatusBadRequest, "number query parameter is required")
		return
	}
	projectID, worktreeID := providerSelector(r)
	checks, err := s.manager.GetGitHubPRChecks(r.Context(), projectID, worktreeID, number)
	if err != nil {
		writeProviderError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"checks": checks})
}

func (s *Server) handleProviderGitHubPRCheckDetails(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	projectID, worktreeID := providerSelector(r)
	details, err := s.manager.GetGitHubPRCheckDetails(r.Context(), projectID, worktreeID, providercli.GitHubPRCheckDetailsOptions{
		CheckRunID:    int64(providerIntQuery(r, "checkRunId", 0)),
		WorkflowRunID: int64(providerIntQuery(r, "workflowRunId", 0)),
		CheckName:     r.URL.Query().Get("checkName"),
		URL:           r.URL.Query().Get("url"),
		Owner:         r.URL.Query().Get("owner"),
		Repo:          r.URL.Query().Get("repo"),
	})
	if err != nil {
		writeProviderError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"details": details})
}

type providerGitHubChecksRerunRequest struct {
	ProjectID  string `json:"projectId"`
	WorktreeID string `json:"worktreeId"`
	PRNumber   int    `json:"prNumber"`
	HeadSHA    string `json:"headSha"`
	FailedOnly bool   `json:"failedOnly"`
}

func (s *Server) handleProviderGitHubPRChecksRerun(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var input providerGitHubChecksRerunRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if input.PRNumber <= 0 || (input.ProjectID == "" && input.WorktreeID == "") {
		writeError(w, http.StatusBadRequest, "project/worktree and prNumber are required")
		return
	}
	result, err := s.manager.RerunGitHubPRChecks(r.Context(), input.ProjectID, input.WorktreeID, input.PRNumber, input.HeadSHA, input.FailedOnly)
	if err != nil {
		writeProviderError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleProviderGitLabMRs(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	projectID, worktreeID := providerSelector(r)
	state := r.URL.Query().Get("state")
	perPage := providerIntQuery(r, "perPage", 20)
	query := r.URL.Query().Get("query")
	items, err := s.manager.ListGitLabMRs(r.Context(), projectID, worktreeID, state, perPage, query)
	if err != nil {
		writeProviderError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"items": items})
}

func (s *Server) handleProviderGitLabProjectRef(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	projectID, worktreeID := providerSelector(r)
	result, err := s.manager.GetGitLabProjectRef(r.Context(), projectID, worktreeID)
	if err != nil {
		writeProviderError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleProviderGitLabMR(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	projectID, worktreeID := providerSelector(r)
	result, err := s.manager.GetGitLabMergeRequest(r.Context(), projectID, worktreeID, providerIntQuery(r, "iid", 0))
	if err != nil {
		writeProviderError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleProviderGitLabMRForBranch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	projectID, worktreeID := providerSelector(r)
	result, err := s.manager.GetGitLabMergeRequestForBranch(r.Context(), projectID, worktreeID, r.URL.Query().Get("branch"), providerIntQuery(r, "linkedMRIid", 0))
	if err != nil {
		writeProviderError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleProviderGitLabIssue(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	projectID, worktreeID := providerSelector(r)
	result, err := s.manager.GetGitLabIssue(r.Context(), projectID, worktreeID, providerIntQuery(r, "iid", 0))
	if err != nil {
		writeProviderError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleProviderGitLabAssignableUsers(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	projectID, worktreeID := providerSelector(r)
	users, err := s.manager.ListGitLabAssignableUsers(r.Context(), projectID, worktreeID)
	if err != nil {
		writeProviderError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"users": users})
}

func (s *Server) handleProviderGitLabIssues(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	projectID, worktreeID := providerSelector(r)
	result, err := s.manager.ListGitLabIssues(
		r.Context(), projectID, worktreeID, r.URL.Query().Get("state"),
		r.URL.Query().Get("assignee"), providerIntQuery(r, "limit", 20),
	)
	if err != nil {
		writeProviderError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleProviderGitLabWorkItems(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	projectID, worktreeID := providerSelector(r)
	result, err := s.manager.ListGitLabWorkItems(
		r.Context(), projectID, worktreeID, r.URL.Query().Get("state"),
		providerIntQuery(r, "page", 1), providerIntQuery(r, "perPage", 20), r.URL.Query().Get("query"),
	)
	if err != nil {
		writeProviderError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleProviderGitLabLabels(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	projectID, worktreeID := providerSelector(r)
	labels, err := s.manager.ListGitLabLabels(r.Context(), projectID, worktreeID)
	if err != nil {
		writeProviderError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, labels)
}

func (s *Server) handleProviderGitLabTodos(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	projectID, worktreeID := providerSelector(r)
	items, err := s.manager.ListGitLabTodos(r.Context(), projectID, worktreeID)
	if err != nil {
		writeProviderError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, items)
}

func (s *Server) handleProviderGitLabWorkItemDetails(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	iid := providerIntQuery(r, "iid", 0)
	itemType := r.URL.Query().Get("type")
	if iid < 1 || (itemType != "issue" && itemType != "mr") {
		writeError(w, http.StatusBadRequest, "positive iid and issue/mr type are required")
		return
	}
	projectID, worktreeID := providerSelector(r)
	projectRef := providerGitLabProjectRefFromQuery(r)
	details, err := s.manager.GetGitLabWorkItemDetails(r.Context(), projectID, worktreeID, iid, itemType, projectRef)
	if err != nil {
		writeProviderError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, details)
}

func (s *Server) handleProviderGitLabWorkItemByPath(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	iid := providerIntQuery(r, "iid", 0)
	itemType := r.URL.Query().Get("type")
	projectRef := providerGitLabProjectRefFromQuery(r)
	if iid < 1 || (itemType != "issue" && itemType != "mr") || projectRef == nil {
		writeError(w, http.StatusBadRequest, "host, path, positive iid, and issue/mr type are required")
		return
	}
	projectID, worktreeID := providerSelector(r)
	item, err := s.manager.GetGitLabWorkItemByPath(r.Context(), projectID, worktreeID, iid, itemType, *projectRef)
	if err != nil {
		writeProviderError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func providerGitLabProjectRefFromQuery(r *http.Request) *providercli.GitLabProjectRef {
	host := strings.TrimSpace(r.URL.Query().Get("host"))
	path := strings.TrimSpace(r.URL.Query().Get("path"))
	if path == "" || strings.ContainsAny(host, "/\\:@?#\r\n\t ") || strings.ContainsAny(path, "\r\n\t") {
		return nil
	}
	return &providercli.GitLabProjectRef{Host: host, Path: path}
}

type providerGitLabIssueMutationRequest struct {
	ProjectID  string                        `json:"projectId"`
	WorktreeID string                        `json:"worktreeId"`
	Number     int                           `json:"number"`
	Title      string                        `json:"title"`
	Body       string                        `json:"body"`
	Updates    providercli.GitLabIssueUpdate `json:"updates"`
	ProjectRef *providercli.GitLabProjectRef `json:"projectRef"`
}

func decodeProviderGitLabIssueMutation(w http.ResponseWriter, r *http.Request) (*providerGitLabIssueMutationRequest, bool) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return nil, false
	}
	var input providerGitLabIssueMutationRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2<<20)).Decode(&input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return nil, false
	}
	if input.ProjectID == "" && input.WorktreeID == "" {
		writeError(w, http.StatusBadRequest, "project or worktree is required")
		return nil, false
	}
	return &input, true
}

func (s *Server) handleProviderGitLabIssueCreate(w http.ResponseWriter, r *http.Request) {
	input, ok := decodeProviderGitLabIssueMutation(w, r)
	if !ok {
		return
	}
	result, err := s.manager.CreateGitLabIssue(r.Context(), input.ProjectID, input.WorktreeID, input.Title, input.Body)
	if err != nil {
		writeProviderError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleProviderGitLabIssueUpdate(w http.ResponseWriter, r *http.Request) {
	input, ok := decodeProviderGitLabIssueMutation(w, r)
	if !ok {
		return
	}
	result, err := s.manager.UpdateGitLabIssue(r.Context(), input.ProjectID, input.WorktreeID, input.Number, input.Updates, input.ProjectRef)
	if err != nil {
		writeProviderError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleProviderGitLabIssueComment(w http.ResponseWriter, r *http.Request) {
	input, ok := decodeProviderGitLabIssueMutation(w, r)
	if !ok {
		return
	}
	result, err := s.manager.AddGitLabIssueComment(r.Context(), input.ProjectID, input.WorktreeID, input.Number, input.Body, input.ProjectRef)
	if err != nil {
		writeProviderError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleProviderGitLabRateLimit(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	host := r.URL.Query().Get("host")
	if strings.ContainsAny(host, "/\\:@?#\r\n\t ") {
		writeError(w, http.StatusBadRequest, "host must be a hostname")
		return
	}
	writeJSON(w, http.StatusOK, s.manager.GetGitLabRateLimit(r.Context(), providerBoolQuery(r, "force"), host))
}

func (s *Server) handleProviderGitLabViewer(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	writeJSON(w, http.StatusOK, s.manager.GetGitLabViewer(r.Context()))
}

func (s *Server) handleProviderGitLabAuthDiagnostic(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	writeJSON(w, http.StatusOK, s.manager.DiagnoseGitLabAuth(r.Context()))
}

type providerGitLabJobRequest struct {
	ProjectID  string                        `json:"projectId"`
	WorktreeID string                        `json:"worktreeId"`
	JobID      int64                         `json:"jobId"`
	ProjectRef *providercli.GitLabProjectRef `json:"projectRef"`
}

func decodeProviderGitLabJobRequest(w http.ResponseWriter, r *http.Request) (*providerGitLabJobRequest, bool) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return nil, false
	}
	var input providerGitLabJobRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return nil, false
	}
	if input.JobID <= 0 || (input.ProjectID == "" && input.WorktreeID == "") {
		writeError(w, http.StatusBadRequest, "project/worktree and jobId are required")
		return nil, false
	}
	return &input, true
}

func (s *Server) handleProviderGitLabJobTrace(w http.ResponseWriter, r *http.Request) {
	input, ok := decodeProviderGitLabJobRequest(w, r)
	if !ok {
		return
	}
	result, err := s.manager.GetGitLabJobTrace(r.Context(), input.ProjectID, input.WorktreeID, input.JobID, input.ProjectRef)
	if err != nil {
		writeProviderError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleProviderGitLabJobRetry(w http.ResponseWriter, r *http.Request) {
	input, ok := decodeProviderGitLabJobRequest(w, r)
	if !ok {
		return
	}
	result, err := s.manager.RetryGitLabJob(r.Context(), input.ProjectID, input.WorktreeID, input.JobID, input.ProjectRef)
	if err != nil {
		writeProviderError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

// handleReviewWorkItems serves the REST-backed providers (bitbucket,
// azure-devops, gitea) whose PR lists come from their HTTP APIs rather than a
// local CLI. Routes stay parallel to the github/gitlab ones.
func (s *Server) handleReviewWorkItems(provider string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		projectID, worktreeID := providerSelector(r)
		state := r.URL.Query().Get("state")
		limit := providerIntQuery(r, "limit", 24)
		items, err := s.manager.ListReviewWorkItems(r.Context(), projectID, worktreeID, provider, state, limit)
		if err != nil {
			writeProviderError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{"items": items})
	}
}

func (s *Server) handleProviderReviewCreate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req struct {
		ProjectID   string `json:"projectId"`
		WorktreeID  string `json:"worktreeId"`
		Provider    string `json:"provider"`
		Base        string `json:"base"`
		Head        string `json:"head"`
		Title       string `json:"title"`
		Body        string `json:"body"`
		Draft       bool   `json:"draft"`
		UseTemplate bool   `json:"useTemplate"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	result, err := s.manager.CreateHostedReview(
		r.Context(),
		req.ProjectID,
		req.WorktreeID,
		providercli.CreateReviewRequest{
			Provider: req.Provider, Base: req.Base, Head: req.Head, Title: req.Title,
			Body: req.Body, Draft: req.Draft, UseTemplate: req.UseTemplate,
		},
	)
	if err != nil {
		writeProviderError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleProviderReviewUpdate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req struct {
		ProjectID       string   `json:"projectId"`
		WorktreeID      string   `json:"worktreeId"`
		Provider        string   `json:"provider"`
		Number          int      `json:"number"`
		Owner           string   `json:"owner"`
		Repo            string   `json:"repo"`
		Title           *string  `json:"title"`
		Body            *string  `json:"body"`
		Base            *string  `json:"base"`
		Draft           *bool    `json:"draft"`
		State           string   `json:"state"`
		AddReviewers    []string `json:"addReviewers"`
		RemoveReviewers []string `json:"removeReviewers"`
		ReviewerIDs     *[]int   `json:"reviewerIds"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	result, err := s.manager.UpdateHostedReview(
		r.Context(),
		req.ProjectID,
		req.WorktreeID,
		providercli.UpdateReviewRequest{
			Provider: req.Provider, Number: req.Number, Owner: req.Owner, Repo: req.Repo,
			Title: req.Title, Body: req.Body,
			Base: req.Base, Draft: req.Draft,
			State: req.State, AddReviewers: req.AddReviewers, RemoveReviewers: req.RemoveReviewers,
			ReviewerIDs: req.ReviewerIDs,
		},
	)
	if err != nil {
		writeProviderError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleProviderReviewMerge(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req struct {
		ProjectID  string `json:"projectId"`
		WorktreeID string `json:"worktreeId"`
		Provider   string `json:"provider"`
		Number     int    `json:"number"`
		Method     string `json:"method"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	result, err := s.manager.MergeHostedReview(r.Context(), req.ProjectID, req.WorktreeID, providercli.MergeReviewRequest{
		Provider: req.Provider, Number: req.Number, Method: req.Method,
	})
	if err != nil {
		writeProviderError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleProviderReviewAutoMerge(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req struct {
		ProjectID  string `json:"projectId"`
		WorktreeID string `json:"worktreeId"`
		Number     int    `json:"number"`
		Enabled    bool   `json:"enabled"`
		Method     string `json:"method"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	result, err := s.manager.SetHostedReviewAutoMerge(r.Context(), req.ProjectID, req.WorktreeID, providercli.SetAutoMergeRequest{Number: req.Number, Enabled: req.Enabled, Method: req.Method})
	if err != nil {
		writeProviderError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleProviderReviewComment(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req struct {
		ProjectID  string `json:"projectId"`
		WorktreeID string `json:"worktreeId"`
		Provider   string `json:"provider"`
		Number     int    `json:"number"`
		Body       string `json:"body"`
		Owner      string `json:"owner"`
		Repo       string `json:"repo"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	result, err := s.manager.AddHostedReviewComment(r.Context(), req.ProjectID, req.WorktreeID, providercli.AddReviewCommentRequest{Provider: req.Provider, Number: req.Number, Body: req.Body, Owner: req.Owner, Repo: req.Repo})
	if err != nil {
		writeProviderError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleProviderInlineReviewComment(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req struct {
		ProjectID  string `json:"projectId"`
		WorktreeID string `json:"worktreeId"`
		Provider   string `json:"provider"`
		Number     int    `json:"number"`
		Body       string `json:"body"`
		Path       string `json:"path"`
		OldPath    string `json:"oldPath"`
		Line       int    `json:"line"`
		StartLine  int    `json:"startLine"`
		CommitID   string `json:"commitId"`
		BaseSHA    string `json:"baseSha"`
		StartSHA   string `json:"startSha"`
		HeadSHA    string `json:"headSha"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	result, err := s.manager.AddHostedInlineReviewComment(r.Context(), req.ProjectID, req.WorktreeID, providercli.AddInlineReviewCommentRequest{Provider: req.Provider, Number: req.Number, Body: req.Body, Path: req.Path, OldPath: req.OldPath, Line: req.Line, StartLine: req.StartLine, CommitID: req.CommitID, BaseSHA: req.BaseSHA, StartSHA: req.StartSHA, HeadSHA: req.HeadSHA})
	if err != nil {
		writeProviderError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleProviderReviewCommentReply(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req struct {
		ProjectID  string `json:"projectId"`
		WorktreeID string `json:"worktreeId"`
		Number     int    `json:"number"`
		CommentID  int    `json:"commentId"`
		Body       string `json:"body"`
		ThreadID   string `json:"threadId"`
		Path       string `json:"path"`
		Line       int    `json:"line"`
		Owner      string `json:"owner"`
		Repo       string `json:"repo"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	result, err := s.manager.ReplyHostedReviewComment(r.Context(), req.ProjectID, req.WorktreeID, providercli.ReplyReviewCommentRequest{Number: req.Number, CommentID: req.CommentID, Body: req.Body, ThreadID: req.ThreadID, Path: req.Path, Line: req.Line, Owner: req.Owner, Repo: req.Repo})
	if err != nil {
		writeProviderError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleProviderReviewThreadResolve(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req struct {
		ProjectID  string `json:"projectId"`
		WorktreeID string `json:"worktreeId"`
		Number     int    `json:"number"`
		ThreadID   string `json:"threadId"`
		Resolved   bool   `json:"resolved"`
		Provider   string `json:"provider"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	result, err := s.manager.ResolveHostedReviewThread(r.Context(), req.ProjectID, req.WorktreeID, providercli.ResolveReviewThreadRequest{Provider: req.Provider, Number: req.Number, ThreadID: req.ThreadID, Resolved: req.Resolved})
	if err != nil {
		writeProviderError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleProviderReviewFileViewed(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req struct {
		ProjectID     string `json:"projectId"`
		WorktreeID    string `json:"worktreeId"`
		PullRequestID string `json:"pullRequestId"`
		Path          string `json:"path"`
		Viewed        bool   `json:"viewed"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	result, err := s.manager.SetHostedReviewFileViewed(r.Context(), req.ProjectID, req.WorktreeID, providercli.SetReviewFileViewedRequest{PullRequestID: req.PullRequestID, Path: req.Path, Viewed: req.Viewed})
	if err != nil {
		writeProviderError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleProviderReviewCapabilities(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	projectID, worktreeID := providerSelector(r)
	capabilities, err := s.manager.HostedReviewCapabilities(r.Context(), projectID, worktreeID)
	if err != nil {
		writeProviderError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, capabilities)
}

func providerSelector(r *http.Request) (string, string) {
	return r.URL.Query().Get("projectId"), r.URL.Query().Get("worktreeId")
}

func providerIntQuery(r *http.Request, key string, fallback int) int {
	raw := r.URL.Query().Get(key)
	if raw == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(raw)
	if err != nil {
		return fallback
	}
	return parsed
}

func providerBoolQuery(r *http.Request, key string) bool {
	value, err := strconv.ParseBool(r.URL.Query().Get(key))
	return err == nil && value
}

// writeProviderError maps CLI/selector failures to stable statuses so the TS
// bridge can distinguish "cli missing" and "not authenticated" from a generic
// load failure, matching the surfaces Electron produces.
func writeProviderError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, providercli.ErrCLIMissing):
		writeError(w, http.StatusNotImplemented, err.Error())
	case errors.Is(err, providercli.ErrCLIUnauthenticated),
		errors.Is(err, providerrest.ErrUnauthenticated):
		writeError(w, http.StatusUnauthorized, err.Error())
	case errors.Is(err, providerrest.ErrRemoteMismatch),
		errors.Is(err, providerrest.ErrProviderUnsupported):
		writeError(w, http.StatusBadRequest, err.Error())
	case errors.Is(err, runtimecore.ErrNotFound):
		writeError(w, http.StatusNotFound, err.Error())
	case errors.Is(err, runtimecore.ErrRemoteNeedsRelay):
		writeError(w, http.StatusConflict, err.Error())
	default:
		writeError(w, http.StatusBadGateway, err.Error())
	}
}
