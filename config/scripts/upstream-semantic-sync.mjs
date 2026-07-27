import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '../..')

function runGit(repository, args) {
  return execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim()
}

function parseArgs(argv) {
  const options = { outputDir: 'artifacts/upstream-semantic-sync' }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--repo') {
      options.repository = argv[++index]
    } else if (value === '--from') {
      options.from = argv[++index]
    } else if (value === '--to') {
      options.to = argv[++index]
    } else if (value === '--output-dir') {
      options.outputDir = argv[++index]
    } else if (value === '--fetch') {
      options.fetch = true
    } else {
      throw new Error(`Unknown argument: ${value}`)
    }
  }
  return options
}

export function classifyPath(filePath, policy) {
  const match = policy.rules.find((rule) =>
    rule.prefixes.some((prefix) => filePath.startsWith(prefix))
  )
  return match ? { area: match.area, risk: match.risk } : policy.fallback
}

function parseCommitLog(raw, policy) {
  if (!raw) {
    return []
  }
  return raw
    .split('\u001e')
    .filter(Boolean)
    .map((record) => {
      const [header, ...paths] = record.trim().split('\n')
      const [commit, authoredAt, subject] = header.split('\u001f')
      const files = paths
        .filter(Boolean)
        .map((filePath) => ({ filePath, ...classifyPath(filePath, policy) }))
      const risks = new Set(files.map((file) => file.risk))
      const risk = risks.has('high') ? 'high' : risks.has('medium') ? 'medium' : 'low'
      return { commit, authoredAt, subject, risk, files }
    })
}

function summarize(commits) {
  const areas = {}
  const risks = { low: 0, medium: 0, high: 0 }
  for (const commit of commits) {
    risks[commit.risk] += 1
    for (const file of commit.files) {
      areas[file.area] = (areas[file.area] ?? 0) + 1
    }
  }
  return {
    commitCount: commits.length,
    changedPathCount: Object.values(areas).reduce((a, b) => a + b, 0),
    areas,
    risks
  }
}

export function renderMarkdown(report) {
  const lines = [
    '# Upstream semantic sync report',
    '',
    `Range: \`${report.range.from}\`..\`${report.range.to}\``,
    '',
    `Commits: ${report.summary.commitCount}; changed paths: ${report.summary.changedPathCount}.`,
    '',
    '## Risk summary',
    '',
    `- High: ${report.summary.risks.high}`,
    `- Medium: ${report.summary.risks.medium}`,
    `- Low: ${report.summary.risks.low}`,
    '',
    '## Commits',
    ''
  ]
  if (report.commits.length === 0) {
    lines.push('No new upstream commits were found.')
  }
  for (const commit of report.commits) {
    lines.push(`- \`${commit.commit.slice(0, 12)}\` [${commit.risk}] ${commit.subject}`)
    const areas = [...new Set(commit.files.map((file) => file.area))]
    if (areas.length > 0) {
      lines.push(`  Areas: ${areas.join(', ')}`)
    }
  }
  lines.push(
    '',
    '## Porting policy',
    '',
    '- High-risk desktop-host/runtime changes require a semantic Go/Tauri port.',
    '- Reports and issues may be automated; merging is always manual.',
    ''
  )
  return lines.join('\n')
}

async function loadConfig() {
  const state = JSON.parse(
    await readFile(path.join(repoRoot, 'config/upstream-sync/state.json'), 'utf8')
  )
  const policy = JSON.parse(
    await readFile(path.join(repoRoot, 'config/upstream-sync/classification-rules.json'), 'utf8')
  )
  return { state, policy }
}

async function cloneUpstream(state) {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'pebble-upstream-sync-'))
  const name = state.repository.nameParts.join('')
  const url = `https://${state.repository.host}/${state.repository.owner}/${name}.git`
  execFileSync('git', ['clone', '--filter=blob:none', '--no-checkout', url, temporaryRoot], {
    stdio: 'inherit'
  })
  return temporaryRoot
}

export async function generateReport(options) {
  const { state, policy } = await loadConfig()
  let repository = options.repository
  let cleanup = false
  if (!repository && options.fetch) {
    repository = await cloneUpstream(state)
    cleanup = true
  }
  if (!repository) {
    throw new Error('Provide --repo <upstream-git-dir> or --fetch.')
  }
  const from = options.from ?? state.lastAudited.commit
  const to = options.to ?? 'origin/main'
  try {
    const resolvedFrom = runGit(repository, ['rev-parse', from])
    const resolvedTo = runGit(repository, ['rev-parse', to])
    const raw = runGit(repository, [
      'log',
      '--reverse',
      '--format=%x1e%H%x1f%aI%x1f%s',
      '--name-only',
      `${resolvedFrom}..${resolvedTo}`
    ])
    const commits = parseCommitLog(raw, policy)
    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      range: { from: resolvedFrom, to: resolvedTo },
      checkpoint: state.lastAudited,
      proposedCheckpoint: { commit: resolvedTo },
      summary: summarize(commits),
      commits
    }
  } finally {
    if (cleanup) {
      await rm(repository, { recursive: true, force: true })
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const report = await generateReport(options)
  const outputDir = path.resolve(repoRoot, options.outputDir)
  await mkdir(outputDir, { recursive: true })
  await writeFile(path.join(outputDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  await writeFile(path.join(outputDir, 'report.md'), renderMarkdown(report))
  console.log(
    `Wrote semantic sync report for ${report.summary.commitCount} commit(s) to ${outputDir}`
  )
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
