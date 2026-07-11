package runtimecore

import (
	"context"
	"errors"
	"sort"
	"strings"
)

// This file mirrors the Tauri Rust command
// source_control_text_generation_commit_context/_pull_request_context (see
// pebble/desktop-tauri/src-tauri/src/commands/source_control_text_generation.rs)
// so pebble-relay-worker can build the identical JSON shape on an SSH-remote
// host: the desktop's shared prompt builders and agent-plan execution only
// differ in where this context comes from, not how it is used.

// GitCommitTextGenerationContext mirrors the Rust
// SourceControlCommitContextResult / TS CommitMessageDraftContext field names
// (camelCase via JSON tags) so the desktop can treat local and relay results
// identically.
type GitCommitTextGenerationContext struct {
	Branch        *string `json:"branch"`
	StagedSummary string  `json:"stagedSummary"`
	StagedPatch   string  `json:"stagedPatch"`
}

// GitPullRequestTextGenerationContext mirrors the Rust
// SourceControlPullRequestContextResult / TS PullRequestDraftContext field
// names.
type GitPullRequestTextGenerationContext struct {
	Branch                     *string `json:"branch"`
	Base                       string  `json:"base"`
	BranchChangedByPreparation bool    `json:"branchChangedByPreparation"`
	CurrentTitle               string  `json:"currentTitle"`
	CurrentBody                string  `json:"currentBody"`
	CurrentDraft               bool    `json:"currentDraft"`
	CommitSummary              string  `json:"commitSummary"`
	ChangeSummary              string  `json:"changeSummary"`
	Patch                      string  `json:"patch"`
}

// BuildGitCommitTextGenerationContext reads staged-diff context for the commit
// message prompt on whatever host it executes on (local runtime process for
// local projects, pebble-relay-worker for SSH-remote projects).
func BuildGitCommitTextGenerationContext(ctx context.Context, repoPath string) (GitCommitTextGenerationContext, error) {
	repoPath = strings.TrimSpace(repoPath)
	if repoPath == "" {
		return GitCommitTextGenerationContext{}, errors.New("repository path is required")
	}
	branch, _ := readGitOutputRaw(ctx, repoPath, "branch", "--show-current")
	stagedSummary, err := readGitOutputRaw(ctx, repoPath, "diff", "--cached", "--name-status", "--")
	if err != nil {
		return GitCommitTextGenerationContext{}, err
	}
	stagedPatch, err := readGitOutputRaw(
		ctx,
		repoPath,
		"diff", "--cached", "--patch", "--minimal", "--no-color", "--no-ext-diff", "--",
	)
	if err != nil {
		return GitCommitTextGenerationContext{}, err
	}
	return GitCommitTextGenerationContext{
		Branch:        normalizeOptionalGitText(branch),
		StagedSummary: stagedSummary,
		StagedPatch:   stagedPatch,
	}, nil
}

// BuildGitPullRequestTextGenerationContext reads base-vs-head diff/commit-log
// context for the pull request fields prompt. Returns (nil, nil) when there is
// nothing to summarize (empty base, or branch does not differ from base),
// mirroring the Rust command's `Option` return used to short-circuit the
// desktop caller with "No branch changes to summarize."
func BuildGitPullRequestTextGenerationContext(
	ctx context.Context,
	repoPath string,
	base string,
	currentTitle string,
	currentBody string,
	currentDraft bool,
) (*GitPullRequestTextGenerationContext, error) {
	repoPath = strings.TrimSpace(repoPath)
	if repoPath == "" {
		return nil, errors.New("repository path is required")
	}
	trimmedBase := strings.TrimSpace(base)
	if trimmedBase == "" || strings.HasPrefix(trimmedBase, "-") {
		return nil, nil
	}

	remotes := splitGitLinesRaw(readGitOutputRawOrEmpty(ctx, repoPath, "remote"))
	refs := filterOutHeadRefs(splitGitLinesRaw(readGitOutputRawOrEmpty(
		ctx, repoPath, "for-each-ref", "--format=%(refname:short)", "refs/remotes",
	)))
	comparisonBase, fetchTarget := resolveGitComparisonBase(trimmedBase, remotes, refs)
	if fetchTarget != nil {
		refspec := "+refs/heads/" + fetchTarget.Branch + ":refs/remotes/" + fetchTarget.Remote + "/" + fetchTarget.Branch
		_, _ = readGitOutputRaw(ctx, repoPath, "fetch", "--no-tags", fetchTarget.Remote, refspec)
	}

	branch, _ := readGitOutputRaw(ctx, repoPath, "branch", "--show-current")
	mergeBase, _ := readGitOutputRaw(ctx, repoPath, "merge-base", comparisonBase, "HEAD")
	mergeBase = strings.TrimSpace(mergeBase)
	if mergeBase == "" {
		return nil, nil
	}
	rangeSpec := mergeBase + "..HEAD"
	commitSummary := readGitOutputRawOrEmpty(ctx, repoPath, "log", "--pretty=format:- %s", "--max-count=50", rangeSpec)
	changeSummary := readGitOutputRawOrEmpty(ctx, repoPath, "diff", "--name-status", rangeSpec)
	patch := readGitOutputRawOrEmpty(
		ctx, repoPath, "diff", "--patch", "--minimal", "--no-color", "--no-ext-diff", rangeSpec,
	)
	if strings.TrimSpace(commitSummary) == "" && strings.TrimSpace(changeSummary) == "" && strings.TrimSpace(patch) == "" {
		return nil, nil
	}

	return &GitPullRequestTextGenerationContext{
		Branch:                     normalizeOptionalGitText(branch),
		Base:                       trimmedBase,
		BranchChangedByPreparation: false,
		CurrentTitle:               currentTitle,
		CurrentBody:                currentBody,
		CurrentDraft:               currentDraft,
		CommitSummary:              commitSummary,
		ChangeSummary:              changeSummary,
		Patch:                      patch,
	}, nil
}

type gitRemoteBranchRef struct {
	Remote string
	Branch string
	Ref    string
}

// resolveGitComparisonBase mirrors the Rust resolve_comparison_base: prefer an
// already-qualified remote branch, then an exact ref match, then the common
// origin/upstream remotes, then a uniquely-matching remote ref suffix.
func resolveGitComparisonBase(base string, remotes []string, refs []string) (string, *gitRemoteBranchRef) {
	if qualified := parseGitRemoteBranch(base, remotes); qualified != nil {
		return qualified.Ref, qualified
	}
	if containsString(refs, base) {
		return base, parseGitRemoteRef(base, remotes)
	}
	for _, candidate := range []string{"origin/" + base, "upstream/" + base} {
		parsed := parseGitRemoteRef(candidate, remotes)
		if parsed != nil && (containsString(refs, candidate) || containsString(remotes, parsed.Remote)) {
			return candidate, parsed
		}
	}
	var matching []string
	suffix := "/" + base
	for _, ref := range refs {
		if strings.HasSuffix(ref, suffix) {
			matching = append(matching, ref)
		}
	}
	if len(matching) == 1 {
		return matching[0], parseGitRemoteRef(matching[0], remotes)
	}
	return base, nil
}

func parseGitRemoteBranch(ref string, remotes []string) *gitRemoteBranchRef {
	sorted := append([]string(nil), remotes...)
	sort.Slice(sorted, func(i, j int) bool { return len(sorted[i]) > len(sorted[j]) })
	for _, remote := range sorted {
		prefix := remote + "/"
		if strings.HasPrefix(ref, prefix) {
			branch := ref[len(prefix):]
			if branch == "" {
				return nil
			}
			return &gitRemoteBranchRef{Remote: remote, Branch: branch, Ref: ref}
		}
	}
	return nil
}

func parseGitRemoteRef(ref string, remotes []string) *gitRemoteBranchRef {
	if parsed := parseGitRemoteBranch(ref, remotes); parsed != nil {
		return parsed
	}
	remote, branch, ok := strings.Cut(ref, "/")
	if !ok || remote == "" || branch == "" {
		return nil
	}
	return &gitRemoteBranchRef{Remote: remote, Branch: branch, Ref: ref}
}

func filterOutHeadRefs(refs []string) []string {
	filtered := make([]string, 0, len(refs))
	for _, ref := range refs {
		if !strings.HasSuffix(ref, "/HEAD") {
			filtered = append(filtered, ref)
		}
	}
	return filtered
}

func splitGitLinesRaw(output string) []string {
	var lines []string
	for _, line := range strings.Split(output, "\n") {
		if trimmed := strings.TrimSpace(line); trimmed != "" {
			lines = append(lines, trimmed)
		}
	}
	return lines
}

func readGitOutputRawOrEmpty(ctx context.Context, repoPath string, args ...string) string {
	output, err := readGitOutputRaw(ctx, repoPath, args...)
	if err != nil {
		return ""
	}
	return output
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func normalizeOptionalGitText(value string) *string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}
