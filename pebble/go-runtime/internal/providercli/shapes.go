// Package providercli runs the gh / glab CLIs locally and maps their JSON
// output into the exact renderer-facing shapes (GitHubWorkItem, PRCheckDetail,
// GitLabWorkItem, GitLabPipelineJob). These mirror src/shared/types.ts and
// src/shared/gitlab-types.ts field-for-field so the desktop app's provider
// flows work against the local runtime without pairing a remote environment.
package providercli

// GitHubWorkItem mirrors src/shared/types.ts GitHubWorkItem (repoId is stamped
// by the renderer, so it is omitted here). Only the fields the list/detail CLI
// paths can populate faithfully are emitted; optional GraphQL-only fields stay
// absent rather than guessed.
type GitHubWorkItem struct {
	ID          string   `json:"id"`
	Type        string   `json:"type"`
	Number      int      `json:"number"`
	Title       string   `json:"title"`
	State       string   `json:"state"`
	URL         string   `json:"url"`
	Labels      []string `json:"labels"`
	UpdatedAt   string   `json:"updatedAt"`
	Author      *string  `json:"author"`
	BranchName  string   `json:"branchName,omitempty"`
	BaseRefName string   `json:"baseRefName,omitempty"`
	HeadSha     string   `json:"headSha,omitempty"`
}

// PRCheckDetail mirrors src/shared/types.ts PRCheckDetail. Status and conclusion
// use the same enum spaces the renderer's check pills expect.
type PRCheckDetail struct {
	Name       string  `json:"name"`
	Status     string  `json:"status"`
	Conclusion *string `json:"conclusion"`
	URL        *string `json:"url"`
}

// GitLabWorkItem mirrors src/shared/gitlab-types.ts GitLabWorkItem (repoId is
// stamped by the renderer, so it is omitted here).
type GitLabWorkItem struct {
	ID          string   `json:"id"`
	Type        string   `json:"type"`
	Number      int      `json:"number"`
	Title       string   `json:"title"`
	State       string   `json:"state"`
	URL         string   `json:"url"`
	Labels      []string `json:"labels"`
	UpdatedAt   string   `json:"updatedAt"`
	Author      *string  `json:"author"`
	BranchName  string   `json:"branchName,omitempty"`
	BaseRefName string   `json:"baseRefName,omitempty"`
}

// GitLabPipelineJob mirrors src/shared/gitlab-types.ts GitLabPipelineJob.
type GitLabPipelineJob struct {
	ID       int      `json:"id"`
	Name     string   `json:"name"`
	Stage    string   `json:"stage"`
	Status   string   `json:"status"`
	WebURL   string   `json:"webUrl"`
	Duration *float64 `json:"duration"`
}
