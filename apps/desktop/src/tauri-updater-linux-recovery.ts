/** Mirrors the `app_linux_update_recovery` Tauri command payload. */
export type LinuxUpdateRecovery = {
  installKind: string
  escalator: string | null
  packageManager: string | null
  installCommand: string | null
  reason: string | null
}

/**
 * Why: Pebble ships a .deb and deliberately never escalates privileges to
 * replace it, so a refusal is the only correct Linux outcome. Making it
 * actionable means naming the exact command instead of leaving the user to
 * guess — Pebble still never runs it.
 */
export function describeLinuxUpdateRefusal(
  recovery: LinuxUpdateRecovery | null,
  releaseUrl: string
): string {
  const preamble = `Pebble is installed as a system package, so it cannot replace itself. Download this release from ${releaseUrl}`

  if (recovery?.installCommand) {
    return `${preamble}, then install it with:\n\n${recovery.installCommand}\n\nReplace <package> with the path to the file you downloaded, keeping the quotes.`
  }

  return `${preamble} and install it with ${missingToolDescription(recovery?.reason ?? null)}.`
}

function missingToolDescription(reason: string | null): string {
  switch (reason) {
    case 'no-escalator':
      // Why: naming a package-manager command without sudo/pkexec would hand the
      // user a line that always fails with a permission error.
      return 'your package manager (Pebble found no sudo or pkexec in the system directories it trusts, so it cannot name the exact command)'
    case 'no-package-manager':
      return 'your package manager (Pebble found no supported package manager in the system directories it trusts)'
    default:
      return 'your package manager'
  }
}
