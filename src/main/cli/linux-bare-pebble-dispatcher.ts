import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { buildAppImageCliWrapper, quoteShell } from './appimage-cli-wrapper'
import { getBundledLauncherPath } from './cli-installer'

// Why: marks a dispatcher this function wrote so repeat serve starts overwrite
// our own file idempotently but never clobber a user's own ~/.local/bin/pebble.
const DISPATCHER_MARKER = '# pebble-serve-bare-pebble-dispatcher'

export type LinuxBarePebbleDispatcherOptions = {
  /** Packaged app resources root; the bundled `pebble-ide` launcher lives under it. */
  resourcesPath: string
  /** Test seam — defaults to the real home directory. */
  homePath?: string
  /** Test seam — defaults to $APPIMAGE (set only when running from an AppImage). */
  appImagePath?: string | null
}

export type LinuxBarePebbleDispatcherState =
  | 'installed'
  | 'skipped-foreign'
  | 'skipped-launcher-missing'

export type LinuxBarePebbleDispatcherResult = {
  state: LinuxBarePebbleDispatcherState
  dispatcherPath: string
  /** What the dispatcher execs: the stable AppImage, or the bundled pebble-ide. */
  target: string | null
}

// Why: on Linux the CLI installs as `pebble-ide`, not bare `pebble`, to avoid
// shadowing GNOME Pebble's /usr/bin/pebble. But the Claude Team launcher typed into
// the initial managed terminal invokes the literal `pebble claude-teams`, so a
// headless serve box needs a bare-`pebble` dispatcher on the managed-terminal PATH
// (~/.local/bin, which patchPackagedProcessPath puts ahead of /usr/bin). It is a
// plain file, not a managed symlink, so CliInstaller.removeLegacyLinuxCommandIfManaged
// never reclaims it.
export async function installLinuxBarePebbleDispatcher(
  options: LinuxBarePebbleDispatcherOptions
): Promise<LinuxBarePebbleDispatcherResult> {
  const dispatcherPath = join(options.homePath ?? homedir(), '.local', 'bin', 'pebble')
  const appImagePath = options.appImagePath ?? process.env.APPIMAGE ?? null

  const resolved = resolveDispatcherScript(options.resourcesPath, appImagePath)
  if (!resolved) {
    return { state: 'skipped-launcher-missing', dispatcherPath, target: null }
  }

  // Why: only (re)write a dispatcher we previously created; leave a user's own
  // `pebble` untouched rather than silently clobbering it on every serve start.
  if (existsSync(dispatcherPath) && !(await isOwnedDispatcher(dispatcherPath))) {
    return { state: 'skipped-foreign', dispatcherPath, target: resolved.target }
  }

  await mkdir(dirname(dispatcherPath), { recursive: true })
  await writeFile(dispatcherPath, resolved.script, 'utf8')
  await chmod(dispatcherPath, 0o755)
  return { state: 'installed', dispatcherPath, target: resolved.target }
}

function resolveDispatcherScript(
  resourcesPath: string,
  appImagePath: string | null
): { script: string; target: string } | null {
  if (appImagePath) {
    // Why: an AppImage mounts resources under an ephemeral FUSE path per launch,
    // so the dispatcher must exec the stable outer AppImage — reuse the same
    // wrapper CliInstaller installs for the AppImage command.
    return { script: withMarker(buildAppImageCliWrapper(appImagePath)), target: appImagePath }
  }

  const launcher = getBundledLauncherPath('linux', resourcesPath)
  // Why: getBundledLauncherPath only joins the path; guard existence so we never
  // write a dispatcher pointing at a missing launcher (which would fail at exec
  // time with a confusing error instead of the command-not-found we fix).
  if (!launcher || !existsSync(launcher)) {
    return null
  }
  return {
    script: `#!/usr/bin/env bash\n${DISPATCHER_MARKER}\nexec ${quoteShell(launcher)} "$@"\n`,
    target: launcher
  }
}

function withMarker(script: string): string {
  const firstNewline = script.indexOf('\n')
  if (firstNewline === -1) {
    return `${script}\n${DISPATCHER_MARKER}\n`
  }
  // Keep the shebang on line 1; insert the marker immediately after it.
  return `${script.slice(0, firstNewline + 1)}${DISPATCHER_MARKER}\n${script.slice(firstNewline + 1)}`
}

async function isOwnedDispatcher(dispatcherPath: string): Promise<boolean> {
  try {
    return (await readFile(dispatcherPath, 'utf8')).includes(DISPATCHER_MARKER)
  } catch {
    return false
  }
}
