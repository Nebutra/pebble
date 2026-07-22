import { spawn as spawnProcess, type SpawnOptions } from 'node:child_process'
import { resolve } from 'node:path'
import { RuntimeClientError } from './types'

export function launchPebbleApp(): void {
  const overrideCommand = process.env.PEBBLE_OPEN_COMMAND
  if (typeof overrideCommand === 'string' && overrideCommand.trim().length > 0) {
    spawnDetached(overrideCommand, [], { shell: true })
    return
  }

  const overrideExecutable = process.env.PEBBLE_APP_EXECUTABLE
  if (typeof overrideExecutable === 'string' && overrideExecutable.trim().length > 0) {
    spawnDetached(overrideExecutable, [], {
      ...getExecutableSpawnOptions(overrideExecutable),
      env: process.env
    })
    return
  }

  throw new RuntimeClientError(
    'runtime_open_failed',
    'Could not determine how to launch Pebble. Start Pebble manually and try again.'
  )
}

function spawnDetached(command: string, args: string[], options: SpawnOptions): void {
  const child = spawnProcess(command, args, {
    detached: true,
    stdio: 'ignore',
    ...options
  })
  // Why: detached launch errors are reported asynchronously after this function
  // returns; openPebble already reports the user-facing timeout if startup fails.
  child.once('error', () => {})
  child.unref()
}

export function servePebbleApp(
  args: {
    json?: boolean
    port?: string | null
    pairingAddress?: string | null
    noPairing?: boolean
    mobilePairing?: boolean
    recipeJson?: boolean
    projectRoot?: string | null
  } = {}
): Promise<number> {
  const executable = resolveForegroundPebbleExecutable()
  const childArgs = ['--serve']
  if (args.json) {
    childArgs.push('--serve-json')
  }
  if (args.port) {
    childArgs.push('--serve-port', args.port)
  }
  if (args.pairingAddress) {
    childArgs.push('--serve-pairing-address', args.pairingAddress)
  }
  if (args.noPairing) {
    childArgs.push('--serve-no-pairing')
  }
  if (args.mobilePairing) {
    childArgs.push('--serve-mobile-pairing')
  }
  if (args.recipeJson) {
    if (!args.projectRoot) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Recipe JSON output requires --project-root.'
      )
    }
    childArgs.push('--serve-recipe-json', '--serve-project-root', args.projectRoot)
  }

  const child = spawnProcess(executable, childArgs, {
    detached: args.recipeJson === true,
    cwd: resolveAppRoot(),
    stdio: args.recipeJson === true ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    ...getExecutableSpawnOptions(executable),
    env: process.env
  })

  if (args.recipeJson) {
    return waitForRecipeJson(child)
  }

  return new Promise((resolve, reject) => {
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null
    const forwardSignal = (signal: NodeJS.Signals): void => {
      child.kill(signal)
      forceKillTimer ??= setTimeout(() => {
        child.kill('SIGKILL')
      }, 5000)
    }
    const cleanup = (): void => {
      process.off('SIGINT', forwardSignal)
      process.off('SIGTERM', forwardSignal)
      if (forceKillTimer) {
        clearTimeout(forceKillTimer)
        forceKillTimer = null
      }
    }
    process.on('SIGINT', forwardSignal)
    process.on('SIGTERM', forwardSignal)
    child.once('error', (error) => {
      cleanup()
      reject(error)
    })
    child.once('exit', (code, signal) => {
      cleanup()
      if (typeof code === 'number') {
        resolve(code)
        return
      }
      reject(new RuntimeClientError('runtime_serve_failed', `Pebble serve exited via ${signal}`))
    })
  })
}

function waitForRecipeJson(child: ReturnType<typeof spawnProcess>): Promise<number> {
  return new Promise((resolve, reject) => {
    let output = ''
    let settled = false
    const timeout = setTimeout(() => {
      finish(new RuntimeClientError('runtime_serve_failed', 'Timed out waiting for recipe JSON.'))
      child.kill('SIGTERM')
    }, 60000)
    const finish = (error?: Error): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      child.stdout?.off('data', onData)
      child.off('error', onError)
      child.off('exit', onExit)
      if (error) {
        reject(error)
        return
      }
      child.stdout?.destroy?.()
      child.unref()
      resolve(0)
    }
    const emitLine = (line: string): void => {
      process.stdout.write(`${line}\n`)
      finish()
    }
    const onData = (chunk: Buffer | string): void => {
      output += chunk.toString()
      const newlineIndex = output.indexOf('\n')
      if (newlineIndex === -1) {
        return
      }
      emitLine(output.slice(0, newlineIndex))
    }
    const onError = (error: Error): void => {
      finish(error)
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) {
        return
      }
      const trimmed = output.trim()
      if (trimmed) {
        emitLine(trimmed)
        return
      }
      finish(
        new RuntimeClientError(
          'runtime_serve_failed',
          typeof code === 'number'
            ? `Pebble serve exited before printing recipe JSON with code ${code}.`
            : `Pebble serve exited before printing recipe JSON via ${signal}.`
        )
      )
    }
    child.stdout?.on('data', onData)
    child.once('error', onError)
    child.once('exit', onExit)
  })
}

function getExecutableSpawnOptions(executable: string): Pick<SpawnOptions, 'shell'> {
  return process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(executable) ? { shell: true } : {}
}

function resolveAppRoot(): string {
  // Why: development desktop commands resolve source-owned sidecars relative
  // to the repository; pinning cwd keeps `pebble serve` independent of the shell.
  return resolve(__dirname, '../../..')
}

function resolveForegroundPebbleExecutable(): string {
  const overrideExecutable = process.env.PEBBLE_APP_EXECUTABLE
  if (typeof overrideExecutable === 'string' && overrideExecutable.trim().length > 0) {
    return overrideExecutable
  }
  throw new RuntimeClientError(
    'runtime_serve_failed',
    'Could not determine how to start Pebble server. Set PEBBLE_APP_EXECUTABLE to the Pebble executable.'
  )
}
