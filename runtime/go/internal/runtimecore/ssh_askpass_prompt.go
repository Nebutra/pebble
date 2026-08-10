package runtimecore

import "strings"

// SshAskpassPromptKind classifies the prompt OpenSSH passes to an SSH_ASKPASS
// helper in argv[1].
type SshAskpassPromptKind int

const (
	// SshAskpassPromptSecret is a private-key passphrase or an account password
	// prompt — the only kind a cached Pebble credential can legitimately answer.
	SshAskpassPromptSecret SshAskpassPromptKind = iota
	// SshAskpassPromptSecurityKey is a FIDO2 PIN or user-presence prompt, which
	// the authenticator answers rather than a stored passphrase.
	SshAskpassPromptSecurityKey
	// SshAskpassPromptOther covers keyboard-interactive challenges such as
	// one-time codes, plus anything unrecognised.
	SshAskpassPromptOther
)

// Why: Pebble sets SSH_ASKPASS_REQUIRE=force so an unattended probe can answer a
// key passphrase, but that setting routes *every* prompt to the same helper.
// Handing the cached passphrase to a PIN prompt sends the wrong secret to a
// different authenticator, which is how a hardware-key target fails with a
// passphrase error instead of asking the user to touch the key.
//
// "Enter PIN for ED25519-SK key ..." is the FIDO2 PIN, but "Enter passphrase for
// ED25519-SK key ..." decrypts the local key file and the cached credential is
// the right answer — so these match on the PIN and presence wording, never on
// the key type.
var sshSecurityKeyPromptMarkers = []string{
	"enter pin for",
	"confirm user presence",
	"user presence for",
}

// ClassifySshAskpassPrompt decides whether a cached credential may answer the
// prompt. Unrecognised prompts classify as SshAskpassPromptOther so the helper
// fails closed: releasing a secret to an unknown question is worse than a
// connection failure the user can see.
func ClassifySshAskpassPrompt(prompt string) SshAskpassPromptKind {
	normalized := strings.ToLower(strings.TrimSpace(prompt))
	if normalized == "" {
		return SshAskpassPromptOther
	}
	for _, marker := range sshSecurityKeyPromptMarkers {
		if strings.Contains(normalized, marker) {
			return SshAskpassPromptSecurityKey
		}
	}
	if strings.Contains(normalized, "passphrase") {
		return SshAskpassPromptSecret
	}
	// Why: OpenSSH's account prompt is "<user>@<host>'s password: " and PAM
	// keyboard-interactive commonly sends a bare "Password:". Prompts that merely
	// contain the word — "One-time password:", "Verification code:" — are
	// challenges a stored credential must not answer.
	if strings.Contains(normalized, "'s password") || strings.HasPrefix(normalized, "password") {
		return SshAskpassPromptSecret
	}
	return SshAskpassPromptOther
}
