import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'
import { isEphemeralSetupTerminalWorktreeId } from '../../../packages/product-core/shared/ephemeral-setup-terminal-worktree-id'
import type { Worktree } from '../../../packages/product-core/shared/types'
import {
  hasSelectedTauriClaudeHostAccount,
  readSelectedTauriClaudeWslAuth,
  readSelectedTauriCodexHome,
  readSelectedTauriCodexWslHome
} from './tauri-accounts-api'
import { recordRuntimeAgentSessionSpawn } from './tauri-agent-status-api'
import {
  ensureRuntimePtyEventDelivery,
  reportRuntimePtyUnavailable
} from './tauri-runtime-pty-events'
import {
  findRuntimeSession,
  requestRuntimePtyJson,
  type RuntimeOutputChunk,
  type RuntimeSession
} from './tauri-runtime-pty-resource'

type PtySpawnOptions = Parameters<PreloadApi['pty']['spawn']>[0]
type PtySpawnResult = Awaited<ReturnType<PreloadApi['pty']['spawn']>>
type RememberPtySize = (id: string, cols: number, rows: number) => unknown

const activeRuntimePtyIds = new Set<string>()
const RUNTIME_SPAWN_READY_TIMEOUT_MS = 20_000
const RUNTIME_SPAWN_RETRY_MS = 200
const RUNTIME_INITIAL_REPLAY_TIMEOUT_MS = 2_000
const RUNTIME_INITIAL_REPLAY_POLL_MS = 50
const RUNTIME_INITIAL_REPLAY_SETTLE_MS = 200
const RUNTIME_PTY_HEALTH_POLL_MS = 1_500

export function hasActiveRuntimePty(id: string): boolean {
  return activeRuntimePtyIds.has(id)
}

export function forgetActiveRuntimePty(id: string): void {
  activeRuntimePtyIds.delete(id)
}

export async function spawnRuntimePty(
  opts: PtySpawnOptions,
  rememberPtySize: RememberPtySize
): Promise<PtySpawnResult> {
  const body = await createRuntimePtySpawnRequest(opts)
  // Why: subscribe before spawning so a fast login shell cannot emit its
  // prompt between session creation and event-stream registration.
  ensureRuntimePtyEventDelivery()
  const session = await spawnRuntimeSessionWhenReady(body)
  activeRuntimePtyIds.add(session.id)
  void monitorRuntimePty(session.id)
  rememberPtySize(session.id, opts.cols, opts.rows)
  recordRuntimeAgentSessionSpawn({ session, spawnOptions: opts })
  const replay = await readRuntimePtyReplay(session.id)
  return {
    id: session.id,
    ...(replay && { replay }),
    ...(opts.launchConfig && { launchConfig: opts.launchConfig })
  }
}

async function createRuntimePtySpawnRequest(opts: PtySpawnOptions): Promise<unknown> {
  const ephemeral = isEphemeralSetupTerminalWorktreeId(opts.worktreeId ?? '')
  const projectId = ephemeral ? '' : await resolveRuntimeProjectId(opts)
  const command = resolveRuntimeCommand(opts)
  return {
    projectId,
    worktreeId: ephemeral ? undefined : opts.worktreeId,
    ephemeral,
    cwd: opts.cwd,
    command,
    environment: getRuntimeSessionEnvironment(opts, command),
    agentKind: opts.launchAgent,
    launchToken: opts.launchToken,
    tabId: opts.tabId,
    leafId: opts.leafId,
    cols: opts.cols,
    rows: opts.rows
  }
}

function getManagedAccountEnvironment(
  launchAgent: string | undefined,
  command: string[] | undefined
): string[] | undefined {
  const executable = command?.[0]
    ?.split(/[\\/]/)
    .pop()
    ?.toLowerCase()
    .replace(/\.(cmd|bat|exe)$/, '')
  if (launchAgent !== 'codex' && executable !== 'codex') {
    return undefined
  }
  const managedHome = readSelectedTauriCodexHome()
  return managedHome ? [`CODEX_HOME=${managedHome}`] : undefined
}

function getRuntimeSessionEnvironment(
  opts: PtySpawnOptions,
  command: string[] | undefined
): string[] | undefined {
  const projectRuntime = opts.projectRuntime
  if (projectRuntime?.status === 'resolved' && projectRuntime.runtime.kind === 'wsl') {
    // WSL-specific values are exported in the inner bash script; putting Linux
    // paths in the Windows host environment would leak them to unrelated tools.
    return undefined
  }
  const values = { ...opts.env, ...opts.launchConfig?.agentEnv }
  if (opts.launchAgent === 'claude' && hasSelectedTauriClaudeHostAccount()) {
    // Managed Claude auth lives in the shared CLI credential store; explicit
    // auth env would silently override the account selected in Settings.
    delete values.ANTHROPIC_API_KEY
    delete values.ANTHROPIC_AUTH_TOKEN
    delete values.CLAUDE_CODE_OAUTH_TOKEN
  }
  for (const entry of getManagedAccountEnvironment(opts.launchAgent, command) ?? []) {
    const separator = entry.indexOf('=')
    if (separator > 0) {
      values[entry.slice(0, separator)] = entry.slice(separator + 1)
    }
  }
  const environment = Object.entries(values).map(([key, value]) => `${key}=${value}`)
  return environment.length > 0 ? environment : undefined
}

async function monitorRuntimePty(id: string): Promise<void> {
  while (activeRuntimePtyIds.has(id)) {
    await delay(RUNTIME_PTY_HEALTH_POLL_MS)
    if (!activeRuntimePtyIds.has(id)) {
      return
    }
    const session = await findRuntimeSession(id).catch(() => undefined)
    if (session === undefined) {
      continue
    }
    if (!session || isTerminalSessionFinished(session.status)) {
      // Why: native event delivery can disconnect while the PTY exits. Reconcile
      // against runtime truth so the renderer never keeps an inert xterm surface.
      reportRuntimePtyUnavailable(id, session?.status ?? 'stopped')
      return
    }
  }
}

function isTerminalSessionFinished(status: string): boolean {
  return status === 'exited' || status === 'failed' || status === 'stopped'
}

async function spawnRuntimeSessionWhenReady(body: unknown): Promise<RuntimeSession> {
  const deadline = Date.now() + RUNTIME_SPAWN_READY_TIMEOUT_MS
  let lastError: unknown = null
  do {
    try {
      return await requestRuntimePtyJson<RuntimeSession>('POST', '/v1/sessions', body, 5000)
    } catch (error) {
      lastError = error
      if (!isRetryableRuntimeStartupError(error) || Date.now() >= deadline) {
        throw error
      }
      await delay(RUNTIME_SPAWN_RETRY_MS)
    }
  } while (Date.now() < deadline)
  throw lastError instanceof Error ? lastError : new Error('Terminal runtime did not become ready.')
}

function isRetryableRuntimeStartupError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
  return (
    message.includes('disconnected') ||
    message.includes('starting') ||
    message.includes('connection refused') ||
    message.includes('runtime transport failed')
  )
}

async function readRuntimePtyReplay(id: string): Promise<string> {
  // Why: zsh can paint a transient pre-prompt clear sequence, then paint the
  // real prompt about 100ms later. Returning the first bytes opens a gap before
  // live listeners attach and leaves xterm with only the cleared screen.
  const deadline = Date.now() + RUNTIME_INITIAL_REPLAY_TIMEOUT_MS
  let replay = ''
  let lastChangedAt: number | null = null
  do {
    await delay(RUNTIME_INITIAL_REPLAY_POLL_MS)
    const tail = await requestRuntimePtyJson<{ chunks: RuntimeOutputChunk[] }>(
      'GET',
      `/v1/sessions/${encodeURIComponent(id)}/tail?limit=200`,
      undefined,
      5000
    ).catch(() => null)
    const nextReplay = tail?.chunks.map((chunk) => chunk.content).join('')
    if (nextReplay !== undefined && nextReplay !== replay) {
      replay = nextReplay
      lastChangedAt = Date.now()
    }
    if (
      replay &&
      lastChangedAt !== null &&
      Date.now() - lastChangedAt >= RUNTIME_INITIAL_REPLAY_SETTLE_MS
    ) {
      return replay
    }
  } while (Date.now() < deadline)
  return replay
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms))
}

async function resolveRuntimeProjectId(opts: PtySpawnOptions): Promise<string> {
  if (!opts.worktreeId) {
    throw new Error('Tauri runtime terminals require a workspace-backed terminal.')
  }
  const worktrees = await window.api.worktrees.listAll()
  const worktree = worktrees.find((entry: Worktree) => entry.id === opts.worktreeId)
  const projectId = worktree?.projectId ?? worktree?.repoId
  if (!projectId) {
    throw new Error(`Unable to resolve project for workspace terminal ${opts.worktreeId}.`)
  }
  return projectId
}

function resolveRuntimeCommand(opts: PtySpawnOptions): string[] | undefined {
  const command = opts.command?.trim()
  const projectRuntime = opts.projectRuntime
  if (projectRuntime?.status === 'repair-required') {
    throw new Error(
      `Project runtime requires repair before terminal spawn: ${projectRuntime.repair.reason}`
    )
  }
  if (projectRuntime?.status === 'resolved' && projectRuntime.runtime.kind === 'wsl') {
    return buildWslInnerCommand(opts, projectRuntime.runtime.distro, command)
  }
  if (!command) {
    return undefined
  }
  const shell = opts.shellOverride?.trim() || defaultRuntimeShell()
  return isWindowsHost() ? [shell, '/d', '/s', '/c', command] : [shell, '-lc', command]
}

function buildWslInnerCommand(
  opts: PtySpawnOptions,
  distro: string,
  command: string | undefined
): string[] {
  const lines: string[] = ['set -e']
  const environment = { ...opts.env, ...opts.launchConfig?.agentEnv }
  if (opts.launchAgent === 'claude' || /^\s*claude(?:\s|$)/i.test(command ?? '')) {
    const managedAuth = readSelectedTauriClaudeWslAuth(distro)
    if (managedAuth) {
      environment.CLAUDE_CONFIG_DIR = managedAuth
      delete environment.ANTHROPIC_API_KEY
      delete environment.ANTHROPIC_AUTH_TOKEN
      delete environment.CLAUDE_CODE_OAUTH_TOKEN
    }
  }
  if (opts.launchAgent === 'codex' || /^\s*codex(?:\s|$)/i.test(command ?? '')) {
    const managedHome = readSelectedTauriCodexWslHome(distro)
    if (managedHome) {
      environment.CODEX_HOME = managedHome
    }
  }
  for (const [key, value] of Object.entries(environment)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      lines.push(`export ${key}=${shellQuote(value)}`)
    }
  }
  lines.push(command ? `exec ${command}` : 'exec "${SHELL:-bash}" -l')
  // Go owns the selected distro and wslpath-derived cwd; the renderer only
  // supplies the Linux-side command/account environment.
  return ['/bin/bash', '-lc', lines.join('\n')]
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function defaultRuntimeShell(): string {
  return isWindowsHost() ? 'cmd.exe' : '/bin/sh'
}

function isWindowsHost(): boolean {
  return navigator.userAgent.toLowerCase().includes('windows')
}
