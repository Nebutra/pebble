package runtimecore

import (
	"bytes"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// Why: a reflog can be arbitrarily long and only its newest entry matters, so
// the probe reads a bounded tail instead of the whole file.
const maxReflogTailBytes = 8 * 1024

// worktreeGitActivityFiles are read for their modification time as a fallback
// when the reflog is unavailable. Deliberately excluded: `index`, `gitdir`, and
// `logs/HEAD`, which `git status` and `git maintenance` restamp on their own and
// would report a worktree nobody has touched as freshly active.
var worktreeGitActivityFiles = []string{"HEAD", "COMMIT_EDITMSG", "ORIG_HEAD"}

// worktreeGitActivityAt reports when git last recorded real work in a worktree,
// in Unix milliseconds. Pebble's own LastActivityAt only moves when a worktree
// is renamed or commented on, so without this a worktree the user commits to
// daily outside the app still reads as idle to the cleanup classifier.
func worktreeGitActivityAt(worktreePath string) (int64, bool) {
	gitDir, ok := resolveWorktreeGitDir(worktreePath)
	if !ok {
		return 0, false
	}
	if at, ok := readNewestReflogEntryAt(filepath.Join(gitDir, "logs", "HEAD")); ok {
		return at, true
	}
	// Why: an expired or trimmed-to-empty reflog leaves no entry to read, so
	// commit metadata is the remaining signal that git itself wrote.
	newest, found := int64(0), false
	for _, name := range worktreeGitActivityFiles {
		info, err := os.Stat(filepath.Join(gitDir, name))
		if err != nil {
			continue
		}
		if at := info.ModTime().UnixMilli(); at > newest {
			newest, found = at, true
		}
	}
	return newest, found
}

// resolveWorktreeGitDir returns the git directory backing a worktree. A linked
// worktree has a `.git` file pointing at `<repo>/.git/worktrees/<name>` rather
// than a directory, and that is where its own reflog lives.
func resolveWorktreeGitDir(worktreePath string) (string, bool) {
	if strings.TrimSpace(worktreePath) == "" {
		return "", false
	}
	dotGit := filepath.Join(worktreePath, ".git")
	info, err := os.Stat(dotGit)
	if err != nil {
		return "", false
	}
	if info.IsDir() {
		return dotGit, true
	}
	content, err := os.ReadFile(dotGit)
	if err != nil {
		return "", false
	}
	pointer := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(string(content)), "gitdir:"))
	if pointer == "" {
		return "", false
	}
	if !filepath.IsAbs(pointer) {
		pointer = filepath.Join(worktreePath, pointer)
	}
	return filepath.Clean(pointer), true
}

// readNewestReflogEntryAt reads the timestamp recorded inside the newest reflog
// entry. The file's own mtime is not used: `git maintenance` and `git status`
// rewrite `logs/HEAD` in linked worktrees, which made an untouched worktree
// look active (upstream #12131).
func readNewestReflogEntryAt(reflogPath string) (int64, bool) {
	file, err := os.Open(reflogPath)
	if err != nil {
		return 0, false
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || info.Size() == 0 {
		return 0, false
	}
	size := info.Size()
	offset := int64(0)
	if size > maxReflogTailBytes {
		offset = size - maxReflogTailBytes
	}
	tail := make([]byte, size-offset)
	if _, err := file.ReadAt(tail, offset); err != nil {
		return 0, false
	}
	lines := bytes.Split(bytes.TrimRight(tail, "\n"), []byte("\n"))
	for index := len(lines) - 1; index >= 0; index-- {
		if at, ok := parseReflogEntryAt(string(lines[index])); ok {
			return at, true
		}
	}
	return 0, false
}

// parseReflogEntryAt pulls the Unix seconds out of one reflog line, whose shape
// is `<old> <new> <name> <email> <seconds> <zone>\t<action>`. The committer name
// may contain spaces, so the timestamp is located from the end of the email
// rather than by counting fields from the start.
func parseReflogEntryAt(line string) (int64, bool) {
	header, _, _ := strings.Cut(line, "\t")
	emailEnd := strings.LastIndex(header, ">")
	if emailEnd < 0 {
		return 0, false
	}
	fields := strings.Fields(header[emailEnd+1:])
	if len(fields) == 0 {
		return 0, false
	}
	seconds, err := strconv.ParseInt(fields[0], 10, 64)
	if err != nil || seconds <= 0 {
		return 0, false
	}
	return seconds * 1000, true
}

// withWorktreeGitActivity raises each worktree's LastActivityAt to whatever git
// last recorded, so the cleanup classifier does not offer up a worktree the user
// is actively working in outside Pebble. Only ever called for local projects:
// an SSH worktree's path does not exist on this machine and probing it here
// would read an unrelated local directory, or nothing at all.
func withWorktreeGitActivity(worktrees []Worktree) []Worktree {
	resolved := make([]Worktree, len(worktrees))
	copy(resolved, worktrees)
	for index := range resolved {
		if at, ok := worktreeGitActivityAt(resolved[index].Path); ok && at > resolved[index].LastActivityAt {
			resolved[index].LastActivityAt = at
		}
	}
	return resolved
}
