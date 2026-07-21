import { describe, expect, it } from 'vitest'

import zh from './locales/zh.json'

const collectStrings = (value: unknown): string[] => {
  if (typeof value === 'string') {
    return [value]
  }
  if (Array.isArray(value)) {
    return value.flatMap(collectStrings)
  }
  if (value && typeof value === 'object') {
    return Object.values(value).flatMap(collectStrings)
  }
  return []
}

describe('Chinese product terminology', () => {
  it('uses the low-friction parallel-universe term instead of Git worktree wording', () => {
    expect(collectStrings(zh).some((text) => text.includes('工作树'))).toBe(false)
    expect(zh.menu.openWorktreePalette).toBe('打开平行宇宙面板')
    expect(zh.auto.components.NewWorkspaceComposerModal.createWorkspace).toBe('创建平行宇宙')
    expect(zh.auto.components.Landing).toMatchObject({
      createParallelUniverse: '创建平行宇宙',
      createFolderSpace: '创建文件夹空间',
      moveUpParallelUniverse: '上移平行宇宙',
      moveDownParallelUniverse: '下移平行宇宙'
    })
  })

  it('keeps external provider workspace nouns distinct', () => {
    const strings = collectStrings(zh)
    expect(strings).toContain('无法切换 Linear 工作区。')
    expect(strings).toContain('OpenCode Go 工作区 ID')
    expect(strings).toContain('浮动工作台')
    expect(strings).toContain('创建文件夹空间')
  })
})
