import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const SERVE_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['serve'],
    summary: 'Start an Pebble runtime server without opening a desktop window',
    usage:
      'pebble serve [--port <port>] [--pairing-address <host>] [--mobile-pairing] [--no-pairing] [--project-root <path>] [--recipe-json] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'port',
      'pairing-address',
      'mobile-pairing',
      'no-pairing',
      'project-root',
      'recipe-json'
    ],
    notes: [
      'Runs in the foreground and prints the runtime endpoint. Stop it with Ctrl+C.',
      'Use --pairing-address when clients should connect through a LAN, Tailscale, SSH-forward, or public tunnel address.',
      'Use --recipe-json with --project-root from VM recipes to print the recipe result JSON and leave the server running.',
      'Use --mobile-pairing to print a mobile-scoped pairing QR/link instead of the default runtime-environment pairing link.',
      'When the web client bundle is available, the server also prints a browser URL with the pairing data embedded.'
    ],
    examples: [
      'pebble serve',
      'pebble serve --json',
      'pebble serve --project-root /workspace/repo --pairing-address wss://sandbox.example.com --recipe-json',
      'pebble serve --port 6768 --pairing-address 100.64.1.20',
      'pebble serve --pairing-address 100.64.1.20 --mobile-pairing'
    ]
  }
]
