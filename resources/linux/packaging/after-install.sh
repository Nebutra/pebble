#!/bin/bash
# Why: register the bundled `pebble-ide` CLI on PATH at package-install time.
# The in-app "Install CLI" action (CliInstaller) can never run on a headless
# server, so without this symlink `pebble serve` is unreachable from the shell on
# the exact hosts that need it most. deb/rpm both run this after unpacking.
#
# The shim resolves the real app by walking up from its own location, so a
# symlink works. We discover the install dir instead of hardcoding /opt/Pebble
# because electron-builder's directory name can vary by productName sanitization.
set -e

primary_link="/usr/bin/pebble-ide"
legacy_link="/usr/bin/pebble-ide"

for dir in /opt/Pebble /opt/pebble-ide /opt/pebble /opt/Pebble /opt/pebble-ide /opt/pebble; do
  sandbox="$dir/chrome-sandbox"
  if [ -f "$sandbox" ]; then
    # Why: packaged Linux installs must leave Chromium's sandbox helper usable
    # on hosts where unprivileged user namespaces are unavailable.
    chmod 4755 "$sandbox" || true
  fi

  shim="$dir/resources/bin/pebble-ide"
  if [ -x "$shim" ]; then
    # Only manage our own symlinks; never clobber unrelated user/system commands.
    if [ ! -e "$primary_link" ] || [ -L "$primary_link" ]; then
      ln -sf "$shim" "$primary_link"
    fi

    legacy_shim="$dir/resources/bin/pebble-ide"
    if [ -x "$legacy_shim" ] && { [ ! -e "$legacy_link" ] || [ -L "$legacy_link" ]; }; then
      ln -sf "$legacy_shim" "$legacy_link"
    fi
    break
  fi
done

exit 0
