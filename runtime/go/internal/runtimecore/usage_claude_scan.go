package runtimecore

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
)

type ClaudeUsageAttributedTurn struct {
	SessionID        string `json:"sessionId"`
	Timestamp        string `json:"timestamp"`
	Model            string `json:"model,omitempty"`
	Cwd              string `json:"cwd,omitempty"`
	GitBranch        string `json:"gitBranch,omitempty"`
	Day              string `json:"day"`
	ProjectKey       string `json:"projectKey"`
	ProjectLabel     string `json:"projectLabel"`
	RepoID           string `json:"repoId,omitempty"`
	WorktreeID       string `json:"worktreeId,omitempty"`
	InputTokens      int64  `json:"inputTokens"`
	OutputTokens     int64  `json:"outputTokens"`
	CacheReadTokens  int64  `json:"cacheReadTokens"`
	CacheWriteTokens int64  `json:"cacheWriteTokens"`
}

type ClaudeUsageScanResult struct {
	Turns        []ClaudeUsageAttributedTurn `json:"turns"`
	FilesScanned int                         `json:"filesScanned"`
	Issues       []string                    `json:"issues"`
}

type usageWorktreeRef struct{ RepoID, WorktreeID, Path, DisplayName string }

func (m *Manager) ScanClaudeUsage(ctx context.Context) ClaudeUsageScanResult {
	files := discoverClaudeUsageFiles()
	worktrees := m.usageWorktreeRefs()
	result := ClaudeUsageScanResult{Turns: []ClaudeUsageAttributedTurn{}, Issues: []string{}}
	type fileResult struct {
		turns []ClaudeUsageAttributedTurn
		issue string
	}
	jobs := make(chan string)
	results := make(chan fileResult, len(files))
	var workers sync.WaitGroup
	workerCount := 4
	if len(files) < workerCount {
		workerCount = len(files)
	}
	for index := 0; index < workerCount; index++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for path := range jobs {
				select {
				case <-ctx.Done():
					return
				default:
				}
				turns, err := scanClaudeUsageFile(path, worktrees)
				if err != nil {
					results <- fileResult{issue: path + ": " + err.Error()}
				} else {
					results <- fileResult{turns: turns}
				}
			}
		}()
	}
	go func() {
		defer close(jobs)
		for _, path := range files {
			select {
			case jobs <- path:
			case <-ctx.Done():
				return
			}
		}
	}()
	go func() { workers.Wait(); close(results) }()
	for file := range results {
		if file.issue != "" {
			result.Issues = append(result.Issues, file.issue)
			continue
		}
		result.FilesScanned++
		result.Turns = append(result.Turns, file.turns...)
	}
	sort.Slice(result.Turns, func(i, j int) bool { return result.Turns[i].Timestamp < result.Turns[j].Timestamp })
	return result
}

func discoverClaudeUsageFiles() []string {
	home, err := os.UserHomeDir()
	if err != nil {
		return []string{}
	}
	roots := []string{filepath.Join(home, ".claude", "projects"), filepath.Join(home, ".claude", "transcripts")}
	seen := map[string]bool{}
	files := []string{}
	for _, root := range roots {
		_ = filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
			if walkErr != nil {
				if errors.Is(walkErr, os.ErrNotExist) {
					return filepath.SkipDir
				}
				return nil
			}
			if entry.Type().IsRegular() && strings.EqualFold(filepath.Ext(entry.Name()), ".jsonl") && !seen[path] {
				seen[path] = true
				files = append(files, path)
			}
			return nil
		})
	}
	sort.Strings(files)
	return files
}

func (m *Manager) usageWorktreeRefs() []usageWorktreeRef {
	projects := m.ListProjects()
	projectNames := map[string]string{}
	for _, project := range projects {
		projectNames[project.ID] = project.Name
	}
	refs := make([]usageWorktreeRef, 0)
	for _, worktree := range m.ListWorktrees("") {
		if worktree.IsArchived || strings.TrimSpace(worktree.Path) == "" {
			continue
		}
		label := strings.TrimSpace(worktree.DisplayName)
		if label == "" {
			label = projectNames[worktree.ProjectID]
		}
		refs = append(refs, usageWorktreeRef{RepoID: worktree.ProjectID, WorktreeID: worktree.ID, Path: comparableUsagePath(worktree.Path), DisplayName: label})
	}
	sort.Slice(refs, func(i, j int) bool { return len(refs[i].Path) > len(refs[j].Path) })
	return refs
}

func scanClaudeUsageFile(path string, worktrees []usageWorktreeRef) ([]ClaudeUsageAttributedTurn, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	turns, err := readClaudeUsageTurns(file, strings.TrimSuffix(filepath.Base(path), filepath.Ext(path)))
	if err != nil {
		return nil, err
	}
	result := make([]ClaudeUsageAttributedTurn, 0, len(turns))
	for _, turn := range turns {
		day := localUsageDay(turn.Timestamp)
		if day == "" {
			continue
		}
		projectKey, projectLabel, repoID, worktreeID := externalUsageLocation(turn.Cwd)
		if worktree := containingUsageWorktree(turn.Cwd, worktrees); worktree != nil {
			projectKey, projectLabel, repoID, worktreeID = worktree.WorktreeID, worktree.DisplayName, worktree.RepoID, worktree.WorktreeID
		}
		result = append(result, ClaudeUsageAttributedTurn{SessionID: turn.SessionID, Timestamp: turn.Timestamp, Model: turn.Model, Cwd: turn.Cwd, GitBranch: turn.GitBranch, Day: day, ProjectKey: projectKey, ProjectLabel: projectLabel, RepoID: repoID, WorktreeID: worktreeID, InputTokens: turn.InputTokens, OutputTokens: turn.OutputTokens, CacheReadTokens: turn.CacheReadTokens, CacheWriteTokens: turn.CacheWriteTokens})
	}
	return result, nil
}

func containingUsageWorktree(cwd string, refs []usageWorktreeRef) *usageWorktreeRef {
	path := comparableUsagePath(cwd)
	if path == "" {
		return nil
	}
	var best *usageWorktreeRef
	for index := range refs {
		parent := strings.TrimRight(refs[index].Path, `/\`)
		if path == parent || strings.HasPrefix(path, parent+string(filepath.Separator)) || strings.HasPrefix(strings.ReplaceAll(path, "\\", "/"), strings.ReplaceAll(parent, "\\", "/")+"/") {
			if best == nil || len(parent) > len(best.Path) {
				best = &refs[index]
			}
		}
	}
	return best
}
func comparableUsagePath(value string) string {
	value = filepath.Clean(strings.TrimSpace(value))
	if runtime.GOOS == "windows" {
		value = strings.ToLower(value)
	}
	return value
}
func externalUsageLocation(cwd string) (string, string, string, string) {
	normalized := strings.ReplaceAll(strings.TrimSpace(cwd), "\\", "/")
	parts := strings.FieldsFunc(normalized, func(r rune) bool { return r == '/' })
	label := "Unknown location"
	if len(parts) >= 2 {
		label = parts[len(parts)-2] + "/" + parts[len(parts)-1]
	} else if len(parts) == 1 {
		label = parts[0]
	}
	key := normalized
	if key == "" {
		key = "unknown"
	}
	return key, label, "", ""
}
func localUsageDay(timestamp string) string {
	parsed, err := time.Parse(time.RFC3339Nano, timestamp)
	if err != nil {
		return ""
	}
	return parsed.Local().Format("2006-01-02")
}
