package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
)

const relayBaseStatusInputLimit = 64 * 1024

type gitWorktreeCreateResult struct {
	CreatedBaseSHA string `json:"createdBaseSha"`
}

func runGitWorktreeCreateJSON(args []string, output io.Writer) error {
	fs := flag.NewFlagSet("git-worktree-create-json", flag.ContinueOnError)
	fs.SetOutput(output)
	root := fs.String("root", "", "remote git repository root")
	path := fs.String("path", "", "remote worktree path")
	branch := fs.String("branch", "", "new worktree branch")
	base := fs.String("base", "", "base ref")
	skipCheckout := fs.Bool("skip-checkout", false, "create without checkout")
	if err := fs.Parse(args); err != nil {
		return err
	}
	rootPath, err := filepath.Abs(strings.TrimSpace(*root))
	if err != nil || strings.TrimSpace(*root) == "" {
		return errors.New("root is required")
	}
	worktreePath, err := filepath.Abs(strings.TrimSpace(*path))
	if err != nil || strings.TrimSpace(*path) == "" {
		return errors.New("worktree path is required")
	}
	branchName := strings.TrimSpace(*branch)
	if strings.HasPrefix(branchName, "-") {
		return errors.New("invalid branch name")
	}
	baseRef := strings.TrimSpace(*base)
	if strings.HasPrefix(baseRef, "-") {
		return errors.New("invalid base ref")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	createdBaseSHA := resolveRelayGitCommit(ctx, rootPath, baseRef)
	gitArgs := []string{"-C", rootPath, "worktree", "add"}
	if *skipCheckout {
		gitArgs = append(gitArgs, "--no-checkout")
	}
	if branchName != "" {
		gitArgs = append(gitArgs, "-b", branchName)
	}
	gitArgs = append(gitArgs, "--", worktreePath)
	if baseRef != "" {
		gitArgs = append(gitArgs, baseRef)
	}
	if combined, err := exec.CommandContext(ctx, "git", gitArgs...).CombinedOutput(); err != nil {
		detail := strings.TrimSpace(string(combined))
		if detail == "" {
			detail = err.Error()
		}
		return errors.New(detail)
	}
	return json.NewEncoder(output).Encode(gitWorktreeCreateResult{CreatedBaseSHA: createdBaseSHA})
}

func runGitBaseStatusJSON(args []string, input io.Reader, output io.Writer) error {
	fs := flag.NewFlagSet("git-base-status-json", flag.ContinueOnError)
	fs.SetOutput(output)
	root := fs.String("root", "", "remote git worktree root")
	if err := fs.Parse(args); err != nil {
		return err
	}
	rootPath, err := filepath.Abs(strings.TrimSpace(*root))
	if err != nil || strings.TrimSpace(*root) == "" {
		return errors.New("root is required")
	}
	var req runtimecore.GitBaseStatusRequest
	decoder := json.NewDecoder(io.LimitReader(input, relayBaseStatusInputLimit+1))
	if err := decoder.Decode(&req); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	return json.NewEncoder(output).Encode(runtimecore.ComputeGitBaseStatus(ctx, rootPath, req))
}

func resolveRelayGitCommit(ctx context.Context, root string, ref string) string {
	if ref == "" {
		return ""
	}
	result, err := exec.CommandContext(ctx, "git", "-C", root, "rev-parse", "--verify", ref+"^{commit}").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(result))
}
