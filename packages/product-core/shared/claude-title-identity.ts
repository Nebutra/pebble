/**
 * Claude Code identity checks — is this title, or this pane, Claude?
 *
 * Why separate from `agent-detection`: those answer "what is this terminal
 * doing" for every agent, while these answer "is this one Claude" and are the
 * signals callers reach for when a wrong answer mislabels a pane. Keeping them
 * together makes the ways Claude identifies itself readable in one place.
 */

import { containsBrailleSpinner } from './braille-spinner-detection'
import { titleHasAgentName } from './agent-name-token-match'

/** ✳ (eight-spoked asterisk — Claude Code idle prefix) */
export const CLAUDE_IDLE = '\u2733'

const CLAUDE_MANAGEMENT_TITLE_RE =
  /^\s*(?:"(?:.*[\\/])?claude(?:\.(?:exe|cmd|bat|ps1))?"|'(?:.*[\\/])?claude(?:\.(?:exe|cmd|bat|ps1))?'|(?:.*[\\/])?claude(?:\.(?:exe|cmd|bat|ps1))?)\s+agents\s*$/i

/**
 * Returns true when the terminal title matches Claude Code's title conventions.
 * Used to scope prompt-cache-timer behavior to Claude sessions only — other
 * agents have different (or no) caching semantics.
 */
export function isClaudeAgent(title: string): boolean {
  if (!title || isClaudeManagementTitle(title)) {
    return false
  }
  const lower = title.toLowerCase()

  // Why: Claude Code titles are prefixed with status indicators (✳, ". ", "* ",
  // braille spinners) followed by the task description. The task text can
  // legitimately mention other agents, so Claude-specific prefixes must win.
  if (hasClaudeIdentityPrefix(title)) {
    return true
  }
  // Why: ". " (working) and "* " (idle) are Claude Code title conventions.
  // Other supported agents do not use them, and rejecting titles that mention
  // another agent in the task text caused false negatives for real Claude tabs.
  if (title.startsWith('. ') || title.startsWith('* ')) {
    return true
  }
  if (containsBrailleSpinner(title)) {
    // Why: named non-Claude agents can carry braille spinners too; Claude-only
    // prompt-cache paths must not fire for those explicit agent titles.
    return !lower.includes('cursor') && !lower.includes('openclaude')
  }
  // Why: permission/action-required Claude titles can omit the usual prefixes.
  // Token-match so cwd/worktree titles like "claude-scratch" do not become
  // Claude tabs, while task text that merely mentions Claude still stays out.
  const trimmedTitle = title.trimStart()
  if (
    trimmedTitle.toLowerCase().startsWith('claude') &&
    titleHasAgentName(trimmedTitle, 'claude')
  ) {
    return true
  }

  return false
}

/** Whether the title is the `claude agents` management screen rather than work. */
export function isClaudeManagementTitle(title: string): boolean {
  return CLAUDE_MANAGEMENT_TITLE_RE.test(title)
}

/**
 * Whether the title carries Claude Code's own prefix glyph.
 *
 * Why this is separate from the label: `getAgentLabel` also answers
 * "Claude Code" for the generic `. ` and `* ` prefixes, which any terminal can
 * produce. Callers that need identity rather than a guess — the sidebar's agent
 * rows, which must not mint a Claude row for an unrelated spinner — can ask for
 * the strong signal on its own.
 */
export function hasClaudeIdentityPrefix(title: string): boolean {
  return title.startsWith(`${CLAUDE_IDLE} `) || title === CLAUDE_IDLE
}

/**
 * Whether a pane's launch agent is Claude Code itself.
 *
 * Why named: Agent Teams panes launch as `claude-agent-teams` and are just as
 * much Claude as `claude` is, but the distinction is easy to miss at a bare
 * `=== 'claude'` comparison.
 */
export function isClaudeLaunchAgent(agent: string | null | undefined): boolean {
  return agent === 'claude' || agent === 'claude-agent-teams'
}
