package runtimecore

// sshIdentityArgs is the single identity/agent argument set behind every system
// ssh exec. The interactive and non-interactive builders had diverged: the
// non-interactive one forced IdentitiesOnly=yes and dropped IdentityAgent, so a
// key held by an agent — which is how a FIDO2 resident key is usually offered —
// was never presented and the target failed as if the credential were wrong.
func sshIdentityArgs(target SshTarget) []string {
	var args []string
	if target.IdentityFile != "" {
		args = append(args, "-i", target.IdentityFile)
		// A nil IdentitiesOnly keeps the historical default of restricting the
		// exec to the configured key rather than every key the agent holds.
		if target.IdentitiesOnly == nil || *target.IdentitiesOnly {
			args = append(args, "-o", "IdentitiesOnly=yes")
		}
	}
	if target.IdentityAgent != "" {
		args = append(args, "-o", "IdentityAgent="+target.IdentityAgent)
	}
	return args
}
