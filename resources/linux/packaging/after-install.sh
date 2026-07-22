#!/bin/bash
# Why: deb/rpm install the Tauri binary under its Cargo name; expose the stable
# `pebble` command while retaining the former Linux command as a compatibility alias.
set -e

native_executable="/usr/bin/pebble-desktop-tauri"

is_pebble_owned_target() {
  case "$1" in
    "$native_executable"|/opt/Pebble/resources/bin/pebble-ide|/opt/pebble-ide/resources/bin/pebble-ide|/opt/pebble/resources/bin/pebble-ide)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

if [ ! -x "$native_executable" ]; then
  exit 0
fi

for link in /usr/bin/pebble /usr/bin/pebble-ide; do
  if [ -e "$link" ] && [ ! -L "$link" ]; then
    continue
  fi
  if [ -L "$link" ]; then
    target="$(readlink "$link" || true)"
    if ! is_pebble_owned_target "$target"; then
      continue
    fi
  fi
  ln -sfn "$native_executable" "$link"
done

exit 0
