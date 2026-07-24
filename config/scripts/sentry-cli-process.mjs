import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'

const require = createRequire(import.meta.url)

export function runSentryCli(args, { cwd }) {
  const packageName = sentryCliPlatformPackage()
  const packagePath = require.resolve(`${packageName}/package.json`)
  const executable = resolve(
    dirname(packagePath),
    process.platform === 'win32' ? 'bin/sentry-cli.exe' : 'bin/sentry-cli'
  )
  const result = spawnSync(executable, args, {
    cwd,
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  if (result.status !== 0) {
    const rawOutput = [result.stdout, result.stderr].filter(Boolean).join('\n')
    const output = redactSentryCliOutput(rawOutput, process.env).trim()
    throw new Error(`sentry-cli failed${output ? `:\n${output}` : ''}`)
  }
}

export function redactSentryCliOutput(output, env) {
  return ['SENTRY_AUTH_TOKEN', 'PEBBLE_SENTRY_DSN', 'PEBBLE_POSTHOG_WRITE_KEY'].reduce(
    (redacted, name) => {
      const value = env[name]?.trim()
      return value ? redacted.replaceAll(value, '<redacted>') : redacted
    },
    output
  )
}

function sentryCliPlatformPackage() {
  if (process.platform === 'darwin') {
    return '@sentry/cli-darwin'
  }
  if (process.platform === 'linux') {
    return process.arch === 'arm64' ? '@sentry/cli-linux-arm64' : '@sentry/cli-linux-x64'
  }
  if (process.platform === 'win32') {
    return process.arch === 'arm64' ? '@sentry/cli-win32-arm64' : '@sentry/cli-win32-x64'
  }
  throw new Error(`Sentry CLI is unsupported on ${process.platform}/${process.arch}.`)
}
