#!/bin/bash
# Why: remove only aliases created for Pebble's native Tauri executable; never
# delete regular files or symlinks that another package or the user now owns.
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

for link in /usr/bin/pebble /usr/bin/pebble-ide; do
  if [ ! -L "$link" ]; then
    continue
  fi
  target="$(readlink "$link" || true)"
  if is_pebble_owned_target "$target"; then
    rm -f "$link"
  fi
done

exit 0
