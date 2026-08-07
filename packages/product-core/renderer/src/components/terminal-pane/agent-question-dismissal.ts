import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry,
  type ParsedAgentStatusPayload
} from '../../../../shared/agent-status-types'
import type { AgentInterruptInferenceRequest } from '../../../../shared/agent-interrupt-intent'
import { isAskUserQuestionTool } from '../../../../shared/ask-user-question-tool'

/** Synthesize the status Claude omits when the user dismisses an AskUserQuestion
 *  card with Escape: the turn resumes working, so the wait, the tool name, and
 *  the live prompt card all clear. Returns null when this is not that case.
 *
 *  Why the store is the authority here: the hook lane is the only producer that
 *  reports `waiting` with a tool name, so the Tauri runtime-session bridge
 *  behind `agentStatus.inferInterrupt` cannot see the question at all.
 *
 *  Why re-validate the baseline: this is a delayed fallback for a missing hook.
 *  A real hook arriving inside the settle window must win, so any drift from
 *  the keystroke's baseline abandons the inference. */
export function resolveDismissedQuestionStatus(args: {
  entry: AgentStatusEntry | undefined
  request: AgentInterruptInferenceRequest
  now: number
}): ParsedAgentStatusPayload | null {
  const { entry, request, now } = args
  if (!entry || request.intent !== 'plain-escape') {
    return null
  }
  // Why: the tool name — not the hook event — discriminates a question from a
  // real permission wait, which stays sticky until the user answers it.
  if (
    entry.agentType !== 'claude' ||
    entry.state !== 'waiting' ||
    !isAskUserQuestionTool(entry.toolName)
  ) {
    return null
  }
  if (
    entry.agentType !== request.baselineAgentType ||
    entry.prompt !== request.baselinePrompt ||
    entry.updatedAt !== request.baselineUpdatedAt ||
    entry.stateStartedAt !== request.baselineStateStartedAt ||
    now - entry.updatedAt > AGENT_STATUS_STALE_AFTER_MS
  ) {
    return null
  }
  // Why: dismissing a question cancels the question, not the turn — so this is
  // a plain `working` row, never `done` + interrupted.
  return { state: 'working', prompt: entry.prompt, agentType: entry.agentType }
}
