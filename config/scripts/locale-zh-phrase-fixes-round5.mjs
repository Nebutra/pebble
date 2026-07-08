// Chinese phrase fixes from high-visibility UI audit round 5.
export const ZH_PHRASE_FIXES_ROUND5 = [
  { pattern: /Pebble集成开发环境/g, replacement: 'Pebble IDE', whenEnIncludes: 'Pebble IDE' },
  { pattern: /Pebble第一/g, replacement: 'Pebble 优先', whenEnIncludes: 'Pebble first' },
  { pattern: /Pebble移动/g, replacement: 'Pebble Mobile', whenEnIncludes: 'Pebble Mobile' },
  { pattern: /Pebble归属/g, replacement: 'Pebble 归因', whenEnIncludes: 'Pebble Attribution' },
  { pattern: /Pebble标志/g, replacement: 'Pebble 标志', whenEnIncludes: 'Pebble logo' },
  { pattern: /喜欢Pebble/g, replacement: '喜欢 Pebble', whenEnIncludes: 'Enjoying Pebble' },
  { pattern: /认识Pebble/g, replacement: '了解 Pebble', whenEnIncludes: 'Get to know Pebble' },
  { pattern: /支持Pebble/g, replacement: '支持 Pebble', whenEnIncludes: 'Support Pebble' },
  { pattern: /展开Pebble/g, replacement: '展开 Pebble', whenEnIncludes: 'Expand Pebble' },
  { pattern: /来自Pebble/g, replacement: '来自 Pebble', whenEnIncludes: 'from Pebble' },
  {
    pattern: /正在重新启动Pebble/g,
    replacement: '正在重启 Pebble',
    whenEnIncludes: 'Restarting Pebble'
  },
  { pattern: /Pebble([\u4e00-\u9fff])/g, replacement: 'Pebble $1', whenEnIncludes: 'Pebble' },
  { pattern: /Linear([\u4e00-\u9fff])/g, replacement: 'Linear $1', whenEnIncludes: 'Linear' },
  { pattern: /Codex([\u4e00-\u9fff])/g, replacement: 'Codex $1', whenEnIncludes: 'Codex' },
  { pattern: /Claude([\u4e00-\u9fff])/g, replacement: 'Claude $1', whenEnIncludes: 'Claude' },
  { pattern: /Claude代码/g, replacement: 'Claude Code', whenEnIncludes: 'Claude Code' },
  { pattern: /GitHub 和Linear/g, replacement: 'GitHub 和 Linear', whenEnIncludes: 'Linear tasks' },
  { pattern: /托管审阅/g, replacement: '托管评审', whenEnIncludes: 'hosted-review' },
  { pattern: /托管审阅/g, replacement: '托管评审', whenEnIncludes: 'Hosted-review' },
  { pattern: /审阅笔记/g, replacement: '评审笔记', whenEnIncludes: 'review note' },
  { pattern: /审阅任务/g, replacement: '评审任务', whenEnIncludes: 'review task' },
  { pattern: /待审阅/g, replacement: '待评审', whenEnIncludes: 'need review' },
  { pattern: /重新审核/g, replacement: '重新评审', whenEnIncludes: 'Re-review' },
  { pattern: /依赖项审核/g, replacement: '依赖项审计', whenEnIncludes: 'dependency audit' },
  { pattern: /Git AI 作者/g, replacement: 'Git AI Author', whenEnIncludes: 'Git AI Author' },
  { pattern: /基本引用/g, replacement: '基础引用', whenEnIncludes: 'base ref' },
  { pattern: /重新开放PR/g, replacement: '重新打开 PR', whenEnIncludes: 'Reopen PR' },
  { pattern: /重新开放/g, replacement: '重新打开', whenEnIncludes: 'reopen' },
  { pattern: /受限制的钥匙/g, replacement: '受限制的密钥', whenEnIncludes: 'restricted keys' },
  { pattern: /更换钥匙/g, replacement: '更换密钥', whenEnIncludes: 'Replace key' },
  {
    pattern: /根据所看到的内容采取行动/g,
    replacement: '根据所看到的内容执行操作',
    whenEnIncludes: 'act on what they see'
  },
  {
    pattern: /建议下一步行动/g,
    replacement: '建议下一步操作',
    whenEnIncludes: 'suggest next actions'
  },
  {
    pattern: /可操作的问题/g,
    replacement: '需处理的问题',
    whenEnIncludes: 'actionable issues'
  },
  {
    pattern: /显示 Pebble 移动按钮/g,
    replacement: '显示 Pebble Mobile 按钮',
    whenEnIncludes: 'Show Pebble Mobile Button'
  }
]
