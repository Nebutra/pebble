package main

import (
	"encoding/json"
	"errors"
	"flag"
	"io"
	"os/exec"
	"sort"
	"strconv"
	"strings"

	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
)

func runGitBaseRefsJSON(args []string, output io.Writer) error {
	fs := flag.NewFlagSet("git-base-refs-json", flag.ContinueOnError)
	fs.SetOutput(output)
	mode := fs.String("mode", "search", "search or default")
	root := fs.String("root", "", "remote git workspace root")
	query := fs.String("query", "", "search query")
	limit := fs.Int("limit", 25, "maximum results")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if strings.TrimSpace(*root) == "" {
		return errors.New("root is required")
	}
	switch *mode {
	case "default":
		result, err := defaultGitBaseRef(*root)
		if err != nil {
			return err
		}
		return json.NewEncoder(output).Encode(result)
	case "search":
		result, err := searchGitBaseRefs(*root, *query, *limit)
		if err != nil {
			return err
		}
		return json.NewEncoder(output).Encode(result)
	default:
		return errors.New("unsupported base-ref mode")
	}
}

func defaultGitBaseRef(root string) (runtimecore.GitBaseRefDefaultResult, error) {
	remotes, err := gitRemoteNames(root)
	if err != nil {
		return runtimecore.GitBaseRefDefaultResult{}, err
	}
	if containsString(remotes, "origin") {
		if value, err := gitOutput(root, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"); err == nil {
			value = strings.TrimSpace(value)
			if value != "" && value != "origin/HEAD" {
				return runtimecore.GitBaseRefDefaultResult{DefaultBaseRef: stringPointer(value), RemoteCount: len(remotes)}, nil
			}
		}
	}
	for _, candidate := range []string{"origin/main", "origin/master", "upstream/main", "main", "master"} {
		if _, err := gitOutput(root, "rev-parse", "--verify", candidate); err == nil {
			return runtimecore.GitBaseRefDefaultResult{DefaultBaseRef: stringPointer(candidate), RemoteCount: len(remotes)}, nil
		}
	}
	return runtimecore.GitBaseRefDefaultResult{RemoteCount: len(remotes)}, nil
}

func searchGitBaseRefs(root string, query string, limit int) ([]runtimecore.GitBaseRefSearchResult, error) {
	if limit <= 0 {
		return []runtimecore.GitBaseRefSearchResult{}, nil
	}
	if limit > 100 {
		limit = 100
	}
	remotes, err := gitRemoteNames(root)
	if err != nil {
		return nil, err
	}
	sort.Slice(remotes, func(i, j int) bool { return len(remotes[i]) > len(remotes[j]) })
	stdout, err := gitOutput(root, "for-each-ref", "--format=%(refname)%00%(refname:short)", "--sort=-committerdate", "--count=500", "refs/heads", "refs/remotes")
	if err != nil {
		return nil, err
	}
	normalizedQuery := strings.ToLower(strings.Map(func(value rune) rune {
		if strings.ContainsRune("*?[]\\", value) {
			return -1
		}
		return value
	}, strings.TrimSpace(query)))
	seen := make(map[string]struct{})
	results := make([]runtimecore.GitBaseRefSearchResult, 0, limit)
	for _, line := range strings.Split(stdout, "\n") {
		parts := strings.SplitN(strings.TrimSpace(line), "\x00", 2)
		if len(parts) != 2 || strings.HasPrefix(parts[0], "refs/remotes/") && strings.HasSuffix(parts[0], "/HEAD") {
			continue
		}
		localName := localBranchName(parts[0], parts[1], remotes)
		if normalizedQuery != "" && !strings.Contains(strings.ToLower(parts[1]), normalizedQuery) && !strings.Contains(strings.ToLower(localName), normalizedQuery) {
			continue
		}
		if _, exists := seen[parts[1]]; exists {
			continue
		}
		seen[parts[1]] = struct{}{}
		results = append(results, runtimecore.GitBaseRefSearchResult{RefName: parts[1], LocalBranchName: localName})
		if len(results) >= limit {
			break
		}
	}
	return results, nil
}

func gitRemoteNames(root string) ([]string, error) {
	stdout, err := gitOutput(root, "remote")
	if err != nil {
		return nil, err
	}
	result := []string{}
	for _, line := range strings.Split(stdout, "\n") {
		if value := strings.TrimSpace(line); value != "" {
			result = append(result, value)
		}
	}
	return result, nil
}

func gitOutput(root string, args ...string) (string, error) {
	command := exec.Command("git", append([]string{"-C", root}, args...)...)
	output, err := command.CombinedOutput()
	if err != nil {
		return "", errors.New(strings.TrimSpace(string(output)) + " (exit " + strconv.Itoa(command.ProcessState.ExitCode()) + ")")
	}
	return string(output), nil
}

func localBranchName(full string, short string, remotes []string) string {
	value := strings.TrimPrefix(full, "refs/remotes/")
	if value == full {
		return short
	}
	for _, remote := range remotes {
		if strings.HasPrefix(value, remote+"/") {
			return strings.TrimPrefix(value, remote+"/")
		}
	}
	parts := strings.Split(value, "/")
	if len(parts) > 1 {
		return strings.Join(parts[1:], "/")
	}
	return short
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func stringPointer(value string) *string {
	return &value
}
