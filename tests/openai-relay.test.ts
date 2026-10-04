import { createServer, type Server } from 'node:http'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  LlmError,
  type GenerateOptions,
  type StreamChunk,
  type LlmModelInfo,
} from '@deepseek-ai/dsh-llm'
import {
  ToolSlotTracker,
  createOpenAiRelayHandler,
  normalizeModelName,
  normalizeReasoningEffort,
  resolveRelayModel,
  translateOpenAiMessages,
  translateOpenAiTools,
} from '../src/web/openai-relay.ts'
import type { AgyAdapter } from '../src/adapter/adapter.ts'

describe('ToolSlotTracker', () => {
  it('assigns contiguous 0-based indices and reports isFirst correctly', () => {
    const tracker = new ToolSlotTracker()
    expect(tracker.size).toBe(0)

    const first = tracker.getSlot({ id: 'call_abc', index: 10 })
    expect(first.index).toBe(0)
    expect(first.isFirst).toBe(true)
    expect(first.id).toBe('call_abc')
    expect(tracker.size).toBe(1)

    // Repeat same slot by index
    const second = tracker.getSlot({ index: 10 })
    expect(second.index).toBe(0)
    expect(second.isFirst).toBe(false)
    expect(second.id).toBe('call_abc')

    // Second slot
    const third = tracker.getSlot({ id: 'call_def', index: 11 })
    expect(third.index).toBe(1)
    expect(third.isFirst).toBe(true)
    expect(third.id).toBe('call_def')
    expect(tracker.size).toBe(2)

    // Arbitrary key
    const fourth = tracker.getSlot(99)
    expect(fourth.index).toBe(2)
    expect(fourth.isFirst).toBe(true)
    expect(tracker.size).toBe(3)
  })
})

describe('OpenAI Relay translation helpers', () => {
  it('normalizes model names with various prefixes', () => {
    expect(normalizeModelName(undefined)).toBe('gemini-3.8-flash-tiered')
    expect(normalizeModelName('')).toBe('gemini-3.8-flash-tiered')
    expect(normalizeModelName('gemini-3.8-flash-tiered')).toBe('gemini-3.8-flash-tiered')
    expect(normalizeModelName('agy/gemini-2.5-pro')).toBe('gemini-2.5-pro')
    expect(normalizeModelName('google/gemini-3.8-flash')).toBe('gemini-3.8-flash')
    expect(normalizeModelName('antigravity/claude-3-7-sonnet')).toBe('claude-3-7-sonnet')
    expect(normalizeModelName('openai/gpt-4o')).toBe('gpt-4o')
  })

  it('normalizes reasoning effort', () => {
    expect(normalizeReasoningEffort('low')).toBe('low')
    expect(normalizeReasoningEffort('MEDIUM')).toBe('medium')
    expect(normalizeReasoningEffort('high')).toBe('high')
    expect(normalizeReasoningEffort('max')).toBe('high')
    expect(normalizeReasoningEffort('invalid')).toBeUndefined()
    expect(normalizeReasoningEffort(undefined)).toBeUndefined()
  })

  it('maps official CLI-style names onto account ids (tiered aliases pin the effort)', () => {
    expect(resolveRelayModel('gemini-3.8-flash-high')).toEqual({ id: 'gemini-3.8-flash-tiered', effort: 'high' })
    expect(resolveRelayModel('gemini-3.8-flash-medium')).toEqual({ id: 'gemini-3.8-flash-tiered', effort: 'medium' })
    expect(resolveRelayModel('gemini-3.8-flash-low')).toEqual({ id: 'gemini-3.8-flash-tiered', effort: 'low' })
    expect(resolveRelayModel('gemini-3.7-flash-high')).toEqual({ id: 'gemini-3.7-flash-tiered', effort: 'high' })
    expect(resolveRelayModel('gemini-3.7-flash-medium')).toEqual({ id: 'gemini-3.7-flash-tiered', effort: 'medium' })
    expect(resolveRelayModel('gemini-3.7-flash-low')).toEqual({ id: 'gemini-3.7-flash-tiered', effort: 'low' })
    expect(resolveRelayModel('gemini-3.1-pro-high')).toEqual({ id: 'gemini-pro-agent' })
    // Bare display ids and legacy ids, mirroring OmniRoute's reference table.
    expect(resolveRelayModel('gemini-3.7-flash')).toEqual({ id: 'gemini-3.7-flash-tiered' })
    expect(resolveRelayModel('gemini-3.8-flash')).toEqual({ id: 'gemini-3.8-flash-tiered', effort: 'high' })
    expect(resolveRelayModel('gpt-oss-120b')).toEqual({ id: 'gpt-oss-120b-medium' })
    expect(resolveRelayModel('gemini-claude-sonnet-4-5')).toEqual({ id: 'claude-sonnet-4-6' })
    expect(resolveRelayModel('gemini-claude-sonnet-4-5-thinking')).toEqual({ id: 'claude-sonnet-4-6' })
    expect(resolveRelayModel('gemini-claude-opus-4-5-thinking')).toEqual({ id: 'claude-opus-4-6-thinking' })
  })

  it('leaves real ids alone; alias resolution runs after prefix stripping', () => {
    expect(resolveRelayModel('gemini-3.6-flash-high')).toEqual({ id: 'gemini-3.6-flash-high' })
    expect(resolveRelayModel('gemini-3.1-pro-low')).toEqual({ id: 'gemini-3.1-pro-low' })
    expect(resolveRelayModel('gpt-oss-120b-medium')).toEqual({ id: 'gpt-oss-120b-medium' })
    expect(resolveRelayModel('claude-sonnet-4-6')).toEqual({ id: 'claude-sonnet-4-6' })
    expect(resolveRelayModel('gemini-3.8-flash-tiered')).toEqual({ id: 'gemini-3.8-flash-tiered' })
    expect(resolveRelayModel('agy/gemini-3.8-flash-high')).toEqual({ id: 'gemini-3.8-flash-tiered', effort: 'high' })
    expect(resolveRelayModel(undefined)).toEqual({ id: 'gemini-3.8-flash-tiered' })
    expect(resolveRelayModel('')).toEqual({ id: 'gemini-3.8-flash-tiered' })
  })

  it('translates OpenAI tools schema', () => {
    const tools = translateOpenAiTools([
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get current weather',
          parameters: {
            type: 'object',
            properties: { location: { type: 'string' } },
            required: ['location'],
          },
        },
      },
    ])
    expect(tools).toHaveLength(1)
    expect(tools![0]).toEqual({
      name: 'get_weather',
      description: 'Get current weather',
      parameters: {
        type: 'object',
        properties: { location: { type: 'string' } },
        required: ['location'],
      },
    })
  })

  it('translates OpenAI messages including reasoning, tool calls, and legacy tools', () => {
    const rawMessages = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'developer', content: 'Developer prompt.' },
      { role: 'user', content: 'Hello world' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Part 1' },
          { type: 'text', text: 'Part 2' },
        ],
      },
      {
        role: 'assistant',
        reasoning_content: 'Let me think...',
        content: 'I will run a tool',
        tool_calls: [
          {
            id: 'call_123',
            type: 'function',
            function: {
              name: 'calculator',
              arguments: '{"expr":"1+1"}',
            },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'call_123',
        content: '2',
      },
      {
        role: 'function',
        name: 'legacy_fn',
        content: 'done',
      },
    ]

    const translated = translateOpenAiMessages(rawMessages)
    expect(translated).toHaveLength(7)

    expect(translated[0].role).toBe('system')
    expect(translated[0].content).toEqual([{ type: 'text', text: 'You are helpful.' }])

    expect(translated[1].role).toBe('system')
    expect(translated[1].content).toEqual([{ type: 'text', text: 'Developer prompt.' }])

    expect(translated[2].role).toBe('user')
    expect(translated[2].content).toEqual([{ type: 'text', text: 'Hello world' }])

    expect(translated[3].role).toBe('user')
    expect(translated[3].content).toEqual([
      { type: 'text', text: 'Part 1' },
      { type: 'text', text: 'Part 2' },
    ])

    expect(translated[4].role).toBe('assistant')
    expect(translated[4].content).toEqual([
      { type: 'reasoning', text: 'Let me think...' },
      { type: 'text', text: 'I will run a tool' },
      {
        type: 'tool-call',
        id: 'call_123',
        name: 'calculator',
        arguments: '{"expr":"1+1"}',
      },
    ])

    expect(translated[5].role).toBe('tool')
    expect(translated[5].content).toEqual([{ type: 'text', text: '2' }])

    expect(translated[6].role).toBe('tool')
    expect(translated[6].content).toEqual([{ type: 'text', text: 'done' }])
  })

  it('translates multimodal image_url with data URIs and registers in adapter memory store', () => {
    const memoryImages = new Map<string, { mediaType: string; data: string }>()
    const registeredIds: string[] = []
    const mockAdapter = {
      registerMemoryImage(id: string, img: { mediaType: string; data: string }) {
        memoryImages.set(id, img)
      },
    } as unknown as AgyAdapter

    const rawMessages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Look at this picture:' },
          {
            type: 'image_url',
            image_url: {
              url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk\n+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==\n',
            },
          },
        ],
      },
    ]

    const translated = translateOpenAiMessages(rawMessages, mockAdapter, registeredIds)
    expect(translated).toHaveLength(1)
    expect(translated[0].role).toBe('user')
    const blocks = translated[0].content as Array<{ type: string; text?: string; attachment?: { attachmentId: string; mediaType: string } }>
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toEqual({ type: 'text', text: 'Look at this picture:' })
    expect(blocks[1].type).toBe('image')
    expect(blocks[1].attachment?.mediaType).toBe('image/png')
    expect(blocks[1].attachment?.attachmentId).toMatch(/^relay-img-/)
    expect(registeredIds).toHaveLength(1)
    expect(registeredIds[0]).toBe(blocks[1].attachment?.attachmentId)

    // Memory image was registered without newline/spaces
    expect(memoryImages.size).toBe(1)
    const registered = memoryImages.get(blocks[1].attachment!.attachmentId)
    expect(registered?.mediaType).toBe('image/png')
    expect(registered?.data).toBe('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==')
  })

  it('throws descriptive error when given remote http/https image URL', () => {
    const rawMessages = [
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: {
              url: 'https://example.com/image.png',
            },
          },
        ],
      },
    ]

    expect(() => translateOpenAiMessages(rawMessages)).toThrow(
      /Remote image URLs .* are not supported/,
    )
  })

  it('throws descriptive error when given malformed data URI', () => {
    const rawMessages = [
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: {
              url: 'data:image/png;notbase64',
            },
          },
        ],
      },
    ]

    expect(() => translateOpenAiMessages(rawMessages)).toThrow(
      /Malformed data URI for image/,
    )
  })

  it('throws descriptive error when image_url object is missing url', () => {
    const rawMessages = [
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: {} as { url: string },
          },
        ],
      },
    ]

    expect(() => translateOpenAiMessages(rawMessages)).toThrow(
      /Malformed image part: missing 'url'/,
    )
  })
})

describe('OpenAI Relay HTTP endpoints', () => {
  let server: Server
  let baseUrl: string
  let mockStreamChunks: StreamChunk[] = []
  let mockStreamError: Error | undefined
  let lastCapturedOptions: GenerateOptions | undefined

  const mockAdapter: Partial<AgyAdapter> = {
    // eslint-disable-next-line @typescript-eslint/require-await
    async *stream(options: GenerateOptions) {
      lastCapturedOptions = options
      if (mockStreamError) {
        throw mockStreamError
      }
      for (const chunk of mockStreamChunks) {
        yield chunk
      }
    },
  }

  const mockListAllModels = vi.fn(async (): Promise<readonly LlmModelInfo[]> => [
    {
      id: 'gemini-3.8-flash-tiered',
      name: 'Gemini 3.8 Flash Tiered',
      provider: 'agy',
      reasoningEfforts: ['low', 'medium', 'high'],
    } as unknown as LlmModelInfo,
    {
      id: 'claude-3-7-sonnet-tiered',
      name: 'Claude 3.7 Sonnet Tiered',
      provider: 'agy',
      reasoningEfforts: [],
    } as unknown as LlmModelInfo,
  ])

  beforeEach(async () => {
    mockStreamChunks = []
    mockStreamError = undefined
    lastCapturedOptions = undefined
    const handler = createOpenAiRelayHandler({
      adapter: mockAdapter as AgyAdapter,
      listAllModels: mockListAllModels,
    })

    server = createServer((req, res) => {
      void handler(req, res)
    })

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const port = (server.address() as { port: number }).port
    baseUrl = `http://127.0.0.1:${port}`
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('handles OPTIONS preflight', async () => {
    const res = await fetch(`${baseUrl}/agy/v1/chat/completions`, { method: 'OPTIONS' })
    expect(res.status).toBe(204)
  })

  it('handles GET /agy/v1 health', async () => {
    const res = await fetch(`${baseUrl}/agy/v1`)
    expect(res.status).toBe(200)
    const json = (await res.json()) as { status: string; endpoints: string[] }
    expect(json.status).toBe('ok')
    expect(json.endpoints).toContain('/agy/v1/chat/completions')
  })

  it('handles GET /agy/v1/models', async () => {
    const res = await fetch(`${baseUrl}/agy/v1/models`)
    expect(res.status).toBe(200)
    const json = (await res.json()) as { object: string; data: Array<{ id: string }> }
    expect(json.object).toBe('list')
    expect(json.data.map((m) => m.id)).toContain('gemini-3.8-flash-tiered')
    expect(json.data.map((m) => m.id)).toContain('claude-3-7-sonnet-tiered')
  })

  it('handles GET /agy/v1/models/:modelId', async () => {
    const res = await fetch(`${baseUrl}/agy/v1/models/gemini-3.8-flash-tiered`)
    expect(res.status).toBe(200)
    const json = (await res.json()) as { id: string; object: string }
    expect(json.id).toBe('gemini-3.8-flash-tiered')
    expect(json.object).toBe('model')
  })

  it('routes official CLI-style names through the alias map (name tier beats body effort)', async () => {
    mockStreamChunks = [
      { type: 'text-delta', text: 'Hello' },
      { type: 'finish', reason: { kind: 'stop' } },
    ]

    const res = await fetch(`${baseUrl}/agy/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gemini-3.8-flash-medium',
        messages: [{ role: 'user', content: 'Hi' }],
        reasoning_effort: 'low',
        stream: false,
      }),
    })

    expect(res.status).toBe(200)
    expect(lastCapturedOptions).toBeDefined()
    expect(lastCapturedOptions!.model).toBe('gemini-3.8-flash-tiered')
    expect(lastCapturedOptions!.reasoningEffort).toBe('medium')
  })

  it('forwards sampling options (stop, temperature, max_tokens, reasoning_effort) to adapter', async () => {
    mockStreamChunks = [
      { type: 'text-delta', text: 'Hello' },
      { type: 'finish', reason: { kind: 'stop' } },
    ]

    const res = await fetch(`${baseUrl}/agy/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gemini-3.8-flash-tiered',
        messages: [{ role: 'user', content: 'Hi' }],
        stop: ['STOP_HERE', 'HALT'],
        temperature: 0.7,
        max_tokens: 1500,
        reasoning_effort: 'high',
        stream: false,
      }),
    })

    expect(res.status).toBe(200)
    expect(lastCapturedOptions).toBeDefined()
    expect(lastCapturedOptions!.stop).toEqual(['STOP_HERE', 'HALT'])
    expect(lastCapturedOptions!.temperature).toBe(0.7)
    expect(lastCapturedOptions!.maxTokens).toBe(1500)
    expect(lastCapturedOptions!.reasoningEffort).toBe('high')
  })

  it('handles non-streaming POST /agy/v1/chat/completions', async () => {
    mockStreamChunks = [
      { type: 'reasoning-delta', text: 'thinking...' },
      { type: 'text-delta', text: 'Hello, ' },
      { type: 'text-delta', text: 'world!' },
      {
        type: 'usage',
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, reasoningTokens: 3 },
      },
      { type: 'finish', reason: { kind: 'stop' } },
    ]

    const res = await fetch(`${baseUrl}/agy/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gemini-3.8-flash-tiered',
        messages: [{ role: 'user', content: 'Hi' }],
        stream: false,
      }),
    })

    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      object: string
      model: string
      choices: Array<{
        message: {
          role: string
          content: string
          reasoning_content?: string
        }
        finish_reason: string
      }>
      usage: {
        prompt_tokens: number
        completion_tokens: number
        total_tokens: number
        completion_tokens_details?: { reasoning_tokens?: number }
      }
    }

    expect(json.object).toBe('chat.completion')
    expect(json.model).toBe('gemini-3.8-flash-tiered')
    expect(json.choices[0].message.role).toBe('assistant')
    expect(json.choices[0].message.content).toBe('Hello, world!')
    expect(json.choices[0].message.reasoning_content).toBe('thinking...')
    expect(json.choices[0].finish_reason).toBe('stop')
    expect(json.usage.prompt_tokens).toBe(12) // 10 + 2 cached
    expect(json.usage.completion_tokens).toBe(5)
    expect(json.usage.total_tokens).toBe(17)
    expect(json.usage.completion_tokens_details?.reasoning_tokens).toBe(3)
  })

  it('handles non-streaming completions with tool calls and assigns 0-based slots', async () => {
    mockStreamChunks = [
      {
        type: 'tool-call-delta',
        index: 5, // Non-zero upstream index
        id: 'call_999' as never,
        name: 'search',
        argumentsDelta: '{"q":',
      },
      {
        type: 'tool-call-delta',
        index: 5,
        argumentsDelta: '"weather"}',
      },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ]

    const res = await fetch(`${baseUrl}/agy/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gemini-3.8-flash-tiered',
        messages: [{ role: 'user', content: 'What is the weather?' }],
        stream: false,
      }),
    })

    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      choices: Array<{
        message: {
          role: string
          content: string | null
          tool_calls?: Array<{
            id: string
            type: string
            function: { name: string; arguments: string }
          }>
        }
        finish_reason: string
      }>
    }

    expect(json.choices[0].finish_reason).toBe('tool_calls')
    expect(json.choices[0].message.tool_calls).toHaveLength(1)
    expect(json.choices[0].message.tool_calls![0]).toEqual({
      id: 'call_999',
      type: 'function',
      function: {
        name: 'search',
        arguments: '{"q":"weather"}',
      },
    })
  })

  it('registers and automatically cleans up in-memory image attachments after request completes', async () => {
    mockStreamChunks = [
      { type: 'text-delta', text: 'I see an image' },
      { type: 'finish', reason: { kind: 'stop' } },
    ]

    const registeredIds: string[] = []
    const clearedIds: string[] = []
    ;(mockAdapter as any).registerMemoryImage = (id: string) => registeredIds.push(id)
    ;(mockAdapter as any).clearMemoryImage = (id: string) => clearedIds.push(id)

    const res = await fetch(`${baseUrl}/agy/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gemini-3.8-flash-tiered',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Analyze this' },
              {
                type: 'image_url',
                image_url: {
                  url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
                },
              },
            ],
          },
        ],
        stream: false,
      }),
    })

    expect(res.status).toBe(200)
    expect(registeredIds).toHaveLength(1)
    expect(clearedIds).toHaveLength(1)
    expect(clearedIds[0]).toBe(registeredIds[0])
  })

  it('handles streaming POST /agy/v1/chat/completions with SSE', async () => {
    mockStreamChunks = [
      { type: 'reasoning-delta', text: 'thinking...' },
      { type: 'text-delta', text: 'chunk 1 ' },
      { type: 'text-delta', text: 'chunk 2' },
      {
        type: 'usage',
        usage: { inputTokens: 5, outputTokens: 4 },
      },
      { type: 'finish', reason: { kind: 'stop' } },
    ]

    const res = await fetch(`${baseUrl}/agy/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gemini-3.8-flash-tiered',
        messages: [{ role: 'user', content: 'stream please' }],
        stream: true,
        stream_options: { include_usage: true },
      }),
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')

    const sseBody = await res.text()
    expect(sseBody).toContain('data: ')
    expect(sseBody).toContain('data: [DONE]')

    // Parse events
    const lines = sseBody.split('\n')
    const events: Array<Record<string, unknown>> = []
    for (const line of lines) {
      if (line.startsWith('data: ') && !line.includes('[DONE]')) {
        events.push(JSON.parse(line.slice(6)) as Record<string, unknown>)
      }
    }

    expect(events.length).toBeGreaterThanOrEqual(4)
    // Initial role chunk
    expect(events[0].choices).toEqual([
      { index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null },
    ])

    // Find reasoning delta
    const reasoningEvent = events.find((e) => {
      const choices = e.choices as Array<{ delta?: { reasoning_content?: string } }>
      return choices?.[0]?.delta?.reasoning_content === 'thinking...'
    })
    expect(reasoningEvent).toBeDefined()

    // Find text deltas
    const textEvent1 = events.find((e) => {
      const choices = e.choices as Array<{ delta?: { content?: string } }>
      return choices?.[0]?.delta?.content === 'chunk 1 '
    })
    expect(textEvent1).toBeDefined()

    // Find finish chunk
    const finishEvent = events.find((e) => {
      const choices = e.choices as Array<{ finish_reason?: string }>
      return choices?.[0]?.finish_reason === 'stop'
    })
    expect(finishEvent).toBeDefined()

    // Find usage chunk
    const usageEvent = events.find((e) => e.usage !== undefined)
    expect(usageEvent).toBeDefined()
  })

  it('handles streaming completions with tool calls and normalizes indices to 0-based slots', async () => {
    mockStreamChunks = [
      {
        type: 'tool-call-delta',
        index: 10, // upstream arbitrary index
        id: 'call_abc' as never,
        name: 'get_time',
        argumentsDelta: '{"zone":',
      },
      {
        type: 'tool-call-delta',
        index: 10,
        argumentsDelta: '"UTC"}',
      },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ]

    const res = await fetch(`${baseUrl}/agy/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gemini-3.8-flash-tiered',
        messages: [{ role: 'user', content: 'What time is it?' }],
        stream: true,
      }),
    })

    expect(res.status).toBe(200)
    const sseBody = await res.text()
    expect(sseBody).toContain('data: [DONE]')

    const lines = sseBody.split('\n')
    const toolCallDeltas: unknown[] = []
    for (const line of lines) {
      if (line.startsWith('data: ') && !line.includes('[DONE]')) {
        const parsed = JSON.parse(line.slice(6)) as {
          choices?: Array<{ delta?: { tool_calls?: unknown[] } }>
        }
        const tc = parsed.choices?.[0]?.delta?.tool_calls
        if (tc) toolCallDeltas.push(...tc)
      }
    }

    expect(toolCallDeltas).toHaveLength(2)
    // First chunk has id, type, name, and 0-based index
    expect(toolCallDeltas[0]).toEqual({
      index: 0,
      id: 'call_abc',
      type: 'function',
      function: { name: 'get_time', arguments: '{"zone":' },
    })
    // Second chunk has arguments delta only and 0-based index
    expect(toolCallDeltas[1]).toEqual({
      index: 0,
      function: { arguments: '"UTC"}' },
    })
  })

  it('defers headers and returns proper HTTP 429 JSON on immediate rate limit in stream', async () => {
    mockStreamError = new LlmError('Account rate limited', 'RATE_LIMIT')

    const res = await fetch(`${baseUrl}/agy/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gemini-3.8-flash-tiered',
        messages: [{ role: 'user', content: 'Hi' }],
        stream: true,
      }),
    })

    // Deferred header correctly preserves 429 status code instead of fake 200 OK
    expect(res.status).toBe(429)
    expect(res.headers.get('content-type')).toContain('application/json')
    const json = (await res.json()) as { error: { message: string; code: string } }
    expect(json.error.code).toBe('insufficient_quota')
    expect(json.error.message).toContain('Account rate limited')
  })

  it('defers headers and returns proper HTTP 401 JSON on auth failure in stream', async () => {
    mockStreamError = new LlmError('No credentials available', 'NO_CREDENTIAL')

    const res = await fetch(`${baseUrl}/agy/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gemini-3.8-flash-tiered',
        messages: [{ role: 'user', content: 'Hi' }],
        stream: true,
      }),
    })

    expect(res.status).toBe(401)
    expect(res.headers.get('content-type')).toContain('application/json')
    const json = (await res.json()) as { error: { message: string; code: string } }
    expect(json.error.code).toBe('invalid_api_key')
  })

  it('defers headers and returns proper HTTP 404 JSON on upstream model not found in stream', async () => {
    mockStreamError = new Error('agy upstream error (404): {"error": {"code": 404, "message": "Requested entity was not found."}}')

    const res = await fetch(`${baseUrl}/agy/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'invalid-model',
        messages: [{ role: 'user', content: 'Hi' }],
        stream: true,
      }),
    })

    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toContain('application/json')
    const json = (await res.json()) as { error: { message: string; code: string } }
    expect(json.error.code).toBe('model_not_found')
    expect(json.error.message).toContain('Requested entity was not found')
  })

  it('returns 400 on malformed data URI in chat completion request', async () => {
    const res = await fetch(`${baseUrl}/agy/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gemini-3.8-flash-tiered',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image_url',
                image_url: { url: 'data:image/png;notbase64' },
              },
            ],
          },
        ],
      }),
    })

    expect(res.status).toBe(400)
    const json = (await res.json()) as { error: { message: string; code: string } }
    expect(json.error.code).toBe('invalid_request_error')
    expect(json.error.message).toContain('Malformed data URI')
  })

  it('rejects invalid JSON with 400', async () => {
    const res = await fetch(`${baseUrl}/agy/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ invalid-json }',
    })
    expect(res.status).toBe(400)
    const json = (await res.json()) as { error: { message: string; type: string } }
    expect(json.error.type).toBe('invalid_request_error')
  })

  it('returns 404 for unknown endpoints', async () => {
    const res = await fetch(`${baseUrl}/agy/v1/nonexistent`)
    expect(res.status).toBe(404)
  })
})
