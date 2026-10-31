import { QUOTA_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgyAdapter } from '../src/adapter/adapter.ts'
import type { AgyAdapterOptions } from '../src/adapter/adapter.ts'
import { classifyFetchError, classifyHttpError } from '../src/runtime/classify.ts'
import { decideRotation } from '../src/runtime/rotation.ts'
import type { AgyAccountSession, ManagedAccount, QuotaGroup } from '../src/types.ts'

const account = (): ManagedAccount => ({ refresh: 'redacted-test-value', addedAt: 0, lastUsed: 0 })

describe('network and quota isolation', () => {
  it.each(['ECONNRESET', 'ETIMEDOUT'])('keeps explicit-proxy %s as a no-write retry', (code) => {
    const error = Object.assign(new TypeError('fetch failed'), { cause: { code } })
    const classified = classifyFetchError(error, { proxyUrl: 'http://proxy.invalid:8080' })
    expect(classified.kind).toBe('proxy-unreachable')
    const a = account()
    expect(decideRotation(classified.kind, a, 1).action).toBe('retry')
    expect(a).not.toHaveProperty('coolingDownUntil')
    expect(a).not.toHaveProperty('verificationRequired')
  })

  it('keeps ordinary and quota-worded 403 responses out of credential punishment', () => {
    for (const body of ['', '{"error":{"status":"RESOURCE_EXHAUSTED"}}']) {
      const result = classifyHttpError(403, new Headers(), body)
      expect(result.kind).toBe('transient')
    }
  })

  it('does not infer hard exhaustion from quota wording alone', () => {
    const result = classifyHttpError(429, new Headers(), '{"error":{"message":"quota exhausted"}}')
    expect(result.rateLimitCategory).not.toBe('quota_exhausted')
    const a = account()
    expect(decideRotation('rate-limit', a, 1, undefined, 'soft_rate_limit').action).toBe('retry')
    expect(a).not.toHaveProperty('coolingDownUntil')
  })

  it('preserves explicit validation challenges as the only 403 account gate', () => {
    expect(classifyHttpError(403, new Headers(), '{"error":{"message":"VALIDATION_REQUIRED"}}').kind)
      .toBe('verification-required')
  })
})


describe('generation 429 quota evidence', () => {
  const now = Date.UTC(2026, 9, 31, 12)
  const resetTime = new Date(now + 60 * 60_000).toISOString()

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  function group(name: string, window = '5h', remainingFraction: number | null = 0, reset: string | null = null): QuotaGroup {
    return { name, windows: [{ bucketId: `${name}-${window}`, window, remainingFraction, resetTime: reset }] }
  }

  async function expect429(
    cached: Partial<ManagedAccount>,
    category: 'quota_exhausted' | 'soft_rate_limit' | 'rate_limited',
    model = 'gemini-3.5-flash',
    retryAfter?: string,
  ): Promise<void> {
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const fetch = vi.fn(async () => new Response('{"error":{"message":"quota exhausted"}}', {
      status: 429,
      headers: retryAfter === undefined ? {} : { 'retry-after': retryAfter },
    }))
    vi.stubGlobal('fetch', fetch)
    const session: AgyAccountSession = {
      auth: { access: 'test-access', expires: now + 3600_000 },
      account: { ...account(), ...cached },
      index: 0,
      impersonation: {
        'User-Agent': 'test-client',
        'X-Goog-Api-Client': 'test-client',
        clientMetadata: { ideType: 'ANTIGRAVITY' },
      },
    }
    const reportFailure = vi.fn<AgyAdapterOptions['reportFailure']>(async () => {})
    const adapter = new AgyAdapter({ getSession: async () => session, reportFailure })
    const options: GenerateOptions = {
      provider: 'agy', model,
      messages: [{ id: 'test-message', role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    }
    const consume = async (): Promise<void> => {
      for await (const chunk of adapter.stream(options)) void chunk
    }
    await expect(consume()).rejects.toMatchObject({
      code: category === 'quota_exhausted' ? QUOTA_EXCEEDED_CODE : 'RATE_LIMIT',
      ...(category !== 'quota_exhausted' && retryAfter !== undefined
        ? { failure: { providerRetryAfterMs: Number(retryAfter) * 1000 } }
        : {}),
    })
    expect(fetch).toHaveBeenCalled()
    expect(reportFailure).toHaveBeenCalledExactlyOnceWith('rate-limit', session, expect.objectContaining({
      status: 429, rateLimitCategory: category, model,
      retryAfterMs: retryAfter === undefined ? undefined : Number(retryAfter) * 1000,
    }))
  }

  it.each(['5h', 'weekly'])('promotes fresh Gemini %s zero limits to terminal quota exhaustion', async (window) => {
    await expect429({ cachedLimits: { updatedAt: now - 60_000, groups: [group('Gemini Models', window)] } }, 'quota_exhausted')
  })

  it.each([
    ['google models', 'gemini-3.5-flash'],
    ['Claude Models', 'claude-sonnet-4-6'],
    ['GPT Models', 'gpt-5'],
    ['3P Models', 'claude-sonnet-4-6'],
    ['Claude Models', 'gpt-5'],
  ])('recognizes the matching %s group for %s', async (name, model) => {
    await expect429({ cachedLimits: { updatedAt: now, groups: [group(name)] } }, 'quota_exhausted', model)
  })

  it.each([
    ['Claude Models', 'gemini-3.5-flash'],
    ['Gemini Models', 'claude-sonnet-4-6'],
    ['Gemini Models', 'gpt-5'],
    ['Gemini Models', 'unknown-model'],
    ['Other Models', 'gemini-3.5-flash'],
  ])('does not promote %s zero limits for %s', async (name, model) => {
    await expect429({ cachedLimits: { updatedAt: now, groups: [group(name)] } }, 'soft_rate_limit', model)
  })

  it('ignores a depleted Claude group alongside a positive Gemini group', async () => {
    await expect429({ cachedLimits: { updatedAt: now, groups: [group('Claude Models'), group('Gemini Models', '5h', 0.5)] } }, 'soft_rate_limit')
  })

  it.each([
    ['stale', now - 5 * 60_000 - 1],
    ['future', now + 1],
    ['invalid', NaN],
  ])('does not promote %s limits', async (_label, updatedAt) => {
    await expect429({ cachedLimits: { updatedAt, groups: [group('Gemini Models')] } }, 'soft_rate_limit')
  })

  it('accepts a limits snapshot exactly five minutes old', async () => {
    await expect429({ cachedLimits: { updatedAt: now - 5 * 60_000, groups: [group('Gemini Models')] } }, 'quota_exhausted')
  })

  it.each([{}, { cachedLimits: { updatedAt: now, groups: [] } }])('does not promote missing limits data %j', async (cached) => {
    await expect429(cached, 'soft_rate_limit')
  })

  it.each([
    ['weekly', 0.005, resetTime, 'quota_exhausted'],
    ['weekly', 0.001, resetTime, 'quota_exhausted'],
    ['weekly', 0.005, null, 'soft_rate_limit'],
    ['weekly', 0.006, resetTime, 'soft_rate_limit'],
    ['5h', 0.005, resetTime, 'soft_rate_limit'],
    ['weekly', null, resetTime, 'soft_rate_limit'],
  ] as const)('checks %s fraction %s with reset %s', async (window, fraction, reset, category) => {
    await expect429({ cachedLimits: { updatedAt: now, groups: [group('Gemini Models', window, fraction, reset)] } }, category)
  })

  it.each([
    [{ remainingFraction: 0 }],
    [{ weeklyFraction: 0, weeklyResetTime: resetTime }],
    [{ weeklyFraction: 0.005, weeklyResetTime: resetTime }],
  ])('also promotes fresh same-family scheduling quota %j', async (quota) => {
    await expect429({ cachedQuotaUpdatedAt: now, cachedQuota: { google: quota } }, 'quota_exhausted')
  })

  it.each([
    { cachedQuotaUpdatedAt: now, cachedQuota: { anthropic: { remainingFraction: 0 } } },
    { cachedQuotaUpdatedAt: now - 5 * 60_000 - 1, cachedQuota: { google: { remainingFraction: 0 } } },
    { cachedQuotaUpdatedAt: now + 1, cachedQuota: { google: { remainingFraction: 0 } } },
    { cachedQuota: { google: { remainingFraction: 0 } } },
    { cachedQuotaUpdatedAt: now, cachedQuota: { google: { weeklyFraction: 0.005 } } },
  ])('does not promote unmatched, stale, or incomplete scheduling quota %j', async (cached) => {
    await expect429(cached, 'soft_rate_limit')
  })

  it('does not promote an unknown-family scheduling bucket', async () => {
    await expect429({ cachedQuotaUpdatedAt: now, cachedQuota: { unknown: { remainingFraction: 0 } } }, 'soft_rate_limit', 'unknown-model')
  })

  it('checks each cache freshness independently', async () => {
    await expect429({
      cachedLimits: { updatedAt: now - 5 * 60_000 - 1, groups: [group('Gemini Models')] },
      cachedQuotaUpdatedAt: now,
      cachedQuota: { google: { remainingFraction: 0.5 } },
    }, 'soft_rate_limit')
  })

  it.each(['3', '10'])('preserves rate_limited and Retry-After %ss without zero evidence', async (retryAfter) => {
    await expect429({}, 'rate_limited', 'gemini-3.5-flash', retryAfter)
  })

  it('keeps a short Retry-After as a soft limit', async () => {
    await expect429({}, 'soft_rate_limit', 'gemini-3.5-flash', '2')
  })

  it('still promotes matching fresh zero evidence when Retry-After is present', async () => {
    await expect429({ cachedLimits: { updatedAt: now, groups: [group('Gemini Models')] } }, 'quota_exhausted', 'gemini-3.5-flash', '10')
  })
})
