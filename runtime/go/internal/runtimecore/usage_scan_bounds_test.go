package runtimecore

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

type stubUsageDirEntry struct {
	name     string
	modified time.Time
}

func (e stubUsageDirEntry) Name() string      { return e.name }
func (e stubUsageDirEntry) IsDir() bool       { return false }
func (e stubUsageDirEntry) Type() os.FileMode { return 0 }
func (e stubUsageDirEntry) Info() (os.FileInfo, error) {
	return stubUsageFileInfo{name: e.name, modified: e.modified}, nil
}

type stubUsageFileInfo struct {
	name     string
	modified time.Time
}

func (i stubUsageFileInfo) Name() string       { return i.name }
func (i stubUsageFileInfo) Size() int64        { return 0 }
func (i stubUsageFileInfo) Mode() os.FileMode  { return 0 }
func (i stubUsageFileInfo) ModTime() time.Time { return i.modified }
func (i stubUsageFileInfo) IsDir() bool        { return false }
func (i stubUsageFileInfo) Sys() any           { return nil }

func TestUsageScanDiscoveryKeepsOnlyTheNewestTranscripts(t *testing.T) {
	discovery := newUsageScanDiscovery()
	base := time.Unix(1_700_000_000, 0)
	total := usageScanMaxFiles + 500
	for index := 0; index < total; index++ {
		name := fmt.Sprintf("session-%05d.jsonl", index)
		discovery.add("/home/user/.claude/projects/"+name, stubUsageDirEntry{
			name: name, modified: base.Add(time.Duration(index) * time.Minute),
		})
	}
	paths, dropped := discovery.paths()
	if !dropped {
		t.Fatal("discovery must report that it dropped transcripts")
	}
	if len(paths) != usageScanMaxFiles {
		t.Fatalf("expected %d retained paths, got %d", usageScanMaxFiles, len(paths))
	}
	// The oldest 500 are the ones that should be gone.
	for _, path := range paths {
		if strings.Contains(path, "session-00000.jsonl") || strings.Contains(path, "session-00499.jsonl") {
			t.Fatalf("an older transcript outranked a newer one: %s", path)
		}
	}
}

func TestUsageScanDiscoveryStaysBoundedWhileWalking(t *testing.T) {
	discovery := newUsageScanDiscovery()
	base := time.Unix(1_700_000_000, 0)
	for index := 0; index < usageScanMaxFiles*5; index++ {
		name := fmt.Sprintf("session-%06d.jsonl", index)
		discovery.add("/home/user/.claude/projects/"+name, stubUsageDirEntry{
			name: name, modified: base.Add(time.Duration(index) * time.Minute),
		})
		// The retained window is what bounds the walk; without compaction this
		// would grow to the size of the whole tree.
		if len(discovery.candidates) > usageScanMaxFiles*2 {
			t.Fatalf("walk footprint grew to %d candidates", len(discovery.candidates))
		}
	}
}

func TestUsageScanDiscoveryIgnoresRepeatedPaths(t *testing.T) {
	discovery := newUsageScanDiscovery()
	entry := stubUsageDirEntry{name: "a.jsonl", modified: time.Unix(1_700_000_000, 0)}
	discovery.add("/home/user/.claude/projects/a.jsonl", entry)
	discovery.add("/home/user/.claude/projects/a.jsonl", entry)
	paths, dropped := discovery.paths()
	if len(paths) != 1 || dropped {
		t.Fatalf("unexpected discovery result: paths=%v dropped=%v", paths, dropped)
	}
}

func TestBoundUsageScanTurnsStopsAtTheBudget(t *testing.T) {
	if got := boundUsageScanTurns(0, 10); got != 10 {
		t.Fatalf("expected a small batch to be retained whole, got %d", got)
	}
	if got := boundUsageScanTurns(usageScanMaxTurns-5, 10); got != 5 {
		t.Fatalf("expected the batch to be trimmed to 5, got %d", got)
	}
	if got := boundUsageScanTurns(usageScanMaxTurns, 10); got != 0 {
		t.Fatalf("expected nothing to be retained past the budget, got %d", got)
	}
}

func TestReadClaudeUsageTurnsCapsASingleTranscript(t *testing.T) {
	var transcript strings.Builder
	for index := 0; index < usageScanMaxFileTurns+250; index++ {
		fmt.Fprintf(&transcript, `{"type":"assistant","uuid":"turn-%d","timestamp":"2026-01-01T00:00:00.000Z","message":{"model":"claude","usage":{"input_tokens":1,"output_tokens":1}}}`+"\n", index)
	}
	turns, err := readClaudeUsageTurns(strings.NewReader(transcript.String()), "session")
	if err != nil {
		t.Fatal(err)
	}
	if len(turns) != usageScanMaxFileTurns {
		t.Fatalf("one transcript retained %d turns, past the %d cap", len(turns), usageScanMaxFileTurns)
	}
}

// Why: the acceptance criterion asks for proof that a scan does not exhaust a
// small machine, so this drives the real scan against a transcript tree far
// larger than the caps and asserts the retained result stays inside them.
func TestScanClaudeUsageStaysBoundedOnAnOversizedHistory(t *testing.T) {
	if testing.Short() {
		t.Skip("stress test")
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	projects := filepath.Join(home, ".claude", "projects")
	if err := os.MkdirAll(projects, 0o755); err != nil {
		t.Fatal(err)
	}
	const files = 400
	const turnsPerFile = 500
	var transcript strings.Builder
	for index := 0; index < turnsPerFile; index++ {
		fmt.Fprintf(&transcript, `{"type":"assistant","uuid":"turn-%d","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp/project","message":{"model":"claude","usage":{"input_tokens":10,"output_tokens":10}}}`+"\n", index)
	}
	for index := 0; index < files; index++ {
		name := filepath.Join(projects, fmt.Sprintf("session-%04d.jsonl", index))
		if err := os.WriteFile(name, []byte(transcript.String()), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	var before, after runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&before)
	result := manager.ScanClaudeUsage(t.Context())
	runtime.GC()
	runtime.ReadMemStats(&after)

	if result.FilesScanned != files {
		t.Fatalf("expected %d files scanned, got %d", files, result.FilesScanned)
	}
	// 400 files x 500 turns is 200k parsed turns against a 150k budget, so the
	// cap has to bite and the scan has to admit that it did.
	if len(result.Turns) != usageScanMaxTurns {
		t.Fatalf("scan retained %d turns, expected the %d cap", len(result.Turns), usageScanMaxTurns)
	}
	if !strings.Contains(strings.Join(result.Issues, "\n"), "scan retained the first") {
		t.Fatalf("a truncated scan reported no issue: %v", result.Issues)
	}
	// A ceiling rather than the primary assertion: the retained turns measure
	// ~48 MiB, so this catches a regression that buffers the whole tree instead.
	const heapBudget = 192 << 20
	if after.HeapAlloc > before.HeapAlloc+heapBudget {
		t.Fatalf("scan grew the heap by %d bytes, past the %d budget", after.HeapAlloc-before.HeapAlloc, heapBudget)
	}
}
