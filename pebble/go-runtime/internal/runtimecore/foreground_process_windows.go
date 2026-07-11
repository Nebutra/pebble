//go:build windows

package runtimecore

import (
	"context"
	"encoding/json"
	"os/exec"
	"strings"
	"time"
)

const foregroundProcessSupported = true
const foregroundProcessUnsupportedReason = ""
const windowsProcessProbeTimeout = 3 * time.Second

const windowsProcessQuery = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-CimInstance -ClassName Win32_Process -Property Name,ParentProcessId,ProcessId | Select-Object Name,ParentProcessId,ProcessId | ConvertTo-Json -Compress`

type windowsProcessRow struct {
	Name            string `json:"Name"`
	ParentProcessID int    `json:"ParentProcessId"`
	ProcessID       int    `json:"ProcessId"`
}

type windowsProcessCandidate struct {
	row   windowsProcessRow
	depth int
}

func resolveForegroundProcessName(pid int) (string, bool) {
	name, _, ok := resolveProcessInspection(pid)
	return name, ok
}

func resolveProcessInspection(pid int) (string, bool, bool) {
	if pid <= 0 {
		return "", false, false
	}
	rows, ok := snapshotWindowsProcessTable()
	if !ok {
		return "", false, false
	}
	candidates := collectWindowsProcessDescendants(rows, pid)
	if len(candidates) == 0 {
		return "", false, false
	}
	best := candidates[0]
	for _, candidate := range candidates[1:] {
		if candidate.depth > best.depth {
			best = candidate
		}
	}
	return baseComm(best.row.Name), true, true
}

func snapshotWindowsProcessTable() ([]windowsProcessRow, bool) {
	ctx, cancel := context.WithTimeout(context.Background(), windowsProcessProbeTimeout)
	defer cancel()
	output, err := exec.CommandContext(ctx, "powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", windowsProcessQuery).Output()
	if err != nil {
		return nil, false
	}
	trimmed := strings.TrimSpace(string(output))
	if trimmed == "" {
		return []windowsProcessRow{}, true
	}
	var rows []windowsProcessRow
	if strings.HasPrefix(trimmed, "[") {
		if json.Unmarshal(output, &rows) != nil {
			return nil, false
		}
		return rows, true
	}
	var row windowsProcessRow
	if json.Unmarshal(output, &row) != nil {
		return nil, false
	}
	return []windowsProcessRow{row}, true
}

func collectWindowsProcessDescendants(rows []windowsProcessRow, rootPID int) []windowsProcessCandidate {
	children := make(map[int][]windowsProcessRow)
	for _, row := range rows {
		if row.ProcessID > 0 {
			children[row.ParentProcessID] = append(children[row.ParentProcessID], row)
		}
	}
	result := []windowsProcessCandidate{}
	seen := map[int]bool{rootPID: true}
	queue := []windowsProcessCandidate{}
	for _, row := range children[rootPID] {
		queue = append(queue, windowsProcessCandidate{row: row, depth: 1})
	}
	for len(queue) > 0 {
		candidate := queue[0]
		queue = queue[1:]
		if seen[candidate.row.ProcessID] {
			continue
		}
		seen[candidate.row.ProcessID] = true
		result = append(result, candidate)
		for _, row := range children[candidate.row.ProcessID] {
			queue = append(queue, windowsProcessCandidate{row: row, depth: candidate.depth + 1})
		}
	}
	return result
}
