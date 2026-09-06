import type { AppSettings } from './shared-types'

export type OpenAIProviderOptions = {
  openai: {
    reasoningEffort: 'none'
  }
}

export function isOpenAIReasoningChatModel(settings: AppSettings): boolean {
  const model = settings.model?.trim().toLowerCase() || ''
  return /^(gpt-5|o1|o3|o4-mini)/.test(model)
}

export function resolveProviderOptions(
  settings: AppSettings,
  options?: { disableReasoning?: boolean }
): OpenAIProviderOptions | undefined {
  if (
    !options?.disableReasoning
    || settings.provider !== 'openai'
    || !isOpenAIReasoningChatModel(settings)
  ) {
    return undefined
  }

  return {
    openai: {
      reasoningEffort: 'none'
    }
  }
}
