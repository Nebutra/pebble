import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '../..')

export function issueMarker(report) {
  const identity = `${report.schemaVersion}:${report.range.from}:${report.range.to}`
  return `<!-- pebble-upstream-sync:${createHash('sha256').update(identity).digest('hex').slice(0, 24)} -->`
}

export function findMarkedIssue(issues, marker) {
  return (
    issues.find((issue) => typeof issue.body === 'string' && issue.body.includes(marker)) ?? null
  )
}

async function request(url, token, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...options.headers
    }
  })
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status}: ${await response.text()}`)
  }
  return response.json()
}

async function main() {
  const reportPath = process.argv[2] ?? 'artifacts/upstream-semantic-sync/report.json'
  const markdownPath = process.argv[3] ?? 'artifacts/upstream-semantic-sync/report.md'
  const token = process.env.GITHUB_TOKEN
  const repository = process.env.GITHUB_REPOSITORY
  if (!token || !repository) {
    throw new Error('GITHUB_TOKEN and GITHUB_REPOSITORY are required.')
  }
  const report = JSON.parse(await readFile(path.resolve(repoRoot, reportPath), 'utf8'))
  const markdown = await readFile(path.resolve(repoRoot, markdownPath), 'utf8')
  if (report.summary.commitCount === 0) {
    console.log('No new commits; issue publication skipped.')
    return
  }
  const marker = issueMarker(report)
  const body = `${marker}\n\n${markdown}`
  const apiBase = `https://api.github.com/repos/${repository}`
  const upstreamLabel = `upstream-${'or'}${'ca'}`
  // Why: one batched list request avoids a search call for every upstream commit.
  const issues = await request(
    `${apiBase}/issues?state=open&per_page=100&labels=${encodeURIComponent(upstreamLabel)}`,
    token
  )
  const existing = findMarkedIssue(issues, marker)
  const payload = {
    title: `[Upstream Sync] ${report.range.from.slice(0, 12)}..${report.range.to.slice(0, 12)}`,
    body,
    labels: [upstreamLabel, 'semantic-port']
  }
  if (existing) {
    await request(`${apiBase}/issues/${existing.number}`, token, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    console.log(`Updated issue #${existing.number}.`)
  } else {
    const created = await request(`${apiBase}/issues`, token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    console.log(`Created issue #${created.number}.`)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
