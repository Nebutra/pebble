// Package providerrest lists review work items (pull requests) for git
// providers that have no bundled CLI path — Bitbucket Cloud, Azure DevOps, and
// Gitea/Forgejo — by calling their REST APIs directly. Auth and base-URL
// configuration mirrors Electron's clients field-for-field: the same PEBBLE_*
// environment variables read by migration/electron-reference/src/main/bitbucket/client.ts,
// migration/electron-reference/src/main/azure-devops/azure-devops-api-request.ts, and
// migration/electron-reference/src/main/gitea/client.ts configure tokens and endpoint overrides.
package providerrest

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"
)

// ReviewWorkItem is the provider-neutral row shape for REST-backed providers.
// It mirrors providercli.GitHubWorkItem / GitLabWorkItem field-for-field so the
// renderer's review pickers can treat all providers uniformly.
type ReviewWorkItem struct {
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
	// IsCrossRepository is true when the PR's head branch lives in a different
	// repo (fork) than the base repo. Pointer + omitempty so "unknown" stays
	// absent instead of falsely reporting false, matching providercli.
	IsCrossRepository *bool `json:"isCrossRepository,omitempty"`
}

// ErrRemoteMismatch signals the repo's primary git remote does not belong to
// the requested provider, so no REST endpoint can be derived. A typed error
// (not an empty list) so callers surface "wrong provider" instead of "no PRs".
var ErrRemoteMismatch = errors.New("repository remote does not match the requested provider")

// ErrUnauthenticated signals the provider API rejected the request (401/403).
// The message names the PEBBLE_* env vars so users know how Electron-parity
// credentials are supplied to the local runtime.
var ErrUnauthenticated = errors.New("provider api rejected the request as unauthenticated")

// ErrProviderUnsupported signals a provider name outside the REST-backed set.
var ErrProviderUnsupported = errors.New("review provider is not supported")

// requestTimeout mirrors REQUEST_TIMEOUT_MS in the Electron clients.
const requestTimeout = 5 * time.Second

// writeRequestTimeout mirrors CREATE_REQUEST_TIMEOUT_MS in Electron's
// azure-devops/gitea pull-request-creation.ts: mutating calls get a longer
// budget than reads since PR creation can trigger provider-side webhooks.
const writeRequestTimeout = 60 * time.Second

const maxResponseBytes = 8 << 20

// CreateReviewInput mirrors providercli.CreateReviewRequest field-for-field so
// the runtimecore dispatch layer can pass the same request shape to either the
// CLI-backed or REST-backed provider path.
type CreateReviewInput struct {
	Base        string
	Head        string
	Title       string
	Body        string
	Draft       bool
	UseTemplate bool
}

// CreateReviewOutput mirrors providercli.CreateReviewResult field-for-field.
type CreateReviewOutput struct {
	OK             bool
	Number         int
	URL            string
	Code           string
	Error          string
	ExistingReview *ReviewSummary
}

// ReviewSummary mirrors providercli.ReviewSummary.
type ReviewSummary struct {
	Number int
	URL    string
}

// UpdateReviewInput mirrors providercli.UpdateReviewRequest field-for-field
// (minus Provider/Number, which the runtimecore dispatch layer already
// consumes before calling into this package).
type UpdateReviewInput struct {
	Title           *string
	Body            *string
	State           string // "open" | "closed"
	AddReviewers    []string
	RemoveReviewers []string
}

// UpdateReviewOutput mirrors providercli.UpdateReviewResult.
type UpdateReviewOutput struct {
	OK    bool
	Code  string
	Error string
}

func envValue(name string) string {
	return strings.TrimSpace(os.Getenv(name))
}

// fetchProviderJSON GETs rawURL and decodes the JSON body into out. 401/403
// map to ErrUnauthenticated with credentialHint appended so each provider can
// name its PEBBLE_* env vars.
func fetchProviderJSON(
	ctx context.Context,
	client *http.Client,
	rawURL string,
	headers map[string]string,
	credentialHint string,
	out interface{},
) error {
	if client == nil {
		client = http.DefaultClient
	}
	reqCtx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, rawURL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return fmt.Errorf("%w (HTTP %d): %s", ErrUnauthenticated, resp.StatusCode, credentialHint)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("provider api returned HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes))
	if err != nil {
		return err
	}
	if err := json.Unmarshal(body, out); err != nil {
		return fmt.Errorf("parse provider api response: %w", err)
	}
	return nil
}

// mutateProviderJSON sends method with an optional JSON body to rawURL and
// decodes the JSON response into out (when out is non-nil; some update calls
// return no useful body). Shared by Create*/Update* across all three
// REST-backed providers so auth/timeout/error-classification stays uniform.
func mutateProviderJSON(
	ctx context.Context,
	client *http.Client,
	method string,
	rawURL string,
	headers map[string]string,
	credentialHint string,
	requestBody interface{},
	out interface{},
) (int, error) {
	if client == nil {
		client = http.DefaultClient
	}
	reqCtx, cancel := context.WithTimeout(ctx, writeRequestTimeout)
	defer cancel()
	var reader io.Reader
	if requestBody != nil {
		encoded, err := json.Marshal(requestBody)
		if err != nil {
			return 0, fmt.Errorf("encode provider api request: %w", err)
		}
		reader = bytes.NewReader(encoded)
	}
	req, err := http.NewRequestWithContext(reqCtx, method, rawURL, reader)
	if err != nil {
		return 0, err
	}
	req.Header.Set("Accept", "application/json")
	if requestBody != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	resp, err := client.Do(req)
	if err != nil {
		if reqCtx.Err() != nil {
			return 0, fmt.Errorf("%w: %w", ErrRequestTimedOut, err)
		}
		return 0, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes))
	if err != nil {
		return resp.StatusCode, err
	}
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return resp.StatusCode, fmt.Errorf("%w (HTTP %d): %s", ErrUnauthenticated, resp.StatusCode, credentialHint)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return resp.StatusCode, fmt.Errorf("%w: HTTP %d: %s", ErrProviderRequestFailed, resp.StatusCode, strings.TrimSpace(string(body)))
	}
	if out != nil && len(bytes.TrimSpace(body)) > 0 {
		if err := json.Unmarshal(body, out); err != nil {
			return resp.StatusCode, fmt.Errorf("parse provider api response: %w", err)
		}
	}
	return resp.StatusCode, nil
}

// ErrRequestTimedOut signals the write request's context deadline elapsed
// before the provider responded, mirroring HostedReviewApiRequestError.timedOut
// in Electron's create-review classifiers ("may have completed" outcome).
var ErrRequestTimedOut = errors.New("provider api request timed out")

// ErrProviderRequestFailed signals a non-2xx, non-auth response from a
// mutating provider API call; the message carries the HTTP status and body
// so callers can classify validation/conflict failures.
var ErrProviderRequestFailed = errors.New("provider api request failed")

// urlSchemePattern distinguishes scheme-ful remotes from scp-like remotes,
// mirroring the /^[a-z][a-z0-9+.-]*:\/\//i checks in the Electron repo-ref parsers.
var urlSchemePattern = regexp.MustCompile(`(?i)^[a-z][a-z0-9+.-]*://`)

// classifyReviewWriteError mirrors classifyCreateError in Electron's
// azure-devops/gitea pull-request-creation.ts: auth first, then
// already-exists, then timeout, then validation, else unknown. shortLabel is
// "PR" for all three REST-backed providers (none of them use "MR" naming).
func classifyReviewWriteError(action string, provider string, err error) (code string, message string) {
	lower := strings.ToLower(err.Error())
	if errors.Is(err, ErrUnauthenticated) {
		return "auth_required", fmt.Sprintf(
			"%s PR failed: %s is not authenticated.", action, provider,
		)
	}
	if strings.Contains(lower, "already exists") || strings.Contains(lower, "active pull request") ||
		strings.Contains(lower, "already open") {
		return "already_exists", "A pull request already exists for this branch."
	}
	if errors.Is(err, ErrRequestTimedOut) || errors.Is(err, context.DeadlineExceeded) {
		return "unknown_completion", "PR creation may have completed. Refreshing branch review state..."
	}
	if strings.Contains(lower, "http 400") || strings.Contains(lower, "http 422") || strings.Contains(lower, "validation") {
		return "validation", fmt.Sprintf(
			"%s PR failed: %s rejected the pull request. Check the base branch and branch state, then try again.",
			action, provider,
		)
	}
	return "unknown", fmt.Sprintf("%s PR failed: %s could not complete the request: %v", action, provider, err)
}

func nullableString(value string) *string {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return &value
}
