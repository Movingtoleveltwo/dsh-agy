/**
 * OpenAI-compatible HTTP relay for dsh-agy.
 *
 * Implements `/agy/v1/models` and `/agy/v1/chat/completions` directly on the
 * DSH host web server, allowing external agent frameworks like Hermes to use
 * Antigravity models over standard OpenAI wire format without separate daemons.
 */

import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  LlmError,
  type GenerateOptions,
  type LlmModelInfo,
  type ReasoningEffortId,
  type ToolSchema,
  type TokenUsage,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { AGY_PROVIDER } from '../adapter/models.ts'
import { AGY_PUBLIC_MODELS } from '../adapter/catalog.ts'
import type { AgyAdapter } from '../adapter/adapter.ts'

type RequestMessage = GenerateOptions['messages'][number]

export interface OpenAiRelayOptions {
  adapter: AgyAdapter
  listAllModels?: () => Promise<readonly LlmModelInfo[]>
  logger?: {
    info?(msg: string): void
    warn?(msg: string): void
    error?(msg: string): void
  }
}

export interface OpenAiMessage {
  role?: string
  content?: unknown
  name?: string
  tool_calls?: Array<{
    id?: string
    type?: string
    function?: {
      name?: string
      arguments?: string
    }
  }>
  tool_call_id?: string
  reasoning_content?: string
  thought?: string
}

export interface OpenAiChatCompletionBody {
  model?: string
  messages?: OpenAiMessage[]
  prompt?: string
  tools?: Array<{
    type?: string
    function?: {
      name?: string
      description?: string
      parameters?: unknown
    }
    name?: string
    description?: string
    parameters?: unknown
  }>
  stream?: boolean
  temperature?: number
  /** Accepted from OpenAI format but ignored (not supported in DSH GenerateOptions) */
  top_p?: number
  stop?: string | string[]
  max_tokens?: number
  max_completion_tokens?: number
  reasoning_effort?: string
  system?: string
  user?: string
  stream_options?: {
    include_usage?: boolean
  }
}

export interface ToolSlotKey {
  index?: number
  id?: string
}

/**
 * Hermes-aligned tool call slot tracker.
 *
 * Maps streamed tool-call events to contiguous 0-based OpenAI indices (`0, 1, 2...`)
 * regardless of whether the upstream engine sends global content indices or UUIDs.
 */
export class ToolSlotTracker {
  private readonly slotByIndex = new Map<number, number>()
  private readonly slotById = new Map<string, number>()
  private readonly idBySlot = new Map<number, string>()
  private nextSlotIndex = 0

  /**
   * Returns the contiguous 0-based OpenAI tool call index, whether this is the first
   * time this tool call slot has been seen, and the stable ID for this tool call.
   */
  getSlot(ref: ToolSlotKey | string | number): { index: number; isFirst: boolean; id: string } {
    let index: number | undefined
    let id: string | undefined

    if (typeof ref === 'number') {
      index = ref
    } else if (typeof ref === 'string') {
      id = ref
    } else if (ref && typeof ref === 'object') {
      index = ref.index
      id = ref.id
    }

    let slot: number | undefined
    let isFirst = false

    if (index !== undefined && this.slotByIndex.has(index)) {
      slot = this.slotByIndex.get(index)
    }

    if (slot === undefined && id && this.slotById.has(id)) {
      slot = this.slotById.get(id)
    }

    if (slot === undefined) {
      slot = this.nextSlotIndex++
      isFirst = true
    }

    if (index !== undefined) {
      this.slotByIndex.set(index, slot)
    }
    if (id) {
      this.slotById.set(id, slot)
    }

    let slotId = this.idBySlot.get(slot)
    if (!slotId) {
      slotId = id || `call_${randomUUID().slice(0, 8)}`
      this.idBySlot.set(slot, slotId)
    }

    return { index: slot, isFirst, id: slotId }
  }

  get size(): number {
    return this.nextSlotIndex
  }
}

/**
 * Creates an HTTP request handler for the `/agy/v1` prefix route.
 */
export function createOpenAiRelayHandler(options: OpenAiRelayOptions) {
  const { adapter, listAllModels, logger } = options

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const rawUrl = req.url ?? '/'
    const parsedUrl = new URL(rawUrl, 'http://127.0.0.1')
    const pathname = parsedUrl.pathname.replace(/\/+$/, '') || '/'

    try {
      if (req.method === 'GET') {
        if (pathname === '/agy/v1' || pathname === '/agy/v1/health') {
          sendJson(res, 200, {
            status: 'ok',
            service: 'dsh-agy openai-compatible relay',
            endpoints: ['/agy/v1/models', '/agy/v1/chat/completions'],
          })
          return
        }

        if (pathname === '/agy/v1/models') {
          const models: readonly { id: string }[] = typeof listAllModels === 'function'
            ? await listAllModels().catch(() => AGY_PUBLIC_MODELS)
            : AGY_PUBLIC_MODELS
          const data = models.map((m) => ({
            id: m.id,
            object: 'model',
            created: 1700000000,
            owned_by: 'google-antigravity',
            permission: [],
            root: m.id,
            parent: null,
          }))
          sendJson(res, 200, { object: 'list', data })
          return
        }

        if (pathname.startsWith('/agy/v1/models/')) {
          const modelId = decodeURIComponent(pathname.slice('/agy/v1/models/'.length))
          sendJson(res, 200, {
            id: modelId,
            object: 'model',
            created: 1700000000,
            owned_by: 'google-antigravity',
            permission: [],
            root: modelId,
            parent: null,
          })
          return
        }

        sendError(res, 404, `Cannot GET ${pathname}`, 'invalid_request_error')
        return
      }

      if (req.method === 'POST') {
        if (pathname === '/agy/v1/chat/completions' || pathname === '/agy/v1/completions') {
          await handleChatCompletions(req, res, adapter, logger)
          return
        }

        sendError(res, 404, `Cannot POST ${pathname}`, 'invalid_request_error')
        return
      }

      sendError(res, 405, `Method ${req.method} not allowed`, 'invalid_request_error')
    } catch (error) {
      logger?.warn?.(`[dsh-agy relay] unexpected error handling ${req.method} ${pathname}: ${String(error)}`)
      handleError(res, error)
    }
  }
}

/**
 * Handle POST /agy/v1/chat/completions request.
 */
async function handleChatCompletions(
  req: IncomingMessage,
  res: ServerResponse,
  adapter: AgyAdapter,
  logger?: { warn?(msg: string): void },
): Promise<void> {
  const bodyText = await readBody(req)
  let body: OpenAiChatCompletionBody
  try {
    body = JSON.parse(bodyText) as OpenAiChatCompletionBody
  } catch {
    sendError(res, 400, 'Invalid JSON body', 'invalid_request_error')
    return
  }

  // Support legacy completions { prompt: "..." }
  if (!Array.isArray(body.messages) && typeof body.prompt === 'string') {
    body.messages = [{ role: 'user', content: body.prompt }]
  }

  if (!Array.isArray(body.messages)) {
    sendError(res, 400, "'messages' is required and must be an array", 'invalid_request_error')
    return
  }

  const registeredAttachmentIds: string[] = []
  const model = normalizeModelName(body.model)
  let messages: RequestMessage[]
  try {
    messages = translateOpenAiMessages(body.messages, adapter, registeredAttachmentIds)
  } catch (err) {
    sendError(res, 400, err instanceof Error ? err.message : String(err), 'invalid_request_error')
    return
  }
  const tools = translateOpenAiTools(body.tools)

  const abortController = new AbortController()
  res.on('close', () => {
    if (!res.writableEnded) {
      abortController.abort()
    }
  })

  const sessionIdHeader = req.headers['x-session-id']
  const sessionId = typeof sessionIdHeader === 'string'
    ? sessionIdHeader
    : (typeof body.user === 'string' ? body.user : undefined)

  const stopList = typeof body.stop === 'string'
    ? [body.stop]
    : (Array.isArray(body.stop) ? body.stop.filter((s): s is string => typeof s === 'string') : undefined)

  const maxTokens = typeof body.max_tokens === 'number'
    ? body.max_tokens
    : (typeof body.max_completion_tokens === 'number' ? body.max_completion_tokens : undefined)

  const generateOptions: GenerateOptions = {
    provider: AGY_PROVIDER,
    model,
    messages,
    tools,
    system: typeof body.system === 'string' ? body.system : undefined,
    temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
    maxTokens,
    stop: stopList,
    reasoningEffort: normalizeReasoningEffort(body.reasoning_effort),
    signal: abortController.signal,
    sessionId: sessionId ? (sessionId as never) : undefined,
  }

  try {
    if (body.stream === true) {
      await handleStreamingCompletion(req, res, adapter, generateOptions, model, body, logger)
    } else {
      await handleNonStreamingCompletion(req, res, adapter, generateOptions, model, body)
    }
  } finally {
    for (const attachmentId of registeredAttachmentIds) {
      adapter.clearMemoryImage(attachmentId)
    }
  }
}

/**
 * Streams chat completion chunks via SSE with deferred HTTP headers and contiguous tool indexing.
 */
async function handleStreamingCompletion(
  req: IncomingMessage,
  res: ServerResponse,
  adapter: AgyAdapter,
  options: GenerateOptions,
  modelName: string,
  body: OpenAiChatCompletionBody,
  logger?: { warn?(msg: string): void },
): Promise<void> {
  const completionId = `chatcmpl-${randomUUID()}`
  const created = Math.floor(Date.now() / 1000)

  const toolSlotTracker = new ToolSlotTracker()
  let finishReason: string = 'stop'
  let lastUsage: TokenUsage | undefined
  let headersSent = false

  try {
    const streamIter = adapter.stream(options)[Symbol.asyncIterator]()

    // Deferred header pattern: await the first chunk before committing HTTP 200 headers.
    // If upstream rejects before yielding (e.g. 401 unauthenticated, 429 quota, 400 invalid model),
    // handleError sends a proper JSON error response with correct HTTP status code.
    let firstResult: IteratorResult<StreamChunk>
    try {
      firstResult = await streamIter.next()
    } catch (initialError) {
      handleError(res, initialError)
      return
    }

    try {
      // Stream connection confirmed -> commit SSE headers
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
      })
      headersSent = true

      // Initial role announcement chunk
      const initialChunk = {
        id: completionId,
        object: 'chat.completion.chunk',
        created,
        model: modelName,
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: '' },
            finish_reason: null,
          },
        ],
      }
      res.write(`data: ${JSON.stringify(initialChunk)}\n\n`)

      const processChunk = (chunk: StreamChunk) => {
        if (chunk.type === 'text-delta') {
          const sseChunk = {
            id: completionId,
            object: 'chat.completion.chunk',
            created,
            model: modelName,
            choices: [
              {
                index: 0,
                delta: { content: chunk.text },
                finish_reason: null,
              },
            ],
          }
          res.write(`data: ${JSON.stringify(sseChunk)}\n\n`)
        } else if (chunk.type === 'reasoning-delta') {
          const sseChunk = {
            id: completionId,
            object: 'chat.completion.chunk',
            created,
            model: modelName,
            choices: [
              {
                index: 0,
                delta: { reasoning_content: chunk.text },
                finish_reason: null,
              },
            ],
          }
          res.write(`data: ${JSON.stringify(sseChunk)}\n\n`)
        } else if (chunk.type === 'tool-call-delta') {
          const { index: slotIndex, isFirst, id: slotId } = toolSlotTracker.getSlot({
            index: chunk.index,
            id: chunk.id ? String(chunk.id) : undefined,
          })

          const toolCallDelta: {
            index: number
            id?: string
            type?: string
            function: {
              name?: string
              arguments: string
            }
          } = {
            index: slotIndex,
            function: {
              arguments: chunk.argumentsDelta,
            },
          }

          if (isFirst) {
            toolCallDelta.id = slotId
            toolCallDelta.type = 'function'
            if (chunk.name) {
              toolCallDelta.function.name = chunk.name
            }
          }

          const sseChunk = {
            id: completionId,
            object: 'chat.completion.chunk',
            created,
            model: modelName,
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [toolCallDelta],
                },
                finish_reason: null,
              },
            ],
          }
          res.write(`data: ${JSON.stringify(sseChunk)}\n\n`)
        } else if (chunk.type === 'usage') {
          lastUsage = chunk.usage
        } else if (chunk.type === 'finish') {
          finishReason = mapFinishReason(chunk.reason, toolSlotTracker.size > 0)
        }
      }

      if (!firstResult.done && firstResult.value) {
        processChunk(firstResult.value)
      }

      while (!firstResult.done) {
        if (res.writableEnded || options.signal?.aborted) break
        const nextResult = await streamIter.next()
        if (nextResult.done) break
        processChunk(nextResult.value)
      }

      // Trailing finish chunk
      const finishChunk = {
        id: completionId,
        object: 'chat.completion.chunk',
        created,
        model: modelName,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: finishReason,
          },
        ],
      }
      res.write(`data: ${JSON.stringify(finishChunk)}\n\n`)

      if (lastUsage && body.stream_options?.include_usage) {
        const usageChunk = {
          id: completionId,
          object: 'chat.completion.chunk',
          created,
          model: modelName,
          choices: [],
          usage: formatUsage(lastUsage),
        }
        res.write(`data: ${JSON.stringify(usageChunk)}\n\n`)
      }

      res.write('data: [DONE]\n\n')
      res.end()
    } finally {
      await streamIter.return?.()
    }
  } catch (error) {
    logger?.warn?.(`[dsh-agy relay] streaming completion interrupted: ${String(error)}`)
    if (!headersSent) {
      handleError(res, error)
    } else if (!res.writableEnded) {
      const errPayload = {
        error: {
          message: error instanceof Error ? error.message : String(error),
          type: 'server_error',
          code: 'internal_error',
        },
      }
      res.write(`data: ${JSON.stringify(errPayload)}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    }
  }
}

/**
 * Handle non-streaming completion requests.
 */
async function handleNonStreamingCompletion(
  req: IncomingMessage,
  res: ServerResponse,
  adapter: AgyAdapter,
  options: GenerateOptions,
  modelName: string,
  _body: OpenAiChatCompletionBody,
): Promise<void> {
  const completionId = `chatcmpl-${randomUUID()}`
  const created = Math.floor(Date.now() / 1000)

  let content = ''
  let reasoningContent = ''
  const toolSlotTracker = new ToolSlotTracker()
  const toolCallsByIndex = new Map<number, { id: string; type: 'function'; function: { name: string; arguments: string } }>()
  let finishReason: string = 'stop'
  let lastUsage: TokenUsage | undefined

  try {
    for await (const chunk of adapter.stream(options)) {
      if (res.writableEnded || options.signal?.aborted) break

      if (chunk.type === 'text-delta') {
        content += chunk.text
      } else if (chunk.type === 'reasoning-delta') {
        reasoningContent += chunk.text
      } else if (chunk.type === 'tool-call-delta') {
        const { index: slotIndex, id: slotId } = toolSlotTracker.getSlot({
          index: chunk.index,
          id: chunk.id ? String(chunk.id) : undefined,
        })
        let tc = toolCallsByIndex.get(slotIndex)
        if (!tc) {
          tc = {
            id: slotId,
            type: 'function',
            function: {
              name: chunk.name ?? '',
              arguments: '',
            },
          }
          toolCallsByIndex.set(slotIndex, tc)
        }
        if (chunk.name && !tc.function.name) {
          tc.function.name = chunk.name
        }
        tc.function.arguments += chunk.argumentsDelta
      } else if (chunk.type === 'usage') {
        lastUsage = chunk.usage
      } else if (chunk.type === 'finish') {
        finishReason = mapFinishReason(chunk.reason, toolSlotTracker.size > 0)
      }
    }

    const toolCalls = Array.from(toolCallsByIndex.entries())
      .sort(([a], [b]) => a - b)
      .map(([, tc]) => tc)

    const message: {
      role: string
      content: string | null
      reasoning_content?: string
      tool_calls?: typeof toolCalls
    } = {
      role: 'assistant',
      content: content.length > 0 ? content : (toolCalls.length > 0 ? null : ''),
    }
    if (reasoningContent.length > 0) {
      message.reasoning_content = reasoningContent
    }
    if (toolCalls.length > 0) {
      message.tool_calls = toolCalls
    }

    const response = {
      id: completionId,
      object: 'chat.completion',
      created,
      model: modelName,
      choices: [
        {
          index: 0,
          message,
          finish_reason: finishReason,
        },
      ],
      usage: formatUsage(lastUsage),
    }

    sendJson(res, 200, response)
  } catch (error) {
    handleError(res, error)
  }
}

/**
 * Normalizes OpenAI model names (stripping common namespace prefixes).
 */
export function normalizeModelName(raw?: string): string {
  if (!raw || typeof raw !== 'string') return 'gemini-3.8-flash-tiered'
  let m = raw.trim()
  if (m.startsWith('agy/')) m = m.slice(4)
  else if (m.startsWith('google/')) m = m.slice(7)
  else if (m.startsWith('antigravity/')) m = m.slice(12)
  else if (m.startsWith('openai/')) m = m.slice(7)
  return m || 'gemini-3.8-flash-tiered'
}

/**
 * Normalizes reasoning effort string into DSH ReasoningEffortId.
 */
export function normalizeReasoningEffort(effort?: string): ReasoningEffortId | undefined {
  if (!effort || typeof effort !== 'string') return undefined
  const lower = effort.toLowerCase()
  if (lower === 'low') return 'low' as ReasoningEffortId
  if (lower === 'medium') return 'medium' as ReasoningEffortId
  if (lower === 'high' || lower === 'max') return 'high' as ReasoningEffortId
  return undefined
}

/**
 * Maps OpenAI tools into DSH ToolSchema[].
 */
export function translateOpenAiTools(tools?: OpenAiChatCompletionBody['tools']): ToolSchema[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined
  return tools.map((t) => ({
    name: t.function?.name ?? t.name ?? '',
    description: t.function?.description ?? t.description ?? '',
    parameters: (t.function?.parameters ?? t.parameters ?? {}) as ToolSchema['parameters'],
  }))
}

/**
 * Translates OpenAI message list into DSH RequestMessage[].
 * Supports multimodal image_url (data URIs), assistant reasoning_content, tool_calls, and tool results.
 */
export function translateOpenAiMessages(
  messages: OpenAiMessage[],
  adapter?: AgyAdapter,
  registeredAttachmentIds?: string[],
): RequestMessage[] {
  const result: RequestMessage[] = []

  for (const m of messages) {
    if (!m || typeof m !== 'object') continue
    const role = m.role

    if (role === 'system' || role === 'developer') {
      const text = extractTextContent(m.content)
      result.push({
        id: randomUUID(),
        role: 'system',
        content: [{ type: 'text', text }],
      } as unknown as RequestMessage)
    } else if (role === 'user') {
      const blocks: Array<
        | { type: 'text'; text: string }
        | { type: 'image'; attachment: { attachmentId: string; mediaType: string } }
      > = []

      if (typeof m.content === 'string') {
        blocks.push({ type: 'text', text: m.content })
      } else if (Array.isArray(m.content)) {
        for (const part of m.content) {
          if (typeof part === 'string') {
            blocks.push({ type: 'text', text: part })
          } else if (part && typeof part === 'object') {
            const p = part as Record<string, unknown>
            if (p.type === 'text' && typeof p.text === 'string') {
              blocks.push({ type: 'text', text: p.text })
            } else if (p.type === 'image_url' || p.image_url) {
              const imgUrlObj = (p.image_url ?? p) as { url?: unknown }
              const url = typeof imgUrlObj.url === 'string' ? imgUrlObj.url : (typeof p.image_url === 'string' ? p.image_url : undefined)
              if (url && typeof url === 'string') {
                if (url.startsWith('data:')) {
                  const match = url.match(/^data:([^;]+);base64,([\s\S]+)$/)
                  if (match && match[2]!.trim().length > 0) {
                    const mediaType = match[1]!
                    const base64Data = match[2]!.replace(/\s+/g, '')
                    const attachmentId = `relay-img-${randomUUID()}`
                    adapter?.registerMemoryImage(attachmentId, { mediaType, data: base64Data })
                    registeredAttachmentIds?.push(attachmentId)
                    blocks.push({
                      type: 'image',
                      attachment: {
                        attachmentId,
                        mediaType,
                      },
                    })
                  } else {
                    throw new Error(`Malformed data URI for image (expected 'data:<media-type>;base64,<data>')`)
                  }
                } else {
                  throw new Error(`Remote image URLs ('${url.slice(0, 32)}...') are not supported; please provide base64 data URIs ('data:<media-type>;base64,<data>')`)
                }
              } else {
                throw new Error("Malformed image part: missing 'url' in 'image_url'")
              }
            } else if (typeof p.text === 'string') {
              blocks.push({ type: 'text', text: p.text })
            }
          }
        }
      }
      if (blocks.length === 0) {
        blocks.push({ type: 'text', text: '' })
      }
      result.push({
        id: randomUUID(),
        role: 'user',
        content: blocks,
      } as unknown as RequestMessage)
    } else if (role === 'assistant') {
      const blocks: Array<
        | { type: 'text'; text: string }
        | { type: 'reasoning'; text: string }
        | { type: 'tool-call'; id: string; name: string; arguments: string }
      > = []

      const reasoning = m.reasoning_content || m.thought
      if (typeof reasoning === 'string' && reasoning.length > 0) {
        blocks.push({ type: 'reasoning', text: reasoning })
      }

      if (typeof m.content === 'string' && m.content.length > 0) {
        blocks.push({ type: 'text', text: m.content })
      } else if (Array.isArray(m.content)) {
        for (const part of m.content) {
          if (typeof part === 'string') {
            blocks.push({ type: 'text', text: part })
          } else if (part && typeof part === 'object') {
            const p = part as Record<string, unknown>
            if ((p.type === 'reasoning' || p.type === 'thinking') && (typeof p.reasoning === 'string' || typeof p.text === 'string')) {
              blocks.push({ type: 'reasoning', text: String(p.reasoning || p.text) })
            } else if (p.type === 'text' && typeof p.text === 'string') {
              blocks.push({ type: 'text', text: p.text })
            }
          }
        }
      }

      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          const args = typeof tc.function?.arguments === 'string'
            ? tc.function.arguments
            : JSON.stringify(tc.function?.arguments ?? {})
          blocks.push({
            type: 'tool-call',
            id: tc.id || `call_${randomUUID().slice(0, 8)}`,
            name: tc.function?.name ?? '',
            arguments: args,
          })
        }
      }

      if (blocks.length === 0) {
        blocks.push({ type: 'text', text: '' })
      }

      result.push({
        id: randomUUID(),
        role: 'assistant',
        content: blocks,
      } as unknown as RequestMessage)
    } else if (role === 'tool') {
      const text = extractTextContent(m.content)
      result.push({
        id: randomUUID(),
        role: 'tool',
        toolCallId: m.tool_call_id || '',
        content: [{ type: 'text', text }],
      } as unknown as RequestMessage)
    } else if (role === 'function') {
      const text = extractTextContent(m.content)
      result.push({
        id: randomUUID(),
        role: 'tool',
        toolCallId: m.name || '',
        content: [{ type: 'text', text }],
      } as unknown as RequestMessage)
    }
  }

  return result
}

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (content === null || content === undefined) return ''
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part === 'object' && 'text' in part && typeof (part as { text: unknown }).text === 'string') {
          return (part as { text: string }).text
        }
        return ''
      })
      .join('\n')
  }
  return JSON.stringify(content)
}

function mapFinishReason(reason?: { kind: string }, hasToolCalls = false): string {
  if (hasToolCalls) return 'tool_calls'
  if (!reason) return 'stop'
  switch (reason.kind) {
    case 'tool-calls':
      return 'tool_calls'
    case 'max-tokens':
      return 'length'
    case 'stop':
    default:
      return 'stop'
  }
}

function formatUsage(usage?: TokenUsage) {
  if (!usage) {
    return {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    }
  }
  const cached = usage.cacheReadTokens ?? 0
  const prompt = usage.inputTokens + cached
  const completion = usage.outputTokens
  const reasoningTokens = usage.reasoningTokens ?? 0
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    prompt_tokens_details: {
      cached_tokens: cached,
    },
    completion_tokens_details: {
      reasoning_tokens: reasoningTokens,
    },
  }
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const json = JSON.stringify(data)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
  })
  res.end(json)
}

function sendError(
  res: ServerResponse,
  status: number,
  message: string,
  type = 'invalid_request_error',
  code?: string,
): void {
  sendJson(res, status, {
    error: {
      message,
      type,
      param: null,
      code: code ?? (status === 401 ? 'invalid_api_key' : status === 404 ? 'not_found' : 'invalid_request_error'),
    },
  })
}

function handleError(res: ServerResponse, error: unknown): void {
  if (res.headersSent) {
    if (!res.writableEnded) res.end()
    return
  }

  let status = 500
  let code = 'internal_error'
  let type = 'api_error'

  if (error instanceof LlmError) {
    if (error.code === 'RATE_LIMIT' || error.code === 'QUOTA_EXCEEDED') {
      status = 429
      code = 'insufficient_quota'
      type = 'insufficient_quota'
    } else if (error.code === 'INVALID_CREDENTIAL' || error.code === 'NO_CREDENTIAL') {
      status = 401
      code = 'invalid_api_key'
      type = 'invalid_request_error'
    } else if (error.code === 'UNSUPPORTED_CONTENT') {
      status = 400
      code = 'unsupported_content'
      type = 'invalid_request_error'
    }
  }

  // Structured HTTP status code if present on the error object
  if (status === 500 && error && typeof error === 'object') {
    const errObj = error as { status?: unknown; statusCode?: unknown; httpStatus?: unknown }
    const rawStatus = typeof errObj.status === 'number'
      ? errObj.status
      : (typeof errObj.statusCode === 'number'
        ? errObj.statusCode
        : (typeof errObj.httpStatus === 'number' ? errObj.httpStatus : undefined))

    if (rawStatus && rawStatus >= 400 && rawStatus < 600) {
      status = rawStatus
      if (status === 404) {
        code = 'model_not_found'
        type = 'invalid_request_error'
      } else if (status === 400) {
        code = 'invalid_request_error'
        type = 'invalid_request_error'
      } else if (status === 401 || status === 403) {
        code = 'invalid_api_key'
        type = 'invalid_request_error'
      } else if (status === 429) {
        code = 'insufficient_quota'
        type = 'insufficient_quota'
      }
    }
  }

  if (status === 500 && error instanceof Error) {
    const msg = error.message
    if (/404|NOT_FOUND|not found/i.test(msg)) {
      status = 404
      code = 'model_not_found'
      type = 'invalid_request_error'
    } else if (/400|INVALID_ARGUMENT|invalid argument/i.test(msg)) {
      status = 400
      code = 'invalid_request_error'
      type = 'invalid_request_error'
    } else if (/401|403|UNAUTHENTICATED|PERMISSION_DENIED|invalid credential/i.test(msg)) {
      status = 401
      code = 'invalid_api_key'
      type = 'invalid_request_error'
    } else if (/429|RESOURCE_EXHAUSTED|quota/i.test(msg)) {
      status = 429
      code = 'insufficient_quota'
      type = 'insufficient_quota'
    }
  }

  sendJson(res, status, {
    error: {
      message: error instanceof Error ? error.message : String(error),
      type,
      param: null,
      code,
    },
  })
}

async function readBody(req: IncomingMessage, limit = 10 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let totalLength = 0
    req.on('data', (chunk: Buffer) => {
      totalLength += chunk.length
      if (totalLength > limit) {
        reject(new Error('Request body exceeds limit'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf-8'))
    })
    req.on('error', reject)
  })
}
