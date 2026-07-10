// Package providerrest lists review work items (pull requests) for git
// providers that have no bundled CLI path — Bitbucket Cloud, Azure DevOps, and
// Gitea/Forgejo — by calling their REST APIs directly. Auth and base-URL
// configuration mirrors Electron's clients field-for-field: the same PEBBLE_*
// environment variables read by src/main/bitbucket/client.ts,
// src/main/azure-devops/azure-devops-api-request.ts, and
// src/main/gitea/client.ts configure tokens and endpoint overrides.
package providerrest

import (
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

const maxResponseBytes = 8 << 20

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

// urlSchemePattern distinguishes scheme-ful remotes from scp-like remotes,
// mirroring the /^[a-z][a-z0-9+.-]*:\/\//i checks in the Electron repo-ref parsers.
var urlSchemePattern = regexp.MustCompile(`(?i)^[a-z][a-z0-9+.-]*://`)

func nullableString(value string) *string {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return &value
}
