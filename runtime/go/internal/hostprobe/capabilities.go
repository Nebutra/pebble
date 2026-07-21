package hostprobe

import (
	"context"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"
)

// probeTimeout bounds each external probe. Mirrors the 5s sync timeouts used by
// isWslAvailable/isPwshAvailable/listWslDistros in the Electron main process.
const probeTimeout = 5 * time.Second

// TerminalCapabilities is the JSON shape the desktop shell consumes. Field names
// mirror RemoteWindowsTerminalCapabilities in
// migration/electron-reference/src/main/ipc/preflight-remote-windows-terminal-capabilities.ts so the renderer
// contract is identical across the Electron and Tauri hosts.
type TerminalCapabilities struct {
	WSLAvailable     bool     `json:"wslAvailable"`
	WSLDistros       []string `json:"wslDistros"`
	PwshAvailable    bool     `json:"pwshAvailable"`
	GitBashAvailable bool     `json:"gitBashAvailable"`
	HostPlatform     *string  `json:"hostPlatform"`
}

// CommandRunner runs an external probe command and returns combined behavior
// (stdout, whether it succeeded). Injected so tests avoid real subprocesses.
type CommandRunner func(ctx context.Context, name string, args ...string) (stdout string, ok bool)

// Prober aggregates the host detection knobs. Zero value is unusable; use
// NewProber for the real host or construct directly in tests with fakes.
type Prober struct {
	GOOS   string
	Env    map[string]string
	Exists func(string) bool
	Run    CommandRunner
}

// NewProber wires a Prober to the real OS: current GOOS, process env, filesystem
// existence, and a bounded exec runner.
func NewProber() *Prober {
	return &Prober{
		GOOS:   runtime.GOOS,
		Env:    environMap(),
		Exists: fileExists,
		Run:    execRunner,
	}
}

// Detect returns the terminal capabilities for this host. On non-Windows it
// returns all-false with an empty distro list and the platform label, exactly
// as Electron's detectWindowsTerminalCapabilities does off Windows.
func (p *Prober) Detect() TerminalCapabilities {
	platform := nodePlatform(p.GOOS)
	caps := TerminalCapabilities{
		WSLDistros:   []string{},
		HostPlatform: &platform,
	}
	if p.GOOS != "windows" {
		return caps
	}
	caps.WSLAvailable = p.isWslAvailable()
	caps.PwshAvailable = p.isPwshAvailable()
	caps.GitBashAvailable = resolveGitBashPath(p.Env, p.GOOS, p.Exists) != ""
	if caps.WSLAvailable {
		caps.WSLDistros = p.listWslDistros()
	}
	return caps
}

// isWslAvailable mirrors isWslAvailable in migration/electron-reference/src/main/wsl.ts: `wsl.exe --status`
// exiting cleanly means WSL is functional.
func (p *Prober) isWslAvailable() bool {
	if p.GOOS != "windows" {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), probeTimeout)
	defer cancel()
	_, ok := p.Run(ctx, "wsl.exe", "--status")
	return ok
}

// isPwshAvailable mirrors isPwshAvailable in migration/electron-reference/src/main/pwsh.ts: `pwsh.exe
// -Version` exiting cleanly means PowerShell 7 is installed.
func (p *Prober) isPwshAvailable() bool {
	if p.GOOS != "windows" {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), probeTimeout)
	defer cancel()
	_, ok := p.Run(ctx, "pwsh.exe", "-Version")
	return ok
}

// listWslDistros mirrors listWslDistros in migration/electron-reference/src/main/wsl.ts: `wsl.exe --list
// --quiet`, NUL-stripped, default-marker-stripped, docker-desktop filtered.
func (p *Prober) listWslDistros() []string {
	if p.GOOS != "windows" {
		return []string{}
	}
	ctx, cancel := context.WithTimeout(context.Background(), probeTimeout)
	defer cancel()
	stdout, ok := p.Run(ctx, "wsl.exe", "--list", "--quiet")
	if !ok {
		return []string{}
	}
	return parseWslDistros(stdout)
}

// parseWslDistros normalizes `wsl.exe --list --quiet` output the way
// normalizeWslListOutput + isUserWslDistro do in migration/electron-reference/src/main/wsl.ts.
func parseWslDistros(output string) []string {
	cleaned := strings.ReplaceAll(output, "\x00", "")
	distros := []string{}
	for _, rawLine := range strings.Split(cleaned, "\n") {
		line := strings.TrimSpace(strings.TrimRight(rawLine, "\r"))
		line = strings.TrimSpace(strings.TrimPrefix(line, "*"))
		if line == "" {
			continue
		}
		if strings.HasPrefix(strings.ToLower(line), "docker-desktop") {
			continue
		}
		distros = append(distros, line)
	}
	return distros
}

// nodePlatform maps GOOS to the Node process.platform string the renderer keys
// off (win32/darwin/linux), so hostPlatform matches the Electron host exactly.
func nodePlatform(goos string) string {
	switch goos {
	case "windows":
		return "win32"
	case "darwin":
		return "darwin"
	default:
		return goos
	}
}

func environMap() map[string]string {
	env := map[string]string{}
	for _, entry := range os.Environ() {
		if idx := strings.IndexByte(entry, '='); idx >= 0 {
			env[entry[:idx]] = entry[idx+1:]
		}
	}
	return env
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func execRunner(ctx context.Context, name string, args ...string) (string, bool) {
	out, err := exec.CommandContext(ctx, name, args...).Output()
	if err != nil {
		return "", false
	}
	return string(out), true
}
