package providercli

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

const githubProjectRefMaxBytes = 4096

var githubProjectURLPattern = regexp.MustCompile(`(?i)^https?://github\.com/(orgs|users)/([^/]+)/projects/(\d+)(?:/views/(\d+))?`)
var githubProjectShortPattern = regexp.MustCompile(`^([A-Za-z0-9][A-Za-z0-9-]*)/(\d+)$`)
var githubOwnerPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9-]*$`)

type GitHubProjectViewError struct {
	Type    string `json:"type"`
	Message string `json:"message"`
}

type GitHubProjectRefResult struct {
	OK         bool                    `json:"ok"`
	Owner      string                  `json:"owner,omitempty"`
	OwnerType  string                  `json:"ownerType,omitempty"`
	Number     int                     `json:"number,omitempty"`
	Title      string                  `json:"title,omitempty"`
	ViewNumber int                     `json:"viewNumber,omitempty"`
	Error      *GitHubProjectViewError `json:"error,omitempty"`
}

type GitHubProjectViewSummary struct {
	ID     string `json:"id"`
	Number int    `json:"number"`
	Name   string `json:"name"`
	Layout string `json:"layout"`
}

type GitHubProjectViewsResult struct {
	OK    bool                       `json:"ok"`
	Views []GitHubProjectViewSummary `json:"views,omitempty"`
	Error *GitHubProjectViewError    `json:"error,omitempty"`
}

type GitHubProjectSummary struct {
	ID        string `json:"id"`
	Owner     string `json:"owner"`
	OwnerType string `json:"ownerType"`
	Number    int    `json:"number"`
	Title     string `json:"title"`
	URL       string `json:"url"`
	Source    string `json:"source"`
}

type GitHubProjectPartialFailure struct {
	Owner   string `json:"owner"`
	Message string `json:"message"`
}

type GitHubAccessibleProjectsResult struct {
	OK              bool                          `json:"ok"`
	Projects        []GitHubProjectSummary        `json:"projects,omitempty"`
	PartialFailures []GitHubProjectPartialFailure `json:"partialFailures,omitempty"`
	Error           *GitHubProjectViewError       `json:"error,omitempty"`
}

func ListAccessibleGitHubProjects(ctx context.Context) GitHubAccessibleProjectsResult {
	projects := make([]GitHubProjectSummary, 0)
	partialFailures := make([]GitHubProjectPartialFailure, 0)
	viewerLogin, cursor, fetched := "", "", 0
	for fetched < 40 {
		page, err := readGitHubViewerProjectsPage(ctx, cursor)
		if err != nil {
			return GitHubAccessibleProjectsResult{Error: &GitHubProjectViewError{Type: "network_error", Message: err.Error()}}
		}
		if viewerLogin == "" {
			viewerLogin = page.Login
		}
		for _, row := range page.Projects {
			if fetched >= 40 {
				break
			}
			if row.Owner == "" {
				row.Owner = viewerLogin
			}
			row.Source = "viewer"
			projects, fetched = append(projects, row), fetched+1
		}
		if !page.HasNext || page.EndCursor == "" {
			break
		}
		cursor = page.EndCursor
	}
	orgCursor, orgsSeen := "", 0
	for orgsSeen < 20 {
		page, err := readGitHubOrganizationsPage(ctx, orgCursor)
		if err != nil {
			partialFailures = append(partialFailures, GitHubProjectPartialFailure{Owner: "*", Message: err.Error()})
			break
		}
		for _, org := range page.Organizations {
			if orgsSeen >= 20 {
				break
			}
			orgsSeen++
			for index, row := range org.Projects {
				if index >= 40 {
					break
				}
				row.Owner, row.OwnerType, row.Source = org.Login, "organization", "org:"+org.Login
				projects = append(projects, row)
			}
		}
		if !page.HasNext || page.EndCursor == "" {
			break
		}
		orgCursor = page.EndCursor
	}
	return GitHubAccessibleProjectsResult{OK: true, Projects: projects, PartialFailures: partialFailures}
}

type githubProjectDiscoveryPage struct {
	Login, EndCursor string
	HasNext          bool
	Projects         []GitHubProjectSummary
}

func readGitHubViewerProjectsPage(ctx context.Context, cursor string) (githubProjectDiscoveryPage, error) {
	afterVar, afterArg := "", ""
	args := []string{"api", "graphql"}
	if cursor != "" {
		afterVar, afterArg = "($after:String!)", ", after:$after"
	}
	query := fmt.Sprintf(`query%s { viewer { login projectsV2(first:20%s) { pageInfo { hasNextPage endCursor } nodes { id number title url owner { __typename ... on Organization { login } ... on User { login } } } } } }`, afterVar, afterArg)
	args = append(args, "-f", "query="+query)
	if cursor != "" {
		args = append(args, "-f", "after="+cursor)
	}
	out, err := runCLI(ctx, "gh", "", args...)
	if err != nil {
		return githubProjectDiscoveryPage{}, err
	}
	var payload struct {
		Data struct {
			Viewer *struct {
				Login    string `json:"login"`
				Projects struct {
					PageInfo struct {
						HasNext   bool    `json:"hasNextPage"`
						EndCursor *string `json:"endCursor"`
					} `json:"pageInfo"`
					Nodes []struct {
						ID     string `json:"id"`
						Number int    `json:"number"`
						Title  string `json:"title"`
						URL    string `json:"url"`
						Owner  *struct {
							Type  string `json:"__typename"`
							Login string `json:"login"`
						} `json:"owner"`
					} `json:"nodes"`
				} `json:"projectsV2"`
			} `json:"viewer"`
		} `json:"data"`
	}
	if err := json.Unmarshal(out, &payload); err != nil {
		return githubProjectDiscoveryPage{}, err
	}
	if payload.Data.Viewer == nil {
		return githubProjectDiscoveryPage{}, fmt.Errorf("viewer missing")
	}
	page := githubProjectDiscoveryPage{Login: payload.Data.Viewer.Login, HasNext: payload.Data.Viewer.Projects.PageInfo.HasNext}
	if payload.Data.Viewer.Projects.PageInfo.EndCursor != nil {
		page.EndCursor = *payload.Data.Viewer.Projects.PageInfo.EndCursor
	}
	for _, row := range payload.Data.Viewer.Projects.Nodes {
		if row.ID == "" || row.Number < 1 {
			continue
		}
		owner, ownerType := page.Login, "user"
		if row.Owner != nil {
			owner = row.Owner.Login
			if row.Owner.Type == "Organization" {
				ownerType = "organization"
			}
		}
		page.Projects = append(page.Projects, GitHubProjectSummary{ID: row.ID, Owner: owner, OwnerType: ownerType, Number: row.Number, Title: row.Title, URL: row.URL})
	}
	return page, nil
}

type githubOrganizationDiscovery struct {
	Login    string
	Projects []GitHubProjectSummary
}
type githubOrganizationsPage struct {
	EndCursor     string
	HasNext       bool
	Organizations []githubOrganizationDiscovery
}

func readGitHubOrganizationsPage(ctx context.Context, cursor string) (githubOrganizationsPage, error) {
	afterVar, afterArg := "", ""
	args := []string{"api", "graphql"}
	if cursor != "" {
		afterVar, afterArg = "($after:String!)", ", after:$after"
	}
	query := fmt.Sprintf(`query%s { viewer { organizations(first:20%s) { pageInfo { hasNextPage endCursor } nodes { login projectsV2(first:20) { nodes { id number title url } } } } } }`, afterVar, afterArg)
	args = append(args, "-f", "query="+query)
	if cursor != "" {
		args = append(args, "-f", "after="+cursor)
	}
	out, err := runCLI(ctx, "gh", "", args...)
	if err != nil {
		return githubOrganizationsPage{}, err
	}
	var payload struct {
		Data struct {
			Viewer *struct {
				Organizations struct {
					PageInfo struct {
						HasNext   bool    `json:"hasNextPage"`
						EndCursor *string `json:"endCursor"`
					} `json:"pageInfo"`
					Nodes []struct {
						Login    string `json:"login"`
						Projects struct {
							Nodes []GitHubProjectSummary `json:"nodes"`
						} `json:"projectsV2"`
					} `json:"nodes"`
				} `json:"organizations"`
			} `json:"viewer"`
		} `json:"data"`
	}
	if err := json.Unmarshal(out, &payload); err != nil {
		return githubOrganizationsPage{}, err
	}
	if payload.Data.Viewer == nil {
		return githubOrganizationsPage{}, fmt.Errorf("viewer missing")
	}
	page := githubOrganizationsPage{HasNext: payload.Data.Viewer.Organizations.PageInfo.HasNext}
	if payload.Data.Viewer.Organizations.PageInfo.EndCursor != nil {
		page.EndCursor = *payload.Data.Viewer.Organizations.PageInfo.EndCursor
	}
	for _, org := range payload.Data.Viewer.Organizations.Nodes {
		page.Organizations = append(page.Organizations, githubOrganizationDiscovery{Login: org.Login, Projects: org.Projects.Nodes})
	}
	return page, nil
}

func ResolveGitHubProjectRef(ctx context.Context, input string) GitHubProjectRefResult {
	owner, ownerType, number, viewNumber, ok := parseGitHubProjectRef(input)
	if !ok {
		return githubProjectRefFailure("validation_error", "Could not parse input. Expected a GitHub project URL or `owner/number`.")
	}
	candidates := []string{ownerType}
	if ownerType == "" {
		candidates = []string{"organization", "user"}
	}
	for _, candidate := range candidates {
		title, found, err := readGitHubProjectTitle(ctx, owner, candidate, number)
		if err != nil {
			return githubProjectRefFailure("network_error", err.Error())
		}
		if found {
			return GitHubProjectRefResult{OK: true, Owner: owner, OwnerType: candidate, Number: number, Title: title, ViewNumber: viewNumber}
		}
	}
	return githubProjectRefFailure("not_found", "Project not found.")
}

func ListGitHubProjectViews(ctx context.Context, owner, ownerType string, projectNumber int) GitHubProjectViewsResult {
	if !githubOwnerPattern.MatchString(owner) || (ownerType != "organization" && ownerType != "user") || projectNumber < 1 {
		return GitHubProjectViewsResult{Error: &GitHubProjectViewError{Type: "validation_error", Message: "Valid owner, ownerType, and projectNumber are required."}}
	}
	views := make([]GitHubProjectViewSummary, 0)
	cursor := ""
	for {
		page, found, err := readGitHubProjectViewsPage(ctx, owner, ownerType, projectNumber, cursor)
		if err != nil {
			return GitHubProjectViewsResult{Error: &GitHubProjectViewError{Type: "network_error", Message: err.Error()}}
		}
		if !found {
			return GitHubProjectViewsResult{Error: &GitHubProjectViewError{Type: "not_found", Message: "Project not found."}}
		}
		views = append(views, page.Views...)
		if !page.HasNext || page.EndCursor == "" {
			break
		}
		cursor = page.EndCursor
	}
	return GitHubProjectViewsResult{OK: true, Views: views}
}

func parseGitHubProjectRef(input string) (string, string, int, int, bool) {
	input = strings.TrimSpace(input)
	if input == "" || len([]byte(input)) > githubProjectRefMaxBytes {
		return "", "", 0, 0, false
	}
	if match := githubProjectURLPattern.FindStringSubmatch(input); match != nil {
		number, _ := strconv.Atoi(match[3])
		viewNumber, _ := strconv.Atoi(match[4])
		ownerType := "user"
		if strings.EqualFold(match[1], "orgs") {
			ownerType = "organization"
		}
		return match[2], ownerType, number, viewNumber, githubOwnerPattern.MatchString(match[2]) && number > 0
	}
	if match := githubProjectShortPattern.FindStringSubmatch(input); match != nil {
		number, _ := strconv.Atoi(match[2])
		return match[1], "", number, 0, number > 0
	}
	return "", "", 0, 0, false
}

func readGitHubProjectTitle(ctx context.Context, owner, ownerType string, number int) (string, bool, error) {
	root := githubProjectOwnerRoot(ownerType)
	query := fmt.Sprintf(`query($owner:String!, $num:Int!) { %s(login:$owner) { projectV2(number:$num) { id title } } }`, root)
	out, err := runCLI(ctx, "gh", "", "api", "graphql", "-f", "query="+query, "-f", "owner="+owner, "-F", fmt.Sprintf("num=%d", number))
	if err != nil {
		if isProviderNotFound(err) {
			return "", false, nil
		}
		return "", false, err
	}
	var payload struct {
		Data map[string]*struct {
			Project *struct{ ID, Title string } `json:"projectV2"`
		} `json:"data"`
	}
	if err := json.Unmarshal(out, &payload); err != nil {
		return "", false, err
	}
	project := payload.Data[root]
	if project == nil || project.Project == nil || project.Project.ID == "" {
		return "", false, nil
	}
	return project.Project.Title, true, nil
}

type githubProjectViewsPage struct {
	Views     []GitHubProjectViewSummary
	HasNext   bool
	EndCursor string
}

func readGitHubProjectViewsPage(ctx context.Context, owner, ownerType string, number int, cursor string) (githubProjectViewsPage, bool, error) {
	root := githubProjectOwnerRoot(ownerType)
	afterVariable, afterArgument := "", ""
	args := []string{"api", "graphql"}
	if cursor != "" {
		afterVariable, afterArgument = ", $after:String!", ", after:$after"
	}
	query := fmt.Sprintf(`query($owner:String!, $num:Int!%s) { %s(login:$owner) { projectV2(number:$num) { id views(first:50%s) { pageInfo { hasNextPage endCursor } nodes { id number name layout } } } } }`, afterVariable, root, afterArgument)
	args = append(args, "-f", "query="+query, "-f", "owner="+owner, "-F", fmt.Sprintf("num=%d", number))
	if cursor != "" {
		args = append(args, "-f", "after="+cursor)
	}
	out, err := runCLI(ctx, "gh", "", args...)
	if err != nil {
		return githubProjectViewsPage{}, false, err
	}
	var payload struct {
		Data map[string]*struct {
			Project *struct {
				ID    string `json:"id"`
				Views struct {
					PageInfo struct {
						HasNextPage bool    `json:"hasNextPage"`
						EndCursor   *string `json:"endCursor"`
					} `json:"pageInfo"`
					Nodes []GitHubProjectViewSummary `json:"nodes"`
				} `json:"views"`
			} `json:"projectV2"`
		} `json:"data"`
	}
	if err := json.Unmarshal(out, &payload); err != nil {
		return githubProjectViewsPage{}, false, err
	}
	ownerPayload := payload.Data[root]
	if ownerPayload == nil || ownerPayload.Project == nil || ownerPayload.Project.ID == "" {
		return githubProjectViewsPage{}, false, nil
	}
	page := githubProjectViewsPage{Views: ownerPayload.Project.Views.Nodes, HasNext: ownerPayload.Project.Views.PageInfo.HasNextPage}
	if ownerPayload.Project.Views.PageInfo.EndCursor != nil {
		page.EndCursor = *ownerPayload.Project.Views.PageInfo.EndCursor
	}
	return page, true, nil
}

func githubProjectOwnerRoot(ownerType string) string {
	if ownerType == "organization" {
		return "organization"
	}
	return "user"
}

func githubProjectRefFailure(errorType, message string) GitHubProjectRefResult {
	return GitHubProjectRefResult{Error: &GitHubProjectViewError{Type: errorType, Message: message}}
}
