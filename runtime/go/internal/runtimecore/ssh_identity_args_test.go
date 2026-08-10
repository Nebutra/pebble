package runtimecore

import (
	"strings"
	"testing"
)

func TestSshIdentityArgsOfferAnAgentHeldKey(t *testing.T) {
	args := sshIdentityArgs(SshTarget{
		IdentityFile:  "/keys/id_ed25519_sk",
		IdentityAgent: "/run/user/1000/keyring/ssh",
	})

	joined := strings.Join(args, " ")
	for _, want := range []string{
		"-i /keys/id_ed25519_sk",
		"IdentitiesOnly=yes",
		"IdentityAgent=/run/user/1000/keyring/ssh",
	} {
		if !strings.Contains(joined, want) {
			t.Fatalf("expected %q in %q", want, joined)
		}
	}
}

func TestSshIdentityArgsHonourIdentitiesOnlyOptOut(t *testing.T) {
	args := sshIdentityArgs(SshTarget{IdentityFile: "/keys/id", IdentitiesOnly: boolPtr(false)})

	joined := strings.Join(args, " ")
	if strings.Contains(joined, "IdentitiesOnly") {
		t.Fatalf("expected no IdentitiesOnly when opted out, got %q", joined)
	}
	if !strings.Contains(joined, "-i /keys/id") {
		t.Fatalf("expected the identity file to stay, got %q", joined)
	}
}

func TestSshIdentityArgsStayEmptyWithoutAnIdentity(t *testing.T) {
	if args := sshIdentityArgs(SshTarget{Host: "example.com"}); len(args) != 0 {
		t.Fatalf("expected no identity args, got %v", args)
	}
}

// Why: the non-interactive builder used to force IdentitiesOnly and drop
// IdentityAgent, so an agent-held key was never presented to the server.
func TestSshConnectionArgsCarryTheIdentityAgent(t *testing.T) {
	args := sshConnectionArgs(SshTarget{
		ID:                       "tgt-agent",
		Host:                     "example.com",
		Username:                 "dev",
		IdentityFile:             "/keys/id_ed25519_sk",
		IdentityAgent:            "/run/agent.sock",
		IdentitiesOnly:           boolPtr(false),
		SystemSshConnectionReuse: boolPtr(false),
	})

	joined := strings.Join(args, " ")
	if !strings.Contains(joined, "IdentityAgent=/run/agent.sock") {
		t.Fatalf("expected the identity agent to be forwarded, got %q", joined)
	}
	if strings.Contains(joined, "IdentitiesOnly") {
		t.Fatalf("expected the opt-out to be honoured, got %q", joined)
	}
}
