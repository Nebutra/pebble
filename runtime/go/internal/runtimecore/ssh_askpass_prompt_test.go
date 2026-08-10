package runtimecore

import "testing"

// Why: the strings below are OpenSSH's own prompt wording, so a future OpenSSH
// rewording shows up here as a failing case rather than as a hardware-key target
// that silently receives the wrong secret.
func TestClassifySshAskpassPromptReleasesTheCredentialOnlyForKeyAndPasswordPrompts(t *testing.T) {
	for _, prompt := range []string{
		"Enter passphrase for key '/home/pebble/.ssh/id_ed25519': ",
		"Enter passphrase for /home/pebble/.ssh/id_rsa: ",
		"Enter passphrase for ED25519-SK key /home/pebble/.ssh/id_ed25519_sk: ",
		"pebble@build-host's password: ",
		"Password: ",
	} {
		if kind := ClassifySshAskpassPrompt(prompt); kind != SshAskpassPromptSecret {
			t.Errorf("prompt %q should accept the cached credential, got %v", prompt, kind)
		}
	}
}

func TestClassifySshAskpassPromptWithholdsTheCredentialFromSecurityKeyPrompts(t *testing.T) {
	for _, prompt := range []string{
		"Enter PIN for ED25519-SK key /home/pebble/.ssh/id_ed25519_sk: ",
		"Enter PIN for ECDSA-SK key /home/pebble/.ssh/id_ecdsa_sk: ",
		"Confirm user presence for key ED25519-SK SHA256:0Ck0dV4hV0kqz2Bv1zGZ8w",
	} {
		if kind := ClassifySshAskpassPrompt(prompt); kind != SshAskpassPromptSecurityKey {
			t.Errorf("prompt %q should be recognised as a security-key prompt, got %v", prompt, kind)
		}
	}
}

func TestClassifySshAskpassPromptFailsClosedOnChallengesAndUnknownPrompts(t *testing.T) {
	for _, prompt := range []string{
		"",
		"   ",
		"One-time password: ",
		"Verification code: ",
		"Duo two-factor login for pebble",
		"Are you sure you want to continue connecting (yes/no/[fingerprint])? ",
	} {
		if kind := ClassifySshAskpassPrompt(prompt); kind != SshAskpassPromptOther {
			t.Errorf("prompt %q should fail closed, got %v", prompt, kind)
		}
	}
}
