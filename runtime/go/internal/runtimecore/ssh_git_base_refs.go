package runtimecore

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"
)

type GitBaseRefDefaultResult struct {
	DefaultBaseRef *string `json:"defaultBaseRef"`
	RemoteCount    int     `json:"remoteCount"`
}

func (m *Manager) ResolveSshGitReviewStart(projectID, kind string, number int, head, base string, cross bool) (GitReviewStartPointResult, error) {
	project, root, err := m.sshFileRelayScope(projectID, "")
	if err != nil {
		return GitReviewStartPointResult{}, err
	}
	if kind != "pr" && kind != "mr" {
		return GitReviewStartPointResult{}, errors.New("unsupported review kind")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	args := []string{
		"git-review-start-json", "--kind", kind, "--root", root,
		"--number", strconv.Itoa(number), "--head", strings.TrimSpace(head), "--base", strings.TrimSpace(base),
	}
	if cross {
		args = append(args, "--cross-repository")
	}
	output, err := m.runSshRelayWorker(ctx, project.HostID, args)
	if err != nil {
		return GitReviewStartPointResult{}, err
	}
	var result GitReviewStartPointResult
	if err := json.Unmarshal(output, &result); err != nil {
		return GitReviewStartPointResult{}, errors.New("relay worker returned malformed review start point")
	}
	return result, nil
}

type GitBaseRefSearchResult struct {
	RefName         string `json:"refName"`
	LocalBranchName string `json:"localBranchName"`
}

type GitPushTarget struct {
	RemoteName string `json:"remoteName"`
	BranchName string `json:"branchName"`
}

type GitReviewStartPointResult struct {
	Error              string         `json:"error,omitempty"`
	BaseBranch         string         `json:"baseBranch,omitempty"`
	CompareBaseRef     string         `json:"compareBaseRef,omitempty"`
	PushTarget         *GitPushTarget `json:"pushTarget,omitempty"`
	HeadSHA            string         `json:"headSha,omitempty"`
	BranchNameOverride string         `json:"branchNameOverride,omitempty"`
}

func (m *Manager) SshGitBaseRefDefault(projectID string) (GitBaseRefDefaultResult, error) {
	project, root, err := m.sshFileRelayScope(projectID, "")
	if err != nil {
		return GitBaseRefDefaultResult{}, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()
	output, err := m.runSshRelayWorker(ctx, project.HostID, []string{"git-base-refs-json", "--mode", "default", "--root", root})
	if err != nil {
		return GitBaseRefDefaultResult{}, err
	}
	var result GitBaseRefDefaultResult
	if err := json.Unmarshal(output, &result); err != nil {
		return GitBaseRefDefaultResult{}, errors.New("relay worker returned malformed base-ref default")
	}
	return result, nil
}

func (m *Manager) SearchSshGitBaseRefs(projectID string, query string, limit int) ([]GitBaseRefSearchResult, error) {
	project, root, err := m.sshFileRelayScope(projectID, "")
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()
	output, err := m.runSshRelayWorker(ctx, project.HostID, []string{
		"git-base-refs-json", "--mode", "search", "--root", root, "--query", query, "--limit", strconv.Itoa(limit),
	})
	if err != nil {
		return nil, err
	}
	var result []GitBaseRefSearchResult
	if err := json.Unmarshal(output, &result); err != nil {
		return nil, errors.New("relay worker returned malformed base-ref search")
	}
	return result, nil
}
