import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { AgySessionManager } from '../src/session.ts'
import { InMemoryAccountStore } from '../src/store/accounts.ts'
import { AgyAdapter } from '../src/adapter/adapter.ts'
import { refreshAccessToken } from '../src/oauth/refresh.ts'
import { AGY_CLIENT_ID } from '../src/oauth/constants.ts'
import { clearExpiredState } from '../src/runtime/rotation.ts'
import { resetText } from '../src/client/quota-view.ts'
import { zh } from '../src/client/locales.ts'
import { createOpenAiRelayHandler } from '../src/web/openai-relay.ts'
import { LlmError } from '@deepseek-ai/dsh-llm'

const NOW = Date.parse('2026-10-14T00:00:00.000Z')
const iso = (offset: number) => new Date(NOW + offset).toISOString()
const account = (id: string, extra: any = {}) => ({
  id, email: `${id}@review.invalid`, enabled: true, refresh: `test-${id}|proj-1`,
  projectId: 'proj-1', clientId: AGY_CLIENT_ID, addedAt: 0, lastUsed: 0,
  fingerprint: { deviceId: 'test-device', sessionToken: 'test-session',
    userAgent: 'antigravity/1.0.0 darwin/arm64', apiClient: 'test-client',
    clientMetadata: { ideType: 'ANTIGRAVITY' }, createdAt: NOW },
  ...extra,
})
const storage = (accounts: any[], activeIndex = 0) => ({ version: 4 as const, accounts, activeIndex })
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ access_token: 'test-access', expires_in: 3600 }), { status: 200 })))
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

it('H1 normal path: choose from the lock-time array after deletion and disable', async () => {
  const inner = new InMemoryAccountStore(storage([
    account('a', { coolingDownUntil: NOW + 60000, cooldownReason: 'quota-exhausted' }),
    account('b'), account('c'),
  ]))
  let inject = true
  const store = {
    load: () => inner.load(), save: (s: any) => inner.save(s),
    mutate: async (fn: any) => {
      if (inject) {
        inject = false
        await inner.mutate(s => {
          s.accounts.splice(0, 1)
          s.accounts[0]!.enabled = false
          s.activeIndex = 0
        })
      }
      return inner.mutate(fn)
    },
  }
  const sessions = new AgySessionManager({ store })
  const selected = await sessions.getSession('gemini-3.8-flash')
  expect(selected!.account.id).toBe('c')
  expect(selected!.index).toBe(1)
  expect((await inner.load()).accounts[1]!.id).toBe('c')
  expect((await inner.load()).activeIndex).toBe(1)
})

it('M4 normal path: two session managers emit one rotation and one poolEvent total', async () => {
  const store = new InMemoryAccountStore(storage([
    account('a', { coolingDownUntil: NOW + 60000, cooldownReason: 'quota-exhausted' }), account('b'),
  ]))
  const onRotate = vi.fn()
  const recordUsage = vi.fn()
  const first = new AgySessionManager({ store, onRotate, recordUsage })
  const second = new AgySessionManager({ store, onRotate, recordUsage })
  const selected = await Promise.all([first.getSession('gemini-3.8-flash'), second.getSession('gemini-3.8-flash')])
  expect(selected.map(s => s!.account.id)).toEqual(['b', 'b'])
  expect(onRotate).toHaveBeenCalledTimes(1)
  expect(recordUsage.mock.calls.filter(([r]) => r.poolEvent)).toHaveLength(1)
})

it('H1/M4 regression: failed commit must not emit uncommitted, duplicate rotations', async () => {
  const inner = new InMemoryAccountStore(storage([
    account('a', { coolingDownUntil: NOW + 60000, cooldownReason: 'quota-exhausted' }), account('b'),
  ]))
  let chain: Promise<any> = Promise.resolve()
  const store = {
    load: () => inner.load(), save: (s: any) => inner.save(s),
    mutate: (fn: any) => {
      const run = async () => {
        const draft = await inner.load()
        await fn(draft)
        throw Object.assign(new Error('simulated atomic rename failure'), { code: 'EIO' })
      }
      chain = chain.then(run, run)
      return chain
    },
  }
  const onRotate = vi.fn()
  const recordUsage = vi.fn()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const sessions = new AgySessionManager({ store, onRotate, recordUsage })
  const selected = await Promise.allSettled([sessions.getSession('gemini-3.8-flash'), sessions.getSession('gemini-3.8-flash')])
  expect((await inner.load()).activeIndex).toBe(0)
  console.log('failed commit result', JSON.stringify({ statuses: selected.map(x => x.status), rotations: onRotate.mock.calls.length, poolEvents: recordUsage.mock.calls.filter(([r]) => r.poolEvent).length }))
  expect(onRotate).toHaveBeenCalledTimes(0)
  expect(recordUsage.mock.calls.filter(([r]) => r.poolEvent)).toHaveLength(0)
})

it('M2 regression: all-blocked deadline must use lock-time state, not the pre-lock snapshot', async () => {
  const inner = new InMemoryAccountStore(storage([
    account('a', { coolingDownUntil: NOW + 5000, cooldownReason: 'quota-exhausted' }),
  ]))
  let inject = true
  const store = {
    load: () => inner.load(), save: (s: any) => inner.save(s),
    mutate: async (fn: any) => {
      if (inject) {
        inject = false
        await inner.mutate(s => {
          s.accounts[0]!.coolingDownUntil = NOW + 60000
          s.accounts[0]!.cachedQuota = { google: { remainingFraction: 0, resetTime: iso(120000), weeklyFraction: 0, weeklyResetTime: iso(180000) } }
          s.accounts[0]!.cachedQuotaUpdatedAt = NOW
        })
      }
      return inner.mutate(fn)
    },
  }
  const sessions = new AgySessionManager({ store })
  const error = await sessions.getSession('gemini-3.8-flash').catch(e => e)
  expect(error.name).toBe('AgyPoolBlockedError')
  console.log('concurrent blocked deadline', JSON.stringify({ actualMs: error.blockedUntil - NOW, expectedMs: 180000 }))
  expect(error.blockedUntil).toBe(NOW + 180000)
})

it('M2 regression: a Gemini rate limit must not inherit an exhausted Claude weekly window', async () => {
  const store = new InMemoryAccountStore(storage([account('a', {
    rateLimitResetTimes: { google: NOW + 60000 },
    cachedLimits: { updatedAt: NOW, groups: [
      { name: 'Gemini Models', windows: [
        { bucketId: 'gemini-5h', window: '5h', remainingFraction: 1, resetTime: iso(5 * 3600000) },
        { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 1, resetTime: iso(6 * 86400000) },
      ] },
      { name: 'Claude and GPT models', windows: [
        { bucketId: '3p-5h', window: '5h', remainingFraction: 1, resetTime: iso(5 * 3600000) },
        { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 0, resetTime: iso(6 * 86400000) },
      ] },
    ] },
  })]))
  const sessions = new AgySessionManager({ store })
  const error = await sessions.getSession('gemini-3.8-flash').catch(e => e)
  expect(error.name).toBe('AgyPoolBlockedError')
  console.log('cross-family blocking', JSON.stringify({ actualKind: error.kind, actualMs: error.blockedUntil - NOW, expectedKind: 'retryable', expectedMs: 60000 }))
  expect(error.kind).toBe('retryable')
  expect(error.blockedUntil).toBe(NOW + 60000)
})

it('week guard: an elapsed rolling cooldown cannot clear a still-exhausted future week', () => {
  const a = account('a', {
    coolingDownUntil: NOW - 1000, cooldownReason: 'quota-exhausted', cooldownSetAt: NOW - 5 * 3600000,
    cachedLimits: { updatedAt: NOW, groups: [{ name: 'Gemini Models', windows: [
      { bucketId: 'gemini-5h', window: '5h', remainingFraction: 1, resetTime: iso(-10000) },
      { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0, resetTime: iso(2 * 86400000) },
    ] }] },
  })
  clearExpiredState(a, NOW)
  expect(a.coolingDownUntil).toBe(NOW + 2 * 86400000)
  expect(a.cooldownReason).toBe('quota-exhausted')
})

it('passed-reset display uses the required Chinese copy', () => {
  expect(resetText(iso(-1000), key => zh[key], NOW)).toBe('重置周期已过')
})

it.each([
  ['120', 120000],
  [new Date(NOW + 45000).toUTCString(), 45000],
  [null, 1000],
  ['not-a-delay', 1000],
])('H3 ordinary path: refresh header %s survives session and adapter as %s ms', async (header, expected) => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'rate_limited' }), {
    status: 429, headers: header === null ? {} : { 'Retry-After': header as string },
  })))
  const sessions = new AgySessionManager({ store: new InMemoryAccountStore(storage([account('a')])) })
  const adapter = new AgyAdapter({ getSession: (model, key) => sessions.getSession(model, undefined, key), reportFailure: async () => {} })
  const options: any = { provider: 'agy', model: 'gemini-3.8-flash', messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: 'test' }] }] }
  const error = await adapter.stream(options)[Symbol.asyncIterator]().next().catch(e => e)
  expect(error.code).toBe('RATE_LIMIT')
  expect(error.failure.providerRetryAfterMs).toBe(expected)
})

it('H3 legacy regression: Relay must not retry the first client before its 120s Retry-After', async () => {
  vi.stubEnv('AGY_CLIENT_ID', 'test-legacy-client')
  vi.stubEnv('AGY_CLIENT_SECRET', 'test-public-client-secret')
  const calls: Array<{ client: string, at: number }> = []
  vi.stubGlobal('fetch', vi.fn(async (_url: any, init: any) => {
    const embedded = init.body.get('client_id') === AGY_CLIENT_ID
    calls.push({ client: embedded ? 'embedded' : 'override', at: Date.now() })
    return new Response('{"error":"rate_limited"}', { status: 429, headers: { 'Retry-After': embedded ? '120' : '1' } })
  }))
  const legacy = account('a')
  delete legacy.clientId
  const sessions = new AgySessionManager({ store: new InMemoryAccountStore(storage([legacy])) })
  const adapter = new AgyAdapter({ getSession: (model, key) => sessions.getSession(model, undefined, key), reportFailure: async () => {} })
  const { res, completed } = callRelay(adapter, false)
  await vi.advanceTimersByTimeAsync(0)
  await vi.runAllTimersAsync()
  await completed
  const firstClientCalls = calls.filter(c => c.client === 'embedded')
  expect(firstClientCalls).toHaveLength(2)
  expect(res.statusCode).toBe(429)
  const retryGap = firstClientCalls[1]!.at - firstClientCalls[0]!.at
  console.log('legacy full-chain retry', JSON.stringify({ calls: calls.map(c => ({ client: c.client, atMs: c.at - NOW })), retryGap, expectedMinimumMs: 120000 }))
  expect(retryGap).toBeGreaterThanOrEqual(120000)
})

function callRelay(adapter: any, stream: boolean) {
  const req: any = new EventEmitter()
  Object.assign(req, { method: 'POST', url: '/agy/v1/chat/completions', headers: {} })
  const res: any = new EventEmitter()
  Object.assign(res, { statusCode: 200, writableEnded: false, headersSent: false, parts: [] as string[] })
  res.writeHead = (status: number, headers: any) => { res.statusCode = status; res.headers = headers; res.headersSent = true; return res }
  res.write = (chunk: any) => { res.parts.push(String(chunk)); return true }
  res.end = (chunk?: any) => { if (chunk !== undefined) res.parts.push(String(chunk)); res.writableEnded = true; return res }
  const completed = createOpenAiRelayHandler({ adapter })(req, res)
  req.emit('data', Buffer.from(JSON.stringify({ model: 'gemini-3.8-flash', messages: [{ role: 'user', content: 'test' }], stream })))
  req.emit('end')
  return { res, completed }
}

for (const stream of [true, false]) {
  it.each([
    ['TRANSPORT', undefined, 500],
    ['RATE_LIMIT', undefined, 1000],
    ['RATE_LIMIT', 5000, 5000],
  ])(`Relay stream=${stream}: %s waits for the full %s / %s delay before retry`, async (code, delay, expectedDelay) => {
    let calls = 0
    const adapter = {
      async *stream() {
        calls++
        if (calls === 1) throw new LlmError('test initial failure', code as any, delay === undefined ? {} : { providerRetryAfterMs: delay as number })
        yield { type: 'text-delta', text: 'recovered' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
    const { res, completed } = callRelay(adapter, stream)
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toBe(1)
    expect(res.headersSent).toBe(false)
    await vi.advanceTimersByTimeAsync(Number(expectedDelay) - 1)
    expect(calls).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    await completed
    expect(calls).toBe(2)
    expect(res.statusCode).toBe(200)
    expect(res.parts.join('')).toContain('recovered')
  })

  it(`Relay stream=${stream}: persistent TRANSPORT is bounded to two attempts`, async () => {
    let calls = 0
    const adapter = { async *stream() { calls++; throw new LlmError('test network drop', 'TRANSPORT') } }
    const { res, completed } = callRelay(adapter, stream)
    await vi.advanceTimersByTimeAsync(500)
    await completed
    expect(calls).toBe(2)
    expect(res.statusCode).toBe(500)
  })
}

it('Relay does not replay a partially delivered streaming turn', async () => {
  let calls = 0
  const adapter = {
    async *stream() {
      calls++
      yield { type: 'text-delta', text: 'already delivered' }
      throw new LlmError('test midstream drop', 'UPSTREAM')
    },
  }
  const { res, completed } = callRelay(adapter, true)
  await completed
  expect(calls).toBe(1)
  expect(res.parts.join('')).toContain('already delivered')
  expect(res.parts.join('')).toContain('test midstream drop')
})


it.each([
  ['unknown reset', null],
  ['past reset but measured zero afterwards', iso(-30000)],
])('week guard regression: a fresh zero reading with %s must not be cleared at cooldown expiry', (_name, resetTime) => {
  const a = account('a', {
    coolingDownUntil: NOW - 1000, cooldownReason: 'quota-exhausted', cooldownSetAt: NOW - 5 * 3600000,
    cachedLimits: { updatedAt: NOW, groups: [{ name: 'Gemini Models', windows: [
      { bucketId: 'gemini-5h', window: '5h', remainingFraction: 1, resetTime: iso(-60000) },
      { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0, resetTime },
    ] }] },
  })
  clearExpiredState(a, NOW)
  console.log('fresh-zero week after clear', JSON.stringify({ resetTime, coolingDownUntil: a.coolingDownUntil ?? null, cooldownReason: a.cooldownReason ?? null }))
  expect(a.cooldownReason).toBe('quota-exhausted')
  expect(a.coolingDownUntil).toBeGreaterThan(NOW)
})
