package runtimehttp

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
)

// The git surface a paired client reads: status, diffs, history, and the
// remote URLs the review UI links to. Every method is scoped to one worktree,
// which the client names with the same selector the worktree RPCs take.
//
// Mutating git methods (commit, push, pull, rebase, conflict resolution) are
// deliberately absent — they have no runtimecore implementation to call yet.

// legacySharedControlGitReadMethods is checked before the worktree is resolved,
// so a git method this runtime does not implement still answers "unknown
// method" rather than blaming the worktree selector it never looked at.
var legacySharedControlGitReadMethods = map[string]bool{
	"git.status": true, "git.submoduleStatus": true, "git.checkIgnored": true,
	"git.history": true, "git.branchCompare": true, "git.commitCompare": true,
	"git.diff": true, "git.branchDiff": true, "git.commitDiff": true,
	"git.remoteFileUrl": true, "git.remoteCommitUrl": true,
	"git.upstreamStatus": true,
}

func (s *Server) runLegacySharedControlGitMethod(method string, raw json.RawMessage) (interface{}, bool, error) {
	if !legacySharedControlGitReadMethods[method] {
		return nil, false, nil
	}
	worktree, found := s.findLegacySharedControlWorktree(readLegacySharedControlGitWorktreeSelector(raw))
	if !found {
		return nil, true, runtimecore.ErrNotFound
	}
	ctx := context.Background()
	switch method {
	case "git.status":
		var params struct {
			Area           string `json:"area"`
			IncludeIgnored bool   `json:"includeIgnored"`
		}
		if err := readLegacySharedControlGitParams(raw, &params); err != nil {
			return nil, true, err
		}
		return legacySharedControlGitResult(s.manager.GitWorktreeStatus(ctx, runtimecore.GitWorktreeStatusRequest{
			ProjectID:      worktree.ProjectID,
			WorktreeID:     worktree.ID,
			Area:           params.Area,
			IncludeIgnored: params.IncludeIgnored,
		}))
	case "git.submoduleStatus":
		var params struct {
			SubmodulePath string `json:"submodulePath"`
			Area          string `json:"area"`
		}
		if err := readLegacySharedControlGitParams(raw, &params); err != nil {
			return nil, true, err
		}
		return legacySharedControlGitResult(s.manager.GitSubmoduleStatus(ctx, runtimecore.GitSubmoduleStatusRequest{
			ProjectID:     worktree.ProjectID,
			WorktreeID:    worktree.ID,
			SubmodulePath: params.SubmodulePath,
			Area:          params.Area,
		}))
	case "git.checkIgnored":
		var params struct {
			Paths []string `json:"paths"`
		}
		if err := readLegacySharedControlGitParams(raw, &params); err != nil {
			return nil, true, err
		}
		return legacySharedControlGitResult(s.manager.GitCheckIgnored(ctx, runtimecore.GitCheckIgnoredRequest{
			ProjectID:  worktree.ProjectID,
			WorktreeID: worktree.ID,
			Paths:      params.Paths,
		}))
	case "git.history":
		var params struct {
			Limit   int    `json:"limit"`
			BaseRef string `json:"baseRef"`
		}
		if err := readLegacySharedControlGitParams(raw, &params); err != nil {
			return nil, true, err
		}
		return legacySharedControlGitResult(s.manager.GitHistory(ctx, runtimecore.GitHistoryRequest{
			ProjectID:  worktree.ProjectID,
			WorktreeID: worktree.ID,
			Limit:      params.Limit,
			BaseRef:    params.BaseRef,
		}))
	case "git.branchCompare":
		var params struct {
			BaseRef string `json:"baseRef"`
		}
		if err := readLegacySharedControlGitParams(raw, &params); err != nil {
			return nil, true, err
		}
		return legacySharedControlGitResult(s.manager.GitBranchCompare(ctx, runtimecore.GitBranchCompareRequest{
			ProjectID:  worktree.ProjectID,
			WorktreeID: worktree.ID,
			BaseRef:    params.BaseRef,
		}))
	case "git.commitCompare":
		var params struct {
			CommitID string `json:"commitId"`
		}
		if err := readLegacySharedControlGitParams(raw, &params); err != nil {
			return nil, true, err
		}
		return legacySharedControlGitResult(s.manager.GitCommitCompare(ctx, runtimecore.GitCommitCompareRequest{
			ProjectID:  worktree.ProjectID,
			WorktreeID: worktree.ID,
			CommitID:   params.CommitID,
		}))
	case "git.diff":
		var params struct {
			FilePath           string `json:"filePath"`
			Staged             bool   `json:"staged"`
			CompareAgainstHead bool   `json:"compareAgainstHead"`
		}
		if err := readLegacySharedControlGitParams(raw, &params); err != nil {
			return nil, true, err
		}
		return legacySharedControlGitResult(s.manager.GitFileDiff(ctx, runtimecore.GitFileDiffRequest{
			ProjectID:          worktree.ProjectID,
			WorktreeID:         worktree.ID,
			FilePath:           params.FilePath,
			Staged:             params.Staged,
			CompareAgainstHead: params.CompareAgainstHead,
		}))
	case "git.branchDiff":
		var params struct {
			FilePath string `json:"filePath"`
			Compare  struct {
				BaseRef    string `json:"baseRef"`
				CompareRef string `json:"compareRef"`
			} `json:"compare"`
			OldPath string `json:"oldPath"`
		}
		if err := readLegacySharedControlGitParams(raw, &params); err != nil {
			return nil, true, err
		}
		return legacySharedControlGitResult(s.manager.GitRefFileDiff(ctx, runtimecore.GitRefFileDiffRequest{
			ProjectID:  worktree.ProjectID,
			WorktreeID: worktree.ID,
			LeftRef:    params.Compare.BaseRef,
			RightRef:   params.Compare.CompareRef,
			FilePath:   params.FilePath,
			OldPath:    params.OldPath,
		}))
	case "git.commitDiff":
		var params struct {
			FilePath  string `json:"filePath"`
			CommitOid string `json:"commitOid"`
			ParentOid string `json:"parentOid"`
			OldPath   string `json:"oldPath"`
		}
		if err := readLegacySharedControlGitParams(raw, &params); err != nil {
			return nil, true, err
		}
		// Why: a commit diff is the ref diff between the commit and its parent;
		// the root commit has none, so git's empty-tree object stands in.
		parent := strings.TrimSpace(params.ParentOid)
		if parent == "" {
			parent = legacySharedControlGitEmptyTree
		}
		return legacySharedControlGitResult(s.manager.GitRefFileDiff(ctx, runtimecore.GitRefFileDiffRequest{
			ProjectID:  worktree.ProjectID,
			WorktreeID: worktree.ID,
			LeftRef:    parent,
			RightRef:   params.CommitOid,
			FilePath:   params.FilePath,
			OldPath:    params.OldPath,
		}))
	case "git.remoteFileUrl":
		var params struct {
			RelativePath string `json:"relativePath"`
			Line         int    `json:"line"`
		}
		if err := readLegacySharedControlGitParams(raw, &params); err != nil {
			return nil, true, err
		}
		return legacySharedControlGitResult(s.manager.GitRemoteFileURL(ctx, runtimecore.GitRemoteFileURLRequest{
			ProjectID:    worktree.ProjectID,
			WorktreeID:   worktree.ID,
			RelativePath: params.RelativePath,
			Line:         params.Line,
		}))
	case "git.upstreamStatus":
		var params struct {
			PushTarget runtimecore.GitUpstreamPushHint `json:"pushTarget"`
		}
		if err := readLegacySharedControlGitParams(raw, &params); err != nil {
			return nil, true, err
		}
		return legacySharedControlGitResult(s.manager.GitWorktreeUpstreamStatus(ctx, runtimecore.GitWorktreeUpstreamStatusRequest{
			ProjectID:  worktree.ProjectID,
			WorktreeID: worktree.ID,
			PushTarget: params.PushTarget,
		}))
	case "git.remoteCommitUrl":
		var params struct {
			SHA string `json:"sha"`
		}
		if err := readLegacySharedControlGitParams(raw, &params); err != nil {
			return nil, true, err
		}
		return legacySharedControlGitResult(s.manager.GitRemoteCommitURL(ctx, runtimecore.GitRemoteCommitURLRequest{
			ProjectID:  worktree.ProjectID,
			WorktreeID: worktree.ID,
			SHA:        params.SHA,
		}))
	default:
		return nil, false, nil
	}
}

// legacySharedControlGitResult adapts a manager call's (value, error) pair to
// the (result, handled, error) shape the request dispatcher expects.
func legacySharedControlGitResult[T any](value T, err error) (interface{}, bool, error) {
	if err != nil {
		return nil, true, err
	}
	return value, true, nil
}

// The empty tree every git repository has, used as the parent of a root commit.
const legacySharedControlGitEmptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

func readLegacySharedControlGitParams(raw json.RawMessage, target interface{}) error {
	if len(raw) == 0 {
		return nil
	}
	if json.Unmarshal(raw, target) != nil {
		return errors.New("invalid git parameters")
	}
	return nil
}

func readLegacySharedControlGitWorktreeSelector(raw json.RawMessage) string {
	selector, _ := readLegacySharedControlWorktree(raw)
	return selector
}
