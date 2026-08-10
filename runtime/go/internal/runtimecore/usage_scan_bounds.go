package runtimecore

import (
	"io/fs"
	"sort"
	"time"
)

// Why: a usage scan reads whatever transcript history the agent CLIs left in
// the home directory, which on a long-lived machine grows without limit. Every
// stage is capped so the scan's peak memory is a property of these constants
// rather than of how long the machine has been in use.
const (
	// The newest transcripts are what a usage view is about, so older ones are
	// dropped rather than paged — and the scan reports that it dropped them.
	usageScanMaxFiles = 4000
	// One transcript is read into memory whole, so a single pathological file
	// must not be able to consume the whole-scan budget on its own.
	usageScanMaxFileTurns = 20000
	// The retained turn budget for one scan.
	usageScanMaxTurns = 150000
	// Workers block on the collector instead of parking every file's turns in a
	// channel buffer sized by the file count.
	usageScanResultBuffer = 8
)

type usageScanCandidate struct {
	path     string
	modified time.Time
}

// usageScanDiscovery accumulates transcript paths while keeping only the newest
// window resident, so walking a tree far larger than the cap stays bounded.
type usageScanDiscovery struct {
	candidates []usageScanCandidate
	seen       map[string]bool
	discovered int
}

func newUsageScanDiscovery() *usageScanDiscovery {
	return &usageScanDiscovery{seen: map[string]bool{}}
}

func (d *usageScanDiscovery) add(path string, entry fs.DirEntry) {
	if d.seen[path] {
		return
	}
	info, err := entry.Info()
	if err != nil {
		return
	}
	d.seen[path] = true
	d.discovered++
	d.candidates = append(d.candidates, usageScanCandidate{path: path, modified: info.ModTime()})
	// Compacting at twice the cap keeps the walk's own footprint bounded while
	// still amortising the sort across many appends.
	if len(d.candidates) >= usageScanMaxFiles*2 {
		d.candidates = newestUsageScanCandidates(d.candidates)
	}
}

// paths returns the retained transcripts in a stable order, and whether
// discovery dropped anything to stay inside the file cap.
func (d *usageScanDiscovery) paths() ([]string, bool) {
	retained := newestUsageScanCandidates(d.candidates)
	paths := make([]string, 0, len(retained))
	for _, candidate := range retained {
		paths = append(paths, candidate.path)
	}
	sort.Strings(paths)
	return paths, d.discovered > len(paths)
}

func newestUsageScanCandidates(candidates []usageScanCandidate) []usageScanCandidate {
	sort.Slice(candidates, func(i, j int) bool {
		if candidates[i].modified.Equal(candidates[j].modified) {
			return candidates[i].path < candidates[j].path
		}
		return candidates[i].modified.After(candidates[j].modified)
	})
	if len(candidates) > usageScanMaxFiles {
		return candidates[:usageScanMaxFiles]
	}
	return candidates
}

// boundUsageScanTurns reports how many of next may still be retained, so a
// collector can keep draining its workers after the budget is spent instead of
// deadlocking them.
func boundUsageScanTurns(retained int, next int) int {
	if retained >= usageScanMaxTurns {
		return 0
	}
	if retained+next > usageScanMaxTurns {
		return usageScanMaxTurns - retained
	}
	return next
}
