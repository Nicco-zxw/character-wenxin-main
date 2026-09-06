export type ToolInputSchema = {
  type: 'object'
  properties: Record<string, unknown>
  required?: string[]
}

export type ToolDefinition = {
  name: string
  description: string
  inputSchema: ToolInputSchema
}

export type ToolContext = {
  signal: AbortSignal
  projectId: string
}

export type ToolHandlerResult = {
  content: string
  isError?: boolean
}

export type ToolHandler = (
  input: Record<string, unknown>,
  ctx: ToolContext
) => Promise<ToolHandlerResult>

export type Tool = {
  definition: ToolDefinition
  handler: ToolHandler
}
