package runtimecore

import (
	"context"
	"errors"
	"net/url"
	"strings"
	"unicode"
)

type hostedRemoteProvider string

const (
	hostedRemoteGitHub    hostedRemoteProvider = "github"
	hostedRemoteGitLab    hostedRemoteProvider = "gitlab"
	hostedRemoteBitbucket hostedRemoteProvider = "bitbucket"
)

type hostedRemote struct {
	Host     string
	Path     string
	Provider hostedRemoteProvider
}

func readPrimaryGitRemoteURL(ctx context.Context, repoPath string) (string, error) {
	if remoteURL, err := readGitOutput(ctx, repoPath, "remote", "get-url", "origin"); err == nil && remoteURL != "" {
		return remoteURL, nil
	}
	remotes, err := readGitOutputRaw(ctx, repoPath, "remote")
	if err != nil {
		return "", err
	}
	for _, remote := range strings.Fields(remotes) {
		if remoteURL, err := readGitOutput(ctx, repoPath, "remote", "get-url", remote); err == nil && remoteURL != "" {
			return remoteURL, nil
		}
	}
	return "", errors.New("git remote is not configured")
}

func buildHostedRemoteFileURL(remoteURL string, relativePath string, branch string, line int) string {
	remote, ok := parseHostedRemote(remoteURL)
	if !ok {
		return ""
	}
	encodedRepoPath := encodeRemotePath(remote.Path)
	encodedBranch := url.PathEscape(branch)
	encodedFilePath := encodeRemotePath(relativePath)
	filePathSuffix := ""
	if encodedFilePath != "" {
		filePathSuffix = "/" + encodedFilePath
	}
	baseURL := "https://" + remote.Host + "/" + encodedRepoPath
	if remote.Provider == hostedRemoteGitHub {
		return baseURL + "/blob/" + encodedBranch + filePathSuffix + "#L" + stringFromPositiveInt(line)
	}
	if remote.Provider == hostedRemoteGitLab {
		return baseURL + "/-/blob/" + encodedBranch + filePathSuffix + "#L" + stringFromPositiveInt(line)
	}
	return baseURL + "/src/" + encodedBranch + filePathSuffix + bitbucketLineFragment(relativePath, line)
}

func buildHostedRemoteCommitURL(remoteURL string, sha string) string {
	remote, ok := parseHostedRemote(remoteURL)
	if !ok {
		return ""
	}
	baseURL := "https://" + remote.Host + "/" + encodeRemotePath(remote.Path)
	encodedSHA := url.PathEscape(strings.TrimSpace(sha))
	if remote.Provider == hostedRemoteGitLab {
		return baseURL + "/-/commit/" + encodedSHA
	}
	if remote.Provider == hostedRemoteBitbucket {
		return baseURL + "/commits/" + encodedSHA
	}
	return baseURL + "/commit/" + encodedSHA
}

func parseHostedRemote(remoteURL string) (hostedRemote, bool) {
	trimmed := strings.TrimPrefix(strings.TrimSpace(remoteURL), "git+")
	if shorthand := parseHostedRemoteShorthand(trimmed); shorthand != nil {
		return *shorthand, true
	}
	if scpLike := parseHostedRemoteSCPLike(trimmed); scpLike != nil {
		return *scpLike, true
	}
	parsed, err := url.Parse(trimmed)
	if err != nil {
		return hostedRemote{}, false
	}
	protocol := strings.ToLower(parsed.Scheme)
	if protocol != "git" && protocol != "http" && protocol != "https" && protocol != "ssh" {
		return hostedRemote{}, false
	}
	host, provider, ok := hostedRemoteProviderForHost(parsed.Hostname())
	if !ok {
		return hostedRemote{}, false
	}
	path, ok := cleanHostedRemotePath(parsed.Path)
	if !ok {
		return hostedRemote{}, false
	}
	return hostedRemote{Host: host, Path: path, Provider: provider}, true
}

func parseHostedRemoteShorthand(remoteURL string) *hostedRemote {
	index := strings.Index(remoteURL, ":")
	if index <= 0 || strings.Contains(remoteURL[:index], "/") {
		return nil
	}
	host, provider, ok := hostedRemoteShorthandHost(remoteURL[:index])
	if !ok {
		return nil
	}
	path, ok := cleanHostedRemotePath(remoteURL[index+1:])
	if !ok {
		return nil
	}
	return &hostedRemote{Host: host, Path: path, Provider: provider}
}

func parseHostedRemoteSCPLike(remoteURL string) *hostedRemote {
	if strings.Contains(remoteURL, "://") || strings.ContainsAny(remoteURL, " \t\r\n") {
		return nil
	}
	index := strings.Index(remoteURL, ":")
	if index <= 0 {
		return nil
	}
	hostPart := remoteURL[:index]
	if at := strings.LastIndex(hostPart, "@"); at >= 0 {
		hostPart = hostPart[at+1:]
	}
	if strings.Contains(hostPart, "/") {
		return nil
	}
	host, provider, ok := hostedRemoteProviderForHost(hostPart)
	if !ok {
		return nil
	}
	path, ok := cleanHostedRemotePath(remoteURL[index+1:])
	if !ok {
		return nil
	}
	return &hostedRemote{Host: host, Path: path, Provider: provider}
}

func hostedRemoteShorthandHost(value string) (string, hostedRemoteProvider, bool) {
	switch strings.ToLower(value) {
	case "github":
		return "github.com", hostedRemoteGitHub, true
	case "gitlab":
		return "gitlab.com", hostedRemoteGitLab, true
	case "bitbucket":
		return "bitbucket.org", hostedRemoteBitbucket, true
	default:
		return "", "", false
	}
}

func hostedRemoteProviderForHost(value string) (string, hostedRemoteProvider, bool) {
	switch strings.ToLower(value) {
	case "github.com", "ssh.github.com":
		return "github.com", hostedRemoteGitHub, true
	case "gitlab.com":
		return "gitlab.com", hostedRemoteGitLab, true
	case "bitbucket.org":
		return "bitbucket.org", hostedRemoteBitbucket, true
	default:
		return "", "", false
	}
}

func cleanHostedRemotePath(path string) (string, bool) {
	normalized := strings.Trim(strings.TrimSuffix(strings.Trim(path, "/"), ".git"), "/")
	parts := strings.Split(normalized, "/")
	cleanParts := make([]string, 0, len(parts))
	for _, part := range parts {
		if part == "" {
			continue
		}
		if decoded, err := url.PathUnescape(part); err == nil {
			part = decoded
		}
		cleanParts = append(cleanParts, part)
	}
	if len(cleanParts) < 2 {
		return "", false
	}
	return strings.Join(cleanParts, "/"), true
}

func encodeRemotePath(path string) string {
	parts := strings.Split(strings.ReplaceAll(path, "\\", "/"), "/")
	encoded := make([]string, 0, len(parts))
	for _, part := range parts {
		if part != "" {
			encoded = append(encoded, url.PathEscape(part))
		}
	}
	return strings.Join(encoded, "/")
}

func bitbucketLineFragment(path string, line int) string {
	parts := strings.Split(strings.ReplaceAll(path, "\\", "/"), "/")
	name := ""
	for i := len(parts) - 1; i >= 0; i-- {
		if parts[i] != "" {
			name = parts[i]
			break
		}
	}
	if name == "" {
		return ""
	}
	return "#" + url.QueryEscape(name+"-"+stringFromPositiveInt(line))
}

func nullableGitURL(value string) GitRemoteURLResult {
	if strings.TrimSpace(value) == "" {
		return GitRemoteURLResult{URL: nil}
	}
	return GitRemoteURLResult{URL: &value}
}

func readGitHubRemoteIdentity(ctx context.Context, repoPath string, remoteName string) *GitHubRepositoryIdentity {
	remoteURL, err := readGitOutput(ctx, repoPath, "remote", "get-url", remoteName)
	if err != nil || remoteURL == "" {
		return nil
	}
	remote, ok := parseHostedRemote(remoteURL)
	if !ok || remote.Provider != hostedRemoteGitHub {
		return nil
	}
	parts := strings.Split(remote.Path, "/")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return nil
	}
	return &GitHubRepositoryIdentity{Owner: parts[0], Repo: parts[1]}
}

func sameGitHubRepositoryIdentity(left *GitHubRepositoryIdentity, right *GitHubRepositoryIdentity) bool {
	if left == nil || right == nil {
		return false
	}
	return strings.EqualFold(left.Owner, right.Owner) && strings.EqualFold(left.Repo, right.Repo)
}

func isFullGitObjectID(value string) bool {
	if len(value) != 40 {
		return false
	}
	for _, r := range value {
		if !unicode.IsDigit(r) && (r < 'a' || r > 'f') && (r < 'A' || r > 'F') {
			return false
		}
	}
	return true
}
