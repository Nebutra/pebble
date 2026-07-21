export function quotePosixShell(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

export function escapeWslShCommandForWindows(command: string): string {
  // WSL preprocesses unescaped $ in Windows argv before the WSL-side shell
  // sees it, even when the POSIX script text would single-quote the dollar.
  let escaped = ''
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]
    if (char === '$' && command[index - 1] !== '\\') {
      escaped += '\\$'
      continue
    }
    escaped += char
  }
  return escaped
}

export function buildWslLoginShellCommand(command: string): string {
  const quotedCommand = quotePosixShell(command)
  return [
    '_pebble_wsl_shell=$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f7)',
    'if [ -z "$_pebble_wsl_shell" ] || [ ! -x "$_pebble_wsl_shell" ]; then',
    '  _pebble_wsl_shell="${SHELL:-/bin/bash}"',
    'fi',
    'if [ -z "$_pebble_wsl_shell" ] || [ ! -x "$_pebble_wsl_shell" ]; then',
    '  _pebble_wsl_shell=/bin/sh',
    'fi',
    '_pebble_wsl_shell_name=$(basename "$_pebble_wsl_shell" | tr "[:upper:]" "[:lower:]")',
    'case "$_pebble_wsl_shell_name" in',
    `  sh|dash) exec "$_pebble_wsl_shell" -lc ${quotedCommand} ;;`,
    `  bash|zsh|ksh|mksh|ash) exec "$_pebble_wsl_shell" -ilc ${quotedCommand} ;;`,
    `  *) exec /bin/sh -lc ${quotedCommand} ;;`,
    'esac'
  ].join('\n')
}

export function buildWslInteractiveLoginShellCommand(): string {
  return [
    '_pebble_wsl_shell=$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f7)',
    'if [ -z "$_pebble_wsl_shell" ] || [ ! -x "$_pebble_wsl_shell" ]; then',
    '  _pebble_wsl_shell="${SHELL:-/bin/bash}"',
    'fi',
    'if [ -z "$_pebble_wsl_shell" ] || [ ! -x "$_pebble_wsl_shell" ]; then',
    '  _pebble_wsl_shell=/bin/sh',
    'fi',
    'exec "$_pebble_wsl_shell" -l'
  ].join('\n')
}
