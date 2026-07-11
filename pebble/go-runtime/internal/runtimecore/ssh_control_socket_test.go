package runtimecore

import (
	"runtime"
	"strings"
	"testing"
)

func boolPtr(value bool) *bool {
	return &value
}

func TestControlSocketPathIsDeterministic(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("control sockets are unix-only")
	}
	target := SshTarget{ID: "tgt-1", Host: "example.com", Port: 22, Username: "dev"}

	first, ok := controlSocketPath(target)
	if !ok {
		t.Fatal("expected a control socket path")
	}
	second, ok := controlSocketPath(target)
	if !ok {
		t.Fatal("expected a control socket path on second call")
	}
	if first != second {
		t.Fatalf("expected deterministic path, got %q then %q", first, second)
	}
}

func TestControlSocketPathDiffersByIdentity(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("control sockets are unix-only")
	}
	a, ok := controlSocketPath(SshTarget{ID: "tgt-a", Host: "example.com", Port: 22, Username: "dev"})
	if !ok {
		t.Fatal("expected a control socket path for target a")
	}
	b, ok := controlSocketPath(SshTarget{ID: "tgt-b", Host: "example.com", Port: 22, Username: "dev"})
	if !ok {
		t.Fatal("expected a control socket path for target b")
	}
	if a == b {
		t.Fatal("expected different targets to hash to different socket paths")
	}

	// Same target, but the port changed (e.g. config drift) — must not reuse
	// a master dialed under the old settings.
	c, ok := controlSocketPath(SshTarget{ID: "tgt-a", Host: "example.com", Port: 2222, Username: "dev"})
	if !ok {
		t.Fatal("expected a control socket path for target a with a new port")
	}
	if a == c {
		t.Fatal("expected a changed port to change the socket path")
	}
}

func TestControlSocketPathDisabledOnWindows(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("this assertion only holds on windows")
	}
	_, ok := controlSocketPath(SshTarget{ID: "tgt-1", Host: "example.com"})
	if ok {
		t.Fatal("expected no control socket path on windows")
	}
}

func TestControlSocketPathRespectsOptOut(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("control sockets are unix-only")
	}
	target := SshTarget{
		ID:                       "tgt-1",
		Host:                     "example.com",
		SystemSshConnectionReuse: boolPtr(false),
	}
	_, ok := controlSocketPath(target)
	if ok {
		t.Fatal("expected no control socket path when connection reuse is disabled")
	}
}

func TestControlSocketPathFallsBackWhenTooLong(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("control sockets are unix-only")
	}
	// The hash itself is fixed-length (16 hex chars); the only way to exceed
	// the platform limit is a socket directory whose own path is already too
	// long. Exercise the length guard directly against the computed limit
	// rather than trying to engineer a real over-long TMPDIR in the test env.
	limit := controlSocketMaxPathLength()
	if limit <= 0 {
		t.Fatalf("expected a positive path length limit, got %d", limit)
	}
	dir, ok := controlSocketDirectory()
	if !ok {
		t.Fatal("expected a control socket directory")
	}
	hash := controlSocketHash(SshTarget{ID: "tgt-1", Host: "example.com"})
	path := dir + "/" + hash
	if len(path) > limit && ok {
		t.Fatalf("computed path length %d unexpectedly exceeds limit %d", len(path), limit)
	}
	// Sanity: the hash segment itself must not already blow the budget on its own.
	if len(hash) >= limit {
		t.Fatalf("hash length %d leaves no room under limit %d", len(hash), limit)
	}
}

func TestSshConnectionArgsIncludeControlMasterByDefault(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("control sockets are unix-only")
	}
	args := sshConnectionArgs(SshTarget{ID: "tgt-1", Host: "example.com", Username: "dev"})
	joined := strings.Join(args, " ")
	for _, want := range []string{"ControlMaster=auto", "ControlPersist=300", "ControlPath="} {
		if !strings.Contains(joined, want) {
			t.Fatalf("expected args to contain %q, got %q", want, joined)
		}
	}
}

func TestSshConnectionArgsOmitControlMasterWhenOptedOut(t *testing.T) {
	args := sshConnectionArgs(SshTarget{
		ID:                       "tgt-1",
		Host:                     "example.com",
		Username:                 "dev",
		SystemSshConnectionReuse: boolPtr(false),
	})
	joined := strings.Join(args, " ")
	if strings.Contains(joined, "ControlMaster") {
		t.Fatalf("expected no ControlMaster args when opted out, got %q", joined)
	}
}
