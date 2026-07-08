const WSLENV_ENTRY_SEPARATOR = ':'

function parseWslenvEntries(value: string | undefined): string[] {
  return value ? value.split(WSLENV_ENTRY_SEPARATOR).filter(Boolean) : []
}

function upsertWslenvEntry(entries: string[], entry: string): void {
  const variableName = entry.split('/')[0]
  const existingIndex = entries.findIndex((value) => value.split('/')[0] === variableName)
  if (existingIndex === -1) {
    entries.push(entry)
    return
  }
  entries[existingIndex] = entry
}

export function addPebbleWslInteropEnv(env: Record<string, string>): void {
  const entries = parseWslenvEntries(env.WSLENV)
  // Why: wsl.exe only imports selected Windows env vars. Agent status in WSL
  // needs both the pane identity and the hook/OMP coordinates at process start.
  const passthroughEntries = [
    'PEBBLE_TERMINAL_HANDLE/u',
    'PEBBLE_PANE_KEY/u',
    'PEBBLE_TAB_ID/u',
    'PEBBLE_WORKTREE_ID/u',
    'PEBBLE_AGENT_LAUNCH_TOKEN/u',
    'PEBBLE_AGENT_HOOK_PORT/u',
    'PEBBLE_AGENT_HOOK_TOKEN/u',
    'PEBBLE_AGENT_HOOK_ENV/u',
    'PEBBLE_AGENT_HOOK_VERSION/u',
    'PEBBLE_AGENT_HOOK_ENDPOINT/p',
    'PEBBLE_OMP_SOURCE_AGENT_DIR/p',
    'PEBBLE_OMP_STATUS_EXTENSION/p',
  ]
  for (const entry of passthroughEntries) {
    const variableName = entry.split('/')[0]
    if (env[variableName]) {
      upsertWslenvEntry(entries, entry)
    }
  }
  env.WSLENV = entries.join(WSLENV_ENTRY_SEPARATOR)
}
