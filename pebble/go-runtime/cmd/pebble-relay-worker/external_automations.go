package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

const externalAutomationCommandTimeout = 30 * time.Second

var externalAutomationJobID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]*$`)

type externalAutomationRequest struct {
	Version   int    `json:"version"`
	Operation string `json:"operation"`
	Provider  string `json:"provider"`
	JobID     string `json:"jobId,omitempty"`
	Action    string `json:"action,omitempty"`
	Name      string `json:"name,omitempty"`
	Prompt    string `json:"prompt,omitempty"`
	Schedule  string `json:"schedule,omitempty"`
	Workdir   string `json:"workdir,omitempty"`
	Page      int    `json:"page,omitempty"`
	PageSize  int    `json:"pageSize,omitempty"`
}

type externalAutomationSource struct {
	Provider         string `json:"provider"`
	CommandAvailable bool   `json:"commandAvailable"`
	Jobs             any    `json:"jobs"`
	Error            string `json:"error,omitempty"`
}

func runExternalAutomations(args []string, output io.Writer) error {
	flags := flag.NewFlagSet("external-automations", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	requestJSON := flags.String("request", "", "versioned JSON request")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if strings.TrimSpace(*requestJSON) == "" {
		return errors.New("external automation request is required")
	}
	var request externalAutomationRequest
	if err := json.Unmarshal([]byte(*requestJSON), &request); err != nil {
		return errors.New("invalid external automation request")
	}
	if request.Version != 1 {
		return errors.New("unsupported external automation request version")
	}
	if request.Provider != "hermes" && request.Provider != "openclaw" {
		return errors.New("unsupported external automation provider")
	}
	switch request.Operation {
	case "list":
		return json.NewEncoder(output).Encode(readExternalAutomationSource(request.Provider))
	case "runs":
		result, err := readExternalAutomationRuns(request)
		if err != nil {
			return err
		}
		return json.NewEncoder(output).Encode(result)
	case "create", "update", "action":
		if err := mutateExternalAutomation(request); err != nil {
			return err
		}
		return json.NewEncoder(output).Encode(map[string]any{"ok": true})
	default:
		return errors.New("unsupported external automation operation")
	}
}

func readExternalAutomationRuns(request externalAutomationRequest) (map[string]any, error) {
	if request.Provider != "hermes" {
		return map[string]any{"total": 0, "runs": []any{}}, nil
	}
	if err := validateExternalAutomationJobID(request.JobID); err != nil {
		return nil, err
	}
	page := request.Page
	if page < 1 {
		page = 1
	}
	pageSize := request.PageSize
	if pageSize < 1 {
		pageSize = 25
	}
	if pageSize > 100 {
		pageSize = 100
	}
	home := filepath.Dir(filepath.Dir(externalAutomationJobsPath("hermes")))
	refs, err := externalAutomationOutputRefs(home, request.JobID)
	if err != nil {
		return nil, err
	}
	refs = mergeExternalAutomationSessionRefs(refs, externalAutomationSessionRefs(home, request.JobID))
	sort.Slice(refs, func(left, right int) bool {
		return refs[left].runAt > refs[right].runAt
	})
	start := (page - 1) * pageSize
	if start > len(refs) {
		start = len(refs)
	}
	end := start + pageSize
	if end > len(refs) {
		end = len(refs)
	}
	runs := make([]any, 0, end-start)
	for _, ref := range refs[start:end] {
		run := hydrateExternalAutomationSession(home, request.JobID, ref)
		if ref.outputPath == "" {
			runs = append(runs, run)
			continue
		}
		path := ref.outputPath
		content, readError := os.ReadFile(path)
		if readError != nil {
			run["status"], run["error"] = "unknown", readError.Error()
			runs = append(runs, run)
			continue
		}
		text := string(content)
		errorText := externalAutomationMarkdownSection(text, "## Error")
		response := externalAutomationMarkdownSection(text, "## Response")
		failed := errorText != "" || strings.Contains(text, "(FAILED)")
		status := "unknown"
		if failed {
			status = "failed"
		} else if response != "" {
			status = "completed"
		}
		preview := response
		if preview == "" {
			preview = errorText
		}
		run["status"], run["output_preview"] = status, externalAutomationPreview(preview)
		if transcript, ok := run["output_content"].(string); ok && transcript != "" {
			run["output_content"] = text + "\n\n---\n\n## Full session log\n\n" + transcript
		} else {
			run["output_content"] = text
		}
		if errorText != "" {
			run["error"] = externalAutomationPreview(errorText)
		}
		runs = append(runs, run)
	}
	return map[string]any{"total": len(refs), "runs": runs}, nil
}

func externalAutomationMarkdownSection(content, heading string) string {
	index := strings.Index(content, heading)
	if index < 0 {
		return ""
	}
	body := strings.TrimLeft(content[index+len(heading):], "\r\n \t")
	if end := strings.Index(body, "\n## "); end >= 0 {
		body = body[:end]
	}
	return strings.TrimSpace(strings.Trim(body, "`"))
}

func externalAutomationPreview(content string) string {
	compact := strings.Join(strings.Fields(content), " ")
	if len(compact) > 180 {
		return compact[:177] + "..."
	}
	return compact
}

func readExternalAutomationSource(provider string) externalAutomationSource {
	_, commandError := exec.LookPath(provider)
	path := externalAutomationJobsPath(provider)
	content, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return externalAutomationSource{Provider: provider, CommandAvailable: commandError == nil, Jobs: []any{}}
	}
	if err != nil {
		return externalAutomationSource{Provider: provider, CommandAvailable: commandError == nil, Jobs: []any{}, Error: err.Error()}
	}
	var value any
	if err := json.Unmarshal(content, &value); err != nil {
		return externalAutomationSource{Provider: provider, CommandAvailable: commandError == nil, Jobs: []any{}, Error: err.Error()}
	}
	if record, ok := value.(map[string]any); ok {
		if jobs, exists := record["jobs"].([]any); exists {
			value = jobs
		}
	}
	if _, ok := value.([]any); !ok {
		value = []any{}
	}
	if provider == "hermes" {
		value = attachExternalAutomationRunCounts(value)
	}
	return externalAutomationSource{Provider: provider, CommandAvailable: commandError == nil, Jobs: value}
}

func attachExternalAutomationRunCounts(value any) any {
	jobs, ok := value.([]any)
	if !ok {
		return []any{}
	}
	for _, job := range jobs {
		record, ok := job.(map[string]any)
		if !ok {
			continue
		}
		jobID, _ := record["id"].(string)
		if validateExternalAutomationJobID(jobID) != nil {
			continue
		}
		result, err := readExternalAutomationRuns(externalAutomationRequest{Provider: "hermes", JobID: jobID, Page: 1, PageSize: 1})
		if err == nil {
			record["run_count"], record["runs"] = result["total"], []any{}
		}
	}
	return jobs
}

func mutateExternalAutomation(request externalAutomationRequest) error {
	command, err := exec.LookPath(request.Provider)
	if err != nil {
		return fmt.Errorf("%s CLI is not on PATH", providerDisplayName(request.Provider))
	}
	arguments, err := externalAutomationArguments(request)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), externalAutomationCommandTimeout)
	defer cancel()
	result, runError := exec.CommandContext(ctx, command, arguments...).CombinedOutput()
	if ctx.Err() == context.DeadlineExceeded {
		return errors.New("external automation command timed out after 30000ms")
	}
	if runError != nil {
		detail := strings.TrimSpace(string(result))
		if detail == "" {
			detail = runError.Error()
		}
		return errors.New(detail)
	}
	return nil
}

func externalAutomationArguments(request externalAutomationRequest) ([]string, error) {
	switch request.Operation {
	case "create":
		if request.Provider != "hermes" {
			return nil, errors.New("only Hermes cron creation and editing are supported")
		}
		name, prompt, schedule, err := validateExternalAutomationFields(request)
		if err != nil {
			return nil, err
		}
		args := []string{"cron", "create", schedule, prompt, "--name", name, "--deliver", "local"}
		return appendExternalAutomationWorkdir(args, request.Workdir), nil
	case "update":
		if request.Provider != "hermes" {
			return nil, errors.New("only Hermes cron creation and editing are supported")
		}
		if err := validateExternalAutomationJobID(request.JobID); err != nil {
			return nil, err
		}
		name, prompt, schedule, err := validateExternalAutomationFields(request)
		if err != nil {
			return nil, err
		}
		args := []string{"cron", "edit", request.JobID, "--schedule", schedule, "--prompt", prompt, "--name", name}
		return appendExternalAutomationWorkdir(args, request.Workdir), nil
	case "action":
		if err := validateExternalAutomationJobID(request.JobID); err != nil {
			return nil, err
		}
		commands := map[string]map[string]string{
			"hermes":   {"pause": "pause", "resume": "resume", "run": "run", "delete": "remove"},
			"openclaw": {"pause": "disable", "resume": "enable", "run": "run", "delete": "rm"},
		}
		command := commands[request.Provider][request.Action]
		if command == "" {
			return nil, errors.New("invalid external automation action")
		}
		return []string{"cron", command, request.JobID}, nil
	default:
		return nil, errors.New("unsupported external automation operation")
	}
}

func validateExternalAutomationFields(request externalAutomationRequest) (string, string, string, error) {
	name, prompt, schedule := strings.TrimSpace(request.Name), strings.TrimSpace(request.Prompt), strings.TrimSpace(request.Schedule)
	if name == "" || prompt == "" || schedule == "" {
		return "", "", "", errors.New("Hermes cron requires name, prompt, and schedule")
	}
	return name, prompt, schedule, nil
}

func validateExternalAutomationJobID(jobID string) error {
	if len(jobID) > 200 || !externalAutomationJobID.MatchString(jobID) {
		return errors.New("invalid external automation job ID")
	}
	return nil
}

func appendExternalAutomationWorkdir(args []string, workdir string) []string {
	if value := strings.TrimSpace(workdir); value != "" {
		return append(args, "--workdir", value)
	}
	return args
}

func externalAutomationJobsPath(provider string) string {
	home, _ := os.UserHomeDir()
	if provider == "hermes" {
		root := strings.TrimSpace(os.Getenv("HERMES_HOME"))
		if root == "" {
			root = filepath.Join(home, ".hermes")
		}
		return filepath.Join(root, "cron", "jobs.json")
	}
	return filepath.Join(home, ".openclaw", "cron", "jobs.json")
}

func providerDisplayName(provider string) string {
	if provider == "hermes" {
		return "Hermes"
	}
	return "OpenClaw"
}
