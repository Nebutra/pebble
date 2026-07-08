const MANAGED_MARKER = '# Pebble managed WSL CLI launcher'
const BRIDGE_MANAGED_MARKER = '# Pebble managed WSL CLI PowerShell bridge'

export function buildWslLauncher(
  windowsLauncherPath: string,
  bridgePath = '${XDG_DATA_HOME:-$HOME/.local/share}/pebble/pebble-wsl-bridge.ps1'
): string {
  const encodedTarget = Buffer.from(windowsLauncherPath, 'utf8').toString('base64')
  return `#!/usr/bin/env bash
set -euo pipefail
${MANAGED_MARKER}
# PEBBLE_WIN_LAUNCHER_B64=${encodedTarget}
PEBBLE_WIN_LAUNCHER=${quoteShell(windowsLauncherPath)}
PEBBLE_BRIDGE_PS1=${quoteShell(bridgePath)}
if command -v powershell.exe >/dev/null 2>&1; then
  PEBBLE_POWERSHELL=powershell.exe
elif [ -x /mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe ]; then
  PEBBLE_POWERSHELL=/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe
else
  echo "Pebble WSL CLI requires Windows interop and could not find powershell.exe." >&2
  exit 1
fi
PEBBLE_BRIDGE_PS1_WIN=$(wslpath -w "$PEBBLE_BRIDGE_PS1")
exec "$PEBBLE_POWERSHELL" -NoProfile -ExecutionPolicy Bypass -File "$PEBBLE_BRIDGE_PS1_WIN" "$PEBBLE_WIN_LAUNCHER" "$@"
`
}

export function buildWslBridgeScript(): string {
  return `${BRIDGE_MANAGED_MARKER}
param(
  [Parameter(Mandatory=$true)]
  [string]$PebbleLauncher,

  [Parameter(ValueFromRemainingArguments=$true)]
  [string[]]$ForwardArgs
)

try {
  & $PebbleLauncher @ForwardArgs
  if (-not $?) {
    exit 1
  }
  if ($null -eq $LASTEXITCODE) {
    exit 0
  }
  exit $LASTEXITCODE
} catch {
  Write-Error $_
  exit 1
}
`
}

export function getBridgePathFromCommandPath(commandPath: string): string {
  // Why: both the current Linux command and the legacy pre-rename command
  // share one WSL bridge under ~/.local/share/pebble.
  return `${commandPath.replace(/\/\.local\/bin\/(?:pebble|pebble-ide)$/, '/.local/share/pebble')}/pebble-wsl-bridge.ps1`
}

export function buildSafeReplaceGuard(path: string, managedMarker: string): string {
  const quotedPath = quoteShell(path)
  const quotedMarker = quoteShell(managedMarker)
  return [
    `if [ -L ${quotedPath} ]; then`,
    '  echo "__PEBBLE_CONFLICT__"',
    '  exit 23',
    `elif [ -e ${quotedPath} ] && { [ ! -f ${quotedPath} ] || ! grep -Fq ${quotedMarker} ${quotedPath}; }; then`,
    '  echo "__PEBBLE_CONFLICT__"',
    '  exit 23',
    'fi'
  ].join('\n')
}

export function buildSafeRemoveCommand(commandPath: string): string {
  const bridgePath = getBridgePathFromCommandPath(commandPath)
  return [
    'set -euo pipefail',
    buildSafeReplaceGuard(commandPath, MANAGED_MARKER),
    buildSafeReplaceGuard(bridgePath, BRIDGE_MANAGED_MARKER),
    `rm -f ${quoteShell(commandPath)} ${quoteShell(bridgePath)}`
  ].join('\n')
}

export function parseManagedLauncherTarget(content: string): string | null {
  const encoded = content.match(/^# PEBBLE_WIN_LAUNCHER_B64=([A-Za-z0-9+/=]+)$/m)?.[1]
  if (encoded) {
    try {
      return Buffer.from(encoded, 'base64').toString('utf8')
    } catch {
      return null
    }
  }

  const legacyTarget = content.match(/^PEBBLE_WIN_LAUNCHER='((?:[^']|'"'"')*)'$/m)?.[1]
  return legacyTarget ? legacyTarget.replaceAll(`'"'"'`, "'") : null
}

export function getPosixDirname(path: string): string {
  return path.slice(0, path.lastIndexOf('/')) || '/'
}

export function getWslLauncherMarker(): string {
  return MANAGED_MARKER
}

export function getWslBridgeMarker(): string {
  return BRIDGE_MANAGED_MARKER
}

export function quoteShell(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}
