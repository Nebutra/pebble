import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'

import type { CommandHandler } from '../dispatch'
import { RuntimeClientError } from '../runtime-client'

type SkillGuideResult = {
  name: string
  requestedAppVersion: string
  resolvedAppVersion: string
  releaseRevision: number
  fallbackReason?: string
  content: string
}

async function isPebbleRoot(candidate: string): Promise<boolean> {
  const paths = [path.join(candidate, 'package.json'), path.join(candidate, 'skill-guides')]
  const results = await Promise.all(paths.map((entry) => stat(entry).catch(() => null)))
  return results[0]?.isFile() === true && results[1]?.isDirectory() === true
}

export async function findBundledSkillRoot(cwd: string): Promise<string> {
  const starts = [cwd, __dirname]
  for (const start of starts) {
    let candidate = path.resolve(start)
    while (true) {
      if (await isPebbleRoot(candidate)) {
        return candidate
      }
      const parent = path.dirname(candidate)
      if (parent === candidate) {
        break
      }
      candidate = parent
    }
  }
  throw new RuntimeClientError(
    'not_found',
    'Could not locate bundled Pebble skill guides from this development CLI.'
  )
}

async function readSkillGuide(cwd: string, name: string, requestedVersion?: string) {
  const root = await findBundledSkillRoot(cwd)
  const manifest = JSON.parse(
    await readFile(path.join(root, 'resources/skills/current-manifest.json'), 'utf8')
  ) as {
    appVersion: string
    skills: { name: string; releaseRevision: number }[]
  }
  const entry = manifest.skills.find((skill) => skill.name === name)
  if (!entry) {
    const available = manifest.skills
      .map((skill) => skill.name)
      .sort()
      .join(', ')
    throw new RuntimeClientError(
      'invalid_argument',
      `Unknown skill: ${name}. Available skills: ${available}`
    )
  }
  const content = await readFile(path.join(root, 'skill-guides', `${name}.md`), 'utf8')
  const requestedAppVersion = requestedVersion?.trim() || manifest.appVersion
  return {
    name,
    requestedAppVersion,
    resolvedAppVersion: manifest.appVersion,
    releaseRevision: entry.releaseRevision,
    ...(requestedAppVersion === manifest.appVersion
      ? {}
      : { fallbackReason: 'requested version is unmapped; using the current bundled guide' }),
    content
  } satisfies SkillGuideResult
}

export const SKILL_HANDLERS: Record<string, CommandHandler> = {
  'skills get': async ({ flags, cwd, json }) => {
    const name = flags.get('name')
    if (typeof name !== 'string' || name.trim() === '') {
      throw new RuntimeClientError('invalid_argument', 'skills get requires one skill name')
    }
    const appVersion = flags.get('app-version')
    const result = await readSkillGuide(
      cwd,
      name.trim(),
      typeof appVersion === 'string' ? appVersion : undefined
    )
    process.stdout.write(json ? `${JSON.stringify(result)}\n` : result.content)
  }
}
