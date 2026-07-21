import type { AgentType, NativeChatMessage } from './native-chat-types'

export type NativeChatReadSessionResult = { messages: NativeChatMessage[] } | { error: string }

export type NativeChatAppendedMessages = NativeChatMessage[]

export type NativeChatAppendedPayload = {
  subscriptionId: string
  messages: NativeChatAppendedMessages
}

export type NativeChatSubscribeArgs = {
  subscriptionId: string
  agent: AgentType
  sessionId: string
  transcriptPath?: string
}

export type NativeChatApi = {
  readSession: (
    agent: AgentType,
    sessionId: string,
    limit?: number,
    transcriptPath?: string
  ) => Promise<NativeChatReadSessionResult>
  subscribe: (
    args: NativeChatSubscribeArgs,
    onAppended: (messages: NativeChatAppendedMessages) => void
  ) => () => void
}
