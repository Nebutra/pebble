// Why: OMP 15.x discovers built-in user extensions from ~/.omp/agent, but a
// typed `omp` in an existing terminal still needs Pebble's status extension
// passed explicitly. Do not redirect PI_CODING_AGENT_DIR here: that variable
// is OMP's mutable home, so config/auth/session commands must keep the user's
// normal source of truth.

const OMP_SUBCOMMANDS = [
  '__complete',
  'acp',
  'agents',
  'auth-broker',
  'auth-gateway',
  'bench',
  'commit',
  'completions',
  'config',
  'dry-balance',
  'gallery',
  'grep',
  'grievances',
  'install',
  'join',
  'models',
  'plugin',
  'read',
  'say',
  'search',
  'setup',
  'shell',
  'ssh',
  'stats',
  'tiny-models',
  'token',
  'ttsr',
  'update',
  'usage',
  'worktree',
  'q',
  'wt'
] as const

export function getPosixOmpShellWrapper(): string {
  const subcommands = OMP_SUBCOMMANDS.join('|')
  return `# Why: OMP does not auto-load Pebble's managed status extension; wrap only
# interactive launch invocations so subcommands such as \`omp config\` keep
# their normal argv shape.
__pebble_omp_should_skip_extension() {
  case "\${1:-}" in
    help|--help|-h|--version|-v) return 0 ;;
    ${subcommands}) return 0 ;;
  esac
  return 1
}
__pebble_omp() {
  local __pebble_use_extension=1
  local __pebble_status_extension="\${PEBBLE_OMP_STATUS_EXTENSION:-}"
  __pebble_omp_should_skip_extension "\${1:-}" && __pebble_use_extension=0
  if [[ $__pebble_use_extension -eq 1 && -n "$__pebble_status_extension" && -f "$__pebble_status_extension" ]]; then
    if [[ "\${1:-}" == "launch" ]]; then
      shift
      command omp launch --extension "$__pebble_status_extension" "$@"
    else
      command omp --extension "$__pebble_status_extension" "$@"
    fi
  else
    command omp "$@"
  fi
}
if [[ -n "\${PEBBLE_OMP_STATUS_EXTENSION:-}" ]]; then
  omp() { __pebble_omp "$@"; }
fi
`
}

export function getPowerShellOmpShellWrapper(): string {
  const subcommands = OMP_SUBCOMMANDS.map((value) => `'${value}'`).join(', ')
  return `# Why: OMP does not auto-load Pebble's managed status extension; wrap only
# interactive launch invocations so subcommands such as \`omp config\` keep
# their normal argv shape.
function Global:__PebbleOmpShouldSkipExtension {
    param([string]$Name)
    $skip = @("help", "--help", "-h", "--version", "-v") + @(${subcommands})
    return $skip -contains $Name
}
if ($env:PEBBLE_OMP_STATUS_EXTENSION) {
    function Global:omp {
        $PebbleUseExtension = -not (__PebbleOmpShouldSkipExtension -Name ([string]($args[0])))
        $PebbleStatusExtension = $env:PEBBLE_OMP_STATUS_EXTENSION
        $PebbleStatus = 0
        $PebbleCommand = Get-Command omp -CommandType Application,ExternalScript -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $PebbleCommand) {
            Write-Error "omp executable not found"
            $PebbleStatus = 127
        } elseif ($PebbleUseExtension -and $PebbleStatusExtension -and
            (Test-Path -LiteralPath $PebbleStatusExtension)) {
            if ($args.Count -gt 0 -and $args[0] -eq "launch") {
                $PebbleLaunchArgs = @($args | Select-Object -Skip 1)
                & $PebbleCommand.Source launch --extension $PebbleStatusExtension @PebbleLaunchArgs
            } else {
                & $PebbleCommand.Source --extension $PebbleStatusExtension @args
            }
            $PebbleStatus = $LASTEXITCODE
        } else {
            & $PebbleCommand.Source @args
            $PebbleStatus = $LASTEXITCODE
        }

        $global:LASTEXITCODE = $PebbleStatus
    }
}
`
}
