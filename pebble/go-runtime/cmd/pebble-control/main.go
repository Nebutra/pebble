package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
)

func main() {
	endpoint := flag.String("endpoint", "http://127.0.0.1:17777", "runtime endpoint")
	token := flag.String("token", os.Getenv("PEBBLE_RUNTIME_TOKEN"), "runtime bearer token")
	flag.Parse()
	args := flag.Args()
	if len(args) == 0 {
		usage()
		os.Exit(2)
	}
	client := controlClient{endpoint: strings.TrimRight(*endpoint, "/"), token: strings.TrimSpace(*token), http: http.DefaultClient}
	if err := run(client, args); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

type controlClient struct {
	endpoint string
	token    string
	http     *http.Client
}

func run(client controlClient, args []string) error {
	switch args[0] {
	case "status":
		return client.printJSON(http.MethodGet, "/v1/status", nil)
	case "events":
		return runEvents(client, args[1:])
	case "project":
		return runProject(client, args[1:])
	case "worktree":
		return runWorktree(client, args[1:])
	case "session":
		return runSession(client, args[1:])
	case "agent":
		return runAgent(client, args[1:])
	case "task":
		return runTask(client, args[1:])
	case "message":
		return runMessage(client, args[1:])
	case "dispatch":
		return runDispatch(client, args[1:])
	case "automation":
		return runAutomation(client, args[1:])
	case "external-task":
		return runExternalTask(client, args[1:])
	case "file":
		return runFile(client, args[1:])
	case "release":
		return runRelease(client, args[1:])
	case "settings":
		return runSettings(client, args[1:])
	case "source-control":
		return runSourceControl(client, args[1:])
	case "browser":
		return runBrowser(client, args[1:])
	case "computer":
		return runComputer(client, args[1:])
	case "emulator":
		return runEmulator(client, args[1:])
	case "mobile-relay":
		return runMobileRelay(client, args[1:])
	case "git":
		return runGit(client, args[1:])
	case "provider":
		return runProvider(client, args[1:])
	case "subsystem":
		return runSubsystem(client, args[1:])
	default:
		usage()
		return fmt.Errorf("unknown command %q", args[0])
	}
}

func runEvents(client controlClient, args []string) error {
	fs := flag.NewFlagSet("events", flag.ExitOnError)
	limit := fs.Int("limit", 0, "number of events to print, or 0 to stream until interrupted")
	topic := fs.String("topic", "", "only print events with this topic")
	raw := fs.Bool("raw", false, "print server-sent event frames")
	_ = fs.Parse(args)
	return client.streamEvents(*limit, strings.TrimSpace(*topic), *raw)
}

func runProject(client controlClient, args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("project command is required")
	}
	switch args[0] {
	case "list":
		return client.printJSON(http.MethodGet, "/v1/projects", nil)
	case "update":
		fs := flag.NewFlagSet("project update", flag.ExitOnError)
		id := fs.String("id", "", "project id")
		name := fs.String("name", "", "project name")
		path := fs.String("path", "", "project path")
		location := fs.String("location", "", "local or ssh")
		host := fs.String("host", "", "remote host id")
		provider := fs.String("provider", "", "source provider")
		_ = fs.Parse(args[1:])
		payload := map[string]string{
			"name":         *name,
			"path":         *path,
			"locationKind": *location,
			"hostId":       *host,
			"provider":     *provider,
		}
		return client.printJSON(http.MethodPatch, "/v1/projects/"+url.PathEscape(*id), payload)
	case "delete":
		fs := flag.NewFlagSet("project delete", flag.ExitOnError)
		id := fs.String("id", "", "project id")
		_ = fs.Parse(args[1:])
		return client.printJSON(http.MethodDelete, "/v1/projects/"+url.PathEscape(*id), nil)
	case "add":
		fs := flag.NewFlagSet("project add", flag.ExitOnError)
		name := fs.String("name", "", "project name")
		path := fs.String("path", "", "project path")
		location := fs.String("location", "local", "local or ssh")
		host := fs.String("host", "", "remote host id")
		provider := fs.String("provider", "", "source provider")
		_ = fs.Parse(args[1:])
		payload := map[string]string{
			"name":         *name,
			"path":         *path,
			"locationKind": *location,
			"hostId":       *host,
			"provider":     *provider,
		}
		return client.printJSON(http.MethodPost, "/v1/projects", payload)
	default:
		return fmt.Errorf("unknown project command %q", args[0])
	}
}

func runWorktree(client controlClient, args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("worktree command is required")
	}
	switch args[0] {
	case "list":
		fs := flag.NewFlagSet("worktree list", flag.ExitOnError)
		projectID := fs.String("project", "", "project id")
		_ = fs.Parse(args[1:])
		path := "/v1/worktrees"
		if *projectID != "" {
			path += "?projectId=" + url.QueryEscape(*projectID)
		}
		return client.printJSON(http.MethodGet, path, nil)
	case "add":
		fs := flag.NewFlagSet("worktree add", flag.ExitOnError)
		projectID := fs.String("project", "", "project id")
		path := fs.String("path", "", "worktree path")
		branch := fs.String("branch", "", "branch name")
		base := fs.String("base", "", "base ref")
		executeGit := fs.Bool("execute-git", false, "run git worktree add")
		_ = fs.Parse(args[1:])
		payload := map[string]interface{}{
			"projectId":  *projectID,
			"path":       *path,
			"branch":     *branch,
			"base":       *base,
			"executeGit": *executeGit,
		}
		return client.printJSON(http.MethodPost, "/v1/worktrees", payload)
	case "delete":
		fs := flag.NewFlagSet("worktree delete", flag.ExitOnError)
		id := fs.String("id", "", "worktree id")
		_ = fs.Parse(args[1:])
		return client.printJSON(http.MethodDelete, "/v1/worktrees/"+url.PathEscape(*id), nil)
	default:
		return fmt.Errorf("unknown worktree command %q", args[0])
	}
}

func runSession(client controlClient, args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("session command is required")
	}
	switch args[0] {
	case "list":
		return client.printJSON(http.MethodGet, "/v1/sessions", nil)
	case "start":
		fs := flag.NewFlagSet("session start", flag.ExitOnError)
		projectID := fs.String("project", "", "project id")
		worktreeID := fs.String("worktree", "", "worktree id")
		cwd := fs.String("cwd", "", "working directory")
		command := fs.String("command", "", "command, split by spaces")
		agentKind := fs.String("agent", "", "agent kind")
		prompt := fs.String("prompt", "", "initial prompt")
		_ = fs.Parse(args[1:])
		payload := map[string]interface{}{
			"projectId":  *projectID,
			"worktreeId": *worktreeID,
			"cwd":        *cwd,
			"command":    splitCommand(*command),
			"agentKind":  *agentKind,
			"prompt":     *prompt,
		}
		return client.printJSON(http.MethodPost, "/v1/sessions", payload)
	case "input":
		fs := flag.NewFlagSet("session input", flag.ExitOnError)
		id := fs.String("id", "", "session id")
		text := fs.String("text", "", "input text")
		newline := fs.Bool("newline", true, "append newline")
		_ = fs.Parse(args[1:])
		payload := map[string]interface{}{"text": *text, "appendNewline": *newline}
		return client.printJSON(http.MethodPost, "/v1/sessions/"+url.PathEscape(*id)+"/input", payload)
	case "tail":
		fs := flag.NewFlagSet("session tail", flag.ExitOnError)
		id := fs.String("id", "", "session id")
		limit := fs.String("limit", "200", "chunk limit")
		_ = fs.Parse(args[1:])
		return client.printJSON(http.MethodGet, "/v1/sessions/"+url.PathEscape(*id)+"/tail?limit="+url.QueryEscape(*limit), nil)
	case "stop":
		fs := flag.NewFlagSet("session stop", flag.ExitOnError)
		id := fs.String("id", "", "session id")
		_ = fs.Parse(args[1:])
		return client.printJSON(http.MethodDelete, "/v1/sessions/"+url.PathEscape(*id), nil)
	default:
		return fmt.Errorf("unknown session command %q", args[0])
	}
}

func runAgent(client controlClient, args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("agent command is required")
	}
	switch args[0] {
	case "profile-list":
		return client.printJSON(http.MethodGet, "/v1/agents/profiles", nil)
	case "profile-add":
		fs := flag.NewFlagSet("agent profile-add", flag.ExitOnError)
		name := fs.String("name", "", "agent name")
		kind := fs.String("kind", "", "agent kind")
		command := fs.String("command", "", "agent command, split by spaces")
		mode := fs.String("mode", "argv", "prompt injection mode")
		promptFlag := fs.String("prompt-flag", "", "prompt flag")
		_ = fs.Parse(args[1:])
		payload := map[string]interface{}{
			"name":                *name,
			"kind":                *kind,
			"command":             splitCommand(*command),
			"promptInjectionMode": *mode,
			"promptFlag":          *promptFlag,
		}
		return client.printJSON(http.MethodPost, "/v1/agents/profiles", payload)
	case "profile-update":
		fs := flag.NewFlagSet("agent profile-update", flag.ExitOnError)
		id := fs.String("id", "", "agent profile id")
		name := fs.String("name", "", "agent name")
		kind := fs.String("kind", "", "agent kind")
		command := fs.String("command", "", "agent command, split by spaces")
		mode := fs.String("mode", "", "prompt injection mode")
		promptFlag := fs.String("prompt-flag", "", "prompt flag")
		_ = fs.Parse(args[1:])
		payload := map[string]interface{}{
			"name":                *name,
			"kind":                *kind,
			"command":             splitCommand(*command),
			"promptInjectionMode": *mode,
			"promptFlag":          *promptFlag,
		}
		return client.printJSON(http.MethodPatch, "/v1/agents/profiles/"+url.PathEscape(*id), payload)
	case "profile-delete":
		fs := flag.NewFlagSet("agent profile-delete", flag.ExitOnError)
		id := fs.String("id", "", "agent profile id")
		_ = fs.Parse(args[1:])
		return client.printJSON(http.MethodDelete, "/v1/agents/profiles/"+url.PathEscape(*id), nil)
	case "run-list":
		return client.printJSON(http.MethodGet, "/v1/agents/runs", nil)
	case "run":
		fs := flag.NewFlagSet("agent run", flag.ExitOnError)
		profileID := fs.String("profile", "", "agent profile id")
		projectID := fs.String("project", "", "project id")
		worktreeID := fs.String("worktree", "", "worktree id")
		cwd := fs.String("cwd", "", "working directory")
		prompt := fs.String("prompt", "", "prompt")
		_ = fs.Parse(args[1:])
		payload := map[string]string{
			"profileId":  *profileID,
			"projectId":  *projectID,
			"worktreeId": *worktreeID,
			"cwd":        *cwd,
			"prompt":     *prompt,
		}
		return client.printJSON(http.MethodPost, "/v1/agents/runs", payload)
	case "run-stop":
		fs := flag.NewFlagSet("agent run-stop", flag.ExitOnError)
		id := fs.String("id", "", "agent run id")
		_ = fs.Parse(args[1:])
		return client.printJSON(http.MethodDelete, "/v1/agents/runs/"+url.PathEscape(*id), nil)
	default:
		return fmt.Errorf("unknown agent command %q", args[0])
	}
}

func runTask(client controlClient, args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("task command is required")
	}
	switch args[0] {
	case "list":
		return client.printJSON(http.MethodGet, "/v1/orchestration/tasks", nil)
	case "add":
		fs := flag.NewFlagSet("task add", flag.ExitOnError)
		title := fs.String("title", "", "task title")
		body := fs.String("body", "", "task body")
		assignee := fs.String("assignee", "", "assignee")
		_ = fs.Parse(args[1:])
		payload := map[string]string{"title": *title, "body": *body, "assignee": *assignee}
		return client.printJSON(http.MethodPost, "/v1/orchestration/tasks", payload)
	case "update":
		fs := flag.NewFlagSet("task update", flag.ExitOnError)
		id := fs.String("id", "", "task id")
		status := fs.String("status", "", "task status")
		assignee := fs.String("assignee", "", "assignee")
		_ = fs.Parse(args[1:])
		payload := map[string]string{"status": *status, "assignee": *assignee}
		return client.printJSON(http.MethodPatch, "/v1/orchestration/tasks/"+url.PathEscape(*id), payload)
	default:
		return fmt.Errorf("unknown task command %q", args[0])
	}
}

func runMessage(client controlClient, args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("message command is required")
	}
	switch args[0] {
	case "list":
		fs := flag.NewFlagSet("message list", flag.ExitOnError)
		to := fs.String("to", "", "recipient")
		unread := fs.Bool("unread", false, "only unread messages")
		_ = fs.Parse(args[1:])
		query := url.Values{}
		if *to != "" {
			query.Set("to", *to)
		}
		if *unread {
			query.Set("unread", "true")
		}
		path := "/v1/orchestration/messages"
		if encoded := query.Encode(); encoded != "" {
			path += "?" + encoded
		}
		return client.printJSON(http.MethodGet, path, nil)
	case "send":
		fs := flag.NewFlagSet("message send", flag.ExitOnError)
		to := fs.String("to", "", "recipient")
		from := fs.String("from", "", "sender")
		subject := fs.String("subject", "", "subject")
		body := fs.String("body", "", "body")
		messageType := fs.String("type", "status", "message type")
		priority := fs.String("priority", "", "priority")
		_ = fs.Parse(args[1:])
		payload := map[string]string{
			"to":       *to,
			"from":     *from,
			"subject":  *subject,
			"body":     *body,
			"type":     *messageType,
			"priority": *priority,
		}
		return client.printJSON(http.MethodPost, "/v1/orchestration/messages", payload)
	case "reply":
		fs := flag.NewFlagSet("message reply", flag.ExitOnError)
		id := fs.String("id", "", "message id")
		from := fs.String("from", "", "sender")
		body := fs.String("body", "", "body")
		subject := fs.String("subject", "", "subject")
		_ = fs.Parse(args[1:])
		payload := map[string]string{"from": *from, "body": *body, "subject": *subject}
		return client.printJSON(http.MethodPost, "/v1/orchestration/messages/"+url.PathEscape(*id)+"/reply", payload)
	default:
		return fmt.Errorf("unknown message command %q", args[0])
	}
}

func runDispatch(client controlClient, args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("dispatch command is required")
	}
	switch args[0] {
	case "list":
		fs := flag.NewFlagSet("dispatch list", flag.ExitOnError)
		taskID := fs.String("task", "", "task id")
		_ = fs.Parse(args[1:])
		path := "/v1/orchestration/dispatches"
		if *taskID != "" {
			path += "?taskId=" + url.QueryEscape(*taskID)
		}
		return client.printJSON(http.MethodGet, path, nil)
	case "add":
		fs := flag.NewFlagSet("dispatch add", flag.ExitOnError)
		taskID := fs.String("task", "", "task id")
		assignee := fs.String("assignee", "", "assignee")
		sessionID := fs.String("session", "", "session id")
		inject := fs.Bool("inject", false, "create injected preamble")
		_ = fs.Parse(args[1:])
		payload := map[string]interface{}{
			"taskId":    *taskID,
			"assignee":  *assignee,
			"sessionId": *sessionID,
			"inject":    *inject,
		}
		return client.printJSON(http.MethodPost, "/v1/orchestration/dispatches", payload)
	case "update":
		fs := flag.NewFlagSet("dispatch update", flag.ExitOnError)
		id := fs.String("id", "", "dispatch id")
		status := fs.String("status", "", "dispatch status")
		_ = fs.Parse(args[1:])
		payload := map[string]string{"status": *status}
		return client.printJSON(http.MethodPatch, "/v1/orchestration/dispatches/"+url.PathEscape(*id), payload)
	default:
		return fmt.Errorf("unknown dispatch command %q", args[0])
	}
}

func runAutomation(client controlClient, args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("automation command is required")
	}
	switch args[0] {
	case "list":
		return client.printJSON(http.MethodGet, "/v1/automations", nil)
	case "add":
		fs := flag.NewFlagSet("automation add", flag.ExitOnError)
		name := fs.String("name", "", "automation name")
		description := fs.String("description", "", "automation description")
		enabled := fs.Bool("enabled", true, "enable automation")
		schedule := fs.String("schedule", "manual", "manual or interval")
		interval := fs.Int64("interval-seconds", 0, "interval seconds for interval schedules")
		cron := fs.String("cron", "", "cron expression for cron schedules")
		eventTopic := fs.String("event-topic", "", "event topic for event schedules")
		timezone := fs.String("timezone", "", "schedule timezone")
		action := fs.String("action", "", "createTask, sendMessage, dispatchTask, startAgentRun, or computerAction")
		payloadJSON := fs.String("payload", "", "action payload JSON object")
		_ = fs.Parse(args[1:])
		payload, err := parseJSONMap(*payloadJSON)
		if err != nil {
			return err
		}
		body := map[string]interface{}{
			"name":        *name,
			"description": *description,
			"enabled":     *enabled,
			"schedule":    automationSchedulePayload(*schedule, *interval, *cron, *eventTopic, *timezone),
			"action": map[string]interface{}{
				"kind":    *action,
				"payload": payload,
			},
		}
		return client.printJSON(http.MethodPost, "/v1/automations", body)
	case "update":
		fs := flag.NewFlagSet("automation update", flag.ExitOnError)
		id := fs.String("id", "", "automation id")
		name := fs.String("name", "", "automation name")
		description := fs.String("description", "", "automation description")
		enabled := fs.String("enabled", "", "true or false")
		schedule := fs.String("schedule", "", "manual or interval")
		interval := fs.Int64("interval-seconds", 0, "interval seconds for interval schedules")
		cron := fs.String("cron", "", "cron expression for cron schedules")
		eventTopic := fs.String("event-topic", "", "event topic for event schedules")
		timezone := fs.String("timezone", "", "schedule timezone")
		action := fs.String("action", "", "createTask, sendMessage, dispatchTask, startAgentRun, or computerAction")
		payloadJSON := fs.String("payload", "", "action payload JSON object")
		_ = fs.Parse(args[1:])
		body := map[string]interface{}{
			"name":        *name,
			"description": *description,
		}
		if *enabled != "" {
			parsed, err := parseBoolString(*enabled)
			if err != nil {
				return err
			}
			body["enabled"] = parsed
		}
		if flagWasSet(fs, "schedule") {
			body["schedule"] = automationSchedulePayload(*schedule, *interval, *cron, *eventTopic, *timezone)
		}
		if flagWasSet(fs, "action") {
			payload, err := parseJSONMap(*payloadJSON)
			if err != nil {
				return err
			}
			body["action"] = map[string]interface{}{
				"kind":    *action,
				"payload": payload,
			}
		}
		return client.printJSON(http.MethodPatch, "/v1/automations/"+url.PathEscape(*id), body)
	case "delete":
		fs := flag.NewFlagSet("automation delete", flag.ExitOnError)
		id := fs.String("id", "", "automation id")
		_ = fs.Parse(args[1:])
		return client.printJSON(http.MethodDelete, "/v1/automations/"+url.PathEscape(*id), nil)
	case "runs":
		fs := flag.NewFlagSet("automation runs", flag.ExitOnError)
		automationID := fs.String("automation", "", "automation id")
		_ = fs.Parse(args[1:])
		path := "/v1/automations/runs"
		if *automationID != "" {
			path += "?automationId=" + url.QueryEscape(*automationID)
		}
		return client.printJSON(http.MethodGet, path, nil)
	case "trigger":
		fs := flag.NewFlagSet("automation trigger", flag.ExitOnError)
		id := fs.String("id", "", "automation id")
		reason := fs.String("reason", "manual", "manual, schedule, or event")
		payloadJSON := fs.String("payload", "", "run payload JSON object")
		_ = fs.Parse(args[1:])
		payload, err := parseJSONMap(*payloadJSON)
		if err != nil {
			return err
		}
		body := map[string]interface{}{"reason": *reason, "payload": payload}
		return client.printJSON(http.MethodPost, "/v1/automations/"+url.PathEscape(*id)+"/runs", body)
	case "evaluate":
		return client.printJSON(http.MethodPost, "/v1/automations/evaluate", map[string]interface{}{})
	default:
		return fmt.Errorf("unknown automation command %q", args[0])
	}
}

func runExternalTask(client controlClient, args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("external-task command is required")
	}
	switch args[0] {
	case "list":
		fs := flag.NewFlagSet("external-task list", flag.ExitOnError)
		provider := fs.String("provider", "", "provider filter")
		kind := fs.String("kind", "", "issue, ticket, or review")
		projectID := fs.String("project", "", "project id")
		taskID := fs.String("task", "", "internal task id")
		repositoryID := fs.String("repository", "", "repository id")
		workspaceID := fs.String("workspace", "", "workspace id")
		_ = fs.Parse(args[1:])
		query := url.Values{}
		if *provider != "" {
			query.Set("provider", *provider)
		}
		if *kind != "" {
			query.Set("kind", *kind)
		}
		if *projectID != "" {
			query.Set("projectId", *projectID)
		}
		if *taskID != "" {
			query.Set("taskId", *taskID)
		}
		if *repositoryID != "" {
			query.Set("repositoryId", *repositoryID)
		}
		if *workspaceID != "" {
			query.Set("workspaceId", *workspaceID)
		}
		path := "/v1/external-tasks"
		if encoded := query.Encode(); encoded != "" {
			path += "?" + encoded
		}
		return client.printJSON(http.MethodGet, path, nil)
	case "upsert":
		fs := flag.NewFlagSet("external-task upsert", flag.ExitOnError)
		provider := fs.String("provider", "", "linear, jira, github, gitlab, bitbucket, azure-devops, or generic")
		kind := fs.String("kind", "", "issue, ticket, or review")
		externalID := fs.String("external-id", "", "provider item id")
		itemURL := fs.String("url", "", "provider item url")
		title := fs.String("title", "", "item title")
		status := fs.String("status", "", "open, inProgress, closed, merged, blocked, or unknown")
		assignee := fs.String("assignee", "", "assignee")
		projectID := fs.String("project", "", "project id")
		taskID := fs.String("task", "", "internal task id")
		createTask := fs.Bool("create-task", false, "create an internal orchestration task when task is empty")
		repositoryID := fs.String("repository", "", "repository id")
		workspaceID := fs.String("workspace", "", "workspace id")
		reviewKind := fs.String("review-kind", "", "provider review kind")
		metadataJSON := fs.String("metadata", "", "metadata JSON object")
		_ = fs.Parse(args[1:])
		metadata, err := parseJSONMap(*metadataJSON)
		if err != nil {
			return err
		}
		payload := map[string]interface{}{
			"provider":     *provider,
			"kind":         *kind,
			"externalId":   *externalID,
			"url":          *itemURL,
			"title":        *title,
			"status":       *status,
			"assignee":     *assignee,
			"projectId":    *projectID,
			"taskId":       *taskID,
			"createTask":   *createTask,
			"repositoryId": *repositoryID,
			"workspaceId":  *workspaceID,
			"reviewKind":   *reviewKind,
			"metadata":     metadata,
		}
		return client.printJSON(http.MethodPost, "/v1/external-tasks", payload)
	case "update":
		fs := flag.NewFlagSet("external-task update", flag.ExitOnError)
		id := fs.String("id", "", "external task id")
		itemURL := fs.String("url", "", "provider item url")
		title := fs.String("title", "", "item title")
		status := fs.String("status", "", "open, inProgress, closed, merged, blocked, or unknown")
		assignee := fs.String("assignee", "", "assignee")
		projectID := fs.String("project", "", "project id")
		taskID := fs.String("task", "", "internal task id")
		repositoryID := fs.String("repository", "", "repository id")
		workspaceID := fs.String("workspace", "", "workspace id")
		reviewKind := fs.String("review-kind", "", "provider review kind")
		metadataJSON := fs.String("metadata", "", "metadata JSON object")
		_ = fs.Parse(args[1:])
		metadata, err := parseJSONMap(*metadataJSON)
		if err != nil {
			return err
		}
		payload := map[string]interface{}{
			"url":          *itemURL,
			"title":        *title,
			"status":       *status,
			"assignee":     *assignee,
			"projectId":    *projectID,
			"taskId":       *taskID,
			"repositoryId": *repositoryID,
			"workspaceId":  *workspaceID,
			"reviewKind":   *reviewKind,
			"metadata":     metadata,
		}
		return client.printJSON(http.MethodPatch, "/v1/external-tasks/"+url.PathEscape(*id), payload)
	case "delete":
		fs := flag.NewFlagSet("external-task delete", flag.ExitOnError)
		id := fs.String("id", "", "external task id")
		_ = fs.Parse(args[1:])
		return client.printJSON(http.MethodDelete, "/v1/external-tasks/"+url.PathEscape(*id), nil)
	default:
		return fmt.Errorf("unknown external-task command %q", args[0])
	}
}

func runFile(client controlClient, args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("file command is required")
	}
	switch args[0] {
	case "tree":
		fs := flag.NewFlagSet("file tree", flag.ExitOnError)
		projectID := fs.String("project", "", "project id")
		worktreeID := fs.String("worktree", "", "worktree id")
		path := fs.String("path", "", "workspace-relative path")
		maxDepth := fs.Int("max-depth", 1, "maximum directory depth")
		_ = fs.Parse(args[1:])
		query := url.Values{}
		query.Set("projectId", *projectID)
		if *worktreeID != "" {
			query.Set("worktreeId", *worktreeID)
		}
		if *path != "" {
			query.Set("path", *path)
		}
		query.Set("maxDepth", fmt.Sprintf("%d", *maxDepth))
		return client.printJSON(http.MethodGet, "/v1/files/tree?"+query.Encode(), nil)
	case "read":
		fs := flag.NewFlagSet("file read", flag.ExitOnError)
		projectID := fs.String("project", "", "project id")
		worktreeID := fs.String("worktree", "", "worktree id")
		path := fs.String("path", "", "workspace-relative path")
		maxBytes := fs.Int64("max-bytes", 0, "maximum bytes to read")
		_ = fs.Parse(args[1:])
		query := url.Values{}
		query.Set("projectId", *projectID)
		query.Set("path", *path)
		if *worktreeID != "" {
			query.Set("worktreeId", *worktreeID)
		}
		if *maxBytes > 0 {
			query.Set("maxBytes", fmt.Sprintf("%d", *maxBytes))
		}
		return client.printJSON(http.MethodGet, "/v1/files/read?"+query.Encode(), nil)
	case "write":
		fs := flag.NewFlagSet("file write", flag.ExitOnError)
		projectID := fs.String("project", "", "project id")
		worktreeID := fs.String("worktree", "", "worktree id")
		path := fs.String("path", "", "workspace-relative path")
		content := fs.String("content", "", "file content")
		createDirs := fs.Bool("create-dirs", false, "create parent directories")
		_ = fs.Parse(args[1:])
		payload := map[string]interface{}{
			"projectId":  *projectID,
			"worktreeId": *worktreeID,
			"path":       *path,
			"content":    *content,
			"createDirs": *createDirs,
		}
		return client.printJSON(http.MethodPost, "/v1/files/write", payload)
	case "tree-update":
		fs := flag.NewFlagSet("file tree-update", flag.ExitOnError)
		projectID := fs.String("project", "", "project id")
		worktreeID := fs.String("worktree", "", "worktree id")
		path := fs.String("path", "", "workspace-relative path")
		entriesJSON := fs.String("entries", "[]", "file entry JSON array")
		_ = fs.Parse(args[1:])
		entries, err := parseJSONArray(*entriesJSON)
		if err != nil {
			return err
		}
		payload := map[string]interface{}{
			"projectId":  *projectID,
			"worktreeId": *worktreeID,
			"path":       *path,
			"entries":    entries,
		}
		return client.printJSON(http.MethodPost, "/v1/files/tree-snapshots", payload)
	case "content-update":
		fs := flag.NewFlagSet("file content-update", flag.ExitOnError)
		projectID := fs.String("project", "", "project id")
		worktreeID := fs.String("worktree", "", "worktree id")
		path := fs.String("path", "", "workspace-relative path")
		content := fs.String("content", "", "file content")
		encoding := fs.String("encoding", "utf-8", "file encoding")
		_ = fs.Parse(args[1:])
		payload := map[string]interface{}{
			"projectId":  *projectID,
			"worktreeId": *worktreeID,
			"path":       *path,
			"content":    *content,
			"encoding":   *encoding,
		}
		return client.printJSON(http.MethodPost, "/v1/files/content-snapshots", payload)
	default:
		return fmt.Errorf("unknown file command %q", args[0])
	}
}

func runRelease(client controlClient, args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("release command is required")
	}
	switch args[0] {
	case "list":
		return client.printJSON(http.MethodGet, "/v1/releases", nil)
	case "create":
		fs := flag.NewFlagSet("release create", flag.ExitOnError)
		version := fs.String("version", "", "release version")
		channel := fs.String("channel", "stable", "release channel")
		_ = fs.Parse(args[1:])
		payload := map[string]string{"version": *version, "channel": *channel}
		return client.printJSON(http.MethodPost, "/v1/releases", payload)
	case "update":
		fs := flag.NewFlagSet("release update", flag.ExitOnError)
		id := fs.String("id", "", "release id")
		channel := fs.String("channel", "", "release channel")
		status := fs.String("status", "", "draft or blocked; ready and published are computed")
		manifest := fs.String("manifest", "", "update manifest uri")
		_ = fs.Parse(args[1:])
		payload := map[string]string{
			"channel":           *channel,
			"status":            *status,
			"updateManifestUri": *manifest,
		}
		return client.printJSON(http.MethodPatch, "/v1/releases/"+url.PathEscape(*id), payload)
	case "artifact":
		fs := flag.NewFlagSet("release artifact", flag.ExitOnError)
		id := fs.String("id", "", "release id")
		platform := fs.String("platform", "", "artifact platform")
		kind := fs.String("kind", "", "artifact kind")
		name := fs.String("name", "", "artifact name")
		artifactURI := fs.String("uri", "", "artifact uri")
		sha256 := fs.String("sha256", "", "artifact sha256")
		size := fs.Int64("size", 0, "artifact size")
		signed := fs.Bool("signed", false, "artifact is signed")
		notarized := fs.Bool("notarized", false, "artifact is notarized")
		_ = fs.Parse(args[1:])
		payload := map[string]interface{}{
			"platform":  *platform,
			"kind":      *kind,
			"name":      *name,
			"uri":       *artifactURI,
			"sha256":    *sha256,
			"size":      *size,
			"signed":    *signed,
			"notarized": *notarized,
		}
		return client.printJSON(http.MethodPost, "/v1/releases/"+url.PathEscape(*id)+"/artifacts", payload)
	case "check":
		fs := flag.NewFlagSet("release check", flag.ExitOnError)
		id := fs.String("id", "", "release id")
		name := fs.String("name", "", "check name")
		status := fs.String("status", "", "pending, passed, or failed")
		message := fs.String("message", "", "check message")
		_ = fs.Parse(args[1:])
		payload := map[string]string{"name": *name, "status": *status, "message": *message}
		return client.printJSON(http.MethodPost, "/v1/releases/"+url.PathEscape(*id)+"/checks", payload)
	case "manifest":
		fs := flag.NewFlagSet("release manifest", flag.ExitOnError)
		id := fs.String("id", "", "release id")
		_ = fs.Parse(args[1:])
		return client.printJSON(http.MethodGet, "/v1/releases/"+url.PathEscape(*id)+"/manifest", nil)
	case "publish":
		fs := flag.NewFlagSet("release publish", flag.ExitOnError)
		id := fs.String("id", "", "release id")
		force := fs.Bool("force", false, "publish even if checks are incomplete")
		_ = fs.Parse(args[1:])
		payload := map[string]bool{"force": *force}
		return client.printJSON(http.MethodPost, "/v1/releases/"+url.PathEscape(*id)+"/publish", payload)
	default:
		return fmt.Errorf("unknown release command %q", args[0])
	}
}

func runSettings(client controlClient, args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("settings command is required")
	}
	switch args[0] {
	case "list":
		fs := flag.NewFlagSet("settings list", flag.ExitOnError)
		scope := fs.String("scope", "", "global, project, or workspace")
		projectID := fs.String("project", "", "project id")
		workspaceID := fs.String("workspace", "", "workspace id")
		key := fs.String("key", "", "setting key")
		_ = fs.Parse(args[1:])
		query := url.Values{}
		if *scope != "" {
			query.Set("scope", *scope)
		}
		if *projectID != "" {
			query.Set("projectId", *projectID)
		}
		if *workspaceID != "" {
			query.Set("workspaceId", *workspaceID)
		}
		if *key != "" {
			query.Set("key", *key)
		}
		path := "/v1/settings"
		if encoded := query.Encode(); encoded != "" {
			path += "?" + encoded
		}
		return client.printJSON(http.MethodGet, path, nil)
	case "set":
		fs := flag.NewFlagSet("settings set", flag.ExitOnError)
		scope := fs.String("scope", "global", "global, project, or workspace")
		projectID := fs.String("project", "", "project id")
		workspaceID := fs.String("workspace", "", "workspace id")
		key := fs.String("key", "", "setting key")
		valueJSON := fs.String("value", "{}", "setting value JSON object")
		_ = fs.Parse(args[1:])
		value, err := parseJSONMap(*valueJSON)
		if err != nil {
			return err
		}
		payload := map[string]interface{}{
			"scope":       *scope,
			"projectId":   *projectID,
			"workspaceId": *workspaceID,
			"key":         *key,
			"value":       value,
		}
		return client.printJSON(http.MethodPost, "/v1/settings", payload)
	case "keybindings":
		fs := flag.NewFlagSet("settings keybindings", flag.ExitOnError)
		platform := fs.String("platform", "", "all, macos, windows, or linux")
		context := fs.String("context", "", "keybinding context")
		command := fs.String("command", "", "command filter")
		_ = fs.Parse(args[1:])
		query := url.Values{}
		if *platform != "" {
			query.Set("platform", *platform)
		}
		if *context != "" {
			query.Set("context", *context)
		}
		if *command != "" {
			query.Set("command", *command)
		}
		path := "/v1/settings/keybindings"
		if encoded := query.Encode(); encoded != "" {
			path += "?" + encoded
		}
		return client.printJSON(http.MethodGet, path, nil)
	case "keybinding-set":
		fs := flag.NewFlagSet("settings keybinding-set", flag.ExitOnError)
		command := fs.String("command", "", "command id")
		accelerator := fs.String("accelerator", "", "platform-neutral accelerator, e.g. CmdOrCtrl+Shift+P")
		platform := fs.String("platform", "", "all, macos, windows, or linux")
		context := fs.String("context", "", "keybinding context")
		enabled := fs.String("enabled", "", "true or false")
		_ = fs.Parse(args[1:])
		payload := map[string]interface{}{
			"command":     *command,
			"accelerator": *accelerator,
			"platform":    *platform,
			"context":     *context,
		}
		if *enabled != "" {
			parsed, err := parseBoolString(*enabled)
			if err != nil {
				return err
			}
			payload["enabled"] = parsed
		}
		return client.printJSON(http.MethodPost, "/v1/settings/keybindings", payload)
	default:
		return fmt.Errorf("unknown settings command %q", args[0])
	}
}

func runBrowser(client controlClient, args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("browser command is required")
	}
	switch args[0] {
	case "tabs":
		return client.printJSON(http.MethodGet, "/v1/browser/tabs", nil)
	case "profiles":
		return client.printJSON(http.MethodGet, "/v1/browser/profiles", nil)
	case "profile-add":
		fs := flag.NewFlagSet("browser profile-add", flag.ExitOnError)
		name := fs.String("name", "", "profile name")
		persistent := fs.Bool("persistent", false, "persist browser profile storage")
		_ = fs.Parse(args[1:])
		payload := map[string]interface{}{"name": *name, "persistent": *persistent}
		return client.printJSON(http.MethodPost, "/v1/browser/profiles", payload)
	case "permission-set":
		fs := flag.NewFlagSet("browser permission-set", flag.ExitOnError)
		profileID := fs.String("profile", "", "profile id")
		origin := fs.String("origin", "", "permission origin")
		name := fs.String("name", "", "permission name")
		state := fs.String("state", "", "prompt, granted, or denied")
		_ = fs.Parse(args[1:])
		payload := map[string]string{
			"profileId": *profileID,
			"origin":    *origin,
			"name":      *name,
			"state":     *state,
		}
		return client.printJSON(http.MethodPost, "/v1/browser/permissions", payload)
	case "downloads":
		fs := flag.NewFlagSet("browser downloads", flag.ExitOnError)
		tabID := fs.String("tab", "", "tab id")
		_ = fs.Parse(args[1:])
		path := "/v1/browser/downloads"
		if *tabID != "" {
			path += "?tabId=" + url.QueryEscape(*tabID)
		}
		return client.printJSON(http.MethodGet, path, nil)
	case "download-add":
		fs := flag.NewFlagSet("browser download-add", flag.ExitOnError)
		tabID := fs.String("tab", "", "tab id")
		downloadURL := fs.String("url", "", "download url")
		filename := fs.String("filename", "", "download filename")
		path := fs.String("path", "", "download path")
		status := fs.String("status", "", "download status")
		_ = fs.Parse(args[1:])
		payload := map[string]string{
			"tabId":    *tabID,
			"url":      *downloadURL,
			"filename": *filename,
			"path":     *path,
			"status":   *status,
		}
		return client.printJSON(http.MethodPost, "/v1/browser/downloads", payload)
	case "download-start":
		fs := flag.NewFlagSet("browser download-start", flag.ExitOnError)
		id := fs.String("id", "", "download id")
		_ = fs.Parse(args[1:])
		return client.printJSON(http.MethodPost, "/v1/browser/downloads/"+url.PathEscape(*id)+"/commands/start", nil)
	case "download-update":
		fs := flag.NewFlagSet("browser download-update", flag.ExitOnError)
		id := fs.String("id", "", "download id")
		status := fs.String("status", "", "download status")
		filename := fs.String("filename", "", "download filename")
		path := fs.String("path", "", "download path")
		bytesReceived := fs.Int64("bytes-received", 0, "downloaded bytes")
		totalBytes := fs.Int64("total-bytes", 0, "total download bytes")
		errMsg := fs.String("error", "", "download error")
		_ = fs.Parse(args[1:])
		payload := map[string]interface{}{"status": *status, "path": *path, "error": *errMsg}
		if *filename != "" {
			payload["filename"] = *filename
		}
		if flagWasSet(fs, "bytes-received") {
			payload["bytesReceived"] = *bytesReceived
		}
		if flagWasSet(fs, "total-bytes") {
			payload["totalBytes"] = *totalBytes
		}
		return client.printJSON(http.MethodPatch, "/v1/browser/downloads/"+url.PathEscape(*id), payload)
	case "open":
		fs := flag.NewFlagSet("browser open", flag.ExitOnError)
		projectID := fs.String("project", "", "project id")
		worktreeID := fs.String("worktree", "", "worktree id")
		profileID := fs.String("profile", "", "profile id")
		title := fs.String("title", "", "tab title")
		tabURL := fs.String("url", "", "url")
		_ = fs.Parse(args[1:])
		payload := map[string]string{
			"projectId":  *projectID,
			"worktreeId": *worktreeID,
			"profileId":  *profileID,
			"title":      *title,
			"url":        *tabURL,
		}
		return client.printJSON(http.MethodPost, "/v1/browser/tabs", payload)
	case "update":
		fs := flag.NewFlagSet("browser update", flag.ExitOnError)
		id := fs.String("id", "", "tab id")
		title := fs.String("title", "", "tab title")
		tabURL := fs.String("url", "", "url")
		status := fs.String("status", "", "status")
		tabError := fs.String("error", "", "error")
		screenshotURI := fs.String("screenshot-uri", "", "latest screenshot uri")
		screenshotCapturedAt := fs.String("screenshot-captured-at", "", "latest screenshot capture time in RFC3339")
		_ = fs.Parse(args[1:])
		payload := map[string]interface{}{
			"title":  *title,
			"url":    *tabURL,
			"status": *status,
			"error":  *tabError,
		}
		if *screenshotURI != "" {
			payload["screenshotUri"] = *screenshotURI
		}
		if *screenshotCapturedAt != "" {
			payload["screenshotCapturedAt"] = *screenshotCapturedAt
		}
		return client.printJSON(http.MethodPatch, "/v1/browser/tabs/"+url.PathEscape(*id), payload)
	case "close":
		fs := flag.NewFlagSet("browser close", flag.ExitOnError)
		id := fs.String("id", "", "tab id")
		_ = fs.Parse(args[1:])
		return client.printJSON(http.MethodDelete, "/v1/browser/tabs/"+url.PathEscape(*id), nil)
	case "command":
		fs := flag.NewFlagSet("browser command", flag.ExitOnError)
		id := fs.String("id", "", "tab id")
		command := fs.String("command", "", "reload, goBack, goForward, stop, or screenshot")
		_ = fs.Parse(args[1:])
		payload := map[string]string{"command": *command}
		return client.printJSON(http.MethodPost, "/v1/browser/tabs/"+url.PathEscape(*id)+"/commands", payload)
	default:
		return fmt.Errorf("unknown browser command %q", args[0])
	}
}

func runComputer(client controlClient, args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("computer command is required")
	}
	switch args[0] {
	case "actions":
		fs := flag.NewFlagSet("computer actions", flag.ExitOnError)
		status := fs.String("status", "", "queued, running, completed, or failed")
		kindPrefix := fs.String("kind-prefix", "", "action kind prefix")
		_ = fs.Parse(args[1:])
		query := url.Values{}
		if *status != "" {
			query.Set("status", *status)
		}
		if *kindPrefix != "" {
			query.Set("kindPrefix", *kindPrefix)
		}
		path := "/v1/computer/actions"
		if encoded := query.Encode(); encoded != "" {
			path += "?" + encoded
		}
		return client.printJSON(http.MethodGet, path, nil)
	case "claim":
		fs := flag.NewFlagSet("computer claim", flag.ExitOnError)
		kindPrefix := fs.String("kind-prefix", "", "action kind prefix")
		limit := fs.Int("limit", 25, "maximum actions to claim")
		_ = fs.Parse(args[1:])
		payload := map[string]interface{}{
			"kindPrefix": *kindPrefix,
			"limit":      *limit,
		}
		return client.printJSON(http.MethodPost, "/v1/computer/actions/claim", payload)
	case "queue":
		fs := flag.NewFlagSet("computer queue", flag.ExitOnError)
		kind := fs.String("kind", "", "action kind")
		target := fs.String("target", "", "target")
		payloadJSON := fs.String("payload-json", "", "action payload JSON object")
		_ = fs.Parse(args[1:])
		actionPayload, err := parseJSONMap(*payloadJSON)
		if err != nil {
			return err
		}
		payload := map[string]interface{}{"kind": *kind, "target": *target}
		if actionPayload != nil {
			payload["payload"] = actionPayload
		}
		return client.printJSON(http.MethodPost, "/v1/computer/actions", payload)
	case "complete":
		fs := flag.NewFlagSet("computer complete", flag.ExitOnError)
		id := fs.String("id", "", "action id")
		status := fs.String("status", "completed", "completed or failed")
		errMsg := fs.String("error", "", "error")
		_ = fs.Parse(args[1:])
		payload := map[string]string{"status": *status, "error": *errMsg}
		return client.printJSON(http.MethodPatch, "/v1/computer/actions/"+url.PathEscape(*id), payload)
	default:
		return fmt.Errorf("unknown computer command %q", args[0])
	}
}

func runEmulator(client controlClient, args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("emulator command is required")
	}
	switch args[0] {
	case "devices":
		return client.printJSON(http.MethodGet, "/v1/emulator/devices", nil)
	case "update-device":
		fs := flag.NewFlagSet("emulator update-device", flag.ExitOnError)
		id := fs.String("id", "", "device id")
		name := fs.String("name", "", "device name")
		runtime := fs.String("runtime", "", "runtime")
		status := fs.String("status", "", "status")
		errMsg := fs.String("error", "", "error")
		_ = fs.Parse(args[1:])
		payload := map[string]string{
			"name":    *name,
			"runtime": *runtime,
			"status":  *status,
			"error":   *errMsg,
		}
		return client.printJSON(http.MethodPatch, "/v1/emulator/devices/"+url.PathEscape(*id), payload)
	case "register":
		fs := flag.NewFlagSet("emulator register", flag.ExitOnError)
		name := fs.String("name", "", "device name")
		platform := fs.String("platform", "", "ios or android")
		runtime := fs.String("runtime", "", "runtime")
		status := fs.String("status", "", "status")
		_ = fs.Parse(args[1:])
		payload := map[string]string{
			"name":     *name,
			"platform": *platform,
			"runtime":  *runtime,
			"status":   *status,
		}
		return client.printJSON(http.MethodPost, "/v1/emulator/devices", payload)
	case "sessions":
		return client.printJSON(http.MethodGet, "/v1/emulator/sessions", nil)
	case "detach":
		fs := flag.NewFlagSet("emulator detach", flag.ExitOnError)
		id := fs.String("id", "", "session id")
		_ = fs.Parse(args[1:])
		return client.printJSON(http.MethodDelete, "/v1/emulator/sessions/"+url.PathEscape(*id), nil)
	case "command":
		fs := flag.NewFlagSet("emulator command", flag.ExitOnError)
		sessionID := fs.String("session", "", "session id")
		command := fs.String("command", "", "tap, swipe, type, install, launch, screenshot, logs, pressKey, or rotate")
		payloadJSON := fs.String("payload-json", "", "command payload JSON object")
		_ = fs.Parse(args[1:])
		commandPayload, err := parseJSONMap(*payloadJSON)
		if err != nil {
			return err
		}
		payload := map[string]interface{}{"command": *command}
		if commandPayload != nil {
			payload["payload"] = commandPayload
		}
		return client.printJSON(http.MethodPost, "/v1/emulator/sessions/"+url.PathEscape(*sessionID)+"/commands", payload)
	case "attach":
		fs := flag.NewFlagSet("emulator attach", flag.ExitOnError)
		deviceID := fs.String("device", "", "device id")
		projectID := fs.String("project", "", "project id")
		worktreeID := fs.String("worktree", "", "worktree id")
		_ = fs.Parse(args[1:])
		payload := map[string]string{
			"deviceId":   *deviceID,
			"projectId":  *projectID,
			"worktreeId": *worktreeID,
		}
		return client.printJSON(http.MethodPost, "/v1/emulator/sessions", payload)
	default:
		return fmt.Errorf("unknown emulator command %q", args[0])
	}
}

func runMobileRelay(client controlClient, args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("mobile-relay command is required")
	}
	switch args[0] {
	case "status":
		return client.printJSON(http.MethodGet, "/v1/mobile-relay/status", nil)
	case "pairing-code":
		fs := flag.NewFlagSet("mobile-relay pairing-code", flag.ExitOnError)
		endpoint := fs.String("endpoint", "", "relay endpoint shown to the device")
		workspace := fs.String("workspace", "", "workspace name")
		ttl := fs.Int("ttl", 300, "pairing code ttl seconds")
		_ = fs.Parse(args[1:])
		payload := map[string]interface{}{
			"endpoint":      *endpoint,
			"workspaceName": *workspace,
			"ttlSeconds":    *ttl,
		}
		return client.printJSON(http.MethodPost, "/v1/mobile-relay/pairing-codes", payload)
	case "pairings":
		return client.printJSON(http.MethodGet, "/v1/mobile-relay/pairings", nil)
	case "projection":
		fs := flag.NewFlagSet("mobile-relay projection", flag.ExitOnError)
		projections := fs.String("projections", "", "comma-separated projection kinds")
		outputLimit := fs.Int("output-limit", 200, "terminal output lines per projection")
		_ = fs.Parse(args[1:])
		path := "/v1/mobile-relay/projection"
		query := url.Values{}
		if *projections != "" {
			query.Set("projections", *projections)
		}
		if flagWasSet(fs, "output-limit") {
			query.Set("outputLimit", fmt.Sprintf("%d", *outputLimit))
		}
		if encoded := query.Encode(); encoded != "" {
			path += "?" + encoded
		}
		return client.printJSON(http.MethodGet, path, nil)
	default:
		return fmt.Errorf("unknown mobile-relay command %q", args[0])
	}
}

func runGit(client controlClient, args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("git command is required")
	}
	switch args[0] {
	case "status":
		fs := flag.NewFlagSet("git status", flag.ExitOnError)
		projectID := fs.String("project", "", "project id")
		_ = fs.Parse(args[1:])
		return client.printJSON(http.MethodGet, "/v1/source-control/status?projectId="+url.QueryEscape(*projectID), nil)
	case "diff":
		fs := flag.NewFlagSet("git diff", flag.ExitOnError)
		projectID := fs.String("project", "", "project id")
		filePath := fs.String("path", "", "file path")
		cached := fs.Bool("cached", false, "read staged diff")
		_ = fs.Parse(args[1:])
		query := url.Values{}
		query.Set("projectId", *projectID)
		if *filePath != "" {
			query.Set("path", *filePath)
		}
		if *cached {
			query.Set("cached", "true")
		}
		return client.printJSON(http.MethodGet, "/v1/source-control/diff?"+query.Encode(), nil)
	default:
		return fmt.Errorf("unknown git command %q", args[0])
	}
}

func runSourceControl(client controlClient, args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("source-control command is required")
	}
	switch args[0] {
	case "list":
		fs := flag.NewFlagSet("source-control list", flag.ExitOnError)
		projectID := fs.String("project", "", "project id")
		workspaceID := fs.String("workspace", "", "workspace id")
		_ = fs.Parse(args[1:])
		query := url.Values{}
		if *projectID != "" {
			query.Set("projectId", *projectID)
		}
		if *workspaceID != "" {
			query.Set("workspaceId", *workspaceID)
		}
		path := "/v1/source-control"
		if encoded := query.Encode(); encoded != "" {
			path += "?" + encoded
		}
		return client.printJSON(http.MethodGet, path, nil)
	case "update":
		fs := flag.NewFlagSet("source-control update", flag.ExitOnError)
		projectID := fs.String("project", "", "project id")
		workspaceID := fs.String("workspace", "", "workspace id")
		provider := fs.String("provider", "", "git provider")
		reviewKind := fs.String("review-kind", "", "review kind")
		branch := fs.String("branch", "", "branch")
		baseBranch := fs.String("base", "", "base branch")
		syncStatus := fs.String("status", "unknown", "clean, dirty, syncing, error, or unknown")
		ahead := fs.Int("ahead", 0, "ahead count")
		behind := fs.Int("behind", 0, "behind count")
		var changes repeatedStringFlag
		fs.Var(&changes, "change", "repeatable source-control change as status:path")
		_ = fs.Parse(args[1:])
		if *workspaceID == "" {
			*workspaceID = *projectID
		}
		parsedChanges, err := parseSourceControlChanges([]string(changes))
		if err != nil {
			return err
		}
		if len(parsedChanges) > 0 && *syncStatus == "unknown" && !flagWasSet(fs, "status") {
			*syncStatus = "dirty"
		}
		payload := map[string]interface{}{
			"repositoryId": *projectID,
			"workspaceId":  *workspaceID,
			"provider":     *provider,
			"reviewKind":   *reviewKind,
			"branch":       *branch,
			"baseBranch":   *baseBranch,
			"syncStatus":   *syncStatus,
			"ahead":        *ahead,
			"behind":       *behind,
		}
		if len(parsedChanges) > 0 {
			payload["changes"] = parsedChanges
		}
		return client.printJSON(http.MethodPost, "/v1/source-control/projections", payload)
	default:
		return fmt.Errorf("unknown source-control command %q", args[0])
	}
}

func runSubsystem(client controlClient, args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("subsystem name is required")
	}
	return client.printJSON(http.MethodGet, "/v1/"+url.PathEscape(args[0])+"/status", nil)
}

func runProvider(client controlClient, args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("provider command is required")
	}
	switch args[0] {
	case "list":
		fs := flag.NewFlagSet("provider list", flag.ExitOnError)
		subsystem := fs.String("subsystem", "", "subsystem filter")
		_ = fs.Parse(args[1:])
		path := "/v1/providers"
		if *subsystem != "" {
			path += "?subsystem=" + url.QueryEscape(*subsystem)
		}
		return client.printJSON(http.MethodGet, path, nil)
	case "register":
		fs := flag.NewFlagSet("provider register", flag.ExitOnError)
		id := fs.String("id", "", "provider id")
		subsystem := fs.String("subsystem", "", "browser, computer, or emulator")
		name := fs.String("name", "", "provider name")
		status := fs.String("status", "ready", "ready, running, degraded, or error")
		capabilities := fs.String("capabilities", "", "comma-separated capabilities")
		message := fs.String("message", "", "provider message")
		_ = fs.Parse(args[1:])
		payload := map[string]interface{}{
			"id":           *id,
			"subsystem":    *subsystem,
			"name":         *name,
			"status":       *status,
			"capabilities": splitCommaList(*capabilities),
			"message":      *message,
		}
		return client.printJSON(http.MethodPost, "/v1/providers", payload)
	default:
		return fmt.Errorf("unknown provider command %q", args[0])
	}
}

func (c controlClient) printJSON(method string, path string, payload interface{}) error {
	var body io.Reader
	if payload != nil {
		content, err := json.Marshal(payload)
		if err != nil {
			return err
		}
		body = bytes.NewReader(content)
	}
	req, err := http.NewRequest(method, c.endpoint+path, body)
	if err != nil {
		return err
	}
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	content, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	if resp.StatusCode >= 400 {
		return fmt.Errorf("%s", strings.TrimSpace(string(content)))
	}
	var formatted bytes.Buffer
	if json.Indent(&formatted, content, "", "  ") == nil {
		fmt.Println(formatted.String())
		return nil
	}
	fmt.Print(string(content))
	return nil
}

func (c controlClient) streamEvents(limit int, topic string, raw bool) error {
	path := "/v1/events"
	if topic != "" {
		path += "?topic=" + url.QueryEscape(topic)
	}
	req, err := http.NewRequest(http.MethodGet, c.endpoint+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "text/event-stream")
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		content, readErr := io.ReadAll(resp.Body)
		if readErr != nil {
			return readErr
		}
		return fmt.Errorf("%s", strings.TrimSpace(string(content)))
	}

	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	event := serverSentEvent{}
	printed := 0
	for scanner.Scan() {
		line := strings.TrimSuffix(scanner.Text(), "\r")
		if line == "" {
			if printServerSentEvent(event, topic, raw) {
				printed++
				if limit > 0 && printed >= limit {
					return nil
				}
			}
			event = serverSentEvent{}
			continue
		}
		event.applyLine(line)
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	if printServerSentEvent(event, topic, raw) && limit > 0 && printed+1 >= limit {
		return nil
	}
	return nil
}

type serverSentEvent struct {
	ID    string
	Topic string
	Data  string
}

func (e *serverSentEvent) applyLine(line string) {
	if line == "" || strings.HasPrefix(line, ":") {
		return
	}
	field, value, ok := strings.Cut(line, ":")
	if !ok {
		return
	}
	value = strings.TrimPrefix(value, " ")
	switch field {
	case "id":
		e.ID = value
	case "event":
		e.Topic = value
	case "data":
		if e.Data != "" {
			e.Data += "\n"
		}
		e.Data += value
	}
}

func printServerSentEvent(event serverSentEvent, topic string, raw bool) bool {
	if event.ID == "" && event.Topic == "" && event.Data == "" {
		return false
	}
	if topic != "" && event.Topic != topic {
		return false
	}
	if raw {
		if event.ID != "" {
			fmt.Printf("id: %s\n", event.ID)
		}
		if event.Topic != "" {
			fmt.Printf("event: %s\n", event.Topic)
		}
		if event.Data != "" {
			for _, line := range strings.Split(event.Data, "\n") {
				fmt.Printf("data: %s\n", line)
			}
		}
		fmt.Println()
		return true
	}
	var formatted bytes.Buffer
	if json.Indent(&formatted, []byte(event.Data), "", "  ") == nil {
		fmt.Println(formatted.String())
		return true
	}
	fmt.Println(event.Data)
	return true
}

func splitCommaList(value string) []string {
	var output []string
	for _, part := range strings.Split(value, ",") {
		part = strings.TrimSpace(part)
		if part != "" {
			output = append(output, part)
		}
	}
	return output
}

type repeatedStringFlag []string

func (flag *repeatedStringFlag) String() string {
	return strings.Join(*flag, ",")
}

func (flag *repeatedStringFlag) Set(value string) error {
	value = strings.TrimSpace(value)
	if value != "" {
		*flag = append(*flag, value)
	}
	return nil
}

func parseSourceControlChanges(values []string) ([]map[string]string, error) {
	changes := make([]map[string]string, 0, len(values))
	for _, raw := range values {
		statusValue, path, ok := strings.Cut(raw, ":")
		if !ok {
			return nil, fmt.Errorf("source-control change %q must use status:path", raw)
		}
		status, ok := normalizeSourceControlChangeStatus(statusValue)
		if !ok {
			return nil, fmt.Errorf("unsupported source-control change status %q", statusValue)
		}
		path = strings.TrimSpace(path)
		if path == "" {
			return nil, fmt.Errorf("source-control change %q is missing a path", raw)
		}
		changes = append(changes, map[string]string{
			"path":   path,
			"status": status,
		})
	}
	return changes, nil
}

func normalizeSourceControlChangeStatus(value string) (string, bool) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "a", "add", "added":
		return "added", true
	case "m", "modify", "modified":
		return "modified", true
	case "d", "delete", "deleted":
		return "deleted", true
	case "r", "rename", "renamed":
		return "renamed", true
	case "?", "??", "untracked":
		return "untracked", true
	case "!", "ignored":
		return "ignored", true
	default:
		return "", false
	}
}

func automationSchedulePayload(kind string, intervalSeconds int64, cron string, eventTopic string, timezone string) map[string]interface{} {
	return map[string]interface{}{
		"kind":            kind,
		"intervalSeconds": intervalSeconds,
		"cron":            cron,
		"eventTopic":      eventTopic,
		"timezone":        timezone,
	}
}

func parseJSONMap(raw string) (map[string]interface{}, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}
	var value map[string]interface{}
	if err := json.Unmarshal([]byte(raw), &value); err != nil {
		return nil, err
	}
	if value == nil {
		return nil, fmt.Errorf("JSON value must be an object")
	}
	return value, nil
}

func parseJSONArray(raw string) ([]interface{}, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return []interface{}{}, nil
	}
	var value []interface{}
	if err := json.Unmarshal([]byte(raw), &value); err != nil {
		return nil, err
	}
	if value == nil {
		return nil, fmt.Errorf("JSON value must be an array")
	}
	return value, nil
}

func parseBoolString(raw string) (bool, error) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "true", "1", "yes", "on":
		return true, nil
	case "false", "0", "no", "off":
		return false, nil
	default:
		return false, fmt.Errorf("invalid boolean %q", raw)
	}
}

func flagWasSet(fs *flag.FlagSet, name string) bool {
	wasSet := false
	fs.Visit(func(current *flag.Flag) {
		if current.Name == name {
			wasSet = true
		}
	})
	return wasSet
}

func splitCommand(command string) []string {
	command = strings.TrimSpace(command)
	if command == "" {
		return nil
	}
	fields, err := splitShellLike(command)
	if err != nil {
		return strings.Fields(command)
	}
	return fields
}

func splitShellLike(input string) ([]string, error) {
	var fields []string
	var current strings.Builder
	var quote rune
	escaped := false
	inField := false

	for _, char := range input {
		if escaped {
			if !isEscapableCommandRune(char) {
				current.WriteRune('\\')
			}
			current.WriteRune(char)
			escaped = false
			inField = true
			continue
		}
		if char == '\\' {
			escaped = true
			inField = true
			continue
		}
		if quote != 0 {
			if char == quote {
				quote = 0
				continue
			}
			current.WriteRune(char)
			inField = true
			continue
		}
		if char == '\'' || char == '"' {
			quote = char
			inField = true
			continue
		}
		if char == ' ' || char == '\t' || char == '\n' || char == '\r' {
			if inField {
				fields = append(fields, current.String())
				current.Reset()
				inField = false
			}
			continue
		}
		current.WriteRune(char)
		inField = true
	}
	if escaped {
		current.WriteRune('\\')
	}
	if quote != 0 {
		return nil, fmt.Errorf("unterminated quote")
	}
	if inField {
		fields = append(fields, current.String())
	}
	return fields, nil
}

func isEscapableCommandRune(char rune) bool {
	switch char {
	case '\\', '\'', '"', ' ', '\t', '\n', '\r':
		return true
	default:
		return false
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: pebble-control [--endpoint URL] <status|events|project|worktree|session|agent|task|message|dispatch|automation|external-task|file|release|settings|source-control|browser|computer|emulator|mobile-relay|git|provider|subsystem> ...")
}
