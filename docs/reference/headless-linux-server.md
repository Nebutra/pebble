# Headless Linux Server

Use this guide when you want to run `pebble serve` on a Linux machine without a
desktop session, such as an Ubuntu VPS or a remote build box.

`pebble serve` starts the Pebble runtime without opening the desktop window. On
Linux, the packaged AppImage still needs the libraries that Electron expects at
startup. Current Pebble builds can start Xvfb automatically for `pebble serve` when
no `DISPLAY` is set, but Xvfb must be installed first. When `DISPLAY` is set,
Pebble uses that display instead of starting a competing Xvfb process.

## Ubuntu 22.04 Prerequisites

Install the AppImage runtime dependency and Xvfb:

```bash
sudo apt-get update
sudo apt-get install -y curl libfuse2 xvfb
```

Download and make the AppImage executable:

```bash
sudo mkdir -p /opt/pebble
sudo curl -L https://github.com/nebutra/pebble/releases/latest/download/pebble-linux.AppImage \
  -o /opt/pebble/pebble-linux.AppImage
sudo chmod +x /opt/pebble/pebble-linux.AppImage
```

If `Xvfb` was installed somewhere other than `/usr/bin`, confirm systemd can
find it later:

```bash
command -v Xvfb
```

## Run In The Foreground

Start with a foreground run before creating a service:

```bash
LIBGL_ALWAYS_SOFTWARE=1 /opt/pebble/pebble-linux.AppImage serve --port 6768
```

For remote clients, pass the address they should use to reach this server. A
Tailscale address is usually the safest option for private servers:

```bash
LIBGL_ALWAYS_SOFTWARE=1 /opt/pebble/pebble-linux.AppImage serve \
  --port 6768 \
  --pairing-address 100.64.1.20
```

The command prints the runtime endpoint and pairing URL. Stop it with `Ctrl+C`.

## Systemd Service

Create a dedicated service user and install directory. Run the service as this
user instead of root so the AppImage can keep Chromium's sandbox enabled.

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin pebble
sudo chown -R pebble:pebble /opt/pebble
```

For most hosts, one `pebble serve` service is enough because Pebble starts Xvfb on
display `:99` when no display exists:

```ini
# /etc/systemd/system/pebble-serve.service
[Unit]
Description=Pebble runtime server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=pebble
WorkingDirectory=/home/pebble
Environment=LIBGL_ALWAYS_SOFTWARE=1
ExecStart=/opt/pebble/pebble-linux.AppImage serve --port 6768 --pairing-address 100.64.1.20
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Replace `100.64.1.20` with the LAN, Tailscale, tunnel, or public hostname that
clients should use.

Enable the service:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now pebble-serve.service
sudo journalctl -u pebble-serve.service -f
```

## Managed Xvfb Service

If you prefer to own the virtual display lifecycle in systemd, run Xvfb as a
separate service and set `DISPLAY=:99` for Pebble.

```ini
# /etc/systemd/system/pebble-xvfb.service
[Unit]
Description=Virtual X display for Pebble
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/Xvfb :99 -screen 0 1280x1024x24 -nolisten tcp
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

If `command -v Xvfb` returned a different path, update `ExecStart` to that
absolute path.

Then add the display dependency to the Pebble service:

```ini
# /etc/systemd/system/pebble-serve.service
[Unit]
Description=Pebble runtime server
After=network-online.target pebble-xvfb.service
Wants=network-online.target pebble-xvfb.service

[Service]
Type=simple
User=pebble
WorkingDirectory=/home/pebble
Environment=DISPLAY=:99
Environment=LIBGL_ALWAYS_SOFTWARE=1
ExecStart=/opt/pebble/pebble-linux.AppImage serve --port 6768 --pairing-address 100.64.1.20
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Enable both units:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now pebble-xvfb.service pebble-serve.service
```

## CLI Install Note

On a headless host, you do not need to open the desktop UI just to run the
server. Invoke the AppImage directly:

```bash
/opt/pebble/pebble-linux.AppImage serve --help
```

If you later install the desktop CLI from Pebble settings, use that CLI for normal
shell workflows. Keep the AppImage path in systemd so service restarts do not
depend on an interactive shell profile.

## Troubleshooting

- `dlopen(): error loading libfuse.so.2`: install `libfuse2`.
- `Missing X server or $DISPLAY`: install `xvfb`, or start the managed Xvfb
  service and set `DISPLAY=:99`.
- `Xvfb not found`: confirm `command -v Xvfb` and use that absolute path in the
  systemd unit.
- GPU or DRI warnings on a VPS: keep `LIBGL_ALWAYS_SOFTWARE=1` in the service
  environment.
- Chromium sandbox errors: confirm the service is running as the non-root
  `pebble` user and that `/opt/pebble` is readable by that user.
- Clients cannot connect: make sure `--pairing-address` is an address reachable
  from the client, and make sure firewalls allow the selected `--port`.
- Diagnosing other missing libraries: extract the AppImage without launching it
  with `./pebble-linux.AppImage --appimage-extract`, then run
  `ldd squashfs-root/pebble` to list any shared libraries the host is missing.
