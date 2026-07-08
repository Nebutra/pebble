#!/bin/bash
# Why: remove the PATH symlink that after-install.sh created, but only if it
# still points into a Pebble/legacy Pebble install dir — never delete unrelated
# commands a user or another package may own.
set -e

for link in /usr/bin/pebble-ide /usr/bin/pebble-ide; do
  if [ ! -L "$link" ]; then
    continue
  fi

  target="$(readlink "$link" || true)"
  case "$target" in
    /opt/Pebble/*|/opt/pebble-ide/*|/opt/pebble/*|/opt/Pebble/*|/opt/pebble-ide/*|/opt/pebble/*)
      rm -f "$link"
      ;;
  esac
done

exit 0
