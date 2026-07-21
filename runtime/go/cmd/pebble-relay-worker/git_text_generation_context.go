package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"strings"
	"time"

	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
)

// gitTextGenerationContextTimeout bounds the git plumbing calls this
// subcommand issues (branch/diff/log/fetch); matches the runtime's
// gitCommandTimeout ceiling for the equivalent local Rust command.
const gitTextGenerationContextTimeout = 30 * time.Second

// runGitTextGenerationContext builds the same staged-diff (commit message) or
// base-vs-head diff/log (pull request fields) context the local Tauri command
// reads, but on the SSH-remote host this process runs on. Unlike the other
// relay-worker subcommands, this one answers synchronously over the SSH exec
// channel (prints JSON to stdout) instead of posting to the runtime gateway:
// the desktop needs the context inline to build a prompt and run the agent
// CLI locally, not as a cached snapshot.
func runGitTextGenerationContext(args []string, output io.Writer) error {
	fs := flag.NewFlagSet("git-text-generation-context", flag.ExitOnError)
	kind := fs.String("kind", "", "context kind: commit or pull-request")
	root := fs.String("root", "", "remote git repository root")
	base := fs.String("base", "", "pull request base branch")
	currentTitle := fs.String("current-title", "", "current pull request title")
	currentBody := fs.String("current-body", "", "current pull request body")
	currentDraft := fs.Bool("current-draft", false, "current pull request draft flag")
	_ = fs.Parse(args)

	ctx, cancel := context.WithTimeout(context.Background(), gitTextGenerationContextTimeout)
	defer cancel()

	switch strings.TrimSpace(*kind) {
	case "commit":
		result, err := runtimecore.BuildGitCommitTextGenerationContext(ctx, *root)
		if err != nil {
			return err
		}
		return writeJSON(output, result)
	case "pull-request":
		result, err := runtimecore.BuildGitPullRequestTextGenerationContext(
			ctx, *root, *base, *currentTitle, *currentBody, *currentDraft,
		)
		if err != nil {
			return err
		}
		return writeJSON(output, result)
	default:
		return errors.New("kind must be \"commit\" or \"pull-request\"")
	}
}

func writeJSON(output io.Writer, payload interface{}) error {
	content, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	_, err = output.Write(content)
	return err
}
