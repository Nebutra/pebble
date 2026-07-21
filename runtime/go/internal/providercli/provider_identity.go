package providercli

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"regexp"
	"strings"
)

var githubAuthHostPattern = regexp.MustCompile(`(?i)^([a-z0-9][a-z0-9.-]*)\s*:?\s*$`)
var githubAuthLoginPattern = regexp.MustCompile(`(?i)Logged in to (\S+) account (\S+)(?:\s+\(([^)]+)\))?`)
var githubAuthActivePattern = regexp.MustCompile(`(?i)Active account:\s*(true|false)`)
var githubAuthScopesPattern = regexp.MustCompile(`(?i)Token scopes:\s*(.+)$`)
var gitlabHostPattern = regexp.MustCompile(`(?i)(?:^|\s)([a-z0-9][a-z0-9.-]*\.[a-z]{2,}|localhost)(?:\s|$|:)`)
var gitlabAuthenticatedPattern = regexp.MustCompile(`(?i)logged in|authenticated|token`)
var gitlabUnauthenticatedPattern = regexp.MustCompile(`(?i)not logged in|not authenticated|has not been authenticated`)

func GetGitHubViewer(ctx context.Context) *GitHubViewer {
	raw, err := runCLI(ctx, "gh", "", "api", "user", "--jq", "{login: .login, email: .email}")
	if err != nil {
		return nil
	}
	var payload struct {
		Login string  `json:"login"`
		Email *string `json:"email"`
	}
	if json.Unmarshal(raw, &payload) != nil || strings.TrimSpace(payload.Login) == "" {
		return nil
	}
	login := strings.TrimSpace(payload.Login)
	return &GitHubViewer{Login: login, Email: trimOptionalString(payload.Email)}
}

func DiagnoseGitHubAuth(ctx context.Context) GitHubAuthDiagnostic {
	stdout, stderr, err := runCLICapture(ctx, "gh", "", "auth", "status")
	available := !errors.Is(err, ErrCLIMissing)
	raw := strings.TrimSpace(string(stdout) + "\n" + string(stderr))
	accounts := parseGitHubAuthAccounts(raw)
	var active *GitHubAuthAccount
	for index := range accounts {
		if accounts[index].Active {
			active = &accounts[index]
			break
		}
	}
	if active == nil && len(accounts) > 0 {
		active = &accounts[0]
	}
	required := []string{"project", "read:org", "repo"}
	missing := append([]string(nil), required...)
	if active != nil {
		missing = missingScopes(active.Scopes, required)
	}
	hasFallback := false
	if active != nil {
		for index := range accounts {
			candidate := &accounts[index]
			if candidate != active && candidate.Source == "keyring" && candidate.Host == active.Host {
				hasFallback = true
				break
			}
		}
	}
	return GitHubAuthDiagnostic{
		GHAvailable: available, ActiveAccount: active, Accounts: accounts,
		EnvTokenInProcess: githubEnvToken(), MissingScopes: missing,
		RequiredScopes: required, HasKeyringFallback: hasFallback,
	}
}

func parseGitHubAuthAccounts(raw string) []GitHubAuthAccount {
	accounts := make([]GitHubAuthAccount, 0)
	currentHost := ""
	var current *GitHubAuthAccount
	flush := func() {
		if current != nil {
			accounts = append(accounts, *current)
			current = nil
		}
	}
	for _, rawLine := range strings.Split(strings.ReplaceAll(raw, "\r\n", "\n"), "\n") {
		line := strings.TrimSuffix(rawLine, "\r")
		if match := githubAuthHostPattern.FindStringSubmatch(line); match != nil && !strings.HasPrefix(strings.ToLower(line), "logged") {
			currentHost = match[1]
			continue
		}
		if match := githubAuthLoginPattern.FindStringSubmatch(line); match != nil {
			flush()
			host := match[1]
			if host == "" {
				host = currentHost
			}
			source, envToken := "keyring", (*string)(nil)
			if match[3] == "GITHUB_TOKEN" || match[3] == "GH_TOKEN" {
				source = "env"
				value := match[3]
				envToken = &value
			}
			current = &GitHubAuthAccount{Host: host, User: match[2], Source: source, EnvToken: envToken, Scopes: []string{}}
			continue
		}
		if current == nil {
			continue
		}
		if match := githubAuthActivePattern.FindStringSubmatch(line); match != nil {
			current.Active = strings.EqualFold(match[1], "true")
		}
		if match := githubAuthScopesPattern.FindStringSubmatch(line); match != nil {
			current.Scopes = splitAuthScopes(match[1])
		}
	}
	flush()
	return accounts
}

func GetGitLabViewer(ctx context.Context) *GitLabViewer {
	raw, err := runCLI(ctx, "glab", "", "api", "user")
	if err != nil {
		return nil
	}
	var payload struct {
		Username string  `json:"username"`
		Email    *string `json:"email"`
	}
	if json.Unmarshal(raw, &payload) != nil || strings.TrimSpace(payload.Username) == "" {
		return nil
	}
	return &GitLabViewer{Username: strings.TrimSpace(payload.Username), Email: trimOptionalString(payload.Email)}
}

func DiagnoseGitLabAuth(ctx context.Context) GitLabAuthDiagnostic {
	stdout, stderr, err := runCLICapture(ctx, "glab", "", "auth", "status")
	available := !errors.Is(err, ErrCLIMissing)
	raw := strings.TrimSpace(string(stdout) + "\n" + string(stderr))
	hosts := parseGitLabAuthHosts(raw)
	authenticated := available && gitlabAuthenticatedPattern.MatchString(raw) && !gitlabUnauthenticatedPattern.MatchString(raw)
	var activeHost *string
	if len(hosts) > 0 {
		activeHost = &hosts[0]
	}
	var errorValue *string
	if err != nil {
		message := strings.TrimSpace(raw)
		if message == "" {
			message = err.Error()
		}
		errorValue = &message
	}
	return GitLabAuthDiagnostic{
		GlabAvailable: available, Authenticated: authenticated, Hosts: hosts,
		ActiveHost: activeHost, EnvTokenInProcess: gitlabEnvToken(), Error: errorValue,
	}
}

func parseGitLabAuthHosts(raw string) []string {
	seen := make(map[string]struct{})
	hosts := make([]string, 0)
	for _, match := range gitlabHostPattern.FindAllStringSubmatch(raw, -1) {
		host := strings.TrimSuffix(strings.ToLower(match[1]), ":")
		if _, ok := seen[host]; !ok {
			seen[host] = struct{}{}
			hosts = append(hosts, host)
		}
	}
	return hosts
}

func splitAuthScopes(raw string) []string {
	parts := strings.Split(raw, ",")
	result := make([]string, 0, len(parts))
	for _, part := range parts {
		value := strings.Trim(strings.TrimSpace(part), `'"`)
		if value != "" {
			result = append(result, value)
		}
	}
	return result
}

func missingScopes(actual, required []string) []string {
	set := make(map[string]struct{}, len(actual))
	for _, scope := range actual {
		set[scope] = struct{}{}
	}
	result := make([]string, 0)
	for _, scope := range required {
		if _, ok := set[scope]; !ok {
			result = append(result, scope)
		}
	}
	return result
}

func trimOptionalString(value *string) *string {
	if value == nil || strings.TrimSpace(*value) == "" {
		return nil
	}
	trimmed := strings.TrimSpace(*value)
	return &trimmed
}

func githubEnvToken() *string {
	if os.Getenv("GH_TOKEN") != "" {
		value := "GH_TOKEN"
		return &value
	}
	if os.Getenv("GITHUB_TOKEN") != "" {
		value := "GITHUB_TOKEN"
		return &value
	}
	return nil
}

func gitlabEnvToken() *string {
	if os.Getenv("GITLAB_TOKEN") != "" {
		value := "GITLAB_TOKEN"
		return &value
	}
	if os.Getenv("GLAB_TOKEN") != "" {
		value := "GLAB_TOKEN"
		return &value
	}
	return nil
}
