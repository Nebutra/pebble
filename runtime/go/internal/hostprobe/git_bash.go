// Package hostprobe detects Windows terminal integrations (WSL, PowerShell 7,
// Git Bash) so the desktop shell can offer the same shell profiles the Electron
// build exposes. Real probes only run on Windows; other platforms return the
// same empty shape Electron's detectWindowsTerminalCapabilities returns there.
package hostprobe

import (
	"path/filepath"
	"regexp"
	"strings"
)

// gitForWindowsBashPattern matches a Git-for-Windows bash.exe. It rejects msys2/cygwin
// bash so only the bundled Git shell is offered.
var gitForWindowsBashPattern = regexp.MustCompile(`(?i)(?:^|\\)(?:git|portablegit)(?:\\usr)?\\bin\\bash\.exe$`)

// windowsPathDelimiter separates PATH entries on Windows; kept explicit because
// probes run cross-platform under test where filepath.ListSeparator differs.
const windowsPathDelimiter = ";"

// isGitForWindowsBashPath reports whether shellPath points at a Git-for-Windows
// bash.exe. It normalizes to backslash form first so forward-slash inputs match.
func isGitForWindowsBashPath(shellPath string) bool {
	normalized := strings.ReplaceAll(shellPath, "/", "\\")
	normalized = filepath.FromSlash(normalized)
	return gitForWindowsBashPattern.MatchString(normalized)
}

func readEnv(env map[string]string, names ...string) string {
	for _, name := range names {
		if value := env[name]; value != "" {
			return value
		}
	}
	return ""
}

func normalizePathSegment(segment string) string {
	trimmed := strings.TrimSpace(segment)
	if len(trimmed) >= 2 && strings.HasPrefix(trimmed, `"`) && strings.HasSuffix(trimmed, `"`) {
		return trimmed[1 : len(trimmed)-1]
	}
	return trimmed
}

func winJoin(parts ...string) string {
	joined := strings.Join(parts, `\`)
	// Collapse any accidental double separators from empty roots.
	return strings.ReplaceAll(joined, `\\`, `\`)
}

func pushCandidate(candidates *[]string, seen map[string]bool, candidate string) {
	if candidate == "" {
		return
	}
	key := strings.ToLower(candidate)
	if seen[key] {
		return
	}
	seen[key] = true
	*candidates = append(*candidates, candidate)
}

// gitBashCandidatePaths checks well-known install roots plus PATH entries that look like a Git install.
func gitBashCandidatePaths(env map[string]string) []string {
	candidates := []string{}
	seen := map[string]bool{}
	roots := []string{
		readEnv(env, "ProgramFiles", "PROGRAMFILES"),
		readEnv(env, "ProgramW6432", "PROGRAMW6432"),
		readEnv(env, "ProgramFiles(x86)", "PROGRAMFILES(X86)"),
		readEnv(env, "LOCALAPPDATA", "LocalAppData"),
	}
	for _, root := range roots {
		if root == "" {
			continue
		}
		pushCandidate(&candidates, seen, winJoin(root, "Git", "bin", "bash.exe"))
		pushCandidate(&candidates, seen, winJoin(root, "Git", "usr", "bin", "bash.exe"))
		pushCandidate(&candidates, seen, winJoin(root, "Programs", "Git", "bin", "bash.exe"))
		pushCandidate(&candidates, seen, winJoin(root, "Programs", "Git", "usr", "bin", "bash.exe"))
	}

	pathValue := readEnv(env, "Path", "PATH")
	if pathValue == "" {
		return candidates
	}
	for _, rawSegment := range strings.Split(pathValue, windowsPathDelimiter) {
		segment := normalizePathSegment(rawSegment)
		if segment == "" {
			continue
		}
		directBash := winJoin(segment, "bash.exe")
		if isGitForWindowsBashPath(directBash) {
			pushCandidate(&candidates, seen, directBash)
		}

		basename := strings.ToLower(winBase(segment))
		parent := winDir(segment)
		parentBasename := strings.ToLower(winBase(parent))
		switch {
		case basename == "cmd" && (parentBasename == "git" || parentBasename == "portablegit"):
			pushCandidate(&candidates, seen, winJoin(parent, "bin", "bash.exe"))
			pushCandidate(&candidates, seen, winJoin(parent, "usr", "bin", "bash.exe"))
		case basename == "git" || basename == "portablegit":
			pushCandidate(&candidates, seen, winJoin(segment, "bin", "bash.exe"))
			pushCandidate(&candidates, seen, winJoin(segment, "usr", "bin", "bash.exe"))
		}
	}
	return candidates
}

// winBase returns the last backslash-separated segment of a Windows path.
func winBase(path string) string {
	trimmed := strings.TrimRight(path, `\`)
	if idx := strings.LastIndex(trimmed, `\`); idx >= 0 {
		return trimmed[idx+1:]
	}
	return trimmed
}

// winDir returns the parent of a Windows path (everything before the final
// backslash), matching path.win32.dirname closely enough for candidate probing.
func winDir(path string) string {
	trimmed := strings.TrimRight(path, `\`)
	if idx := strings.LastIndex(trimmed, `\`); idx >= 0 {
		return trimmed[:idx]
	}
	return trimmed
}

// resolveGitBashPath returns the first existing Git-for-Windows bash.exe, or ""
// when none is found. It is a no-op off Windows, matching resolveGitBashPath.
func resolveGitBashPath(env map[string]string, goos string, exists func(string) bool) string {
	if goos != "windows" {
		return ""
	}
	for _, candidate := range gitBashCandidatePaths(env) {
		if isGitForWindowsBashPath(candidate) && exists(candidate) {
			return candidate
		}
	}
	return ""
}
