package runtimecore

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

const securityKeyPublicKey = "sk-ssh-ed25519@openssh.com AAAAB3Nz yubikey@example\n"

func TestSshQueryListsSecurityKeyTypes(t *testing.T) {
	tests := []struct {
		name   string
		output string
		want   bool
	}{
		{name: "pre 8.2", output: "ssh-ed25519\nssh-rsa\necdsa-sha2-nistp256\n", want: false},
		{name: "ed25519 sk", output: "ssh-ed25519\nsk-ssh-ed25519@openssh.com\n", want: true},
		{name: "ecdsa sk", output: "ssh-rsa\nsk-ecdsa-sha2-nistp256@openssh.com\n", want: true},
		{name: "trailing space", output: "sk-ssh-ed25519@openssh.com \n", want: true},
		{name: "empty", output: "", want: false},
		// A certificate type merely embeds the name; it is not an offerable key.
		{name: "cert only", output: "sk-ssh-ed25519-cert-v01@openssh.com\n", want: false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := SshQueryListsSecurityKeyTypes(test.output); got != test.want {
				t.Fatalf("expected %v, got %v for %q", test.want, got, test.output)
			}
		})
	}
}

func TestPublicKeyLineUsesSecurityKey(t *testing.T) {
	if !PublicKeyLineUsesSecurityKey(securityKeyPublicKey) {
		t.Fatal("expected an sk- public key line to be recognised")
	}
	if PublicKeyLineUsesSecurityKey("ssh-ed25519 AAAAB3Nz laptop@example\n") {
		t.Fatal("expected a software key line to be rejected")
	}
	if PublicKeyLineUsesSecurityKey("") {
		t.Fatal("expected an empty line to be rejected")
	}
}

func TestDetectSshSystemCapabilitiesReadsQueryOutput(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake ssh executable uses a unix shell script")
	}
	sshPath := writeFakeSshQueryBinary(t, "#!/bin/sh\nprintf 'ssh-ed25519\\nsk-ssh-ed25519@openssh.com\\n'\n")
	t.Setenv("PEBBLE_SYSTEM_SSH_PATH", sshPath)

	capabilities := DetectSshSystemCapabilities(context.Background())
	if !capabilities.Available || !capabilities.SecurityKeyAuth {
		t.Fatalf("expected security-key support, got %+v", capabilities)
	}
	if capabilities.Path != sshPath {
		t.Fatalf("expected path %q, got %q", sshPath, capabilities.Path)
	}
}

func TestDetectSshSystemCapabilitiesTreatsUnsupportedQueryAsNoSecurityKeys(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake ssh executable uses a unix shell script")
	}
	// A binary too old to understand `-Q` also predates FIDO2 support.
	sshPath := writeFakeSshQueryBinary(t, "#!/bin/sh\necho 'unknown option -- Q' >&2\nexit 1\n")
	t.Setenv("PEBBLE_SYSTEM_SSH_PATH", sshPath)

	capabilities := DetectSshSystemCapabilities(context.Background())
	if !capabilities.Available {
		t.Fatal("expected the binary to still count as available")
	}
	if capabilities.SecurityKeyAuth {
		t.Fatal("expected no security-key support from a binary that rejects -Q")
	}
}

func TestDetectSshSystemCapabilitiesReportsMissingBinary(t *testing.T) {
	t.Setenv("PEBBLE_SYSTEM_SSH_PATH", "")
	t.Setenv("PATH", t.TempDir())

	if capabilities := DetectSshSystemCapabilities(context.Background()); capabilities.Available {
		t.Fatalf("expected no capabilities without a binary, got %+v", capabilities)
	}
}

func TestEnsureSshTargetTransportNamesTheInstallStep(t *testing.T) {
	err := EnsureSshTargetTransport(SshTarget{Host: "example.com"}, SshSystemCapabilities{})
	if err == nil {
		t.Fatal("expected a missing-binary error")
	}
	for _, want := range []string{"system ssh binary not found", "PEBBLE_SYSTEM_SSH_PATH"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("expected %q in %q", want, err.Error())
		}
	}
}

func TestEnsureSshTargetTransportRejectsSecurityKeyOnOlderSsh(t *testing.T) {
	target := SshTarget{Host: "example.com", IdentityFile: writeSecurityKeyIdentity(t)}

	err := EnsureSshTargetTransport(target, SshSystemCapabilities{Available: true})
	if err == nil {
		t.Fatal("expected a security-key gating error")
	}
	if !strings.Contains(err.Error(), "OpenSSH 8.2") {
		t.Fatalf("expected the required version in %q", err.Error())
	}
}

func TestEnsureSshTargetTransportAcceptsSecurityKeyOnSupportedSsh(t *testing.T) {
	target := SshTarget{Host: "example.com", IdentityFile: writeSecurityKeyIdentity(t)}
	capabilities := SshSystemCapabilities{Available: true, SecurityKeyAuth: true}

	if err := EnsureSshTargetTransport(target, capabilities); err != nil {
		t.Fatalf("expected a supported security key to pass, got %v", err)
	}
}

func TestEnsureSshTargetTransportIgnoresSoftwareKeysOnOlderSsh(t *testing.T) {
	identity := filepath.Join(t.TempDir(), "id_ed25519")
	writeIdentityFile(t, identity+".pub", "ssh-ed25519 AAAAB3Nz laptop@example\n")
	target := SshTarget{Host: "example.com", IdentityFile: identity}

	if err := EnsureSshTargetTransport(target, SshSystemCapabilities{Available: true}); err != nil {
		t.Fatalf("expected a software key to pass on any ssh, got %v", err)
	}
}

func TestIdentityFileUsesSecurityKeyExpandsHome(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	writeIdentityFile(t, filepath.Join(home, "id_sk.pub"), securityKeyPublicKey)

	if !IdentityFileUsesSecurityKey("~/id_sk") {
		t.Fatal("expected a tilde identity path to resolve against the home directory")
	}
	if IdentityFileUsesSecurityKey("") {
		t.Fatal("expected an empty identity path to be rejected")
	}
	if IdentityFileUsesSecurityKey(filepath.Join(home, "missing")) {
		t.Fatal("expected an identity without a .pub sibling to be rejected")
	}
}

func TestSshTargetNeedsUserPresenceFollowsTheIdentity(t *testing.T) {
	if !SshTargetNeedsUserPresence(SshTarget{IdentityFile: writeSecurityKeyIdentity(t)}) {
		t.Fatal("expected a security-key target to need user presence")
	}
	if SshTargetNeedsUserPresence(SshTarget{Host: "example.com"}) {
		t.Fatal("expected a target without an identity file to need no presence")
	}
}

func writeSecurityKeyIdentity(t *testing.T) string {
	t.Helper()
	identity := filepath.Join(t.TempDir(), "id_ed25519_sk")
	writeIdentityFile(t, identity+".pub", securityKeyPublicKey)
	return identity
}

func writeFakeSshQueryBinary(t *testing.T, script string) string {
	t.Helper()
	sshPath := filepath.Join(t.TempDir(), "ssh")
	if err := os.WriteFile(sshPath, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	return sshPath
}

func writeIdentityFile(t *testing.T, path string, contents string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}
}
