package runtimecore

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"
)

const workspacePortLimit = 200

type WorkspacePortOwner struct {
	WorktreeID  string `json:"worktreeId"`
	RepoID      string `json:"repoId"`
	DisplayName string `json:"displayName"`
	Path        string `json:"path"`
	Confidence  string `json:"confidence"`
}

type WorkspacePort struct {
	ID          string              `json:"id"`
	BindHost    string              `json:"bindHost"`
	ConnectHost string              `json:"connectHost"`
	Port        int                 `json:"port"`
	PID         int                 `json:"pid,omitempty"`
	ProcessName string              `json:"processName,omitempty"`
	Protocol    string              `json:"protocol"`
	Kind        string              `json:"kind"`
	Owner       *WorkspacePortOwner `json:"owner,omitempty"`
}

type WorkspacePortScanResult struct {
	Platform          string          `json:"platform"`
	ScannedAt         int64           `json:"scannedAt"`
	Ports             []WorkspacePort `json:"ports"`
	UnavailableReason string          `json:"unavailableReason,omitempty"`
}

type WorkspacePortKillRequest struct {
	RepoID string `json:"repoId,omitempty"`
	PID    int    `json:"pid"`
	Port   int    `json:"port"`
}

type WorkspacePortKillResult struct {
	OK     bool   `json:"ok"`
	Reason string `json:"reason,omitempty"`
}

type rawWorkspacePort struct {
	host        string
	port        int
	pid         int
	processName string
	commandLine string
	cwd         string
}

func (m *Manager) ScanWorkspacePorts(ctx context.Context, repoID string) WorkspacePortScanResult {
	result := WorkspacePortScanResult{Platform: runtime.GOOS, ScannedAt: time.Now().UnixMilli(), Ports: []WorkspacePort{}}
	raw, err := scanListeningPorts(ctx)
	if err != nil {
		result.UnavailableReason = fmt.Sprintf("Port scanning is unavailable on %s: %v", runtime.GOOS, err)
		return result
	}
	probes := m.workspacePortProbes(strings.TrimSpace(repoID))
	for _, item := range raw {
		port := enrichWorkspacePort(item, probes)
		result.Ports = append(result.Ports, port)
	}
	sort.Slice(result.Ports, func(i, j int) bool {
		left, right := result.Ports[i], result.Ports[j]
		if workspacePortRank(left.Kind) != workspacePortRank(right.Kind) {
			return workspacePortRank(left.Kind) < workspacePortRank(right.Kind)
		}
		if left.Port != right.Port {
			return left.Port < right.Port
		}
		return left.ConnectHost < right.ConnectHost
	})
	if len(result.Ports) > workspacePortLimit {
		result.Ports = result.Ports[:workspacePortLimit]
	}
	return result
}

func (m *Manager) KillWorkspacePort(ctx context.Context, req WorkspacePortKillRequest) WorkspacePortKillResult {
	if req.PID <= 0 || req.Port <= 0 || req.Port > 65535 {
		return WorkspacePortKillResult{Reason: "Invalid process or port."}
	}
	// Why: renderer-provided PIDs are untrusted. Re-scan immediately before
	// termination and require the same workspace-owned PID/port pair.
	scan := m.ScanWorkspacePorts(ctx, req.RepoID)
	for _, port := range scan.Ports {
		if port.PID == req.PID && port.Port == req.Port {
			if port.Kind != "workspace" {
				return WorkspacePortKillResult{Reason: "Only workspace-owned local processes can be stopped here."}
			}
			if req.PID == os.Getpid() {
				return WorkspacePortKillResult{Reason: "Pebble cannot stop its own process."}
			}
			if err := terminateWorkspacePortProcess(req.PID); err != nil {
				return WorkspacePortKillResult{Reason: err.Error()}
			}
			return WorkspacePortKillResult{OK: true}
		}
	}
	return WorkspacePortKillResult{Reason: "The port is no longer listening."}
}

type workspacePortProbe struct{ id, repoID, displayName, path string }

func (m *Manager) workspacePortProbes(repoID string) []workspacePortProbe {
	projects := map[string]Project{}
	for _, project := range m.ListProjects() {
		projects[project.ID] = project
	}
	var probes []workspacePortProbe
	for _, worktree := range m.ListWorktrees(repoID) {
		project, ok := projects[worktree.ProjectID]
		if !ok || project.LocationKind == "ssh" || (repoID != "" && worktree.ProjectID != repoID) {
			continue
		}
		name := worktree.DisplayName
		if name == "" {
			name = filepath.Base(worktree.Path)
		}
		probes = append(probes, workspacePortProbe{worktree.ID, worktree.ProjectID, name, filepath.Clean(worktree.Path)})
	}
	return probes
}

func scanListeningPorts(parent context.Context) ([]rawWorkspacePort, error) {
	ctx, cancel := context.WithTimeout(parent, 4*time.Second)
	defer cancel()
	if runtime.GOOS == "windows" {
		return scanWindowsListeningPorts(ctx)
	}
	output, err := exec.CommandContext(ctx, "lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcn").Output()
	if err != nil {
		return nil, err
	}
	ports := parseLsofWorkspacePorts(string(output))
	loadUnixWorkspacePortMetadata(ctx, ports)
	return dedupeWorkspacePorts(ports), nil
}

func parseLsofWorkspacePorts(output string) []rawWorkspacePort {
	var ports []rawWorkspacePort
	pid := 0
	name := ""
	for scanner := bufio.NewScanner(strings.NewReader(output)); scanner.Scan(); {
		line := scanner.Text()
		if len(line) < 2 {
			continue
		}
		switch line[0] {
		case 'p':
			pid, _ = strconv.Atoi(line[1:])
			name = ""
		case 'c':
			name = line[1:]
		case 'n':
			host, port, ok := parseWorkspacePortAddress(line[1:])
			if ok {
				ports = append(ports, rawWorkspacePort{host: host, port: port, pid: pid, processName: name})
			}
		}
	}
	return ports
}

func loadUnixWorkspacePortMetadata(ctx context.Context, ports []rawWorkspacePort) {
	pids := make([]string, 0, len(ports))
	seen := map[int]bool{}
	for _, port := range ports {
		if port.pid > 0 && !seen[port.pid] {
			seen[port.pid] = true
			pids = append(pids, strconv.Itoa(port.pid))
		}
	}
	if len(pids) == 0 {
		return
	}
	metadata := map[int]rawWorkspacePort{}
	if output, err := exec.CommandContext(ctx, "lsof", "-a", "-p", strings.Join(pids, ","), "-d", "cwd", "-Fpn").Output(); err == nil {
		pid := 0
		for _, line := range strings.Split(string(output), "\n") {
			if strings.HasPrefix(line, "p") {
				pid, _ = strconv.Atoi(line[1:])
			} else if pid > 0 && strings.HasPrefix(line, "n") {
				value := metadata[pid]
				value.cwd = line[1:]
				metadata[pid] = value
			}
		}
	}
	if output, err := exec.CommandContext(ctx, "ps", "-p", strings.Join(pids, ","), "-o", "pid=", "-o", "command=").Output(); err == nil {
		for _, line := range strings.Split(string(output), "\n") {
			fields := strings.Fields(line)
			if len(fields) < 2 {
				continue
			}
			pid, err := strconv.Atoi(fields[0])
			if err != nil {
				continue
			}
			value := metadata[pid]
			value.commandLine = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(line), fields[0]))
			metadata[pid] = value
		}
	}
	for index := range ports {
		value := metadata[ports[index].pid]
		ports[index].cwd = value.cwd
		ports[index].commandLine = value.commandLine
	}
}

func scanWindowsListeningPorts(ctx context.Context) ([]rawWorkspacePort, error) {
	output, err := exec.CommandContext(ctx, "netstat", "-ano", "-p", "tcp").Output()
	if err != nil {
		return nil, err
	}
	var ports []rawWorkspacePort
	for _, line := range strings.Split(string(output), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 5 || !strings.EqualFold(fields[0], "TCP") || !strings.EqualFold(fields[3], "LISTENING") {
			continue
		}
		host, port, ok := parseWorkspacePortAddress(fields[1])
		if !ok {
			continue
		}
		pid, _ := strconv.Atoi(fields[4])
		ports = append(ports, rawWorkspacePort{host: host, port: port, pid: pid})
	}
	return dedupeWorkspacePorts(ports), nil
}

func parseWorkspacePortAddress(value string) (string, int, bool) {
	value = strings.TrimSpace(strings.TrimSuffix(value, " (LISTEN)"))
	index := strings.LastIndex(value, ":")
	if index < 1 {
		return "", 0, false
	}
	host := strings.Trim(value[:index], "[]")
	port, err := strconv.Atoi(value[index+1:])
	if err != nil || port < 1 || port > 65535 {
		return "", 0, false
	}
	return host, port, true
}

func enrichWorkspacePort(raw rawWorkspacePort, probes []workspacePortProbe) WorkspacePort {
	connectHost := raw.host
	if connectHost == "*" || connectHost == "0.0.0.0" || connectHost == "::" {
		connectHost = "localhost"
	}
	port := WorkspacePort{ID: fmt.Sprintf("%s:%d:%d", raw.host, raw.port, raw.pid), BindHost: raw.host, ConnectHost: connectHost, Port: raw.port, PID: raw.pid, ProcessName: raw.processName, Protocol: inferWorkspacePortProtocol(raw.port), Kind: "external"}
	if owner := attributeWorkspacePort(raw, probes); owner != nil {
		port.Kind = "workspace"
		port.Owner = owner
	} else if isContainerWorkspacePort(raw) {
		port.Kind = "container"
	}
	return port
}

func attributeWorkspacePort(raw rawWorkspacePort, probes []workspacePortProbe) *WorkspacePortOwner {
	best := -1
	confidence := ""
	for index, probe := range probes {
		path := filepath.Clean(probe.path)
		cwd := filepath.Clean(raw.cwd)
		if raw.cwd != "" && (cwd == path || strings.HasPrefix(cwd, path+string(filepath.Separator))) {
			if best < 0 || len(path) > len(probes[best].path) {
				best, confidence = index, "cwd"
			}
		}
	}
	if best < 0 {
		command := filepath.ToSlash(raw.commandLine)
		for index, probe := range probes {
			path := filepath.ToSlash(filepath.Clean(probe.path))
			if strings.Contains(command, path) && (best < 0 || len(path) > len(probes[best].path)) {
				best, confidence = index, "command"
			}
		}
	}
	if best < 0 {
		return nil
	}
	probe := probes[best]
	return &WorkspacePortOwner{WorktreeID: probe.id, RepoID: probe.repoID, DisplayName: probe.displayName, Path: probe.path, Confidence: confidence}
}

func inferWorkspacePortProtocol(port int) string {
	if port == 443 || port == 8443 {
		return "https"
	}
	for _, candidate := range []int{80, 3000, 3001, 4200, 5000, 5173, 5174, 8000, 8080, 8888} {
		if port == candidate {
			return "http"
		}
	}
	return "unknown"
}
func isContainerWorkspacePort(raw rawWorkspacePort) bool {
	value := strings.ToLower(raw.processName + " " + raw.commandLine)
	return strings.Contains(value, "container") || strings.Contains(value, "com.docker.backend")
}
func workspacePortRank(kind string) int {
	if kind == "workspace" {
		return 0
	}
	if kind == "container" {
		return 1
	}
	return 2
}
func dedupeWorkspacePorts(input []rawWorkspacePort) []rawWorkspacePort {
	seen := map[string]bool{}
	result := []rawWorkspacePort{}
	for _, port := range input {
		host := port.host
		if host == "*" || host == "0.0.0.0" || host == "::" {
			host = "localhost"
		}
		key := fmt.Sprintf("%s:%d:%d", host, port.port, port.pid)
		if !seen[key] {
			seen[key] = true
			result = append(result, port)
		}
	}
	return result
}
