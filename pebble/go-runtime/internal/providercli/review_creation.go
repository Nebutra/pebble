package providercli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

type CreateReviewRequest struct {
	Provider    string `json:"provider"`
	Base        string `json:"base"`
	Head        string `json:"head,omitempty"`
	Title       string `json:"title"`
	Body        string `json:"body,omitempty"`
	Draft       bool   `json:"draft,omitempty"`
	UseTemplate bool   `json:"useTemplate,omitempty"`
}

type ReviewSummary struct {
	Number int    `json:"number"`
	URL    string `json:"url"`
}

type CreateReviewResult struct {
	OK             bool           `json:"ok"`
	Number         int            `json:"number,omitempty"`
	URL            string         `json:"url,omitempty"`
	Code           string         `json:"code,omitempty"`
	Error          string         `json:"error,omitempty"`
	ExistingReview *ReviewSummary `json:"existingReview,omitempty"`
}

var githubPullURLPattern = regexp.MustCompile(`https://github\.com/[^/\s]+/[^/\s]+/pull/(\d+)`)
var gitlabMergeRequestURLPattern = regexp.MustCompile(`https?://[^\s]+/-/merge_requests/(\d+)`)

func IsReviewProviderAuthenticated(ctx context.Context, workdir string, provider string, host string) bool {
	var bin string
	switch provider {
	case "github":
		bin = "gh"
	case "gitlab":
		bin = "glab"
	default:
		return false
	}
	args := []string{"auth", "status"}
	if strings.TrimSpace(host) != "" {
		args = append(args, "--hostname", strings.TrimSpace(host))
	}
	_, err := runCLI(ctx, bin, workdir, args...)
	return err == nil
}

func CreateGitHubPullRequest(ctx context.Context, workdir string, input CreateReviewRequest) CreateReviewResult {
	base, head, title, invalid := validateCreateReviewInput(input, "PR", "pull request")
	if invalid != nil {
		return *invalid
	}
	body := resolveReviewBody(workdir, input, []string{
		".github/pull_request_template.md",
		".github/PULL_REQUEST_TEMPLATE.md",
		"pull_request_template.md",
		"PULL_REQUEST_TEMPLATE.md",
		"docs/pull_request_template.md",
		"docs/PULL_REQUEST_TEMPLATE.md",
	})
	bodyFile, err := os.CreateTemp("", "pebble-pr-body-*.md")
	if err != nil {
		return unknownCreateReviewResult("PR", "GitHub", err)
	}
	bodyPath := bodyFile.Name()
	defer os.Remove(bodyPath)
	if _, err := bodyFile.WriteString(body); err != nil {
		bodyFile.Close()
		return unknownCreateReviewResult("PR", "GitHub", err)
	}
	if err := bodyFile.Close(); err != nil {
		return unknownCreateReviewResult("PR", "GitHub", err)
	}
	args := []string{"pr", "create", "--base", base, "--title", title, "--body-file", bodyPath}
	if head != "" {
		args = append(args, "--head", head)
	}
	if input.Draft {
		args = append(args, "--draft")
	}
	out, err := runCLI(ctx, "gh", workdir, args...)
	if err == nil {
		if created := parseGitHubCreatePayload(out); created != nil {
			return CreateReviewResult{OK: true, Number: created.Number, URL: created.URL}
		}
		if existing := findGitHubReview(ctx, workdir, head, base); existing != nil {
			return CreateReviewResult{OK: true, Number: existing.Number, URL: existing.URL}
		}
		return unknownCompletionResult("PR")
	}
	result := classifyCreateReviewError("PR", "GitHub", err)
	if (result.Code == "already_exists" || result.Code == "unknown_completion") && head != "" {
		if existing := findGitHubReview(ctx, workdir, head, base); existing != nil {
			result.Code = "already_exists"
			result.ExistingReview = existing
		}
	}
	return result
}

func CreateGitLabMergeRequest(ctx context.Context, workdir string, input CreateReviewRequest) CreateReviewResult {
	base, head, title, invalid := validateCreateReviewInput(input, "MR", "merge request")
	if invalid != nil {
		return *invalid
	}
	body := resolveReviewBody(workdir, input, []string{
		".gitlab/merge_request_templates/Default.md",
		".gitlab/merge_request_templates/default.md",
		".gitlab/merge_request_template.md",
		".gitlab/MERGE_REQUEST_TEMPLATE.md",
	})
	args := []string{
		"mr", "create", "--target-branch", base, "--title", title,
		"--description", body, "--yes",
	}
	if head != "" {
		args = append(args, "--source-branch", head)
	}
	if input.Draft {
		args = append(args, "--draft")
	}
	out, err := runCLI(ctx, "glab", workdir, args...)
	if err == nil {
		if created := parseGitLabCreatePayload(out); created != nil {
			return CreateReviewResult{OK: true, Number: created.Number, URL: created.URL}
		}
		if existing := findGitLabReview(ctx, workdir, head, base); existing != nil {
			return CreateReviewResult{OK: true, Number: existing.Number, URL: existing.URL}
		}
		return unknownCompletionResult("MR")
	}
	result := classifyCreateReviewError("MR", "GitLab", err)
	if (result.Code == "already_exists" || result.Code == "unknown_completion") && head != "" {
		if existing := findGitLabReview(ctx, workdir, head, base); existing != nil {
			result.Code = "already_exists"
			result.ExistingReview = existing
		}
	}
	return result
}

func validateCreateReviewInput(
	input CreateReviewRequest,
	shortLabel string,
	reviewLabel string,
) (string, string, string, *CreateReviewResult) {
	base := normalizeBaseRef(input.Base)
	head := normalizeHeadRef(input.Head)
	title := strings.TrimSpace(input.Title)
	if base == "" || title == "" {
		result := CreateReviewResult{
			Code:  "validation",
			Error: fmt.Sprintf("Create %s failed: base branch and title are required.", shortLabel),
		}
		return "", "", "", &result
	}
	if head != "" && strings.EqualFold(head, base) {
		result := CreateReviewResult{
			Code: "validation",
			Error: fmt.Sprintf(
				"Create %s failed: choose a different base branch before creating a %s.",
				shortLabel,
				reviewLabel,
			),
		}
		return "", "", "", &result
	}
	return base, head, title, nil
}

func resolveReviewBody(workdir string, input CreateReviewRequest, candidates []string) string {
	if !input.UseTemplate || strings.TrimSpace(input.Body) != "" {
		return input.Body
	}
	for _, candidate := range candidates {
		contents, err := os.ReadFile(filepath.Join(workdir, candidate))
		if err == nil {
			return string(contents)
		}
	}
	return ""
}

func normalizeHeadRef(value string) string {
	value = strings.TrimSpace(value)
	value = strings.TrimPrefix(value, "refs/heads/")
	if strings.HasPrefix(value, "refs/remotes/") {
		parts := strings.SplitN(strings.TrimPrefix(value, "refs/remotes/"), "/", 2)
		if len(parts) == 2 {
			value = parts[1]
		}
	}
	return value
}

func normalizeBaseRef(value string) string {
	value = normalizeHeadRef(value)
	value = strings.TrimPrefix(value, "origin/")
	value = strings.TrimPrefix(value, "upstream/")
	return value
}

func parseGitHubCreatePayload(out []byte) *ReviewSummary {
	var payload struct {
		Number int    `json:"number"`
		URL    string `json:"url"`
	}
	if json.Unmarshal(out, &payload) == nil && payload.Number > 0 && strings.TrimSpace(payload.URL) != "" {
		return &ReviewSummary{Number: payload.Number, URL: strings.TrimSpace(payload.URL)}
	}
	match := githubPullURLPattern.FindSubmatch(out)
	return reviewSummaryFromURLMatch(match)
}

func parseGitLabCreatePayload(out []byte) *ReviewSummary {
	var payload struct {
		IID    int    `json:"iid"`
		Number int    `json:"number"`
		WebURL string `json:"web_url"`
		URL    string `json:"url"`
	}
	if json.Unmarshal(out, &payload) == nil {
		number := payload.IID
		if number == 0 {
			number = payload.Number
		}
		url := strings.TrimSpace(payload.WebURL)
		if url == "" {
			url = strings.TrimSpace(payload.URL)
		}
		if number > 0 && url != "" {
			return &ReviewSummary{Number: number, URL: url}
		}
	}
	match := gitlabMergeRequestURLPattern.FindSubmatch(out)
	return reviewSummaryFromURLMatch(match)
}

func reviewSummaryFromURLMatch(match [][]byte) *ReviewSummary {
	if len(match) != 2 {
		return nil
	}
	number, err := strconv.Atoi(string(match[1]))
	if err != nil || number <= 0 {
		return nil
	}
	return &ReviewSummary{Number: number, URL: string(match[0])}
}

func findGitHubReview(ctx context.Context, workdir string, head string, base string) *ReviewSummary {
	if head == "" {
		return nil
	}
	out, err := runCLI(
		ctx,
		"gh",
		workdir,
		"pr", "list", "--head", head, "--base", base, "--state", "open",
		"--limit", "2", "--json", "number,url",
	)
	if err != nil {
		return nil
	}
	var items []ReviewSummary
	if json.Unmarshal(out, &items) != nil || len(items) != 1 || items[0].Number <= 0 || items[0].URL == "" {
		return nil
	}
	return &items[0]
}

func findGitLabReview(ctx context.Context, workdir string, head string, base string) *ReviewSummary {
	if head == "" {
		return nil
	}
	out, err := runCLI(
		ctx,
		"glab",
		workdir,
		"mr", "list", "--source-branch", head, "--target-branch", base,
		"--per-page", "2", "--output", "json",
	)
	if err != nil {
		return nil
	}
	var items []json.RawMessage
	if json.Unmarshal(out, &items) != nil || len(items) != 1 {
		return nil
	}
	return parseGitLabCreatePayload(items[0])
}

func classifyCreateReviewError(shortLabel string, provider string, err error) CreateReviewResult {
	if errors.Is(err, ErrCLIMissing) {
		return CreateReviewResult{
			Code:  "unsupported_provider",
			Error: fmt.Sprintf("Create %s failed: install the %s CLI in this environment.", shortLabel, provider),
		}
	}
	if errors.Is(err, ErrCLIUnauthenticated) {
		return CreateReviewResult{
			Code:  "auth_required",
			Error: fmt.Sprintf("Create %s failed: %s is not authenticated.", shortLabel, provider),
		}
	}
	lower := strings.ToLower(err.Error())
	if strings.Contains(lower, "already exists") {
		return CreateReviewResult{Code: "already_exists", Error: fmt.Sprintf("A %s already exists for this branch.", strings.ToLower(shortLabel))}
	}
	if strings.Contains(lower, "timed out") || strings.Contains(lower, "timeout") || errors.Is(err, context.DeadlineExceeded) {
		return unknownCompletionResult(shortLabel)
	}
	if strings.Contains(lower, "validation failed") || strings.Contains(lower, "http 422") {
		return CreateReviewResult{
			Code:  "validation",
			Error: fmt.Sprintf("Create %s failed: %s rejected the review. Check the base branch and branch state, then try again.", shortLabel, provider),
		}
	}
	return unknownCreateReviewResult(shortLabel, provider, err)
}

func unknownCompletionResult(shortLabel string) CreateReviewResult {
	return CreateReviewResult{
		Code:  "unknown_completion",
		Error: fmt.Sprintf("%s creation may have completed. Refreshing branch review state...", shortLabel),
	}
}

func unknownCreateReviewResult(shortLabel string, provider string, err error) CreateReviewResult {
	return CreateReviewResult{
		Code:  "unknown",
		Error: fmt.Sprintf("Create %s failed: %s could not create the review: %v", shortLabel, provider, err),
	}
}
