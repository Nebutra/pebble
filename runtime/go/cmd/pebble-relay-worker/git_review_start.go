package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"strings"

	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
)

func runGitReviewStartJSON(args []string, output io.Writer) error {
	fs := flag.NewFlagSet("git-review-start-json", flag.ContinueOnError)
	fs.SetOutput(output)
	kind := fs.String("kind", "", "pr or mr")
	root := fs.String("root", "", "remote git workspace root")
	number := fs.Int("number", 0, "PR number or MR IID")
	head := fs.String("head", "", "head/source branch")
	base := fs.String("base", "", "base/target branch")
	cross := fs.Bool("cross-repository", false, "review originates in another repository")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if strings.TrimSpace(*root) == "" || *number <= 0 {
		return errors.New("root and positive number are required")
	}
	result, err := resolveGitReviewStart(*root, *kind, *number, *head, *base, *cross)
	if err != nil {
		result = runtimecore.GitReviewStartPointResult{Error: err.Error()}
	}
	return json.NewEncoder(output).Encode(result)
}

func resolveGitReviewStart(root, kind string, number int, head, base string, cross bool) (runtimecore.GitReviewStartPointResult, error) {
	head = strings.TrimSpace(head)
	base = strings.TrimSpace(base)
	if head == "" {
		return runtimecore.GitReviewStartPointResult{}, fmt.Errorf("review #%d has no head branch metadata", number)
	}
	remotes, err := gitRemoteNames(root)
	if err != nil || len(remotes) == 0 {
		return runtimecore.GitReviewStartPointResult{}, errors.New("repository has no configured remote")
	}
	remote := remotes[0]
	if containsString(remotes, "origin") {
		remote = "origin"
	}
	compare := ""
	if base != "" {
		compare = "refs/remotes/" + remote + "/" + base
		if err := fetchRemoteTrackingRef(root, remote, base); err != nil && kind == "pr" {
			return runtimecore.GitReviewStartPointResult{}, fmt.Errorf("failed to fetch %s/%s: %w", remote, base, err)
		}
	}
	if cross {
		providerRef := fmt.Sprintf("refs/pull/%d/head", number)
		if kind == "mr" {
			providerRef = fmt.Sprintf("refs/merge-requests/%d/head", number)
		}
		if _, err := gitOutput(root, "fetch", remote, providerRef); err != nil {
			return runtimecore.GitReviewStartPointResult{}, fmt.Errorf("failed to fetch %s: %w", providerRef, err)
		}
		sha, err := gitOutput(root, "rev-parse", "--verify", "FETCH_HEAD")
		if err != nil || strings.TrimSpace(sha) == "" {
			return runtimecore.GitReviewStartPointResult{}, errors.New("could not resolve fetched review head")
		}
		value := strings.TrimSpace(sha)
		result := runtimecore.GitReviewStartPointResult{BaseBranch: value, CompareBaseRef: compare}
		if kind == "pr" {
			result.HeadSHA = value
			result.BranchNameOverride = head
		}
		return result, nil
	}
	if err := fetchRemoteTrackingRef(root, remote, head); err != nil {
		return runtimecore.GitReviewStartPointResult{}, fmt.Errorf("failed to fetch %s/%s: %w", remote, head, err)
	}
	remoteRef := remote + "/" + head
	sha, err := gitOutput(root, "rev-parse", "--verify", remoteRef)
	if err != nil {
		return runtimecore.GitReviewStartPointResult{}, fmt.Errorf("remote ref %s does not exist after fetch", remoteRef)
	}
	result := runtimecore.GitReviewStartPointResult{
		BaseBranch:     remoteRef,
		CompareBaseRef: compare,
		PushTarget:     &runtimecore.GitPushTarget{RemoteName: remote, BranchName: head},
	}
	if kind == "pr" {
		result.BaseBranch = strings.TrimSpace(sha)
		result.HeadSHA = result.BaseBranch
		result.BranchNameOverride = head
	}
	return result, nil
}

func fetchRemoteTrackingRef(root, remote, branch string) error {
	destination := "refs/remotes/" + remote + "/" + branch
	_, err := gitOutput(root, "fetch", remote, "+refs/heads/"+branch+":"+destination)
	return err
}
