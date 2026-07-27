import { describe, expect, it, vi } from 'vitest'

import { RuntimeClient } from '../runtime-client'
import { SKILL_HANDLERS, findBundledSkillRoot } from './skills'

describe('development bundled skill guides', () => {
  it('locates the repository from a nested checkout path', async () => {
    await expect(findBundledSkillRoot(process.cwd())).resolves.toBe(process.cwd())
  })

  it('prints the canonical guide without a runtime call', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const client = new RuntimeClient()
    const call = vi.spyOn(client, 'call')

    await SKILL_HANDLERS['skills get']({
      flags: new Map([['name', 'pebble-cli']]),
      client,
      cwd: process.cwd(),
      json: false
    })

    expect(write).toHaveBeenCalledWith(expect.stringContaining('# Pebble CLI'))
    expect(call).not.toHaveBeenCalled()
    write.mockRestore()
  })
})
