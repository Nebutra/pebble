// Why: local PTYs and the daemon/SSH path must use identical ZDOTDIR discovery;
// small drift here breaks different terminal transports in different ways.

function quotePosixSingle(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function getZshEnvTemplate(zshDir: string, headerPrefix = ''): string {
  const header = headerPrefix
    ? `Pebble ${headerPrefix} zsh shell-ready wrapper`
    : 'Pebble zsh shell-ready wrapper'
  return `# ${header}
_pebble_spawn_orig_zdotdir="\${PEBBLE_ORIG_ZDOTDIR:-}"
_pebble_user_zdotdir="\${_pebble_spawn_orig_zdotdir:-$HOME}"
_pebble_zshenv_source_dir="\${PEBBLE_ZSHENV_SOURCE_DIR:-$HOME}"
_pebble_zshenv_path=""
unset PEBBLE_ZSHENV_SOURCE_DIR

# Normalize fallback and source roots before reading user .zshenv so nested
# Pebble PTYs never source another Pebble wrapper recursively.
while [[ "\${_pebble_user_zdotdir}" == */ ]]; do
  _pebble_user_zdotdir="\${_pebble_user_zdotdir%/}"
done
case "\${_pebble_user_zdotdir}" in
  ""|*/shell-ready/zsh) _pebble_user_zdotdir="$HOME" ;;
esac
while [[ "\${_pebble_zshenv_source_dir}" == */ ]]; do
  _pebble_zshenv_source_dir="\${_pebble_zshenv_source_dir%/}"
done
case "\${_pebble_zshenv_source_dir}" in
  ""|*/shell-ready/zsh) _pebble_zshenv_source_dir="$HOME" ;;
esac

# Why: source at wrapper top level, not in a function/subshell, so .zshenv
# exports, functions, path/fpath typesets, and zsh options keep normal scope.
unset ZDOTDIR
if [[ -n "\${_pebble_zshenv_source_dir:-}" && -f "\${_pebble_zshenv_source_dir}/.zshenv" ]]; then
  _pebble_zshenv_path="\${_pebble_zshenv_source_dir}/.zshenv"
fi
if [[ -n "\${_pebble_zshenv_path:-}" ]]; then
  source "\${_pebble_zshenv_path}"
fi

_pebble_discovered_zdotdir="\${ZDOTDIR:-}"

while [[ "\${_pebble_discovered_zdotdir}" == */ ]]; do
  _pebble_discovered_zdotdir="\${_pebble_discovered_zdotdir%/}"
done

case "\${_pebble_discovered_zdotdir}" in
  *[![:space:]]*) ;;
  *) _pebble_discovered_zdotdir="" ;;
esac

if [[ -n "\${_pebble_discovered_zdotdir}" && ! -d "\${_pebble_discovered_zdotdir}" ]]; then
  [[ "\${PEBBLE_DEBUG:-0}" == "1" ]] && echo "[pebble-shell-ready] Discovered ZDOTDIR '\${_pebble_discovered_zdotdir}' does not exist, falling back" >&2
  _pebble_discovered_zdotdir=""
fi

export PEBBLE_ORIG_ZDOTDIR="\${_pebble_discovered_zdotdir:-\${_pebble_user_zdotdir:-$HOME}}"

while [[ "\${PEBBLE_ORIG_ZDOTDIR}" == */ ]]; do
  PEBBLE_ORIG_ZDOTDIR="\${PEBBLE_ORIG_ZDOTDIR%/}"
done

case "\${PEBBLE_ORIG_ZDOTDIR}" in
  ""|*/shell-ready/zsh) export PEBBLE_ORIG_ZDOTDIR="$HOME" ;;
esac

export ZDOTDIR=${quotePosixSingle(zshDir)}
unset _pebble_spawn_orig_zdotdir _pebble_user_zdotdir _pebble_zshenv_source_dir _pebble_zshenv_path _pebble_discovered_zdotdir
`
}

export function getZshStartupFileSourceBlock(options: {
  fileName: '.zprofile' | '.zshrc' | '.zlogin'
  homeExpression?: string
  interactiveOnly?: boolean
  skipWhenHomeIsCurrentZdotdir?: boolean
}): string {
  const homeExpression = options.homeExpression ?? '"${PEBBLE_ORIG_ZDOTDIR:-$HOME}"'
  const checks = [
    options.skipWhenHomeIsCurrentZdotdir ? '"$_pebble_home" != "$ZDOTDIR"' : null,
    options.interactiveOnly ? '-o interactive' : null,
    `-f "$_pebble_home/${options.fileName}"`
  ].filter(Boolean)

  return `_pebble_home=${homeExpression}
case "\${_pebble_home%/}" in
  */shell-ready/zsh) _pebble_home="$HOME" ;;
esac
if [[ ${checks.join(' && ')} ]]; then
  _pebble_wrapper_zdotdir="$ZDOTDIR"
  # Why: user startup files resolve plugin/config paths from their own ZDOTDIR;
  # Pebble restores its wrapper dir afterward so zsh still loads wrapper files.
  export ZDOTDIR="$_pebble_home"
  source "$_pebble_home/${options.fileName}"
  export ZDOTDIR="$_pebble_wrapper_zdotdir"
  unset _pebble_wrapper_zdotdir
fi
`
}

// Why: zsh precmd fires before zle switches the PTY into line-editing mode,
// so the marker must be emitted from zle-line-init. Registering it through
// add-zle-hook-widget is unsafe: the azhw dispatcher aborts its hook chain
// when an earlier hook exits non-zero, and a pre-existing raw user widget
// (e.g. oh-my-zsh vi-mode without VI_MODE_SET_CURSOR) is preserved as the
// first hook and fails — silently suppressing the marker and stalling every
// startup command on the pre-ready timeout. Instead, own zle-line-init: emit
// the marker first, then chain to whatever widget was installed before.
export function getZshShellReadyMarkerRegistrationBlock(escapedMarker: string): string {
  return `if [[ "\${PEBBLE_SHELL_READY_MARKER:-0}" == "1" ]]; then
  # Why: capture the prior zle-line-init so the marker chains to it. On a
  # re-source we are already the bound widget, so keep the function captured
  # the first time instead of clobbering it to empty (which would silently
  # drop the user's widget on every prompt after the second source). Only
  # user-defined widgets are chainable as plain functions; builtin/completion
  # forms (rare for zle-line-init) are left unchained.
  if [[ "\${widgets[zle-line-init]:-}" == "user:__pebble_prompt_mark" ]]; then
    :
  elif (( \${+widgets[zle-line-init]} )) && [[ "\${widgets[zle-line-init]}" == user:* ]]; then
    __pebble_prev_line_init_fn="\${widgets[zle-line-init]#user:}"
  else
    __pebble_prev_line_init_fn=""
  fi
  __pebble_prompt_mark() {
    printf "${escapedMarker}"
    # Why: call the prior hook as a plain function, not an aliased widget, so
    # $WIDGET stays zle-line-init for add-zle-hook-widget dispatchers.
    if [[ -n "\${__pebble_prev_line_init_fn:-}" ]]; then
      "\${__pebble_prev_line_init_fn}" "$@"
    fi
  }
  zle -N zle-line-init __pebble_prompt_mark
fi
`
}

export function getZshFinalZdotdirRestoreBlock(homeExpression = '"${PEBBLE_ORIG_ZDOTDIR:-$HOME}"') {
  return `_pebble_home=${homeExpression}
case "\${_pebble_home%/}" in
  */shell-ready/zsh) _pebble_home="$HOME" ;;
esac
# Why: after Pebble's last wrapper file has loaded, the interactive shell should
# expose the same ZDOTDIR a normal zsh startup would expose.
export ZDOTDIR="$_pebble_home"
unset _pebble_home
`
}
