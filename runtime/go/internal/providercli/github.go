package providercli

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// GitHubForkParent mirrors the owner/repo pair getRepoUpstream resolves in
// migration/electron-reference/src/main/github/client.ts.
type GitHubForkParent struct {
	Owner string
	Repo  string
}

// ResolveGitHubForkParent asks the GitHub API for originOwner/originRepo's fork
// parent, mirroring getRepoUpstream's API fallback path (migration/electron-reference/src/main/github/client.ts)
// for repos with no `upstream` git remote configured. Best-effort: any CLI
// failure (missing gh, unauthenticated, non-fork, network) resolves to nil
// rather than surfacing an error, matching Electron's swallow-and-return-null
// behavior for this best-effort lookup.
func ResolveGitHubForkParent(ctx context.Context, workdir string, originOwner string, originRepo string) *GitHubForkParent {
	owner := strings.TrimSpace(originOwner)
	repo := strings.TrimSpace(originRepo)
	if owner == "" || repo == "" {
		return nil
	}
	// Why: best-effort fork lookup must not block callers on a stalled gh
	// process, mirroring the 10s cap in getRepoUpstream.
	runCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	out, err := runCLI(runCtx, "gh", workdir, "repo", "view", owner+"/"+repo, "--json", "isFork,parent")
	if err != nil {
		return nil
	}
	var data struct {
		IsFork bool `json:"isFork"`
		Parent *struct {
			Name  string `json:"name"`
			Owner struct {
				Login string `json:"login"`
			} `json:"owner"`
		} `json:"parent"`
	}
	if json.Unmarshal(out, &data) != nil || !data.IsFork || data.Parent == nil {
		return nil
	}
	parentOwner := strings.TrimSpace(data.Parent.Owner.Login)
	parentRepo := strings.TrimSpace(data.Parent.Name)
	if parentOwner == "" || parentRepo == "" {
		return nil
	}
	return &GitHubForkParent{Owner: parentOwner, Repo: parentRepo}
}

// ghPRListFields mirrors WORK_ITEM_PR_LIST_JSON_FIELDS in migration/electron-reference/src/main/github/client.ts.
// gh infers owner/repo from the git remotes in workdir, matching Electron's
// cwd-based resolution.
const ghPRListFields = "number,title,state,url,labels,updatedAt,author,isDraft,headRefName,baseRefName,headRefOid,isCrossRepository"

// ghPRRaw is the subset of `gh pr list/view --json` output this package maps.
type ghPRRaw struct {
	Number      int              `json:"number"`
	Title       string           `json:"title"`
	State       string           `json:"state"`
	URL         string           `json:"url"`
	Labels      []ghLabel        `json:"labels"`
	UpdatedAt   string           `json:"updatedAt"`
	Author      *ghAuthor        `json:"author"`
	IsDraft     bool             `json:"isDraft"`
	HeadRefName string           `json:"headRefName"`
	BaseRefName string           `json:"baseRefName"`
	HeadRefOid  string           `json:"headRefOid"`
	Merged      bool             `json:"merged"`
	MergedAt    *json.RawMessage `json:"mergedAt"`
	// IsCrossRepository is a *bool (not bool) so its absence in older gh
	// responses stays distinguishable from an explicit false.
	IsCrossRepository *bool `json:"isCrossRepository"`
}

type ghLabel struct {
	Name string `json:"name"`
}

type ghAuthor struct {
	Login string `json:"login"`
	// gh returns login-less bot authors as {is_bot:true,name:...}; fall back to name.
	Name string `json:"name"`
}

// ListGitHubPRs runs `gh pr list` and maps to GitHubWorkItem[] (type "pr"),
// mirroring the PR side of listWorkItems in migration/electron-reference/src/main/github/client.ts.
func ListGitHubPRs(ctx context.Context, workdir string, limit int) ([]GitHubWorkItem, error) {
	if limit <= 0 {
		limit = 24
	}
	out, err := runCLI(ctx, "gh", workdir,
		"pr", "list", "--limit", strconv.Itoa(limit), "--json", ghPRListFields)
	if err != nil {
		return nil, err
	}
	var raw []ghPRRaw
	if err := json.Unmarshal(out, &raw); err != nil {
		return nil, fmt.Errorf("parse gh pr list output: %w", err)
	}
	items := make([]GitHubWorkItem, 0, len(raw))
	for i := range raw {
		items = append(items, mapGitHubPR(&raw[i]))
	}
	return items, nil
}

// GetGitHubPR runs `gh pr view <n>` and maps to a single GitHubWorkItem,
// matching the `item` shape the renderer expects for detail views.
func GetGitHubPR(ctx context.Context, workdir string, number int) (GitHubWorkItem, error) {
	out, err := runCLI(ctx, "gh", workdir,
		"pr", "view", strconv.Itoa(number), "--json", ghPRListFields)
	if err != nil {
		return GitHubWorkItem{}, err
	}
	var raw ghPRRaw
	if err := json.Unmarshal(out, &raw); err != nil {
		return GitHubWorkItem{}, fmt.Errorf("parse gh pr view output: %w", err)
	}
	return mapGitHubPR(&raw), nil
}

// GetGitHubPRChecks mirrors the `gh pr checks --json name,state,link` fallback
// path in getPRChecks (migration/electron-reference/src/main/github/client.ts). A PR with no check runs makes
// gh exit non-zero with "no checks reported"; that is an empty section, not a
// failure, exactly as Electron treats it.
func GetGitHubPRChecks(ctx context.Context, workdir string, number int) ([]PRCheckDetail, error) {
	return getGitHubPRChecks(ctx, workdir, number, "")
}

func GetGitHubPRChecksForRepo(ctx context.Context, owner, repo string, number int) ([]PRCheckDetail, error) {
	return getGitHubPRChecks(ctx, "", number, owner+"/"+repo)
}

func getGitHubPRChecks(ctx context.Context, workdir string, number int, repo string) ([]PRCheckDetail, error) {
	args := []string{"pr", "checks", strconv.Itoa(number), "--json", "name,state,link"}
	if repo != "" {
		args = append(args, "--repo", repo)
	}
	out, err := runCLI(ctx, "gh", workdir, args...)
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "no checks reported") {
			return []PRCheckDetail{}, nil
		}
		return nil, err
	}
	var raw []struct {
		Name  string `json:"name"`
		State string `json:"state"`
		Link  string `json:"link"`
	}
	if err := json.Unmarshal(out, &raw); err != nil {
		return nil, fmt.Errorf("parse gh pr checks output: %w", err)
	}
	checks := make([]PRCheckDetail, 0, len(raw))
	for _, d := range raw {
		conclusion := mapCheckConclusion(d.State)
		var url *string
		if d.Link != "" {
			link := d.Link
			url = &link
		}
		checks = append(checks, PRCheckDetail{
			Name:          d.Name,
			Status:        mapCheckStatus(d.State),
			Conclusion:    conclusion,
			URL:           url,
			WorkflowRunID: parseActionsRunID(d.Link),
		})
	}
	return checks, nil
}

var actionsRunPattern = regexp.MustCompile(`/actions/runs/(\d+)(?:/|$)`)

func parseActionsRunID(value string) *int64 {
	match := actionsRunPattern.FindStringSubmatch(value)
	if len(match) != 2 {
		return nil
	}
	id, err := strconv.ParseInt(match[1], 10, 64)
	if err != nil || id <= 0 {
		return nil
	}
	return &id
}

type GitHubPRCheckDetailsOptions struct {
	CheckRunID    int64
	WorkflowRunID int64
	CheckName     string
	URL           string
	Owner         string
	Repo          string
}

func GetGitHubPRCheckDetails(ctx context.Context, workdir string, options GitHubPRCheckDetailsOptions) (*PRCheckRunDetails, error) {
	owner, repo, err := resolveGitHubOwnerRepo(ctx, workdir, options.Owner, options.Repo)
	if err != nil {
		return nil, err
	}
	var checkRun *githubCheckRun
	annotations := []PRCheckAnnotation{}
	if options.CheckRunID > 0 {
		checkRun, err = readGitHubCheckRun(ctx, workdir, owner, repo, options.CheckRunID)
		if err != nil {
			return nil, err
		}
		annotations = readGitHubCheckAnnotations(ctx, workdir, owner, repo, options.CheckRunID)
	}
	workflowRunID := options.WorkflowRunID
	if workflowRunID <= 0 && checkRun != nil && checkRun.CheckSuite != nil && checkRun.CheckSuite.WorkflowRun != nil {
		workflowRunID = checkRun.CheckSuite.WorkflowRun.ID
	}
	jobs := []PRCheckJob{}
	if workflowRunID > 0 {
		jobs = readGitHubWorkflowJobs(ctx, workdir, owner, repo, workflowRunID, options.CheckName)
	}
	name := strings.TrimSpace(options.CheckName)
	if checkRun != nil && strings.TrimSpace(checkRun.Name) != "" {
		name = checkRun.Name
	}
	if name == "" {
		name = "Check"
	}
	details := &PRCheckRunDetails{Name: name, URL: optionalString(options.URL), DetailsURL: optionalString(options.URL), Annotations: annotations, Jobs: jobs}
	if checkRun != nil {
		details.Status = optionalString(checkRun.Status)
		details.Conclusion = optionalString(checkRun.Conclusion)
		details.URL = firstString(checkRun.HTMLURL, options.URL)
		details.DetailsURL = firstString(checkRun.DetailsURL, options.URL)
		details.StartedAt = optionalString(checkRun.StartedAt)
		details.CompletedAt = optionalString(checkRun.CompletedAt)
		details.Title = optionalString(checkRun.Output.Title)
		details.Summary = optionalString(checkRun.Output.Summary)
		details.Text = optionalString(checkRun.Output.Text)
	}
	return details, nil
}

func RerunGitHubPRChecks(ctx context.Context, workdir string, number int, headSHA string, failedOnly bool) GitHubRerunPRChecksResult {
	owner, repo, err := resolveGitHubOwnerRepo(ctx, workdir, "", "")
	if err != nil {
		return GitHubRerunPRChecksResult{Error: err.Error()}
	}
	checks, err := readCommitCheckRuns(ctx, workdir, owner, repo, headSHA)
	if err != nil || len(checks) == 0 {
		checks, err = GetGitHubPRChecks(ctx, workdir, number)
	}
	if err != nil {
		return GitHubRerunPRChecksResult{Error: err.Error()}
	}
	runIDs := map[int64]struct{}{}
	checkRunIDs := map[int64]struct{}{}
	for _, check := range checks {
		if failedOnly && (check.Conclusion == nil || (*check.Conclusion != "failure" && *check.Conclusion != "cancelled" && *check.Conclusion != "timed_out")) {
			continue
		}
		if check.WorkflowRunID != nil {
			runIDs[*check.WorkflowRunID] = struct{}{}
		} else if check.CheckRunID != nil {
			checkRunIDs[*check.CheckRunID] = struct{}{}
		}
	}
	if len(runIDs) == 0 && len(checkRunIDs) == 0 {
		message := "No rerunnable checks found."
		if failedOnly {
			message = "No failed GitHub Actions checks to rerun."
		}
		return GitHubRerunPRChecksResult{Error: message}
	}
	count := 0
	for id := range runIDs {
		endpoint := fmt.Sprintf("repos/%s/%s/actions/runs/%d/rerun", owner, repo, id)
		if failedOnly {
			endpoint = fmt.Sprintf("repos/%s/%s/actions/runs/%d/rerun-failed-jobs", owner, repo, id)
		}
		if _, err := runCLI(ctx, "gh", workdir, "api", "-X", "POST", endpoint); err != nil {
			return GitHubRerunPRChecksResult{Error: err.Error()}
		}
		count++
	}
	for id := range checkRunIDs {
		endpoint := fmt.Sprintf("repos/%s/%s/check-runs/%d/rerequest", owner, repo, id)
		if _, err := runCLI(ctx, "gh", workdir, "api", "-X", "POST", endpoint); err != nil {
			return GitHubRerunPRChecksResult{Error: err.Error()}
		}
		count++
	}
	return GitHubRerunPRChecksResult{OK: true, Count: count}
}

func readCommitCheckRuns(ctx context.Context, workdir, owner, repo, headSHA string) ([]PRCheckDetail, error) {
	headSHA = strings.TrimSpace(headSHA)
	if headSHA == "" {
		return nil, nil
	}
	out, err := runCLI(ctx, "gh", workdir, "api", fmt.Sprintf("repos/%s/%s/commits/%s/check-runs?per_page=100", owner, repo, headSHA))
	if err != nil {
		return nil, err
	}
	var raw struct {
		CheckRuns []struct {
			ID         int64  `json:"id"`
			Name       string `json:"name"`
			Status     string `json:"status"`
			Conclusion string `json:"conclusion"`
			DetailsURL string `json:"details_url"`
			HTMLURL    string `json:"html_url"`
		} `json:"check_runs"`
	}
	if err := json.Unmarshal(out, &raw); err != nil {
		return nil, fmt.Errorf("parse GitHub commit check runs: %w", err)
	}
	checks := make([]PRCheckDetail, 0, len(raw.CheckRuns))
	for _, item := range raw.CheckRuns {
		id := item.ID
		url := firstString(item.DetailsURL, item.HTMLURL)
		conclusion := mapCheckConclusion(item.Conclusion)
		checks = append(checks, PRCheckDetail{
			Name:          item.Name,
			Status:        mapCheckStatus(item.Status),
			Conclusion:    conclusion,
			URL:           url,
			CheckRunID:    &id,
			WorkflowRunID: parseActionsRunID(valueOrEmpty(url)),
		})
	}
	return checks, nil
}

func valueOrEmpty(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

type githubCheckRun struct {
	Name        string `json:"name"`
	Status      string `json:"status"`
	Conclusion  string `json:"conclusion"`
	HTMLURL     string `json:"html_url"`
	DetailsURL  string `json:"details_url"`
	StartedAt   string `json:"started_at"`
	CompletedAt string `json:"completed_at"`
	Output      struct {
		Title   string `json:"title"`
		Summary string `json:"summary"`
		Text    string `json:"text"`
	} `json:"output"`
	CheckSuite *struct {
		WorkflowRun *struct {
			ID int64 `json:"id"`
		} `json:"workflow_run"`
	} `json:"check_suite"`
}

func resolveGitHubOwnerRepo(ctx context.Context, workdir, owner, repo string) (string, string, error) {
	if strings.TrimSpace(owner) != "" && strings.TrimSpace(repo) != "" {
		return strings.TrimSpace(owner), strings.TrimSpace(repo), nil
	}
	out, err := runCLI(ctx, "gh", workdir, "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner")
	if err != nil {
		return "", "", err
	}
	parts := strings.SplitN(strings.TrimSpace(string(out)), "/", 2)
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return "", "", fmt.Errorf("could not resolve GitHub owner/repo")
	}
	return parts[0], parts[1], nil
}

func readGitHubCheckRun(ctx context.Context, workdir, owner, repo string, id int64) (*githubCheckRun, error) {
	out, err := runCLI(ctx, "gh", workdir, "api", fmt.Sprintf("repos/%s/%s/check-runs/%d", owner, repo, id))
	if err != nil {
		return nil, err
	}
	var result githubCheckRun
	if err := json.Unmarshal(out, &result); err != nil {
		return nil, fmt.Errorf("parse GitHub check run: %w", err)
	}
	return &result, nil
}

func readGitHubCheckAnnotations(ctx context.Context, workdir, owner, repo string, id int64) []PRCheckAnnotation {
	out, err := runCLI(ctx, "gh", workdir, "api", fmt.Sprintf("repos/%s/%s/check-runs/%d/annotations?per_page=20", owner, repo, id))
	if err != nil {
		return []PRCheckAnnotation{}
	}
	var raw []struct {
		Path       string `json:"path"`
		StartLine  *int64 `json:"start_line"`
		EndLine    *int64 `json:"end_line"`
		Level      string `json:"annotation_level"`
		Title      string `json:"title"`
		Message    string `json:"message"`
		RawDetails string `json:"raw_details"`
	}
	if json.Unmarshal(out, &raw) != nil {
		return []PRCheckAnnotation{}
	}
	result := make([]PRCheckAnnotation, 0, len(raw))
	for _, item := range raw {
		result = append(result, PRCheckAnnotation{Path: optionalString(item.Path), StartLine: item.StartLine, EndLine: item.EndLine, AnnotationLevel: optionalString(item.Level), Title: optionalString(item.Title), Message: item.Message, RawDetails: optionalString(item.RawDetails)})
	}
	return result
}

func readGitHubWorkflowJobs(ctx context.Context, workdir, owner, repo string, id int64, checkName string) []PRCheckJob {
	out, err := runCLI(ctx, "gh", workdir, "api", fmt.Sprintf("repos/%s/%s/actions/runs/%d/jobs?per_page=100", owner, repo, id))
	if err != nil {
		return []PRCheckJob{}
	}
	var raw struct {
		Jobs []struct {
			ID          int64  `json:"id"`
			Name        string `json:"name"`
			Status      string `json:"status"`
			Conclusion  string `json:"conclusion"`
			StartedAt   string `json:"started_at"`
			CompletedAt string `json:"completed_at"`
			HTMLURL     string `json:"html_url"`
			Steps       []struct {
				Name        string `json:"name"`
				Status      string `json:"status"`
				Conclusion  string `json:"conclusion"`
				StartedAt   string `json:"started_at"`
				CompletedAt string `json:"completed_at"`
			} `json:"steps"`
		} `json:"jobs"`
	}
	if json.Unmarshal(out, &raw) != nil {
		return []PRCheckJob{}
	}
	result := []PRCheckJob{}
	for _, job := range raw.Jobs {
		steps := make([]PRCheckStep, 0, len(job.Steps))
		for _, step := range job.Steps {
			steps = append(steps, PRCheckStep{Name: step.Name, Status: optionalString(step.Status), Conclusion: optionalString(step.Conclusion), StartedAt: optionalString(step.StartedAt), CompletedAt: optionalString(step.CompletedAt)})
		}
		jobID := job.ID
		result = append(result, PRCheckJob{ID: &jobID, Name: job.Name, Status: optionalString(job.Status), Conclusion: optionalString(job.Conclusion), StartedAt: optionalString(job.StartedAt), CompletedAt: optionalString(job.CompletedAt), URL: optionalString(job.HTMLURL), Steps: steps})
	}
	exact := []PRCheckJob{}
	if checkName != "" {
		for _, job := range result {
			if job.Name == checkName {
				exact = append(exact, job)
			}
		}
	}
	if len(exact) > 0 {
		result = exact
	}
	attachFailedJobLogTails(ctx, workdir, owner, repo, result)
	return result
}

func attachFailedJobLogTails(ctx context.Context, workdir, owner, repo string, jobs []PRCheckJob) {
	remaining := 3
	for index := range jobs {
		if remaining == 0 || jobs[index].ID == nil || !isFailedCheckState(jobs[index].Conclusion) {
			continue
		}
		out, err := runCLI(ctx, "gh", workdir, "api", fmt.Sprintf("repos/%s/%s/actions/jobs/%d/logs", owner, repo, *jobs[index].ID))
		if err == nil {
			const maxTailBytes = 16 * 1024
			if len(out) > maxTailBytes {
				out = out[len(out)-maxTailBytes:]
			}
			value := string(out)
			jobs[index].LogTail = &value
		}
		remaining--
	}
}

func isFailedCheckState(value *string) bool {
	if value == nil {
		return false
	}
	switch strings.ToLower(*value) {
	case "failure", "failed", "action_required", "cancelled", "stale", "startup_failure", "timed_out":
		return true
	default:
		return false
	}
}

func optionalString(value string) *string {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	return &value
}
func firstString(values ...string) *string {
	for _, value := range values {
		if result := optionalString(value); result != nil {
			return result
		}
	}
	return nil
}

func mapGitHubPR(raw *ghPRRaw) GitHubWorkItem {
	labels := make([]string, 0, len(raw.Labels))
	for _, l := range raw.Labels {
		if l.Name != "" {
			labels = append(labels, l.Name)
		}
	}
	item := GitHubWorkItem{
		ID:                fmt.Sprintf("pr:%d", raw.Number),
		Type:              "pr",
		Number:            raw.Number,
		Title:             raw.Title,
		State:             mapPRState(raw),
		URL:               raw.URL,
		Labels:            labels,
		UpdatedAt:         raw.UpdatedAt,
		Author:            ghAuthorLogin(raw.Author),
		BranchName:        raw.HeadRefName,
		BaseRefName:       raw.BaseRefName,
		HeadSha:           raw.HeadRefOid,
		IsCrossRepository: raw.IsCrossRepository,
	}
	return item
}

// mapPRState mirrors the state derivation in mapPullRequestWorkItem: merged wins,
// then closed, then draft, then open. gh reports state as MERGED/CLOSED/OPEN.
func mapPRState(raw *ghPRRaw) string {
	switch strings.ToUpper(raw.State) {
	case "MERGED":
		return "merged"
	case "CLOSED":
		return "closed"
	}
	if raw.Merged || raw.MergedAt != nil {
		return "merged"
	}
	if raw.IsDraft {
		return "draft"
	}
	return "open"
}

func ghAuthorLogin(author *ghAuthor) *string {
	if author == nil {
		return nil
	}
	login := author.Login
	if login == "" {
		login = author.Name
	}
	if login == "" {
		return nil
	}
	return &login
}

// mapCheckStatus mirrors mapCheckStatus in migration/electron-reference/src/main/github/mappers.ts.
func mapCheckStatus(state string) string {
	switch strings.ToUpper(state) {
	case "PENDING", "QUEUED":
		return "queued"
	case "IN_PROGRESS":
		return "in_progress"
	default:
		return "completed"
	}
}

// mapCheckConclusion mirrors mapCheckConclusion in migration/electron-reference/src/main/github/mappers.ts.
func mapCheckConclusion(state string) *string {
	var result string
	switch strings.ToUpper(state) {
	case "SUCCESS", "PASS":
		result = "success"
	case "FAILURE", "FAIL", "STALE", "STARTUP_FAILURE":
		result = "failure"
	case "ACTION_REQUIRED":
		result = "action_required"
	case "CANCELLED":
		result = "cancelled"
	case "TIMED_OUT":
		result = "timed_out"
	case "SKIPPED":
		result = "skipped"
	case "PENDING", "QUEUED", "IN_PROGRESS":
		result = "pending"
	case "NEUTRAL":
		result = "neutral"
	default:
		return nil
	}
	return &result
}
