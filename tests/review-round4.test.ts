import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { AgySessionManager } from '../src/session.ts'
import { InMemoryAccountStore } from '../src/store/accounts.ts'
import { AgyAdapter } from '../src/adapter/adapter.ts'
import { refreshAccessToken } from '../src/oauth/refresh.ts'
import { AGY_CLIENT_ID } from '../src/oauth/constants.ts'
import { clearExpiredState } from '../src/runtime/rotation.ts'
import { createOpenAiRelayHandler } from '../src/web/openai-relay.ts'

const NOW = Date.parse('2026-10-14T00:00:00.000Z')
const HOUR = 3600000
const DAY = 24 * HOUR
const iso = (delta: number) => new Date(NOW + delta).toISOString()
const account = (id: string, extra: any = {}) => ({
  id, email: `${id}@review.invalid`, enabled: true, refresh: `test-${id}|proj-1`,
  projectId: 'proj-1', clientId: AGY_CLIENT_ID, addedAt: 0, lastUsed: 0,
  fingerprint: { deviceId: 'test-device', sessionToken: 'test-session',
    userAgent: 'antigravity/1.0.0 darwin/arm64', apiClient: 'test-client',
    clientMetadata: { ideType: 'ANTIGRAVITY' }, createdAt: NOW },
  ...extra,
})
const storage = (accounts: any[]) => ({ version: 4 as const, accounts, activeIndex: 0 })
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"access_token":"test-access","expires_in":3600}', { status: 200 })))
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks() })

function legacyRefreshFailure(last: 'network' | 'http503', calls: Array<{ client: string; at: number }> = []) {
  vi.stubEnv('AGY_CLIENT_ID', 'review-legacy-client')
  vi.stubEnv('AGY_CLIENT_SECRET', 'review-public-client-secret')
  vi.stubGlobal('fetch', vi.fn(async (_url: any, init: any) => {
    const embedded = init.body.get('client_id') === AGY_CLIENT_ID
    calls.push({ client: embedded ? 'embedded' : 'override', at: Date.now() })
    if (embedded) return new Response('{"error":"rate_limited"}', { status: 429, headers: { 'Retry-After': '120' } })
    if (last === 'network') throw new TypeError('fetch failed', { cause: Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }) })
    return new Response('{"error":"temporarily_unavailable"}', { status: 503 })
  }))
}
function callRelay(adapter: any) {
  const req: any = new EventEmitter()
  Object.assign(req, { method: 'POST', url: '/agy/v1/chat/completions', headers: {} })
  const res: any = new EventEmitter()
  Object.assign(res, { statusCode: 200, writableEnded: false, headersSent: false, parts: [] as string[] })
  res.writeHead = (status: number, headers: any) => { res.statusCode = status; res.headers = headers; res.headersSent = true; return res }
  res.write = (chunk: any) => { res.parts.push(String(chunk)); return true }
  res.end = (chunk?: any) => { if (chunk !== undefined) res.parts.push(String(chunk)); res.writableEnded = true; return res }
  const completed = createOpenAiRelayHandler({ adapter })(req, res)
  req.emit('data', Buffer.from(JSON.stringify({ model: 'gemini-3.8-flash', messages: [{ role: 'user', content: 'test' }], stream: false })))
  req.emit('end')
  return { res, completed }
}

it('H1/M4 strengthened: failed commit rejects both picks without token I/O or notifications', async () => {
  const inner = new InMemoryAccountStore(storage([
    account('a', { coolingDownUntil: NOW + 60000, cooldownReason: 'quota-exhausted' }), account('b'),
  ]))
  let chain = Promise.resolve()
  const store = {
    load: () => inner.load(), save: (s: any) => inner.save(s),
    mutate: (fn: any) => {
      const run = async () => { const draft = await inner.load(); await fn(draft); throw Object.assign(new Error('simulated EIO'), { code: 'EIO' }) }
      chain = chain.then(run, run)
      return chain
    },
  }
  const onRotate = vi.fn(), recordUsage = vi.fn()
  const sessions = new AgySessionManager({ store, onRotate, recordUsage })
  const results = await Promise.allSettled([sessions.getSession('gemini-3.8-flash'), sessions.getSession('gemini-3.8-flash')])
  expect(results.map(r => r.status)).toEqual(['rejected', 'rejected'])
  expect(fetch).not.toHaveBeenCalled()
  expect(onRotate).not.toHaveBeenCalled()
  expect(recordUsage).not.toHaveBeenCalled()
  expect((await inner.load()).activeIndex).toBe(0)
})

it('H3: later network failure must preserve a previous 120s Retry-After', async () => {
  legacyRefreshFailure('network')
  const result = await refreshAccessToken({ access: '', expires: 0, refresh: 'test-refresh|proj-1' })
  console.log('H3 network aggregate', result.type === 'failed' ? { status: result.error.status, retryAfterMs: result.error.retryAfterMs } : result.type)
  expect(result.type).toBe('failed')
  if (result.type === 'failed') expect(result.error.retryAfterMs).toBe(120000)
})

it.each(['network', 'http503'] as const)('H3 full chain: 429 then %s must not re-hit the first client before 120s', async last => {
  const calls: Array<{ client: string; at: number }> = []
  legacyRefreshFailure(last, calls)
  const legacy = account('a'); delete legacy.clientId
  const sessions = new AgySessionManager({ store: new InMemoryAccountStore(storage([legacy])) })
  const adapter = new AgyAdapter({ getSession: (model, key) => sessions.getSession(model, undefined, key), reportFailure: async () => {} })
  const { completed } = callRelay(adapter)
  await vi.advanceTimersByTimeAsync(0)
  await vi.runAllTimersAsync()
  await completed
  const firstClient = calls.filter(c => c.client === 'embedded')
  console.log(`H3 ${last} calls`, calls.map(c => ({ client: c.client, atMs: c.at - NOW })))
  expect(firstClient).toHaveLength(2)
  expect(firstClient[1]!.at - firstClient[0]!.at).toBeGreaterThanOrEqual(120000)
})

it.each(['disable', 'delete'])('M2: all accounts %s under lock must not fall back to the stale nonempty pool', async change => {
  const inner = new InMemoryAccountStore(storage([account('a', { coolingDownUntil: NOW + 5000, cooldownReason: 'quota-exhausted' })]))
  let inject = true
  const store = {
    load: () => inner.load(), save: (s: any) => inner.save(s),
    mutate: async (fn: any) => {
      if (inject) {
        inject = false
        await inner.mutate(s => { if (change === 'disable') s.accounts[0]!.enabled = false; else s.accounts = [] })
      }
      return inner.mutate(fn)
    },
  }
  const result = await new AgySessionManager({ store }).getSession('gemini-3.8-flash').catch(e => e)
  console.log(`M2 empty after ${change}`, { name: result?.name, kind: result?.kind, blockedMs: result?.blockedUntil - NOW })
  expect(result).toBeUndefined()
})

it('M2: deadline freshness must use the lock-time clock after contention', async () => {
  const inner = new InMemoryAccountStore(storage([account('a', {
    rateLimitResetTimes: { google: NOW + 60000 },
    cachedQuota: { google: { remainingFraction: 1, weeklyFraction: 0, weeklyResetTime: iso(6 * DAY) } },
    cachedQuotaUpdatedAt: NOW - 59000,
  })]))
  const store = {
    load: () => inner.load(), save: (s: any) => inner.save(s),
    mutate: async (fn: any) => { vi.setSystemTime(NOW + 2000); return inner.mutate(fn) },
  }
  const result = await new AgySessionManager({ store }).getSession('gemini-3.8-flash').catch(e => e)
  console.log('M2 old clock', { kind: result.kind, blockedMs: result.blockedUntil - NOW })
  expect(result.kind).toBe('retryable')
  expect(result.blockedUntil).toBe(NOW + 60000)
})

it('M2 family: expired cooldown must not smuggle a Claude weekly deadline into Gemini blocking', async () => {
  const inner = new InMemoryAccountStore(storage([account('a', {
    coolingDownUntil: NOW - 1000, cooldownReason: 'quota-exhausted', cooldownSetAt: NOW - 5 * HOUR,
    cachedLimits: { updatedAt: NOW, groups: [
      { name: 'Gemini Models', windows: [
        { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0, resetTime: iso(HOUR) },
        { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 1, resetTime: iso(6 * DAY) },
      ] },
      { name: 'Claude and GPT models', windows: [
        { bucketId: '3p-5h', window: '5h', remainingFraction: 1, resetTime: iso(HOUR) },
        { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 0, resetTime: iso(6 * DAY) },
      ] },
    ] },
  })]))
  const result = await new AgySessionManager({ store: inner }).getSession('gemini-3.8-flash').catch(e => e)
  console.log('M2 cooldown family leak', { kind: result.kind, blockedMs: result.blockedUntil - NOW, expectedMs: HOUR })
  expect(result.kind).toBe('quota-exhausted')
  expect(result.blockedUntil).toBe(NOW + HOUR)
})

it.each([['unknown reset', null], ['past reset', iso(-30000)]])('week guard: fresh zero with %s must remain frozen without a legacy cooldownSetAt', (_label, resetTime) => {
  const a = account('a', {
    coolingDownUntil: NOW - 1000, cooldownReason: 'quota-exhausted',
    cachedLimits: { updatedAt: NOW, groups: [{ name: 'Gemini Models', windows: [
      { bucketId: 'gemini-5h', window: '5h', remainingFraction: 1, resetTime: iso(-60000) },
      { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0, resetTime },
    ] }] },
  })
  clearExpiredState(a, NOW)
  console.log('week missing failure timestamp', { resetTime, cooldownReason: a.cooldownReason, coolingDownUntil: a.coolingDownUntil })
  expect(a.cooldownReason).toBe('quota-exhausted')
  expect(a.coolingDownUntil).toBeGreaterThan(NOW)
})

it('week guard: a zero measured exactly at reset must not be unfrozen by the recovery branch', () => {
  const a = account('a', {
    coolingDownUntil: NOW - 1000, cooldownReason: 'quota-exhausted', cooldownSetAt: NOW - 5 * HOUR,
    cachedLimits: { updatedAt: NOW - 30000, groups: [{ name: 'Gemini Models', windows: [
      { bucketId: 'gemini-5h', window: '5h', remainingFraction: 1, resetTime: iso(-60000) },
      { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0, resetTime: iso(-30000) },
    ] }] },
  })
  clearExpiredState(a, NOW)
  console.log('week measurement at reset', { cooldownReason: a.cooldownReason, coolingDownUntil: a.coolingDownUntil })
  expect(a.cooldownReason).toBe('quota-exhausted')
  expect(a.coolingDownUntil).toBeGreaterThan(NOW)
})
