package providercli

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

const providerRateLimitCacheTTL = 30 * time.Second
const gitLabRateLimitCacheMaxEntries = 64

var githubRateLimitCache struct {
	sync.Mutex
	snapshot *GitHubRateLimitSnapshot
}

var gitlabRateLimitCache struct {
	sync.Mutex
	snapshots map[string]GitLabRateLimitSnapshot
}

type githubRateLimitPayload struct {
	Resources struct {
		Core    *githubRateLimitBucketPayload `json:"core"`
		Search  *githubRateLimitBucketPayload `json:"search"`
		GraphQL *githubRateLimitBucketPayload `json:"graphql"`
	} `json:"resources"`
}

type githubRateLimitBucketPayload struct {
	Limit     int64 `json:"limit"`
	Remaining int64 `json:"remaining"`
	Reset     int64 `json:"reset"`
}

func GetGitHubRateLimit(ctx context.Context, force bool) GitHubRateLimitResult {
	githubRateLimitCache.Lock()
	defer githubRateLimitCache.Unlock()
	now := time.Now()
	if !force && githubRateLimitCache.snapshot != nil && now.Sub(time.UnixMilli(githubRateLimitCache.snapshot.FetchedAt)) < providerRateLimitCacheTTL {
		return GitHubRateLimitResult{OK: true, Snapshot: githubRateLimitCache.snapshot}
	}
	raw, err := runCLI(ctx, "gh", "", "api", "rate_limit")
	if err != nil {
		return GitHubRateLimitResult{Error: err.Error()}
	}
	var payload githubRateLimitPayload
	if err := json.Unmarshal(raw, &payload); err != nil {
		return GitHubRateLimitResult{Error: err.Error()}
	}
	fallbackReset := now.Unix()
	snapshot := GitHubRateLimitSnapshot{
		Core:      mapGitHubRateLimitBucket(payload.Resources.Core, fallbackReset),
		Search:    mapGitHubRateLimitBucket(payload.Resources.Search, fallbackReset),
		GraphQL:   mapGitHubRateLimitBucket(payload.Resources.GraphQL, fallbackReset),
		FetchedAt: now.UnixMilli(),
	}
	githubRateLimitCache.snapshot = &snapshot
	return GitHubRateLimitResult{OK: true, Snapshot: &snapshot}
}

func mapGitHubRateLimitBucket(raw *githubRateLimitBucketPayload, fallbackReset int64) GitHubRateLimitBucket {
	if raw == nil {
		return GitHubRateLimitBucket{ResetAt: fallbackReset}
	}
	return GitHubRateLimitBucket{Limit: raw.Limit, Remaining: raw.Remaining, ResetAt: raw.Reset}
}

func GetGitLabRateLimit(ctx context.Context, force bool, host string) GitLabRateLimitResult {
	host = strings.TrimSpace(host)
	cacheKey := host
	if cacheKey == "" {
		cacheKey = "default"
	}
	gitlabRateLimitCache.Lock()
	defer gitlabRateLimitCache.Unlock()
	if gitlabRateLimitCache.snapshots == nil {
		gitlabRateLimitCache.snapshots = make(map[string]GitLabRateLimitSnapshot)
	}
	now := time.Now()
	pruneGitLabRateLimitCache(now)
	if cached, ok := gitlabRateLimitCache.snapshots[cacheKey]; !force && ok && now.Sub(time.UnixMilli(cached.FetchedAt)) < providerRateLimitCacheTTL {
		return GitLabRateLimitResult{OK: true, Snapshot: &cached}
	}
	args := []string{"api", "-i"}
	if host != "" {
		args = append(args, "--hostname", host)
	}
	args = append(args, "user")
	raw, err := runCLI(ctx, "glab", "", args...)
	if err != nil {
		return GitLabRateLimitResult{Error: err.Error()}
	}
	snapshot := parseGitLabRateLimitSnapshot(raw, host, now.UnixMilli())
	rememberGitLabRateLimitSnapshot(cacheKey, snapshot, now)
	return GitLabRateLimitResult{OK: true, Snapshot: &snapshot}
}

func parseGitLabRateLimitSnapshot(raw []byte, host string, fetchedAt int64) GitLabRateLimitSnapshot {
	headers := parseFinalHTTPHeaders(string(raw))
	limit, hasLimit := parseHeaderInt(headers, "ratelimit-limit", "x-ratelimit-limit")
	remaining, hasRemaining := parseHeaderInt(headers, "ratelimit-remaining", "x-ratelimit-remaining")
	resetAt, hasReset := parseGitLabReset(headers)
	var hostValue *string
	if host != "" {
		hostCopy := host
		hostValue = &hostCopy
	}
	snapshot := GitLabRateLimitSnapshot{Host: hostValue, FetchedAt: fetchedAt}
	if hasLimit || hasRemaining || hasReset {
		snapshot.Rest = &GitLabRateLimitBucket{Limit: limit, Remaining: remaining, ResetAt: resetAt}
	}
	return snapshot
}

func parseFinalHTTPHeaders(raw string) map[string]string {
	headers := make(map[string]string)
	current := make(map[string]string)
	inHeaders := false
	for _, line := range strings.Split(strings.ReplaceAll(raw, "\r\n", "\n"), "\n") {
		if strings.HasPrefix(line, "HTTP/") {
			current = make(map[string]string)
			inHeaders = true
			continue
		}
		if !inHeaders {
			continue
		}
		if line == "" {
			headers = current
			inHeaders = false
			continue
		}
		if key, value, ok := strings.Cut(line, ":"); ok {
			current[strings.ToLower(strings.TrimSpace(key))] = strings.TrimSpace(value)
		}
	}
	if inHeaders {
		headers = current
	}
	return headers
}

func parseHeaderInt(headers map[string]string, keys ...string) (int64, bool) {
	for _, key := range keys {
		value, ok := headers[key]
		if !ok {
			continue
		}
		parsed, err := strconv.ParseInt(value, 10, 64)
		if err == nil {
			return parsed, true
		}
	}
	return 0, false
}

func parseGitLabReset(headers map[string]string) (*int64, bool) {
	if value, ok := parseHeaderInt(headers, "ratelimit-reset", "x-ratelimit-reset"); ok {
		return &value, true
	}
	for _, key := range []string{"ratelimit-resettime", "x-ratelimit-resettime"} {
		if parsed, err := http.ParseTime(headers[key]); err == nil {
			value := parsed.Unix()
			return &value, true
		}
	}
	return nil, false
}

func pruneGitLabRateLimitCache(now time.Time) {
	for key, snapshot := range gitlabRateLimitCache.snapshots {
		if now.Sub(time.UnixMilli(snapshot.FetchedAt)) >= providerRateLimitCacheTTL {
			delete(gitlabRateLimitCache.snapshots, key)
		}
	}
}

func rememberGitLabRateLimitSnapshot(key string, snapshot GitLabRateLimitSnapshot, now time.Time) {
	pruneGitLabRateLimitCache(now)
	if len(gitlabRateLimitCache.snapshots) >= gitLabRateLimitCacheMaxEntries {
		oldestKey := ""
		oldestAt := int64(^uint64(0) >> 1)
		for candidate, value := range gitlabRateLimitCache.snapshots {
			if value.FetchedAt < oldestAt {
				oldestKey, oldestAt = candidate, value.FetchedAt
			}
		}
		delete(gitlabRateLimitCache.snapshots, oldestKey)
	}
	gitlabRateLimitCache.snapshots[key] = snapshot
}
