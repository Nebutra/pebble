package providercli

import (
	"bytes"
	"context"
	"fmt"
	"net/url"
	"strings"
)

const githubRawContentMaxBytes = 8 * 1024 * 1024

type GitHubPRFileContentsRequest struct {
	Path    string `json:"path"`
	OldPath string `json:"oldPath,omitempty"`
	Status  string `json:"status"`
	HeadSHA string `json:"headSha"`
	BaseSHA string `json:"baseSha"`
}

type GitHubPRFileContents struct {
	Original         string `json:"original"`
	Modified         string `json:"modified"`
	OriginalIsBinary bool   `json:"originalIsBinary"`
	ModifiedIsBinary bool   `json:"modifiedIsBinary"`
	OriginalTooLarge bool   `json:"originalTooLarge,omitempty"`
	ModifiedTooLarge bool   `json:"modifiedTooLarge,omitempty"`
}

func GetGitHubPRFileContents(ctx context.Context, workdir, preference string, input GitHubPRFileContentsRequest) GitHubPRFileContents {
	sources, err := ResolveGitHubWorkItemSources(ctx, workdir, preference)
	if err != nil || sources.PRs == nil {
		return GitHubPRFileContents{}
	}
	result := GitHubPRFileContents{}
	if input.Status != "added" {
		path := input.OldPath
		if path == "" {
			path = input.Path
		}
		result.Original, result.OriginalIsBinary, result.OriginalTooLarge = readGitHubRawContent(ctx, workdir, *sources.PRs, path, input.BaseSHA)
	}
	if input.Status != "removed" {
		result.Modified, result.ModifiedIsBinary, result.ModifiedTooLarge = readGitHubRawContent(ctx, workdir, *sources.PRs, input.Path, input.HeadSHA)
	}
	return result
}

func readGitHubRawContent(ctx context.Context, workdir string, source GitHubOwnerRepo, path, ref string) (string, bool, bool) {
	if strings.TrimSpace(path) == "" || strings.TrimSpace(ref) == "" {
		return "", false, false
	}
	segments := strings.Split(strings.ReplaceAll(path, "\\", "/"), "/")
	for index := range segments {
		segments[index] = url.PathEscape(segments[index])
	}
	endpoint := fmt.Sprintf("repos/%s/%s/contents/%s?ref=%s", source.Owner, source.Repo, strings.Join(segments, "/"), url.QueryEscape(ref))
	out, err := runCLI(ctx, "gh", workdir, "api", "--cache", "300s", "-H", "Accept: application/vnd.github.raw", endpoint)
	if err != nil {
		return "", false, false
	}
	if len(out) > githubRawContentMaxBytes {
		return "", false, true
	}
	sample := out
	if len(sample) > 2048 {
		sample = sample[:2048]
	}
	if bytes.IndexByte(sample, 0) >= 0 {
		return "", true, false
	}
	return string(out), false, false
}
