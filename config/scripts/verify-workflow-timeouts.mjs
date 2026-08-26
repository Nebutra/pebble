// Why: no job in the release path had a ceiling, so a hang ran until the
// platform's own six-hour limit killed it. v1.4.149 sat in notarization for
// exactly that long and the release was simply missing for three days, with
// nothing anywhere saying so. A job without a ceiling cannot report being stuck;
// it can only disappear.
//
// Reusable jobs (`uses:`) are exempt here because the ceiling belongs to the
// workflow they call, which this script also checks.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'

const WORKFLOW_DIR = '.github/workflows'

const failures = []
let checked = 0

for (const entry of readdirSync(WORKFLOW_DIR)) {
  if (!entry.endsWith('.yml') && !entry.endsWith('.yaml')) {
    continue
  }
  const path = join(WORKFLOW_DIR, entry)
  let document
  try {
    document = parse(readFileSync(path, 'utf8'))
  } catch (error) {
    failures.push(`${entry}: could not be parsed — ${error.message}`)
    continue
  }
  for (const [name, job] of Object.entries(document?.jobs ?? {})) {
    if (job?.uses) {
      // The called workflow carries the ceiling; it is checked on its own pass.
      continue
    }
    checked += 1
    const ceiling = job?.['timeout-minutes']
    if (typeof ceiling !== 'number') {
      failures.push(`${entry}: job "${name}" has no timeout-minutes`)
      continue
    }
    // GitHub kills a job at six hours regardless, so a larger number is not a
    // ceiling — it only looks like one.
    if (ceiling >= 360) {
      failures.push(
        `${entry}: job "${name}" sets timeout-minutes ${ceiling}, at or past the platform's own 360`
      )
    }
  }
}

if (failures.length > 0) {
  console.error('Workflow jobs must declare a timeout below the platform ceiling:\n')
  for (const failure of failures) {
    console.error(`  ${failure}`)
  }
  process.exit(1)
}

console.log(`Workflow timeout check passed across ${checked} job(s).`)
