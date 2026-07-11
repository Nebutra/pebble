package runtimecore

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func writeCapturingSsh(t *testing.T, captureDir string) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("capturing ssh fixture uses a POSIX shell")
	}
	path := filepath.Join(t.TempDir(), "ssh")
	script := "#!/bin/sh\nlast=''\nfor arg in \"$@\"; do last=$arg; done\ncase \"$last\" in\n  'uname -s; uname -m') printf 'Linux\\nx86_64\\n'; exit 0 ;;\n  *'.pebble-relay-worker.tmp'*) cat > " + shellQuote(filepath.Join(captureDir, "worker")) + "; printf 'deployed\\n'; exit 0 ;;\nesac\nprintf '%s\\n' \"$@\" > " + shellQuote(filepath.Join(captureDir, "args")) + "\ncat > " + shellQuote(filepath.Join(captureDir, "stdin")) + "\nprintf '%s' \"$PEBBLE_SSH_ASKPASS_SECRET\" > " + shellQuote(filepath.Join(captureDir, "secret")) + "\nprintf 'installed\\n'\n"
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestSshAgentHookBootstrapUsesPurposeScopedCommandAndStdin(t *testing.T) {
	manager, _ := newSshTestManager(t)
	identitiesOnly := true
	target, err := manager.CreateSshTarget(SshTargetInput{Host: "hooks.example", Username: "deploy", Port: 2222, IdentityFile: "/keys/id", IdentitiesOnly: &identitiesOnly})
	if err != nil {
		t.Fatal(err)
	}
	capture := t.TempDir()
	t.Setenv("PEBBLE_SYSTEM_SSH_PATH", writeCapturingSsh(t, capture))
	if _, err := manager.SeedSshCredential(target.ID, SshCredentialKindPassphrase, "not-in-argv"); err != nil {
		t.Fatal(err)
	}
	payload := "#!/bin/sh\necho bootstrap\n"
	t.Setenv("PEBBLE_GO_RUNTIME_SOURCE_DIR", filepath.Clean(filepath.Join("..", "..")))
	result, err := manager.BootstrapSshAgentHooks(context.Background(), target.ID, SshAgentHookBootstrapRequest{Version: 1, Script: payload})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Success || result.Status != "installed" || !strings.Contains(result.Output, "installed") {
		t.Fatalf("unexpected bootstrap result: %+v", result)
	}
	args, _ := os.ReadFile(filepath.Join(capture, "args"))
	if !strings.Contains(string(args), "deploy@hooks.example") || !strings.Contains(string(args), "sh -s -- pebble-agent-hooks-v1") || !strings.Contains(string(args), "2222") {
		t.Fatalf("missing target/bootstrap args: %s", args)
	}
	if strings.Contains(string(args), "not-in-argv") {
		t.Fatal("credential leaked into ssh argv")
	}
	stdin, _ := os.ReadFile(filepath.Join(capture, "stdin"))
	if !strings.HasSuffix(string(stdin), payload) || !strings.Contains(string(stdin), "PEBBLE_RELAY_WORKER='$HOME/.pebble/bin/pebble-relay-worker'") {
		t.Fatalf("bootstrap stdin mismatch: %q", stdin)
	}
	worker, _ := os.ReadFile(filepath.Join(capture, "worker"))
	if len(worker) < 1024 || string(worker[:4]) != "\x7fELF" {
		t.Fatalf("Linux relay worker was not deployed before bootstrap: %d bytes", len(worker))
	}
	secret, _ := os.ReadFile(filepath.Join(capture, "secret"))
	if string(secret) != "not-in-argv" {
		t.Fatal("cached credential was not supplied through askpass environment")
	}
}

func TestSshAgentHookBootstrapRejectsInvalidOrOversizedPayload(t *testing.T) {
	manager, _ := newSshTestManager(t)
	target, err := manager.CreateSshTarget(SshTargetInput{Host: "hooks.example"})
	if err != nil {
		t.Fatal(err)
	}
	for _, request := range []SshAgentHookBootstrapRequest{{Version: 2, Script: "true"}, {Version: 1, Script: " "}, {Version: 1, Script: strings.Repeat("x", maxAgentHookBootstrapBytes+1)}} {
		if _, err := manager.BootstrapSshAgentHooks(context.Background(), target.ID, request); err == nil {
			t.Fatalf("expected request rejection: %+v", request)
		}
	}
}
