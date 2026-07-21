import { spawnSync } from 'node:child_process'

export function resolveMacosCodeSigningIdentity({
  environment = process.env,
  runSecurity = runSecurityFindIdentity
} = {}) {
  const explicit = environment.APPLE_SIGNING_IDENTITY?.trim()
  if (explicit) {
    return explicit
  }
  if (!environment.APPLE_CERTIFICATE?.trim()) {
    return null
  }
  const identities = parseCodeSigningIdentities(runSecurity())
  // Why: tauri-action imports APPLE_CERTIFICATE before beforeBuildCommand but
  // does not expose the imported certificate name to child build scripts.
  const identity =
    identities.find((candidate) => candidate.startsWith('Developer ID Application:')) ??
    identities[0]
  if (!identity) {
    throw new Error('APPLE_CERTIFICATE is configured but no code-signing identity is available')
  }
  return identity
}

export function parseCodeSigningIdentities(output) {
  return [...output.matchAll(/^\s*\d+\)\s+[0-9A-F]+\s+"([^"]+)"/gmu)].map((match) => match[1])
}

function runSecurityFindIdentity() {
  const result = spawnSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
    encoding: 'utf8'
  })
  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    throw new Error(`security find-identity exited with status ${result.status}`)
  }
  return result.stdout
}
