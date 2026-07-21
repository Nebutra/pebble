package providercli

import (
	"context"
	"encoding/json"
)

func ListGitLabTodos(ctx context.Context, workdir string) []GitLabTodo {
	project, err := resolveGitLabProjectRef(ctx, workdir, nil)
	if err != nil {
		return []GitLabTodo{}
	}
	out, err := runCLI(ctx, "glab", workdir, gitLabAPIArgs(project, "todos?state=pending&per_page=50")...)
	if err != nil {
		return []GitLabTodo{}
	}
	var raw []struct {
		ID         int    `json:"id"`
		ActionName string `json:"action_name"`
		TargetType string `json:"target_type"`
		Target     *struct {
			IID    *int   `json:"iid"`
			Title  string `json:"title"`
			WebURL string `json:"web_url"`
		} `json:"target"`
		TargetURL string `json:"target_url"`
		Author    *struct {
			Username  string `json:"username"`
			AvatarURL string `json:"avatar_url"`
		} `json:"author"`
		Project *struct {
			Path string `json:"path_with_namespace"`
		} `json:"project"`
		UpdatedAt string `json:"updated_at"`
		State     string `json:"state"`
	}
	if json.Unmarshal(out, &raw) != nil {
		return []GitLabTodo{}
	}
	items := make([]GitLabTodo, 0, len(raw))
	for _, entry := range raw {
		item := GitLabTodo{ID: entry.ID, ActionName: entry.ActionName, TargetType: entry.TargetType, TargetURL: entry.TargetURL, UpdatedAt: entry.UpdatedAt, State: "pending"}
		if entry.State == "done" {
			item.State = "done"
		}
		if entry.Target != nil {
			item.TargetIID = entry.Target.IID
			item.TargetTitle = entry.Target.Title
			if item.TargetURL == "" {
				item.TargetURL = entry.Target.WebURL
			}
		}
		if entry.Project != nil {
			item.ProjectPath = entry.Project.Path
		}
		if entry.Author != nil {
			item.AuthorUsername = entry.Author.Username
			item.AuthorAvatarURL = entry.Author.AvatarURL
		}
		items = append(items, item)
	}
	return items
}
