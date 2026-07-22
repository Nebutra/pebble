import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')
const goRoot = resolve(root, 'runtime/go')
const goCache = resolve(tmpdir(), 'pebble-go-build-cache')
mkdirSync(goCache, { recursive: true })

export function runSshNativeGate({ profile, spawn = spawnSync } = {}) {
  const pattern =
    profile === 'terminal-artifacts'
      ? 'SSH|Ssh|TerminalArtifact|Codex'
      : 'SSH|Ssh|Relay|Remote|PortForward'
  const commands = [
    [process.execPath, ['config/scripts/build-relay.mjs'], root],
    [
      'go',
      [
        'test',
        './internal/runtimecore',
        './internal/runtimehttp',
        './cmd/pebble-relay-worker',
        '-run',
        pattern,
        '-count=1'
      ],
      goRoot
    ]
  ]
  for (const [executable, args, cwd] of commands) {
    const result = spawn(executable, args, {
      cwd,
      stdio: 'inherit',
      env: { ...process.env, GOCACHE: process.env.GOCACHE ?? goCache }
    })
    if (result.error) {
      throw result.error
    }
    if (result.status !== 0) {
      return result.status ?? 1
    }
  }
  return 0
}
