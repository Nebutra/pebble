package providercli

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var pullRequestURLOwnerRepo = regexp.MustCompile(`(?i)^https?://[^/\s]+/([^/\s]+)/([^/\s]+)/pull/\d+`)

const githubPRBranchFields = "number,title,state,url,updatedAt,isDraft,headRefOid,headRefName,baseRefOid,baseRefName,mergeable,reviewDecision,autoMergeRequest,mergeStateStatus,statusCheckRollup"

type GitHubPRForBranchRequest struct {
	Branch                 string  `json:"branch"`
	LinkedPRNumber         *int    `json:"linkedPRNumber,omitempty"`
	FallbackPRNumber       *int    `json:"fallbackPRNumber,omitempty"`
	AcceptMergedFallbackPR bool    `json:"acceptMergedFallbackPR,omitempty"`
	CurrentHeadOID         *string `json:"currentHeadOid,omitempty"`
}

type GitHubPRInfo struct {
	Number           int         `json:"number"`
	Title            string      `json:"title"`
	State            string      `json:"state"`
	URL              string      `json:"url"`
	ChecksStatus     string      `json:"checksStatus"`
	UpdatedAt        string      `json:"updatedAt"`
	Mergeable        string      `json:"mergeable"`
	ReviewDecision   interface{} `json:"reviewDecision,omitempty"`
	AutoMergeEnabled bool        `json:"autoMergeEnabled"`
	MergeStateStatus interface{} `json:"mergeStateStatus,omitempty"`
	HeadSHA          string      `json:"headSha,omitempty"`
	BaseRefName      string      `json:"baseRefName,omitempty"`
	ConfirmedHeadOID string      `json:"confirmedContainedHeadOid,omitempty"`
	// Why: durable linked merged PRs must only clear on a definite not-contained
	// probe for this exact worktree head (upstream #7460 / #10841 family).
	HeadDivergedFromMergedPRAtOID string                   `json:"headDivergedFromMergedPRAtOid,omitempty"`
	PRRepo                        *GitHubOwnerRepo         `json:"prRepo,omitempty"`
	HeadRepo                      *GitHubOwnerRepo         `json:"headRepo,omitempty"`
	ConflictSummary               *GitHubPRConflictSummary `json:"conflictSummary,omitempty"`
}

// MergedPRCommitMembership is a three-way membership probe for merged PR history.
// unknown must never clear a durable linked PR; not-contained is the only positive clear signal.
type MergedPRCommitMembership string

const (
	mergedPRContained    MergedPRCommitMembership = "contained"
	mergedPRNotContained MergedPRCommitMembership = "not-contained"
	mergedPRUnknown      MergedPRCommitMembership = "unknown"
)

type GitHubPRConflictSummary struct {
	BaseRef         string   `json:"baseRef"`
	BaseCommit      string   `json:"baseCommit"`
	CommitsBehind   int      `json:"commitsBehind"`
	Files           []string `json:"files"`
	LocalMergeState string   `json:"localMergeState,omitempty"`
}

type githubPRBranchRaw struct {
	Number           int               `json:"number"`
	Title            string            `json:"title"`
	State            string            `json:"state"`
	URL              string            `json:"url"`
	UpdatedAt        string            `json:"updatedAt"`
	IsDraft          bool              `json:"isDraft"`
	HeadRefOID       string            `json:"headRefOid"`
	HeadRefName      string            `json:"headRefName"`
	BaseRefOID       string            `json:"baseRefOid"`
	BaseRefName      string            `json:"baseRefName"`
	Mergeable        string            `json:"mergeable"`
	ReviewDecision   *string           `json:"reviewDecision"`
	AutoMergeRequest json.RawMessage   `json:"autoMergeRequest"`
	MergeStateStatus *string           `json:"mergeStateStatus"`
	StatusChecks     []json.RawMessage `json:"statusCheckRollup"`
}

func GetGitHubPRForBranch(ctx context.Context, workdir string, input GitHubPRForBranchRequest) (*GitHubPRInfo, error) {
	branch := strings.TrimPrefix(strings.TrimSpace(input.Branch), "refs/heads/")
	candidates, headRepo := githubPRRepositoryCandidates(ctx, workdir)
	var raw *githubPRBranchRaw
	var selectedRepo *GitHubOwnerRepo
	var err error
	if validPRNumber(input.LinkedPRNumber) {
		raw, selectedRepo, err = readGitHubPRBranchByNumberCandidates(ctx, workdir, candidates, *input.LinkedPRNumber)
	} else if branch != "" {
		raw, selectedRepo, err = readGitHubPRBranchByNameCandidates(ctx, workdir, candidates, headRepo, branch)
		if err == nil && raw == nil {
			if remote, trackedBranch := readGitHubTrackedUpstream(ctx, workdir, branch); remote != "" {
				trackedRepo, _ := resolveGitHubRemoteOwnerRepo(ctx, workdir, remote)
				if trackedRepo != nil && (trackedBranch != branch || !sameGitHubRepo(trackedRepo, headRepo)) {
					raw, selectedRepo, err = readGitHubPRBranchByNameCandidates(ctx, workdir, candidates, trackedRepo, trackedBranch)
					if raw != nil {
						headRepo = trackedRepo
					}
				}
			}
		}
	}
	if err != nil {
		return nil, err
	}
	usedFallback := false
	if raw == nil && input.LinkedPRNumber == nil && validPRNumber(input.FallbackPRNumber) {
		raw, selectedRepo, err = readGitHubPRBranchByNumberCandidates(ctx, workdir, candidates, *input.FallbackPRNumber)
		usedFallback = true
	}
	if err != nil || raw == nil {
		return nil, err
	}
	confirmedHead := ""
	headDiverged := ""
	currentHead := ""
	if input.CurrentHeadOID != nil {
		currentHead = strings.TrimSpace(*input.CurrentHeadOID)
	}
	if strings.EqualFold(raw.State, "MERGED") {
		if input.LinkedPRNumber == nil {
			// Implicit / branch-matched merged PR: hide unless the head is on the PR line.
			headMatches := currentHead != "" && strings.EqualFold(currentHead, raw.HeadRefOID)
			preservedFallback := usedFallback && input.AcceptMergedFallbackPR
			if !headMatches && !preservedFallback {
				if currentHead == "" || selectedRepo == nil {
					return nil, nil
				}
				membership := githubMergedPRContainsCommit(ctx, workdir, *selectedRepo, raw.Number, currentHead)
				if membership != mergedPRContained {
					return nil, nil
				}
				confirmedHead = currentHead
			}
		} else if currentHead != "" && !strings.EqualFold(currentHead, raw.HeadRefOID) {
			// Durable linked merged PR: stamp divergence only on definite not-contained.
			probeRepo := selectedRepo
			if probeRepo == nil {
				probeRepo = ownerRepoFromPullRequestURL(raw.URL)
			}
			if probeRepo != nil {
				switch githubMergedPRContainsCommit(ctx, workdir, *probeRepo, raw.Number, currentHead) {
				case mergedPRContained:
					confirmedHead = currentHead
				case mergedPRNotContained:
					headDiverged = currentHead
				}
			}
		}
	}
	result := mapGitHubPRBranchInfo(raw)
	result.PRRepo, result.HeadRepo, result.ConfirmedHeadOID = selectedRepo, headRepo, confirmedHead
	result.HeadDivergedFromMergedPRAtOID = headDiverged
	if result.Mergeable == "CONFLICTING" && raw.BaseRefName != "" && raw.BaseRefOID != "" && raw.HeadRefOID != "" {
		result.ConflictSummary = readGitHubPRConflictSummary(ctx, workdir, raw.BaseRefName, raw.BaseRefOID, raw.HeadRefOID)
	}
	return result, nil
}

// Why: exact-linked `gh pr view` with no resolved repo candidates returns
// selectedRepo=nil; derive the PR's own repo from its web URL so a diverged
// merged linked PR can still be probed and cleared. Host-agnostic for GHE.
func ownerRepoFromPullRequestURL(url string) *GitHubOwnerRepo {
	match := pullRequestURLOwnerRepo.FindStringSubmatch(strings.TrimSpace(url))
	if len(match) != 3 {
		return nil
	}
	return &GitHubOwnerRepo{Owner: match[1], Repo: match[2]}
}

func validPRNumber(value *int) bool { return value != nil && *value > 0 }

func githubPRRepositoryCandidates(ctx context.Context, workdir string) ([]GitHubOwnerRepo, *GitHubOwnerRepo) {
	origin, _ := resolveGitHubRemoteOwnerRepo(ctx, workdir, "origin")
	upstream, _ := resolveGitHubRemoteOwnerRepo(ctx, workdir, "upstream")
	// Why: contributor clones often omit an upstream remote even though their
	// hosted review belongs to the fork parent.
	if upstream == nil && origin != nil {
		if parent := ResolveGitHubForkParent(ctx, workdir, origin.Owner, origin.Repo); parent != nil {
			upstream = &GitHubOwnerRepo{Owner: parent.Owner, Repo: parent.Repo}
		}
	}
	result := make([]GitHubOwnerRepo, 0, 2)
	for _, candidate := range []*GitHubOwnerRepo{upstream, origin} {
		if candidate == nil {
			continue
		}
		duplicate := false
		for index := range result {
			duplicate = duplicate || sameGitHubRepo(&result[index], candidate)
		}
		if !duplicate {
			result = append(result, *candidate)
		}
	}
	return result, origin
}

func sameGitHubRepo(left, right *GitHubOwnerRepo) bool {
	return left != nil && right != nil && strings.EqualFold(left.Owner, right.Owner) && strings.EqualFold(left.Repo, right.Repo)
}

func readGitHubPRBranchByNumberCandidates(ctx context.Context, workdir string, candidates []GitHubOwnerRepo, number int) (*githubPRBranchRaw, *GitHubOwnerRepo, error) {
	if len(candidates) == 0 {
		raw, err := readGitHubPRBranchByNumber(ctx, workdir, number)
		return raw, nil, err
	}
	for index := range candidates {
		raw, err := readGitHubPRBranchByNumberInRepo(ctx, workdir, candidates[index], number)
		if err != nil {
			return nil, nil, err
		}
		if raw != nil {
			return raw, &candidates[index], nil
		}
	}
	return nil, nil, nil
}

func readGitHubPRBranchByNameCandidates(ctx context.Context, workdir string, candidates []GitHubOwnerRepo, headRepo *GitHubOwnerRepo, branch string) (*githubPRBranchRaw, *GitHubOwnerRepo, error) {
	if len(candidates) == 0 || headRepo == nil {
		raw, err := readGitHubPRBranchByName(ctx, workdir, branch)
		return raw, nil, err
	}
	for index := range candidates {
		endpoint := fmt.Sprintf("repos/%s/%s/pulls?head=%s&state=all&per_page=1", candidates[index].Owner, candidates[index].Repo, url.QueryEscape(headRepo.Owner+":"+branch))
		out, err := runCLI(ctx, "gh", workdir, "api", endpoint)
		if err != nil {
			return nil, nil, err
		}
		var rows []githubPRRESTBranchRaw
		if json.Unmarshal(out, &rows) != nil || len(rows) == 0 {
			continue
		}
		raw, err := readGitHubPRBranchByNumberInRepo(ctx, workdir, candidates[index], rows[0].Number)
		if err != nil {
			return nil, nil, err
		}
		if raw == nil {
			raw = rows[0].toBranchRaw()
		}
		return raw, &candidates[index], nil
	}
	return nil, nil, nil
}

type githubPRRESTBranchRaw struct {
	Number    int     `json:"number"`
	Title     string  `json:"title"`
	State     string  `json:"state"`
	HTMLURL   string  `json:"html_url"`
	UpdatedAt string  `json:"updated_at"`
	Draft     bool    `json:"draft"`
	MergedAt  *string `json:"merged_at"`
	Base      struct {
		Ref string `json:"ref"`
		SHA string `json:"sha"`
	} `json:"base"`
	Head struct {
		Ref string `json:"ref"`
		SHA string `json:"sha"`
	} `json:"head"`
}

func (raw githubPRRESTBranchRaw) toBranchRaw() *githubPRBranchRaw {
	state := raw.State
	if raw.MergedAt != nil {
		state = "MERGED"
	}
	return &githubPRBranchRaw{Number: raw.Number, Title: raw.Title, State: state, URL: raw.HTMLURL, UpdatedAt: raw.UpdatedAt, IsDraft: raw.Draft, HeadRefOID: raw.Head.SHA, HeadRefName: raw.Head.Ref, BaseRefOID: raw.Base.SHA, BaseRefName: raw.Base.Ref, Mergeable: "UNKNOWN"}
}

func readGitHubPRBranchByNumberInRepo(ctx context.Context, workdir string, repo GitHubOwnerRepo, number int) (*githubPRBranchRaw, error) {
	out, err := runCLI(ctx, "gh", workdir, "pr", "view", strconv.Itoa(number), "--repo", repo.Owner+"/"+repo.Repo, "--json", githubPRBranchFields)
	if err != nil {
		if isProviderNotFound(err) {
			return nil, nil
		}
		return nil, err
	}
	var raw githubPRBranchRaw
	if json.Unmarshal(out, &raw) != nil || raw.Number < 1 {
		return nil, nil
	}
	return &raw, nil
}

func readGitHubTrackedUpstream(ctx context.Context, workdir, branch string) (string, string) {
	out, err := runCLI(ctx, "git", workdir, "for-each-ref", "--format=%(refname)%00%(upstream)", "refs/heads/"+branch)
	if err != nil {
		return "", ""
	}
	parts := strings.Split(strings.TrimSpace(string(out)), "\x00")
	if len(parts) != 2 || !strings.HasPrefix(parts[1], "refs/remotes/") {
		return "", ""
	}
	remoteBranch := strings.TrimPrefix(parts[1], "refs/remotes/")
	slash := strings.Index(remoteBranch, "/")
	if slash < 1 || slash == len(remoteBranch)-1 {
		return "", ""
	}
	return remoteBranch[:slash], remoteBranch[slash+1:]
}

const (
	commitPullsPageSize = 100
	// Why: a worktree HEAD is associated with ~1 PR, so page 1 is short in practice
	// and this cap is never reached; it only bounds the pathological case of a commit
	// linked to hundreds of PRs, where staying unknown is the safe answer.
	commitPullsMaxPages = 5
)

func githubMergedPRContainsCommit(
	ctx context.Context,
	workdir string,
	repo GitHubOwnerRepo,
	number int,
	oid string,
) MergedPRCommitMembership {
	oid = strings.ToLower(strings.TrimSpace(oid))
	if len(oid) < 4 || len(oid) > 64 {
		return mergedPRUnknown
	}
	for _, char := range oid {
		if !strings.ContainsRune("0123456789abcdef", char) {
			return mergedPRUnknown
		}
	}
	// Why paginate: a full page that omits the target PR may just be truncated.
	// Reading only page 1 and calling it not-contained would wrongly clear a
	// durable link; calling it unknown would never clear one that diverged.
	for page := 1; page <= commitPullsMaxPages; page++ {
		endpoint := fmt.Sprintf(
			"repos/%s/%s/commits/%s/pulls?per_page=%d&page=%d",
			repo.Owner, repo.Repo, oid, commitPullsPageSize, page,
		)
		out, err := runCLI(ctx, "gh", workdir, "api", endpoint)
		if err != nil {
			return mergedPRUnknown
		}
		var rows []struct {
			Number int `json:"number"`
		}
		// Why: a non-array success payload is a shape mismatch, not an empty page.
		if json.Unmarshal(out, &rows) != nil {
			return mergedPRUnknown
		}
		for _, row := range rows {
			if row.Number == number {
				return mergedPRContained
			}
		}
		if len(rows) < commitPullsPageSize {
			return mergedPRNotContained
		}
	}
	return mergedPRUnknown
}

func readGitHubPRConflictSummary(ctx context.Context, workdir, baseRef, fallbackBaseOID, headOID string) *GitHubPRConflictSummary {
	baseOID := fallbackBaseOID
	fetchCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	_, _ = runCLI(fetchCtx, "git", workdir, "fetch", "--quiet", "origin", baseRef)
	cancel()
	for _, ref := range []string{"refs/remotes/origin/" + baseRef, "origin/" + baseRef} {
		if out, err := runCLI(ctx, "git", workdir, "rev-parse", "--verify", ref); err == nil && strings.TrimSpace(string(out)) != "" {
			baseOID = strings.TrimSpace(string(out))
			break
		}
	}
	mergeBaseOut, err := runCLI(ctx, "git", workdir, "merge-base", headOID, baseOID)
	if err != nil || strings.TrimSpace(string(mergeBaseOut)) == "" {
		return nil
	}
	countOut, err := runCLI(ctx, "git", workdir, "rev-list", "--count", headOID+".."+baseOID)
	if err != nil {
		return nil
	}
	commitsBehind, _ := strconv.Atoi(strings.TrimSpace(string(countOut)))
	files, ok := readGitHubPRConflictFiles(ctx, workdir, strings.TrimSpace(string(mergeBaseOut)), headOID, baseOID)
	if !ok {
		return nil
	}
	shortBase := baseOID
	if len(shortBase) > 7 {
		shortBase = shortBase[:7]
	}
	result := &GitHubPRConflictSummary{BaseRef: baseRef, BaseCommit: shortBase, CommitsBehind: commitsBehind, Files: files}
	if len(files) == 0 {
		result.LocalMergeState = "clean"
	}
	return result
}

func readGitHubPRConflictFiles(ctx context.Context, workdir, mergeBase, headOID, baseOID string) ([]string, bool) {
	modern := []string{"merge-tree", "--write-tree", "--name-only", "-z", "--no-messages", "--merge-base", mergeBase, headOID, baseOID}
	stdout, stderr, err := runCLICapture(ctx, "git", workdir, modern...)
	if err != nil && len(stdout) == 0 && strings.Contains(strings.ToLower(string(stderr)), "merge-base") {
		stdout, _, err = runCLICapture(ctx, "git", workdir, "merge-tree", "--write-tree", "--name-only", "-z", "--no-messages", headOID, baseOID)
	}
	if err != nil && len(stdout) == 0 {
		return nil, false
	}
	entries := strings.Split(string(stdout), "\x00")
	files := make([]string, 0)
	for index, entry := range entries {
		if index > 0 && entry != "" {
			files = append(files, entry)
		}
	}
	return files, true
}

func readGitHubPRBranchByNumber(ctx context.Context, workdir string, number int) (*githubPRBranchRaw, error) {
	out, err := runCLI(ctx, "gh", workdir, "pr", "view", strconv.Itoa(number), "--json", githubPRBranchFields)
	if err != nil {
		if isProviderNotFound(err) {
			return nil, nil
		}
		return nil, err
	}
	var raw githubPRBranchRaw
	if json.Unmarshal(out, &raw) != nil || raw.Number < 1 {
		return nil, nil
	}
	return &raw, nil
}

func readGitHubPRBranchByName(ctx context.Context, workdir, branch string) (*githubPRBranchRaw, error) {
	out, err := runCLI(ctx, "gh", workdir, "pr", "list", "--head", branch, "--state", "all", "--limit", "20", "--json", githubPRBranchFields)
	if err != nil {
		return nil, err
	}
	var rows []githubPRBranchRaw
	if json.Unmarshal(out, &rows) != nil || len(rows) == 0 {
		return nil, nil
	}
	return &rows[0], nil
}

func mapGitHubPRBranchInfo(raw *githubPRBranchRaw) *GitHubPRInfo {
	state := strings.ToLower(raw.State)
	if raw.IsDraft && state == "open" {
		state = "draft"
	}
	mergeable := strings.ToUpper(firstNonEmpty(raw.Mergeable, "UNKNOWN"))
	if raw.MergeStateStatus != nil && strings.EqualFold(*raw.MergeStateStatus, "DIRTY") {
		mergeable = "CONFLICTING"
	}
	info := &GitHubPRInfo{
		Number: raw.Number, Title: raw.Title, State: state, URL: raw.URL,
		ChecksStatus: githubPRChecksStatus(raw.StatusChecks), UpdatedAt: raw.UpdatedAt,
		Mergeable:        mergeable,
		AutoMergeEnabled: len(raw.AutoMergeRequest) > 0 && string(raw.AutoMergeRequest) != "null",
		HeadSHA:          raw.HeadRefOID, BaseRefName: raw.BaseRefName,
	}
	if raw.ReviewDecision != nil {
		info.ReviewDecision = *raw.ReviewDecision
	}
	if raw.MergeStateStatus != nil {
		info.MergeStateStatus = *raw.MergeStateStatus
	}
	return info
}

func githubPRChecksStatus(rows []json.RawMessage) string {
	if len(rows) == 0 {
		return "neutral"
	}
	pending := false
	for _, row := range rows {
		lower := strings.ToLower(string(row))
		if strings.Contains(lower, `"conclusion":"failure"`) || strings.Contains(lower, `"conclusion":"cancelled"`) || strings.Contains(lower, `"state":"failure"`) || strings.Contains(lower, `"state":"error"`) {
			return "failure"
		}
		if strings.Contains(lower, `"status":"in_progress"`) || strings.Contains(lower, `"status":"queued"`) || strings.Contains(lower, `"state":"pending"`) {
			pending = true
		}
	}
	if pending {
		return "pending"
	}
	return "success"
}
