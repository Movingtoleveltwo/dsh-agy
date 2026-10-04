import { createServer, type Server } from 'node:http'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { GenerateOptions, StreamChunk, LlmModelInfo } from '@deepseek-ai/dsh-llm'
import {
  createOpenAiRelayHandler,
  normalizeModelName,
  normalizeReasoningEffort,
  translateOpenAiMessages,
  translateOpenAiTools,
} from '../src/web/openai-relay.ts'
import type { AgyAdapter } from '../src/adapter/adapter.ts'

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

  it('translates OpenAI messages correctly', () => {
    const rawMessages = [
      { role: 'system', content: 'You are helpful.' },
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
    expect(translated).toHaveLength(6)

    expect(translated[0].role).toBe('system')
    expect(translated[0].content).toEqual([{ type: 'text', text: 'You are helpful.' }])

    expect(translated[1].role).toBe('user')
    expect(translated[1].content).toEqual([{ type: 'text', text: 'Hello world' }])

    expect(translated[2].role).toBe('user')
    expect(translated[2].content).toEqual([
      { type: 'text', text: 'Part 1' },
      { type: 'text', text: 'Part 2' },
    ])

    expect(translated[3].role).toBe('assistant')
    expect(translated[3].content).toEqual([
      { type: 'text', text: 'I will run a tool' },
      {
        type: 'tool-call',
        id: 'call_123',
        name: 'calculator',
        arguments: '{"expr":"1+1"}',
      },
    ])

    expect(translated[4].role).toBe('tool')
    expect(translated[4].content).toEqual([{ type: 'text', text: '2' }])

    expect(translated[5].role).toBe('tool')
    expect(translated[5].content).toEqual([{ type: 'text', text: 'done' }])
  })
})

describe('OpenAI Relay HTTP endpoints', () => {
  let server: Server
  let baseUrl: string
  let mockStreamChunks: StreamChunk[] = []

  const mockAdapter: Partial<AgyAdapter> = {
    // eslint-disable-next-line @typescript-eslint/require-await
    async *stream(_options: GenerateOptions) {
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

  it('handles OPTIONS preflight with CORS headers', async () => {
    const res = await fetch(`${baseUrl}/agy/v1/chat/completions`, { method: 'OPTIONS' })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(res.headers.get('access-control-allow-methods')).toContain('POST')
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

  it('handles non-streaming POST /agy/v1/chat/completions', async () => {
    mockStreamChunks = [
      { type: 'reasoning-delta', text: 'thinking...' },
      { type: 'text-delta', text: 'Hello, ' },
      { type: 'text-delta', text: 'world!' },
      {
        type: 'usage',
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2 },
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
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
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
  })

  it('handles non-streaming completions with tool calls', async () => {
    mockStreamChunks = [
      {
        type: 'tool-call-delta',
        index: 0,
        id: 'call_999' as never,
        name: 'search',
        argumentsDelta: '{"q":',
      },
      {
        type: 'tool-call-delta',
        index: 0,
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

  it('handles streaming completions with tool calls', async () => {
    mockStreamChunks = [
      {
        type: 'tool-call-delta',
        index: 0,
        id: 'call_abc' as never,
        name: 'get_time',
        argumentsDelta: '{"zone":',
      },
      {
        type: 'tool-call-delta',
        index: 0,
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
    expect(toolCallDeltas[0]).toEqual({
      index: 0,
      id: 'call_abc',
      type: 'function',
      function: { name: 'get_time', arguments: '{"zone":' },
    })
    expect(toolCallDeltas[1]).toEqual({
      index: 0,
      function: { arguments: '"UTC"}' },
    })
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
