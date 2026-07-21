package runtimecore

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
)

type HostGitReviewStartRequest struct {
	ProjectID         string
	Kind              string
	Number            int
	Head              string
	Base              string
	IsCrossRepository bool
}

func (m *Manager) ResolveHostGitReviewStart(ctx context.Context, request HostGitReviewStartRequest) GitReviewStartPointResult {
	project, err := m.localGitProject(request.ProjectID)
	if err != nil {
		return GitReviewStartPointResult{Error: err.Error()}
	}
	result, err := resolveHostGitReviewStart(ctx, project.Path, request)
	if err != nil {
		return GitReviewStartPointResult{Error: err.Error()}
	}
	return result
}

func (m *Manager) PrefetchHostWorktreeBase(ctx context.Context, projectID, base string) {
	project, err := m.localGitProject(projectID)
	if err != nil {
		return
	}
	remote, branch, ok := splitRemoteTrackingBase(base)
	if !ok {
		return
	}
	_ = fetchHostRemoteBranch(ctx, project.Path, remote, branch)
}

func resolveHostGitReviewStart(ctx context.Context, path string, request HostGitReviewStartRequest) (GitReviewStartPointResult, error) {
	head := strings.TrimSpace(request.Head)
	if head == "" {
		return GitReviewStartPointResult{}, fmt.Errorf("%s #%d has no head branch metadata", strings.ToUpper(request.Kind), request.Number)
	}
	remote, err := defaultHostGitRemote(ctx, path)
	if err != nil {
		return GitReviewStartPointResult{}, err
	}
	if request.Kind == "mr" {
		return resolveHostGitMRStart(ctx, path, remote, request)
	}
	return resolveHostGitPRStart(ctx, path, remote, request)
}

func resolveHostGitPRStart(ctx context.Context, path, remote string, request HostGitReviewStartRequest) (GitReviewStartPointResult, error) {
	compare := optionalHostCompareRef(remote, request.Base)
	fetchCompare := func() error {
		if strings.TrimSpace(request.Base) == "" {
			return nil
		}
		if err := fetchHostRemoteBranch(ctx, path, remote, request.Base); err != nil {
			return fmt.Errorf("failed to fetch %s/%s: %w", remote, request.Base, err)
		}
		return nil
	}
	if request.IsCrossRepository {
		headSHA, err := fetchHostPullRequestHead(ctx, path, remote, request.Number)
		if err != nil {
			return GitReviewStartPointResult{}, err
		}
		if err := fetchCompare(); err != nil {
			return GitReviewStartPointResult{}, err
		}
		return GitReviewStartPointResult{BaseBranch: headSHA, CompareBaseRef: compare, HeadSHA: headSHA, BranchNameOverride: request.Head}, nil
	}
	if err := fetchHostRemoteBranch(ctx, path, remote, request.Head); err != nil {
		headSHA, fallbackErr := fetchHostPullRequestHead(ctx, path, remote, request.Number)
		if fallbackErr != nil {
			return GitReviewStartPointResult{}, fmt.Errorf("failed to fetch %s/%s: %w", remote, request.Head, err)
		}
		if err := fetchCompare(); err != nil {
			return GitReviewStartPointResult{}, err
		}
		return GitReviewStartPointResult{BaseBranch: headSHA, CompareBaseRef: compare, HeadSHA: headSHA, BranchNameOverride: request.Head}, nil
	}
	remoteRef := remote + "/" + request.Head
	headSHA, err := hostGitRequiredOutput(ctx, path, "rev-parse", "--verify", remoteRef)
	if err != nil || headSHA == "" {
		return GitReviewStartPointResult{}, fmt.Errorf("remote ref %s does not exist after fetch", remoteRef)
	}
	if err := fetchCompare(); err != nil {
		return GitReviewStartPointResult{}, err
	}
	return GitReviewStartPointResult{
		BaseBranch: headSHA, CompareBaseRef: compare, HeadSHA: headSHA, BranchNameOverride: request.Head,
		PushTarget: &GitPushTarget{RemoteName: remote, BranchName: request.Head},
	}, nil
}

func resolveHostGitMRStart(ctx context.Context, path, remote string, request HostGitReviewStartRequest) (GitReviewStartPointResult, error) {
	compare := optionalHostCompareRef(remote, request.Base)
	fetchOptionalCompare := func() string {
		if compare == "" || fetchHostRemoteBranch(ctx, path, remote, request.Base) != nil {
			return ""
		}
		return compare
	}
	if request.IsCrossRepository {
		ref := "refs/merge-requests/" + strconv.Itoa(request.Number) + "/head"
		if _, err := hostGitRequiredOutput(ctx, path, "fetch", remote, ref); err != nil {
			return GitReviewStartPointResult{}, fmt.Errorf("failed to fetch %s: %w", ref, err)
		}
		headSHA, err := hostGitRequiredOutput(ctx, path, "rev-parse", "--verify", "FETCH_HEAD")
		if err != nil || headSHA == "" {
			return GitReviewStartPointResult{}, fmt.Errorf("could not resolve fork MR !%d head after fetch", request.Number)
		}
		return GitReviewStartPointResult{BaseBranch: headSHA, CompareBaseRef: fetchOptionalCompare()}, nil
	}
	if err := fetchHostRemoteBranch(ctx, path, remote, request.Head); err != nil {
		return GitReviewStartPointResult{}, fmt.Errorf("failed to fetch %s/%s: %w", remote, request.Head, err)
	}
	remoteRef := remote + "/" + request.Head
	if _, err := hostGitRequiredOutput(ctx, path, "rev-parse", "--verify", remoteRef); err != nil {
		return GitReviewStartPointResult{}, fmt.Errorf("remote ref %s does not exist after fetch", remoteRef)
	}
	return GitReviewStartPointResult{
		BaseBranch: remoteRef, CompareBaseRef: fetchOptionalCompare(),
		PushTarget: &GitPushTarget{RemoteName: remote, BranchName: request.Head},
	}, nil
}

func fetchHostPullRequestHead(ctx context.Context, path, remote string, number int) (string, error) {
	ref := "refs/pull/" + strconv.Itoa(number) + "/head"
	if _, err := hostGitRequiredOutput(ctx, path, "fetch", remote, ref); err != nil {
		return "", fmt.Errorf("failed to fetch %s: %w", ref, err)
	}
	sha, err := hostGitRequiredOutput(ctx, path, "rev-parse", "--verify", "FETCH_HEAD")
	if err != nil || sha == "" {
		return "", errors.New("could not resolve PR head after fetch")
	}
	return sha, nil
}

func fetchHostRemoteBranch(ctx context.Context, path, remote, branch string) error {
	remote = strings.TrimSpace(remote)
	branch = strings.TrimSpace(branch)
	if remote == "" || branch == "" || strings.Contains(branch, "..") {
		return errors.New("invalid remote branch")
	}
	refspec := "+refs/heads/" + branch + ":refs/remotes/" + remote + "/" + branch
	_, err := hostGitRequiredOutput(ctx, path, "fetch", remote, refspec)
	return err
}

func defaultHostGitRemote(ctx context.Context, path string) (string, error) {
	remotes := hostGitLines(ctx, path, "remote")
	for _, remote := range remotes {
		if remote == "origin" {
			return remote, nil
		}
	}
	if len(remotes) == 0 {
		return "", errors.New("repository has no configured git remote")
	}
	return remotes[0], nil
}

func optionalHostCompareRef(remote, branch string) string {
	branch = strings.TrimSpace(branch)
	if branch == "" {
		return ""
	}
	return "refs/remotes/" + remote + "/" + branch
}

func splitRemoteTrackingBase(base string) (string, string, bool) {
	base = strings.TrimPrefix(strings.TrimSpace(base), "refs/remotes/")
	if base == "" || strings.HasPrefix(base, "refs/") || strings.Contains(base, "..") {
		return "", "", false
	}
	index := strings.IndexByte(base, '/')
	if index <= 0 || index == len(base)-1 {
		return "", "", false
	}
	return base[:index], base[index+1:], true
}

func hostGitRequiredOutput(ctx context.Context, path string, args ...string) (string, error) {
	commandCtx, cancel := context.WithTimeout(ctx, gitCommandTimeout)
	defer cancel()
	argv := append([]string{"-C", path}, args...)
	output, err := exec.CommandContext(commandCtx, "git", argv...).CombinedOutput()
	if err != nil {
		return "", errors.New(commandFailureMessage(output, err))
	}
	return strings.TrimSpace(string(output)), nil
}
