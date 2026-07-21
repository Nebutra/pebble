//go:build windows

package runtimecore

import "testing"

func TestCollectWindowsProcessDescendantsTracksDepth(t *testing.T) {
	rows := []windowsProcessRow{
		{ProcessID: 101, ParentProcessID: 100, Name: "cmd.exe"},
		{ProcessID: 102, ParentProcessID: 101, Name: "node.exe"},
		{ProcessID: 103, ParentProcessID: 102, Name: "codex.exe"},
		{ProcessID: 200, ParentProcessID: 999, Name: "other.exe"},
	}
	candidates := collectWindowsProcessDescendants(rows, 100)
	if len(candidates) != 3 || candidates[2].depth != 3 || candidates[2].row.Name != "codex.exe" {
		t.Fatalf("candidates = %#v", candidates)
	}
}
