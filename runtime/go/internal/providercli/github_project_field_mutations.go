package providercli

import (
	"context"
	"encoding/json"
	"fmt"
)

type GitHubProjectFieldMutationValue struct {
	Kind        string  `json:"kind"`
	OptionID    string  `json:"optionId,omitempty"`
	IterationID string  `json:"iterationId,omitempty"`
	Text        string  `json:"text,omitempty"`
	Number      float64 `json:"number,omitempty"`
	Date        string  `json:"date,omitempty"`
}

func UpdateGitHubProjectItemField(ctx context.Context, projectID, itemID, fieldID string, value GitHubProjectFieldMutationValue) GitHubProjectMutationResult {
	if projectID == "" || itemID == "" || fieldID == "" {
		return GitHubProjectMutationResult{Error: projectValidationError("Project, item, and field IDs are required.")}
	}
	valueLiteral, ok := githubProjectFieldValueLiteral(value)
	if !ok {
		return GitHubProjectMutationResult{Error: projectValidationError("Unsupported ProjectV2 field value.")}
	}
	query := fmt.Sprintf(`mutation($project:ID!, $item:ID!, $field:ID!) { updateProjectV2ItemFieldValue(input:{projectId:$project,itemId:$item,fieldId:$field,value:%s}) { projectV2Item { id } } }`, valueLiteral)
	return runGitHubProjectMutation(ctx, query, projectID, itemID, fieldID)
}

func ClearGitHubProjectItemField(ctx context.Context, projectID, itemID, fieldID string) GitHubProjectMutationResult {
	if projectID == "" || itemID == "" || fieldID == "" {
		return GitHubProjectMutationResult{Error: projectValidationError("Project, item, and field IDs are required.")}
	}
	query := `mutation($project:ID!, $item:ID!, $field:ID!) { clearProjectV2ItemFieldValue(input:{projectId:$project,itemId:$item,fieldId:$field}) { projectV2Item { id } } }`
	return runGitHubProjectMutation(ctx, query, projectID, itemID, fieldID)
}

func UpdateGitHubIssueTypeBySlug(ctx context.Context, owner, repo string, number int, issueTypeID *string) GitHubProjectMutationResult {
	if !validGitHubRepoSlug(owner, repo) || number < 1 {
		return GitHubProjectMutationResult{Error: projectValidationError("Valid repository and issue number are required.")}
	}
	lookup := `query($owner:String!, $repo:String!, $number:Int!) { repository(owner:$owner,name:$repo) { issue(number:$number) { id } } }`
	out, err := runCLI(ctx, "gh", "", "api", "graphql", "-f", "query="+lookup, "-f", "owner="+owner, "-f", "repo="+repo, "-F", fmt.Sprintf("number=%d", number))
	if err != nil {
		return GitHubProjectMutationResult{Error: projectProviderError(err)}
	}
	var payload struct {
		Data struct {
			Repository *struct {
				Issue *struct {
					ID string `json:"id"`
				} `json:"issue"`
			} `json:"repository"`
		} `json:"data"`
	}
	if json.Unmarshal(out, &payload) != nil || payload.Data.Repository == nil || payload.Data.Repository.Issue == nil || payload.Data.Repository.Issue.ID == "" {
		return GitHubProjectMutationResult{Error: &GitHubProjectViewError{Type: "not_found", Message: "Issue not found."}}
	}
	issueID := payload.Data.Repository.Issue.ID
	if issueTypeID == nil {
		mutation := `mutation($issue:ID!) { updateIssue(input:{id:$issue,issueTypeId:null}) { issue { id } } }`
		_, err = runCLI(ctx, "gh", "", "api", "graphql", "-f", "query="+mutation, "-f", "issue="+issueID)
	} else {
		mutation := `mutation($issue:ID!, $type:ID!) { updateIssue(input:{id:$issue,issueTypeId:$type}) { issue { id } } }`
		_, err = runCLI(ctx, "gh", "", "api", "graphql", "-f", "query="+mutation, "-f", "issue="+issueID, "-f", "type="+*issueTypeID)
	}
	if err != nil {
		return GitHubProjectMutationResult{Error: projectProviderError(err)}
	}
	return GitHubProjectMutationResult{OK: true}
}

func githubProjectFieldValueLiteral(value GitHubProjectFieldMutationValue) (string, bool) {
	switch value.Kind {
	case "single-select":
		return fmt.Sprintf(`{singleSelectOptionId:%q}`, value.OptionID), value.OptionID != ""
	case "iteration":
		return fmt.Sprintf(`{iterationId:%q}`, value.IterationID), value.IterationID != ""
	case "text":
		return fmt.Sprintf(`{text:%q}`, value.Text), true
	case "number":
		return fmt.Sprintf(`{number:%v}`, value.Number), true
	case "date":
		return fmt.Sprintf(`{date:%q}`, value.Date), value.Date != ""
	default:
		return "", false
	}
}

func runGitHubProjectMutation(ctx context.Context, query, projectID, itemID, fieldID string) GitHubProjectMutationResult {
	_, err := runCLI(ctx, "gh", "", "api", "graphql", "-f", "query="+query, "-f", "project="+projectID, "-f", "item="+itemID, "-f", "field="+fieldID)
	if err != nil {
		return GitHubProjectMutationResult{Error: projectProviderError(err)}
	}
	return GitHubProjectMutationResult{OK: true}
}
