import type { PiAgentKind } from '../../shared/pi-agent-kind'

export const PEBBLE_PI_PREFILL_EXTENSION_FILE = 'pebble-prefill.ts'

// Why: prefill-without-submit needs an env-var the bundled `pebble-prefill.ts`
// extension can read on session_start. Each kind owns its own variable so an
// OMP PTY never honors a Pi draft (or vice versa).
const PREFILL_ENV_VAR_BY_KIND: Record<PiAgentKind, string> = {
  pi: 'PEBBLE_PI_PREFILL',
  omp: 'PEBBLE_OMP_PREFILL'
}

/** Pi's prefill env var. Exported for callers that need the literal name
 *  (renderer draft-launch plan builder, tests). OMP callers should read
 *  `PEBBLE_OMP_PREFILL_ENV_VAR` instead. */
export const PEBBLE_PI_PREFILL_ENV_VAR = PREFILL_ENV_VAR_BY_KIND.pi

/** OMP's prefill env var. Mirrors `PEBBLE_PI_PREFILL_ENV_VAR` for OMP launches
 *  so renderer plans and shell-ready restore lines can stay agent-scoped. */
export const PEBBLE_OMP_PREFILL_ENV_VAR = PREFILL_ENV_VAR_BY_KIND.omp

export function getPiPrefillExtensionSource(kind: PiAgentKind): string {
  const envVar = PREFILL_ENV_VAR_BY_KIND[kind]
  return [
    'export default function (pi) {',
    "  pi.on('session_start', async (event, ctx) => {",
    '    if (!process.env.PEBBLE_PANE_KEY) return',
    "    if (event.reason !== 'startup') return",
    `    const prefill = process.env.${envVar}`,
    '    if (!prefill) return',
    `    delete process.env.${envVar}`,
    '    try {',
    '      ctx.ui.setEditorText(prefill)',
    '    } catch {}',
    '  })',
    '}',
    ''
  ].join('\n')
}
