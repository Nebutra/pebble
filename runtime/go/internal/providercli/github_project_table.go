package providercli

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
)

const githubProjectTableMaxItems = 500

type githubProjectTableReadError struct {
	Kind       string
	Message    string
	TotalCount int
}

func (err *githubProjectTableReadError) Error() string { return err.Message }

type GitHubProjectTableRequest struct {
	Owner         string  `json:"owner"`
	OwnerType     string  `json:"ownerType"`
	ProjectNumber int     `json:"projectNumber"`
	ViewID        string  `json:"viewId,omitempty"`
	ViewNumber    int     `json:"viewNumber,omitempty"`
	ViewName      string  `json:"viewName,omitempty"`
	QueryOverride *string `json:"queryOverride,omitempty"`
}

type GitHubProjectTableResult struct {
	OK         bool                    `json:"ok"`
	Data       *GitHubProjectTable     `json:"data,omitempty"`
	Error      *GitHubProjectViewError `json:"error,omitempty"`
	TotalCount int                     `json:"totalCount,omitempty"`
}

type GitHubProjectTable struct {
	Project            map[string]interface{}   `json:"project"`
	SelectedView       map[string]interface{}   `json:"selectedView"`
	Rows               []map[string]interface{} `json:"rows"`
	TotalCount         int                      `json:"totalCount"`
	ParentFieldDropped bool                     `json:"parentFieldDropped"`
}

type githubProjectRawField struct {
	Type          string                   `json:"__typename"`
	ID            string                   `json:"id"`
	Name          string                   `json:"name"`
	DataType      string                   `json:"dataType"`
	Options       []map[string]interface{} `json:"options"`
	Configuration *struct {
		Iterations          []map[string]interface{} `json:"iterations"`
		CompletedIterations []map[string]interface{} `json:"completedIterations"`
	} `json:"configuration"`
}

type githubProjectRawView struct {
	ID     string  `json:"id"`
	Number int     `json:"number"`
	Name   string  `json:"name"`
	Layout string  `json:"layout"`
	Filter *string `json:"filter"`
	Fields struct {
		PageInfo struct {
			HasNext   bool    `json:"hasNextPage"`
			EndCursor *string `json:"endCursor"`
		} `json:"pageInfo"`
		Nodes []githubProjectRawField `json:"nodes"`
	} `json:"fields"`
	GroupByFields struct {
		Nodes []githubProjectRawField `json:"nodes"`
	} `json:"groupByFields"`
	SortByFields struct {
		Nodes []struct {
			Direction string                `json:"direction"`
			Field     githubProjectRawField `json:"field"`
		} `json:"nodes"`
	} `json:"sortByFields"`
}

func GetGitHubProjectViewTable(ctx context.Context, input GitHubProjectTableRequest) GitHubProjectTableResult {
	if !githubOwnerPattern.MatchString(input.Owner) || (input.OwnerType != "organization" && input.OwnerType != "user") || input.ProjectNumber < 1 {
		return GitHubProjectTableResult{Error: projectValidationError("Valid owner, ownerType, and projectNumber are required.")}
	}
	project, views, err := readGitHubProjectConfig(ctx, input)
	if err != nil {
		return GitHubProjectTableResult{Error: projectProviderError(err)}
	}
	selected := selectGitHubProjectView(views, input)
	if selected == nil {
		return GitHubProjectTableResult{Error: &GitHubProjectViewError{Type: "not_found", Message: "Project view not found."}}
	}
	if selected.Layout != "TABLE_LAYOUT" {
		return GitHubProjectTableResult{Error: &GitHubProjectViewError{Type: "unsupported_layout", Message: "Only table-layout ProjectV2 views are supported."}}
	}
	query := ""
	if selected.Filter != nil {
		query = *selected.Filter
	}
	if input.QueryOverride != nil {
		query = *input.QueryOverride
	}
	if err := readGitHubProjectViewFields(ctx, selected); err != nil {
		if classified, ok := err.(*githubProjectTableReadError); ok {
			return GitHubProjectTableResult{Error: &GitHubProjectViewError{Type: classified.Kind, Message: classified.Message}}
		}
		return GitHubProjectTableResult{Error: projectProviderError(err)}
	}
	rows, total, parentDropped, err := readGitHubProjectItems(ctx, input, query)
	if err != nil {
		if classified, ok := err.(*githubProjectTableReadError); ok {
			return GitHubProjectTableResult{Error: &GitHubProjectViewError{Type: classified.Kind, Message: classified.Message}, TotalCount: classified.TotalCount}
		}
		return GitHubProjectTableResult{Error: projectProviderError(err)}
	}
	data := &GitHubProjectTable{
		Project:      map[string]interface{}{"id": project.ID, "owner": input.Owner, "ownerType": input.OwnerType, "number": input.ProjectNumber, "title": project.Title, "url": project.URL},
		SelectedView: normalizeGitHubProjectView(*selected), Rows: rows, TotalCount: total, ParentFieldDropped: parentDropped,
	}
	return GitHubProjectTableResult{OK: true, Data: data}
}

type githubProjectConfig struct{ ID, Title, URL string }

func readGitHubProjectConfig(ctx context.Context, input GitHubProjectTableRequest) (githubProjectConfig, []githubProjectRawView, error) {
	root, cursor := githubProjectOwnerRoot(input.OwnerType), ""
	views := make([]githubProjectRawView, 0)
	project := githubProjectConfig{}
	for {
		afterVar, afterArg := "", ""
		args := []string{"api", "graphql"}
		if cursor != "" {
			afterVar, afterArg = ", $after:String!", ", after:$after"
		}
		query := fmt.Sprintf(`query($owner:String!, $num:Int!%s) { %s(login:$owner) { projectV2(number:$num) { id title url views(first:20%s) { pageInfo { hasNextPage endCursor } nodes { id number name layout filter fields(first:50) { pageInfo { hasNextPage endCursor } nodes { %s } } groupByFields(first:10) { nodes { %s } } sortByFields(first:10) { nodes { direction field { %s } } } } } } } }`, afterVar, root, afterArg, githubProjectFieldSelection, githubProjectFieldSelection, githubProjectFieldSelection)
		args = append(args, "-f", "query="+query, "-f", "owner="+input.Owner, "-F", fmt.Sprintf("num=%d", input.ProjectNumber))
		if cursor != "" {
			args = append(args, "-f", "after="+cursor)
		}
		out, err := runCLI(ctx, "gh", "", args...)
		if err != nil {
			return project, nil, err
		}
		var payload struct {
			Data map[string]*struct {
				Project *struct {
					ID    string `json:"id"`
					Title string `json:"title"`
					URL   string `json:"url"`
					Views struct {
						PageInfo struct {
							HasNext   bool    `json:"hasNextPage"`
							EndCursor *string `json:"endCursor"`
						} `json:"pageInfo"`
						Nodes []githubProjectRawView `json:"nodes"`
					} `json:"views"`
				} `json:"projectV2"`
			} `json:"data"`
		}
		if json.Unmarshal(out, &payload) != nil {
			return project, nil, fmt.Errorf("failed to parse project config")
		}
		owner := payload.Data[root]
		if owner == nil || owner.Project == nil || owner.Project.ID == "" {
			return project, nil, fmt.Errorf("project not found")
		}
		project = githubProjectConfig{ID: owner.Project.ID, Title: owner.Project.Title, URL: owner.Project.URL}
		views = append(views, owner.Project.Views.Nodes...)
		if !owner.Project.Views.PageInfo.HasNext || owner.Project.Views.PageInfo.EndCursor == nil {
			break
		}
		cursor = *owner.Project.Views.PageInfo.EndCursor
	}
	return project, views, nil
}

func readGitHubProjectViewFields(ctx context.Context, view *githubProjectRawView) error {
	for view.Fields.PageInfo.HasNext {
		if view.Fields.PageInfo.EndCursor == nil || *view.Fields.PageInfo.EndCursor == "" {
			return &githubProjectTableReadError{Kind: "schema_drift", Message: "views.fields.pageInfo.endCursor missing with hasNextPage=true"}
		}
		query := fmt.Sprintf(`query($id:ID!, $after:String!) { node(id:$id) { ... on ProjectV2View { fields(first:50, after:$after) { pageInfo { hasNextPage endCursor } nodes { %s } } } } }`, githubProjectFieldSelection)
		out, err := runCLI(ctx, "gh", "", "api", "graphql", "-f", "query="+query, "-f", "id="+view.ID, "-f", "after="+*view.Fields.PageInfo.EndCursor)
		if err != nil {
			return err
		}
		var payload struct {
			Data struct {
				Node *struct {
					Fields struct {
						PageInfo struct {
							HasNext   bool    `json:"hasNextPage"`
							EndCursor *string `json:"endCursor"`
						} `json:"pageInfo"`
						Nodes []githubProjectRawField `json:"nodes"`
					} `json:"fields"`
				} `json:"node"`
			} `json:"data"`
		}
		if json.Unmarshal(out, &payload) != nil || payload.Data.Node == nil {
			return &githubProjectTableReadError{Kind: "schema_drift", Message: "view field continuation is missing"}
		}
		view.Fields.Nodes = append(view.Fields.Nodes, payload.Data.Node.Fields.Nodes...)
		view.Fields.PageInfo = payload.Data.Node.Fields.PageInfo
	}
	return nil
}

const githubProjectFieldSelection = `__typename id name dataType ... on ProjectV2SingleSelectField { options { id name color } } ... on ProjectV2IterationField { configuration { iterations { id title startDate duration } completedIterations { id title startDate duration } } }`

func selectGitHubProjectView(views []githubProjectRawView, input GitHubProjectTableRequest) *githubProjectRawView {
	for index := range views {
		if input.ViewID != "" && views[index].ID == input.ViewID {
			return &views[index]
		}
	}
	for index := range views {
		if input.ViewNumber > 0 && views[index].Number == input.ViewNumber {
			return &views[index]
		}
	}
	for index := range views {
		if input.ViewName != "" && views[index].Name == input.ViewName {
			return &views[index]
		}
	}
	if input.ViewID == "" && input.ViewNumber == 0 && input.ViewName == "" {
		for index := range views {
			if views[index].Layout == "TABLE_LAYOUT" {
				return &views[index]
			}
		}
	}
	return nil
}

func normalizeGitHubProjectView(view githubProjectRawView) map[string]interface{} {
	fields := make([]map[string]interface{}, 0, len(view.Fields.Nodes))
	for _, field := range view.Fields.Nodes {
		if normalized := normalizeGitHubProjectField(field); normalized != nil {
			fields = append(fields, normalized)
		}
	}
	groups := make([]map[string]interface{}, 0, len(view.GroupByFields.Nodes))
	for _, field := range view.GroupByFields.Nodes {
		if normalized := normalizeGitHubProjectField(field); normalized != nil {
			groups = append(groups, normalized)
		}
	}
	sorts := make([]map[string]interface{}, 0, len(view.SortByFields.Nodes))
	for _, sort := range view.SortByFields.Nodes {
		if field := normalizeGitHubProjectField(sort.Field); field != nil && (sort.Direction == "ASC" || sort.Direction == "DESC") {
			sorts = append(sorts, map[string]interface{}{"direction": sort.Direction, "field": field})
		}
	}
	filter := ""
	if view.Filter != nil {
		filter = *view.Filter
	}
	return map[string]interface{}{"id": view.ID, "number": view.Number, "name": view.Name, "layout": view.Layout, "filter": filter, "fields": fields, "groupByFields": groups, "sortByFields": sorts}
}

func normalizeGitHubProjectField(field githubProjectRawField) map[string]interface{} {
	if field.ID == "" || field.Name == "" {
		return nil
	}
	dataType := field.DataType
	if dataType == "" {
		dataType = field.Type
	}
	if field.Type == "ProjectV2SingleSelectField" || dataType == "SINGLE_SELECT" {
		return map[string]interface{}{"kind": "single-select", "id": field.ID, "name": field.Name, "dataType": "SINGLE_SELECT", "options": field.Options}
	}
	if field.Type == "ProjectV2IterationField" || dataType == "ITERATION" {
		iterations := make([]map[string]interface{}, 0)
		if field.Configuration != nil {
			for _, row := range field.Configuration.CompletedIterations {
				row["completed"] = true
				iterations = append(iterations, row)
			}
			for _, row := range field.Configuration.Iterations {
				row["completed"] = false
				iterations = append(iterations, row)
			}
		}
		return map[string]interface{}{"kind": "iteration", "id": field.ID, "name": field.Name, "dataType": "ITERATION", "iterations": iterations}
	}
	return map[string]interface{}{"kind": "field", "id": field.ID, "name": field.Name, "dataType": dataType}
}

func readGitHubProjectItems(ctx context.Context, input GitHubProjectTableRequest, filter string) ([]map[string]interface{}, int, bool, error) {
	rows, total, err := readGitHubProjectItemsWithParent(ctx, input, filter, true)
	if err == nil || !strings.Contains(strings.ToLower(err.Error()), "parent") {
		return rows, total, false, err
	}
	// Why: Issue.parent is not available for every token/schema combination;
	// preserve the rest of the Project table by retrying the complete stream.
	rows, total, err = readGitHubProjectItemsWithParent(ctx, input, filter, false)
	return rows, total, true, err
}

func readGitHubProjectItemsWithParent(ctx context.Context, input GitHubProjectTableRequest, filter string, includeParent bool) ([]map[string]interface{}, int, error) {
	root, cursor, total := githubProjectOwnerRoot(input.OwnerType), "", 0
	rows := make([]map[string]interface{}, 0)
	for len(rows) < 500 {
		afterVar, afterArg := "", ""
		args := []string{"api", "graphql"}
		if cursor != "" {
			afterVar, afterArg = ", $after:String!", ", after:$after"
		}
		query := fmt.Sprintf(`query($owner:String!, $num:Int!, $q:String!%s) { %s(login:$owner) { projectV2(number:$num) { items(first:100%s, query:$q, orderBy:{field:POSITION,direction:ASC}) { totalCount pageInfo { hasNextPage endCursor } nodes { id type updatedAt content { __typename ... on Issue { number title url state stateReason repository { nameWithOwner } assignees(first:5) { nodes { login name avatarUrl } } labels(first:10) { nodes { name color } } issueType { id name color description } %s } ... on PullRequest { number title url state isDraft repository { nameWithOwner } assignees(first:5) { nodes { login name avatarUrl } } labels(first:10) { nodes { name color } } } ... on DraftIssue { title body } } fieldValues(first:100) { pageInfo { hasNextPage } nodes { __typename ... on ProjectV2ItemFieldSingleSelectValue { field { %s } name color optionId } ... on ProjectV2ItemFieldIterationValue { field { %s } title startDate duration iterationId } ... on ProjectV2ItemFieldTextValue { field { %s } text } ... on ProjectV2ItemFieldNumberValue { field { %s } number } ... on ProjectV2ItemFieldDateValue { field { %s } date } ... on ProjectV2ItemFieldLabelValue { field { %s } labels(first:10) { nodes { name color } } } ... on ProjectV2ItemFieldUserValue { field { %s } users(first:5) { nodes { login name avatarUrl } } } } } } } } }`, afterVar, root, afterArg, githubProjectParentSelection(includeParent), githubProjectFieldSelection, githubProjectFieldSelection, githubProjectFieldSelection, githubProjectFieldSelection, githubProjectFieldSelection, githubProjectFieldSelection, githubProjectFieldSelection)
		args = append(args, "-f", "query="+query, "-f", "owner="+input.Owner, "-F", fmt.Sprintf("num=%d", input.ProjectNumber), "-f", "q="+filter)
		if cursor != "" {
			args = append(args, "-f", "after="+cursor)
		}
		out, err := runCLI(ctx, "gh", "", args...)
		if err != nil {
			return nil, total, err
		}
		var payload struct {
			Data map[string]*struct {
				Project *struct {
					Items struct {
						TotalCount int `json:"totalCount"`
						PageInfo   struct {
							HasNext   bool    `json:"hasNextPage"`
							EndCursor *string `json:"endCursor"`
						} `json:"pageInfo"`
						Nodes []map[string]interface{} `json:"nodes"`
					} `json:"items"`
				} `json:"projectV2"`
			} `json:"data"`
		}
		if json.Unmarshal(out, &payload) != nil {
			return nil, total, fmt.Errorf("failed to parse project items")
		}
		owner := payload.Data[root]
		if owner == nil || owner.Project == nil {
			return nil, total, fmt.Errorf("project not found")
		}
		total = owner.Project.Items.TotalCount
		if total > githubProjectTableMaxItems {
			return nil, total, &githubProjectTableReadError{Kind: "too_large", Message: fmt.Sprintf("View has %d items.", total), TotalCount: total}
		}
		for _, raw := range owner.Project.Items.Nodes {
			if projectFieldValuesContinue(raw) {
				return nil, total, &githubProjectTableReadError{Kind: "schema_drift", Message: "item fieldValues exceed the supported page size", TotalCount: total}
			}
			if len(rows) >= githubProjectTableMaxItems {
				break
			}
			if row := normalizeGitHubProjectRow(raw, len(rows)); row != nil {
				rows = append(rows, row)
			}
		}
		if !owner.Project.Items.PageInfo.HasNext || owner.Project.Items.PageInfo.EndCursor == nil {
			break
		}
		cursor = *owner.Project.Items.PageInfo.EndCursor
	}
	return rows, total, nil
}

func githubProjectParentSelection(include bool) string {
	if include {
		return "parent { number title url }"
	}
	return ""
}

func projectFieldValuesContinue(raw map[string]interface{}) bool {
	values, _ := raw["fieldValues"].(map[string]interface{})
	pageInfo, _ := values["pageInfo"].(map[string]interface{})
	continued, _ := pageInfo["hasNextPage"].(bool)
	return continued
}

func normalizeGitHubProjectRow(raw map[string]interface{}, position int) map[string]interface{} {
	id, _ := raw["id"].(string)
	if id == "" {
		return nil
	}
	itemType, _ := raw["type"].(string)
	content, _ := raw["content"].(map[string]interface{})
	if content == nil || (itemType != "ISSUE" && itemType != "PULL_REQUEST" && itemType != "DRAFT_ISSUE") {
		itemType = "REDACTED"
		content = map[string]interface{}{}
	}
	title, _ := content["title"].(string)
	if itemType == "REDACTED" {
		title = "Restricted item"
	}
	fieldValuesByID := map[string]interface{}{}
	fieldValues, _ := raw["fieldValues"].(map[string]interface{})
	if pageInfo, _ := fieldValues["pageInfo"].(map[string]interface{}); pageInfo != nil && pageInfo["hasNextPage"] == true {
		return nil
	}
	if nodes, _ := fieldValues["nodes"].([]interface{}); nodes != nil {
		for _, entry := range nodes {
			if value := normalizeGitHubProjectFieldValue(entry); value != nil {
				if fieldID, _ := value["fieldId"].(string); fieldID != "" {
					fieldValuesByID[fieldID] = value
				}
			}
		}
	}
	return map[string]interface{}{
		"id": id, "itemType": itemType, "updatedAt": stringValue(raw["updatedAt"]), "position": position,
		"content": map[string]interface{}{
			"number": nullableNumber(content["number"]), "title": title, "body": nullableString(content["body"]), "url": nullableString(content["url"]),
			"state": nullableString(content["state"]), "stateReason": nullableString(content["stateReason"]), "isDraft": nullableBool(content["isDraft"]),
			"repository": nestedString(content["repository"], "nameWithOwner"), "assignees": nestedNodes(content["assignees"]), "labels": nestedNodes(content["labels"]),
			"parentIssue": nullableObject(content["parent"]), "issueType": nullableObject(content["issueType"]),
		},
		"fieldValuesByFieldId": fieldValuesByID,
	}
}

func normalizeGitHubProjectFieldValue(raw interface{}) map[string]interface{} {
	row, _ := raw.(map[string]interface{})
	if row == nil {
		return nil
	}
	field, _ := row["field"].(map[string]interface{})
	fieldID, _ := field["id"].(string)
	if fieldID == "" {
		return nil
	}
	kind, _ := row["__typename"].(string)
	switch kind {
	case "ProjectV2ItemFieldSingleSelectValue":
		return map[string]interface{}{"kind": "single-select", "fieldId": fieldID, "optionId": stringValue(row["optionId"]), "name": stringValue(row["name"]), "color": stringValue(row["color"])}
	case "ProjectV2ItemFieldIterationValue":
		return map[string]interface{}{"kind": "iteration", "fieldId": fieldID, "iterationId": stringValue(row["iterationId"]), "title": stringValue(row["title"]), "startDate": stringValue(row["startDate"]), "duration": numberValue(row["duration"])}
	case "ProjectV2ItemFieldTextValue":
		return map[string]interface{}{"kind": "text", "fieldId": fieldID, "text": stringValue(row["text"])}
	case "ProjectV2ItemFieldNumberValue":
		return map[string]interface{}{"kind": "number", "fieldId": fieldID, "number": numberValue(row["number"])}
	case "ProjectV2ItemFieldDateValue":
		return map[string]interface{}{"kind": "date", "fieldId": fieldID, "date": stringValue(row["date"])}
	case "ProjectV2ItemFieldLabelValue":
		return map[string]interface{}{"kind": "labels", "fieldId": fieldID, "labels": nestedNodes(row["labels"])}
	case "ProjectV2ItemFieldUserValue":
		return map[string]interface{}{"kind": "users", "fieldId": fieldID, "users": nestedNodes(row["users"])}
	default:
		return nil
	}
}

func stringValue(value interface{}) string  { result, _ := value.(string); return result }
func numberValue(value interface{}) float64 { result, _ := value.(float64); return result }
func nullableString(value interface{}) interface{} {
	if result, ok := value.(string); ok {
		return result
	}
	return nil
}
func nullableNumber(value interface{}) interface{} {
	if result, ok := value.(float64); ok {
		return result
	}
	return nil
}
func nullableBool(value interface{}) interface{} {
	if result, ok := value.(bool); ok {
		return result
	}
	return nil
}
func nullableObject(value interface{}) interface{} {
	if result, ok := value.(map[string]interface{}); ok {
		return result
	}
	return nil
}
func nestedString(value interface{}, key string) interface{} {
	if result := nullableObject(value); result != nil {
		return nullableString(result.(map[string]interface{})[key])
	}
	return nil
}
func nestedNodes(value interface{}) []interface{} {
	if object, ok := value.(map[string]interface{}); ok {
		if nodes, ok := object["nodes"].([]interface{}); ok {
			return nodes
		}
	}
	return []interface{}{}
}
