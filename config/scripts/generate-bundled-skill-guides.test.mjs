import { describe, expect, it } from 'vitest'

import { buildArtifacts, skillNames } from './generate-bundled-skill-guides.mjs'

describe('bundled skill guide generation', () => {
  it('generates one stub and manifest entry for every Pebble skill', async () => {
    const artifacts = await buildArtifacts({ bootstrap: false })
    const manifest = JSON.parse(artifacts.files.get('resources/skills/current-manifest.json'))

    expect(manifest.skills.map((skill) => skill.name)).toEqual(skillNames)
    for (const name of skillNames) {
      const stub = artifacts.files.get(`skills/${name}/SKILL.md`)
      expect(stub).toMatch(new RegExp(`PEBBLE skills get ${name}`))
      expect(stub).not.toMatch(/electron/i)
    }
  })

  it('embeds all guides in generated Go source for offline retrieval', async () => {
    const artifacts = await buildArtifacts({ bootstrap: false })
    const source = artifacts.files.get(
      'runtime/go/cmd/pebble-control/bundled_skill_guides_generated.go'
    )

    for (const name of skillNames) {
      expect(source).toMatch(new RegExp(`"${name}"`))
    }
    expect(source).toMatch(/const bundledSkillAppVersion/)
  })
})
