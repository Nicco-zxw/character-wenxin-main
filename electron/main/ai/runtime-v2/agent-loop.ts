import { runAgent } from '../agent/run-agent'
import { isToolUseNotSupportedError } from '../provider'
import type { ConversationManager } from './conversation-manager'
import type { StagedChangesStore } from './staged-changes-store'
import {
  AgentLoopCore,
  type EventEmitter,
  type RunAgentImpl,
  type ToolUseErrorClassifier
} from './agent-loop-core'

export * from './agent-loop-core'

export class AgentLoop extends AgentLoopCore {
  constructor(
    conversation: ConversationManager,
    staged: StagedChangesStore,
    emit: EventEmitter,
    runAgentImpl: RunAgentImpl = runAgent,
    toolUseErrorClassifier: ToolUseErrorClassifier = isToolUseNotSupportedError
  ) {
    super(conversation, staged, emit, runAgentImpl, toolUseErrorClassifier)
  }
}
