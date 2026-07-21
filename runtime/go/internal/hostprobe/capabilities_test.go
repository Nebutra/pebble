package hostprobe

import (
	"context"
	"reflect"
	"testing"
)

// fakeRun builds a CommandRunner that answers per-command from a table keyed by
// the probe binary name.
func fakeRun(table map[string]struct {
	stdout string
	ok     bool
}) CommandRunner {
	return func(_ context.Context, name string, _ ...string) (string, bool) {
		entry, found := table[name]
		if !found {
			return "", false
		}
		return entry.stdout, entry.ok
	}
}

func TestDetectNonWindowsReturnsEmptyShape(t *testing.T) {
	for _, goos := range []string{"darwin", "linux"} {
		p := &Prober{
			GOOS: goos,
			Env:  map[string]string{"PATH": `C:\Program Files\Git\cmd`},
			// Exists/Run should never be consulted off Windows.
			Exists: func(string) bool { t.Fatalf("exists called on %s", goos); return false },
			Run: func(context.Context, string, ...string) (string, bool) {
				t.Fatalf("run called on %s", goos)
				return "", false
			},
		}
		caps := p.Detect()
		if caps.WSLAvailable || caps.PwshAvailable || caps.GitBashAvailable {
			t.Fatalf("%s: expected all-false, got %+v", goos, caps)
		}
		if len(caps.WSLDistros) != 0 {
			t.Fatalf("%s: expected no distros, got %v", goos, caps.WSLDistros)
		}
		if caps.HostPlatform == nil {
			t.Fatalf("%s: expected non-nil hostPlatform", goos)
		}
		want := goos
		if goos == "darwin" {
			want = "darwin"
		}
		if *caps.HostPlatform != want {
			t.Fatalf("%s: hostPlatform = %q, want %q", goos, *caps.HostPlatform, want)
		}
	}
}

func TestDetectWindowsAllAvailable(t *testing.T) {
	p := &Prober{
		GOOS:   "windows",
		Env:    map[string]string{"ProgramFiles": `C:\Program Files`},
		Exists: func(path string) bool { return path == `C:\Program Files\Git\bin\bash.exe` },
		Run: fakeRun(map[string]struct {
			stdout string
			ok     bool
		}{
			"wsl.exe":  {stdout: "  Ubuntu\r\n* Debian\r\ndocker-desktop\r\n", ok: true},
			"pwsh.exe": {stdout: "PowerShell 7.4.1", ok: true},
		}),
	}
	caps := p.Detect()
	if !caps.WSLAvailable {
		t.Fatalf("expected wslAvailable")
	}
	if !caps.PwshAvailable {
		t.Fatalf("expected pwshAvailable")
	}
	if !caps.GitBashAvailable {
		t.Fatalf("expected gitBashAvailable")
	}
	if got, want := caps.WSLDistros, []string{"Ubuntu", "Debian"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("distros = %v, want %v (docker-desktop and default marker filtered)", got, want)
	}
	if caps.HostPlatform == nil || *caps.HostPlatform != "win32" {
		t.Fatalf("hostPlatform = %v, want win32", caps.HostPlatform)
	}
}

func TestDetectWindowsWslUnavailableSkipsDistroList(t *testing.T) {
	listCalled := false
	p := &Prober{
		GOOS:   "windows",
		Env:    map[string]string{},
		Exists: func(string) bool { return false },
		Run: func(_ context.Context, name string, args ...string) (string, bool) {
			if name == "wsl.exe" {
				if len(args) > 0 && args[0] == "--list" {
					listCalled = true
					return "Ubuntu\r\n", true
				}
				// --status fails -> WSL unavailable.
				return "", false
			}
			return "", false
		},
	}
	caps := p.Detect()
	if caps.WSLAvailable {
		t.Fatalf("expected wslAvailable false")
	}
	if listCalled {
		t.Fatalf("distro list must not run when WSL is unavailable")
	}
	if len(caps.WSLDistros) != 0 {
		t.Fatalf("expected empty distros, got %v", caps.WSLDistros)
	}
}

func TestResolveGitBashPathFromPathFixture(t *testing.T) {
	env := map[string]string{
		"PATH": `C:\Windows;C:\Program Files\Git\cmd;C:\msys64\usr\bin`,
	}
	existing := map[string]bool{
		`C:\Program Files\Git\bin\bash.exe`: true,
	}
	got := resolveGitBashPath(env, "windows", func(path string) bool { return existing[path] })
	if got != `C:\Program Files\Git\bin\bash.exe` {
		t.Fatalf("resolveGitBashPath = %q, want the Git cmd sibling bash.exe", got)
	}
}

func TestResolveGitBashPathRejectsMsys2(t *testing.T) {
	// A direct msys2 bash on PATH must never be accepted as Git Bash.
	env := map[string]string{"PATH": `C:\msys64\usr\bin`}
	got := resolveGitBashPath(env, "windows", func(string) bool { return true })
	if got != "" {
		t.Fatalf("expected msys2 bash rejected, got %q", got)
	}
}

func TestIsGitForWindowsBashPath(t *testing.T) {
	cases := map[string]bool{
		`C:\Program Files\Git\bin\bash.exe`:     true,
		`C:\Program Files\Git\usr\bin\bash.exe`: true,
		`D:\PortableGit\bin\bash.exe`:           true,
		`D:/PortableGit/bin/bash.exe`:           true,
		`C:\msys64\usr\bin\bash.exe`:            false,
		`C:\cygwin64\bin\bash.exe`:              false,
		`C:\Program Files\Git\bin\git.exe`:      false,
	}
	for path, want := range cases {
		if got := isGitForWindowsBashPath(path); got != want {
			t.Fatalf("isGitForWindowsBashPath(%q) = %v, want %v", path, got, want)
		}
	}
}

func TestParseWslDistros(t *testing.T) {
	// NUL bytes (UTF-16 leakage), CRLF, default marker, docker-desktop filtering.
	raw := "\x00U\x00b\x00u\x00n\x00t\x00u\x00\r\n* Debian\r\ndocker-desktop-data\r\n\r\n"
	got := parseWslDistros(raw)
	want := []string{"Ubuntu", "Debian"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("parseWslDistros = %v, want %v", got, want)
	}
}
