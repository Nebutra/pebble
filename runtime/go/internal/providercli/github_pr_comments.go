package providercli

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

const githubReviewThreadsQuery = `query($owner: String!, $repo: String!, $pr: Int!) {
  repository(owner: $owner, name: $repo) { pullRequest(number: $pr) {
    reviewThreads(first: 100) { nodes { id isResolved line startLine originalLine originalStartLine comments(first: 100) { nodes { databaseId author { __typename login avatarUrl(size: 48) } body createdAt url path reactionGroups { content reactors { totalCount } } } } } }
    comments(first: 100) { nodes { databaseId author { __typename login avatarUrl(size: 48) } body createdAt url reactionGroups { content reactors { totalCount } } } }
  } }
}`

type GitHubPRComment struct {
	ID              int64            `json:"id"`
	Author          string           `json:"author"`
	AuthorAvatarURL string           `json:"authorAvatarUrl"`
	Body            string           `json:"body"`
	CreatedAt       string           `json:"createdAt"`
	URL             string           `json:"url"`
	Reactions       []GitHubReaction `json:"reactions,omitempty"`
	Path            string           `json:"path,omitempty"`
	ThreadID        string           `json:"threadId,omitempty"`
	IsResolved      *bool            `json:"isResolved,omitempty"`
	IsOutdated      *bool            `json:"isOutdated,omitempty"`
	Line            *int             `json:"line,omitempty"`
	StartLine       *int             `json:"startLine,omitempty"`
	IsBot           *bool            `json:"isBot,omitempty"`
}

type GitHubReaction struct {
	Content string `json:"content"`
	Count   int    `json:"count"`
}

type githubGraphQLComment struct {
	DatabaseID int64  `json:"databaseId"`
	Body       string `json:"body"`
	CreatedAt  string `json:"createdAt"`
	URL        string `json:"url"`
	Path       string `json:"path"`
	Author     *struct {
		Type      string `json:"__typename"`
		Login     string `json:"login"`
		AvatarURL string `json:"avatarUrl"`
	} `json:"author"`
	ReactionGroups []struct {
		Content  string `json:"content"`
		Reactors struct {
			TotalCount int `json:"totalCount"`
		} `json:"reactors"`
	} `json:"reactionGroups"`
}

func ListGitHubPRComments(ctx context.Context, workdir string, number int, preference string) []GitHubPRComment {
	sources, err := ResolveGitHubWorkItemSources(ctx, workdir, preference)
	if err != nil || sources.PRs == nil || number < 1 {
		return []GitHubPRComment{}
	}
	source := *sources.PRs
	comments, graphQLOK := readGitHubPRThreadComments(ctx, workdir, source, number)
	if !graphQLOK {
		comments = readGitHubPRIssueComments(ctx, workdir, source, number)
	}
	comments = append(comments, readGitHubPRReviewSummaries(ctx, workdir, source, number)...)
	sort.SliceStable(comments, func(i, j int) bool { return comments[i].CreatedAt < comments[j].CreatedAt })
	return comments
}

func readGitHubPRThreadComments(ctx context.Context, workdir string, source GitHubOwnerRepo, number int) ([]GitHubPRComment, bool) {
	out, err := runCLI(ctx, "gh", workdir, "api", "graphql", "-f", "query="+githubReviewThreadsQuery, "-f", "owner="+source.Owner, "-f", "repo="+source.Repo, "-F", fmt.Sprintf("pr=%d", number))
	if err != nil {
		return nil, false
	}
	var payload struct {
		Data struct {
			Repository struct {
				PullRequest struct {
					ReviewThreads struct {
						Nodes []struct {
							ID                                               string `json:"id"`
							IsResolved                                       bool   `json:"isResolved"`
							Line, StartLine, OriginalLine, OriginalStartLine *int
							Comments                                         struct {
								Nodes []githubGraphQLComment `json:"nodes"`
							} `json:"comments"`
						} `json:"nodes"`
					} `json:"reviewThreads"`
					Comments struct {
						Nodes []githubGraphQLComment `json:"nodes"`
					} `json:"comments"`
				} `json:"pullRequest"`
			} `json:"repository"`
		} `json:"data"`
	}
	if json.Unmarshal(out, &payload) != nil {
		return nil, false
	}
	pr := payload.Data.Repository.PullRequest
	comments := make([]GitHubPRComment, 0)
	for _, row := range pr.Comments.Nodes {
		comments = append(comments, mapGitHubGraphQLComment(row))
	}
	for _, thread := range pr.ReviewThreads.Nodes {
		for _, row := range thread.Comments.Nodes {
			comment := mapGitHubGraphQLComment(row)
			comment.Path, comment.ThreadID = row.Path, thread.ID
			resolved, outdated := thread.IsResolved, thread.Line == nil
			comment.IsResolved, comment.IsOutdated = &resolved, &outdated
			comment.Line, comment.StartLine = firstInt(thread.Line, thread.OriginalLine), firstInt(thread.StartLine, thread.OriginalStartLine)
			comments = append(comments, comment)
		}
	}
	return comments, true
}

func mapGitHubGraphQLComment(row githubGraphQLComment) GitHubPRComment {
	comment := GitHubPRComment{ID: row.DatabaseID, Body: row.Body, CreatedAt: row.CreatedAt, URL: row.URL, Reactions: mapGitHubReactions(row.ReactionGroups)}
	if row.Author != nil {
		comment.Author, comment.AuthorAvatarURL = row.Author.Login, row.Author.AvatarURL
		isBot := row.Author.Type == "Bot"
		comment.IsBot = &isBot
	} else {
		comment.Author = "ghost"
	}
	return comment
}

func mapGitHubReactions(groups []struct {
	Content  string `json:"content"`
	Reactors struct {
		TotalCount int `json:"totalCount"`
	} `json:"reactors"`
}) []GitHubReaction {
	names := map[string]string{"THUMBS_UP": "+1", "THUMBS_DOWN": "-1", "LAUGH": "laugh", "CONFUSED": "confused", "HEART": "heart", "HOORAY": "hooray", "ROCKET": "rocket", "EYES": "eyes"}
	result := make([]GitHubReaction, 0)
	for _, group := range groups {
		if content := names[group.Content]; content != "" && group.Reactors.TotalCount > 0 {
			result = append(result, GitHubReaction{Content: content, Count: group.Reactors.TotalCount})
		}
	}
	return result
}

func readGitHubPRIssueComments(ctx context.Context, workdir string, source GitHubOwnerRepo, number int) []GitHubPRComment {
	var raw []githubCommentRaw
	if readPaginatedGitHubArray(ctx, workdir, fmt.Sprintf("repos/%s/%s/issues/%d/comments?per_page=100", source.Owner, source.Repo, number), &raw) != nil {
		return []GitHubPRComment{}
	}
	result := make([]GitHubPRComment, 0, len(raw))
	for _, row := range raw {
		comment := GitHubPRComment{ID: row.ID, Body: row.Body, CreatedAt: row.CreatedAt, URL: row.HTMLURL, Author: "ghost"}
		if row.User != nil {
			comment.Author, comment.AuthorAvatarURL = row.User.Login, row.User.AvatarURL
			bot := row.User.Type == "Bot"
			comment.IsBot = &bot
		}
		result = append(result, comment)
	}
	return result
}

func readGitHubPRReviewSummaries(ctx context.Context, workdir string, source GitHubOwnerRepo, number int) []GitHubPRComment {
	var raw []struct {
		ID          int64  `json:"id"`
		Body        string `json:"body"`
		SubmittedAt string `json:"submitted_at"`
		HTMLURL     string `json:"html_url"`
		User        *struct {
			Login     string `json:"login"`
			AvatarURL string `json:"avatar_url"`
			Type      string `json:"type"`
		} `json:"user"`
	}
	if readPaginatedGitHubArray(ctx, workdir, fmt.Sprintf("repos/%s/%s/pulls/%d/reviews?per_page=100", source.Owner, source.Repo, number), &raw) != nil {
		return []GitHubPRComment{}
	}
	result := make([]GitHubPRComment, 0, len(raw))
	for _, row := range raw {
		if strings.TrimSpace(row.Body) == "" {
			continue
		}
		comment := GitHubPRComment{ID: row.ID, Body: row.Body, CreatedAt: row.SubmittedAt, URL: row.HTMLURL, Author: "ghost"}
		if row.User != nil {
			comment.Author, comment.AuthorAvatarURL = row.User.Login, row.User.AvatarURL
			bot := row.User.Type == "Bot"
			comment.IsBot = &bot
		}
		result = append(result, comment)
	}
	return result
}

func firstInt(primary, fallback *int) *int {
	if primary != nil {
		return primary
	}
	return fallback
}
