import type { AppSettings, AiRunUsage } from '../shared-types'
import { performAiRequest } from './http'

/** 图片生成接口的返回结果 */
export type GeneratedImageResult = {
  dataUrl: string
  revisedPrompt?: string
  /** 部分图片模型（如 gpt-image-1）会返回 token 用量 */
  usage?: AiRunUsage
}

/** 将图片生成相关的配置项（imageModel、imageApiKey、imageBaseUrl）提取到通用字段中 */
function normalizeImageSettings(settings: AppSettings): AppSettings {
  return {
    ...settings,
    model: settings.imageModel?.trim() || '',
    apiKey: settings.imageApiKey?.trim() || '',
    baseUrl: settings.imageBaseUrl?.trim() || ''
  }
}

/** 根据 base64 数据的头部特征推断图片 MIME 类型 */
function inferMimeType(base64: string): string {
  if (base64.startsWith('/9j/')) {
    return 'image/jpeg'
  }

  if (base64.startsWith('UklGR')) {
    return 'image/webp'
  }

  return 'image/png'
}

/** 判断错误是否为「provider 不支持 response_format 参数」，用于决定是否去掉该参数重试。 */
function isUnsupportedResponseFormatError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error ?? '')).toLowerCase()
  return message.includes('response_format') && (
    message.includes('not supported')
    || message.includes('unsupportedparams')
    || message.includes('unsupported')
    || message.includes('drop_params')
  )
}

/**
 * 调用 OpenAI 兼容的图片生成接口，返回 data URL 格式的图片。
 *
 * @param settings - 应用配置（需包含 imageModel、imageBaseUrl、imageApiKey）
 * @param prompt - 图片生成提示词
 * @returns 包含 dataUrl 和可选 revisedPrompt 的结果
 */
export async function generateImage(settings: AppSettings, prompt: string): Promise<GeneratedImageResult> {
  const normalized = normalizeImageSettings(settings)
  if (!normalized.model.trim()) {
    throw new Error('请先在设置中填写专用的图片生成模型（不会自动回退到文本模型）。')
  }
  if (!normalized.baseUrl.trim()) {
    throw new Error('请先在设置中填写专用的图片生成 Base URL。')
  }
  if (!normalized.apiKey.trim()) {
    throw new Error('请先在设置中填写专用的图片生成 API Key。')
  }

  const url = `${normalized.baseUrl.replace(/\/$/, '')}/images/generations`
  const timeoutMs = settings.aiTimeoutSeconds ? settings.aiTimeoutSeconds * 1000 : undefined

  // 默认请求 b64_json 以获得可本地保存的自包含图片；部分 provider（如 gpt-image-1、
  // 经 litellm 代理的 agnes 等）不支持 response_format，命中后去掉该参数重试一次。
  const buildBody = (includeResponseFormat: boolean): string => JSON.stringify({
    model: normalized.model,
    prompt,
    size: '1024x1536',
    ...(includeResponseFormat ? { response_format: 'b64_json' } : {})
  })

  const requestOnce = (includeResponseFormat: boolean): Promise<Response> => performAiRequest({
    url,
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${normalized.apiKey}`
      },
      body: buildBody(includeResponseFormat)
    },
    providerLabel: '图片生成接口',
    timeoutMs
  })

  let response: Response
  try {
    response = await requestOnce(true)
  } catch (error) {
    if (!isUnsupportedResponseFormatError(error)) {
      throw error
    }
    response = await requestOnce(false)
  }

  const data = (await response.json()) as {
    data?: Array<{
      b64_json?: string
      revised_prompt?: string
      url?: string
    }>
    usage?: {
      input_tokens?: number
      output_tokens?: number
      total_tokens?: number
      prompt_tokens?: number
      completion_tokens?: number
    }
  }
  const first = data.data?.[0]
  if (!first) {
    throw new Error('图片生成成功，但没有返回图片数据。')
  }

  const rawUsage = data.usage
  const usage: AiRunUsage | undefined = rawUsage
    ? {
        promptTokens: Number.isFinite(rawUsage.input_tokens) ? rawUsage.input_tokens : (Number.isFinite(rawUsage.prompt_tokens) ? rawUsage.prompt_tokens : undefined),
        completionTokens: Number.isFinite(rawUsage.output_tokens) ? rawUsage.output_tokens : (Number.isFinite(rawUsage.completion_tokens) ? rawUsage.completion_tokens : undefined),
        totalTokens: Number.isFinite(rawUsage.total_tokens) ? rawUsage.total_tokens : undefined
      }
    : undefined

  if (first.b64_json?.trim()) {
    const base64 = first.b64_json.trim()
    return {
      dataUrl: `data:${inferMimeType(base64)};base64,${base64}`,
      revisedPrompt: first.revised_prompt?.trim() || undefined,
      usage
    }
  }

  if (first.url?.trim()) {
    // 部分 provider 返回远程 URL；本地保存功能只接受 data URL，这里下载并转 base64 兜底。
    const dataUrl = await remoteImageToDataUrl(first.url.trim(), timeoutMs)
    return {
      dataUrl,
      revisedPrompt: first.revised_prompt?.trim() || undefined,
      usage
    }
  }

  throw new Error('图片生成成功，但返回结果中没有可用图片。')
}

/** 下载远程图片并转成 base64 data URL；失败时回退为原始 URL。 */
async function remoteImageToDataUrl(url: string, timeoutMs?: number): Promise<string> {
  try {
    const response = await performAiRequest({
      url,
      init: { method: 'GET' },
      providerLabel: '图片下载',
      timeoutMs
    })
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim() || ''
    const base64 = Buffer.from(await response.arrayBuffer()).toString('base64')
    const mimeType = contentType.startsWith('image/') ? contentType : `image/${inferMimeType(base64).replace('image/', '')}`
    return `data:${mimeType};base64,${base64}`
  } catch {
    return url
  }
}
