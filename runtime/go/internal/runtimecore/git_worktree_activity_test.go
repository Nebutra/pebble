package runtimecore

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func reflogEntry(committer string, at time.Time, action string) string {
	return fmt.Sprintf(
		"%040d %040d %s %d +0000\t%s\n",
		0, 1, committer, at.Unix(), action,
	)
}

// writeLinkedWorktree lays out a linked worktree the way `git worktree add`
// does: a `.git` file pointing at the repository's per-worktree git directory.
func writeLinkedWorktree(t *testing.T, name string) (worktreePath, gitDir string) {
	t.Helper()
	root := t.TempDir()
	worktreePath = filepath.Join(root, name)
	gitDir = filepath.Join(root, "repo", ".git", "worktrees", name)
	for _, dir := range []string{worktreePath, filepath.Join(gitDir, "logs")} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	pointer := []byte("gitdir: " + gitDir + "\n")
	if err := os.WriteFile(filepath.Join(worktreePath, ".git"), pointer, 0o644); err != nil {
		t.Fatal(err)
	}
	return worktreePath, gitDir
}

func writeReflog(t *testing.T, gitDir string, entries ...string) {
	t.Helper()
	path := filepath.Join(gitDir, "logs", "HEAD")
	if err := os.WriteFile(path, []byte(strings.Join(entries, "")), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestWorktreeGitActivityReadsTheNewestReflogEntry(t *testing.T) {
	worktreePath, gitDir := writeLinkedWorktree(t, "feature")
	older := time.Now().Add(-72 * time.Hour).Truncate(time.Second)
	newest := time.Now().Add(-2 * time.Hour).Truncate(time.Second)
	writeReflog(t, gitDir,
		reflogEntry("Ada Lovelace <ada@example.test>", older, "branch: Created from HEAD"),
		reflogEntry("Ada Lovelace <ada@example.test>", newest, "commit: teach the engine"),
	)
	at, ok := worktreeGitActivityAt(worktreePath)
	if !ok {
		t.Fatal("expected the linked worktree's reflog to be found")
	}
	if at != newest.UnixMilli() {
		t.Fatalf("got %d, want the newest entry at %d", at, newest.UnixMilli())
	}
}

func TestWorktreeGitActivityIgnoresRestampedReflogMtime(t *testing.T) {
	// Why: `git maintenance` and `git status` rewrite logs/HEAD in linked
	// worktrees. Trusting its mtime is what made an untouched worktree read as
	// freshly active and kept it out of cleanup forever (upstream #12131).
	worktreePath, gitDir := writeLinkedWorktree(t, "stale")
	recorded := time.Now().Add(-90 * 24 * time.Hour).Truncate(time.Second)
	writeReflog(t, gitDir, reflogEntry("Ada <ada@example.test>", recorded, "commit: last real work"))
	reflogPath := filepath.Join(gitDir, "logs", "HEAD")
	restamped := time.Now()
	if err := os.Chtimes(reflogPath, restamped, restamped); err != nil {
		t.Fatal(err)
	}
	at, ok := worktreeGitActivityAt(worktreePath)
	if !ok {
		t.Fatal("expected the reflog to be read")
	}
	if at != recorded.UnixMilli() {
		t.Fatalf("got %d, want the recorded entry at %d — the file mtime leaked in", at, recorded.UnixMilli())
	}
}

func TestWorktreeGitActivityIgnoresGitMaintainedFiles(t *testing.T) {
	// Why: the index is rewritten by a bare `git status`, so counting it would
	// reintroduce the same false activity signal the reflog fix removes.
	worktreePath, gitDir := writeLinkedWorktree(t, "indexed")
	for _, name := range []string{"index", "gitdir"} {
		if err := os.WriteFile(filepath.Join(gitDir, name), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if _, ok := worktreeGitActivityAt(worktreePath); ok {
		t.Fatal("git-maintained files were treated as activity")
	}
}

func TestWorktreeGitActivityFallsBackWhenTheReflogExpired(t *testing.T) {
	// Why: `git reflog expire` can trim the file to zero bytes, which leaves no
	// entry to parse but does not mean the worktree was never used.
	worktreePath, gitDir := writeLinkedWorktree(t, "expired")
	writeReflog(t, gitDir)
	committed := time.Now().Add(-36 * time.Hour).Truncate(time.Second)
	head := filepath.Join(gitDir, "COMMIT_EDITMSG")
	if err := os.WriteFile(head, []byte("teach the engine\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(head, committed, committed); err != nil {
		t.Fatal(err)
	}
	at, ok := worktreeGitActivityAt(worktreePath)
	if !ok {
		t.Fatal("expected commit metadata to stand in for the expired reflog")
	}
	if at != committed.UnixMilli() {
		t.Fatalf("got %d, want the commit metadata mtime at %d", at, committed.UnixMilli())
	}
}

func TestWorktreeGitActivityReadsTheNewestEntryOfALongReflog(t *testing.T) {
	// Why: only a bounded tail of the reflog is read, so the newest entry has to
	// survive the truncation that keeps a huge reflog from being slurped whole.
	worktreePath, gitDir := writeLinkedWorktree(t, "busy")
	entries := make([]string, 0, 600)
	base := time.Now().Add(-600 * time.Hour).Truncate(time.Second)
	for index := range 600 {
		entries = append(entries, reflogEntry(
			"Ada Lovelace <ada@example.test>",
			base.Add(time.Duration(index)*time.Hour),
			fmt.Sprintf("commit: change %d", index),
		))
	}
	writeReflog(t, gitDir, entries...)
	if info, err := os.Stat(filepath.Join(gitDir, "logs", "HEAD")); err != nil || info.Size() <= maxReflogTailBytes {
		t.Fatalf("reflog must exceed the %d-byte tail to exercise truncation", maxReflogTailBytes)
	}
	newest := base.Add(599 * time.Hour)
	at, ok := worktreeGitActivityAt(worktreePath)
	if !ok || at != newest.UnixMilli() {
		t.Fatalf("got (%d, %v), want the newest entry at %d", at, ok, newest.UnixMilli())
	}
}

func TestWorktreeGitActivityHandlesAPlainRepository(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, ".git", "logs"), 0o755); err != nil {
		t.Fatal(err)
	}
	recorded := time.Now().Add(-5 * time.Hour).Truncate(time.Second)
	entry := reflogEntry("Ada <ada@example.test>", recorded, "checkout: moving from main to work")
	if err := os.WriteFile(filepath.Join(root, ".git", "logs", "HEAD"), []byte(entry), 0o644); err != nil {
		t.Fatal(err)
	}
	at, ok := worktreeGitActivityAt(root)
	if !ok || at != recorded.UnixMilli() {
		t.Fatalf("got (%d, %v), want %d for a non-linked repository", at, ok, recorded.UnixMilli())
	}
}

func TestWorktreeGitActivityRejectsUnreadableLayouts(t *testing.T) {
	cases := map[string]func(t *testing.T) string{
		"missing worktree": func(t *testing.T) string {
			return filepath.Join(t.TempDir(), "absent")
		},
		"empty path": func(t *testing.T) string { return "" },
		"dangling gitdir pointer": func(t *testing.T) string {
			root := t.TempDir()
			pointer := []byte("gitdir: " + filepath.Join(root, "gone") + "\n")
			if err := os.WriteFile(filepath.Join(root, ".git"), pointer, 0o644); err != nil {
				t.Fatal(err)
			}
			return root
		},
		"blank gitdir pointer": func(t *testing.T) string {
			root := t.TempDir()
			if err := os.WriteFile(filepath.Join(root, ".git"), []byte("gitdir:\n"), 0o644); err != nil {
				t.Fatal(err)
			}
			return root
		},
	}
	for name, build := range cases {
		t.Run(name, func(t *testing.T) {
			if at, ok := worktreeGitActivityAt(build(t)); ok {
				t.Fatalf("expected no activity signal, got %d", at)
			}
		})
	}
}

func TestParseReflogEntryToleratesCommitterNamesWithSpaces(t *testing.T) {
	// Why: the timestamp is located from the end of the email, because counting
	// space-separated fields from the start breaks on any multi-word name.
	cases := []struct {
		name string
		line string
		want int64
	}{
		{"multi-word name", "0 1 Ada King Lovelace <ada@example.test> 1700000000 +0100\tcommit: work", 1700000000000},
		{"single-word name", "0 1 ada <ada@example.test> 1700000001 -0500\tcommit: work", 1700000001000},
		{"angle bracket in name", "0 1 a<b> c <c@example.test> 1700000002 +0000\tcommit: work", 1700000002000},
		{"no action suffix", "0 1 Ada <ada@example.test> 1700000003 +0000", 1700000003000},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			at, ok := parseReflogEntryAt(tc.line)
			if !ok || at != tc.want {
				t.Fatalf("got (%d, %v), want %d", at, ok, tc.want)
			}
		})
	}
	for _, malformed := range []string{"", "not a reflog line", "0 1 Ada <ada@example.test> zero +0000\twork", "0 1 Ada <ada@example.test> 0 +0000\twork"} {
		if at, ok := parseReflogEntryAt(malformed); ok {
			t.Fatalf("parsed %q as %d", malformed, at)
		}
	}
}

func TestCleanupSparesAWorktreeGitSaysIsActive(t *testing.T) {
	// Why: Pebble stamps LastActivityAt only on rename or comment, so without the
	// git signal every clean worktree reads as idle since the epoch and the
	// classifier offers it up for deletion no matter how recently it was used.
	worktreePath, gitDir := writeLinkedWorktree(t, "active")
	recent := time.Now().Add(-time.Hour).Truncate(time.Second)
	writeReflog(t, gitDir, reflogEntry("Ada <ada@example.test>", recent, "commit: today's work"))
	project := Project{ID: "proj", Path: filepath.Join(t.TempDir(), "repo"), LocationKind: "local", Provider: "git"}
	worktrees := []Worktree{{ID: "wt", ProjectID: "proj", Path: worktreePath}}
	scannedAt := time.Now().UnixMilli()

	if got := cleanupEligibleWorktrees(project, worktrees, "", scannedAt); len(got) != 1 {
		t.Fatalf("expected the raw worktree to look idle without the git signal, got %#v", got)
	}
	resolved := withWorktreeGitActivity(worktrees)
	if resolved[0].LastActivityAt != recent.UnixMilli() {
		t.Fatalf("git activity was not applied: %d", resolved[0].LastActivityAt)
	}
	if got := cleanupEligibleWorktrees(project, resolved, "", scannedAt); len(got) != 0 {
		t.Fatalf("an actively used worktree was offered for cleanup: %#v", got)
	}
	// Why: the stored value must never be lowered — a rename today still counts
	// as activity even on a repository whose last commit was months ago.
	stored := []Worktree{{ID: "wt", ProjectID: "proj", Path: worktreePath, LastActivityAt: scannedAt}}
	if withWorktreeGitActivity(stored)[0].LastActivityAt != scannedAt {
		t.Fatal("the git signal overwrote a newer stored activity stamp")
	}
}

func TestCleanupStillOffersAWorktreeGitSaysIsStale(t *testing.T) {
	worktreePath, gitDir := writeLinkedWorktree(t, "stale")
	old := time.Now().Add(-120 * 24 * time.Hour).Truncate(time.Second)
	writeReflog(t, gitDir, reflogEntry("Ada <ada@example.test>", old, "commit: last touched months ago"))
	project := Project{ID: "proj", Path: filepath.Join(t.TempDir(), "repo"), LocationKind: "local", Provider: "git"}
	resolved := withWorktreeGitActivity([]Worktree{{ID: "wt", ProjectID: "proj", Path: worktreePath}})
	if resolved[0].LastActivityAt != old.UnixMilli() {
		t.Fatalf("git activity was not applied: %d", resolved[0].LastActivityAt)
	}
	if got := cleanupEligibleWorktrees(project, resolved, "", time.Now().UnixMilli()); len(got) != 1 {
		t.Fatalf("a genuinely stale worktree stopped being a cleanup candidate: %#v", got)
	}
}
