/**
 * The quota verdict is the ONLY thing allowed to park an account for a 429.
 *
 * These cases pin the decision table that replaced body-text guessing: a spent
 * window is named by the ledger, a healthy reading must not cool anything, and an
 * unreadable ledger must cool nothing at all. The last rule is the asymmetric
 * one — a false park costs hours of pool capacity silently, while letting an
 * unclear failure through costs one retry.
 */

import { describe, expect, it } from 'vitest'
import { isQuotaDrained, judgeQuotaExhaustion } from '../src/runtime/quota-verdict.ts'
import type { QuotaGroup } from '../src/types.ts'

function group(name: string, windows: Array<{ bucketId: string; window: string; remainingFraction: number | null; resetTime?: string | null }>): QuotaGroup {
  return {
    name,
    windows: windows.map((window) => ({
      bucketId: window.bucketId,
      window: window.window,
      remainingFraction: window.remainingFraction,
      resetTime: window.resetTime ?? null,
    })),
  }
}

function gemini(fiveHour: number | null, weekly: number | null): QuotaGroup[] {
  return [group('Gemini Models', [
    { bucketId: 'gemini-5h', window: '5h', remainingFraction: fiveHour, resetTime: '2026-10-20T18:18:58Z' },
    { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: weekly, resetTime: '2026-10-27T08:47:39Z' },
  ])]
}

describe('judgeQuotaExhaustion', () => {
  it('names the 5-hour tier when that bucket alone is empty', () => {
    const verdict = judgeQuotaExhaustion({ family: 'google', groups: gemini(0, 1) })
    expect(verdict).toEqual({ state: 'drained', tier: '5h', buckets: ['gemini-5h'] })
  })

  it('names the weekly tier when the weekly window is spent, even if the 5h window refilled', () => {
    const verdict = judgeQuotaExhaustion({ family: 'google', groups: gemini(1, 0) })
    expect(verdict).toEqual({ state: 'drained', tier: 'weekly', buckets: ['gemini-weekly'] })
  })

  it('prefers the weekly tier when both are empty (it is the longer rest)', () => {
    const verdict = judgeQuotaExhaustion({ family: 'google', groups: gemini(0, 0) })
    expect(verdict.state).toBe('drained')
    expect(verdict).toMatchObject({ tier: 'weekly' })
  })

  it('treats a nearly-spent weekly window as spent (1% of a week is no runway)', () => {
    const verdict = judgeQuotaExhaustion({ family: 'google', groups: gemini(1, 0.005) })
    expect(verdict).toMatchObject({ state: 'drained', tier: 'weekly' })
  })

  it('reports available when every window still has a real reading', () => {
    expect(judgeQuotaExhaustion({ family: 'google', groups: gemini(0.9, 0.6) }))
      .toEqual({ state: 'available' })
  })

  it('is unknown, never "available", when a fraction is missing', () => {
    // A null fraction is "not measured", and calling that available would turn a
    // malformed probe into a false all-clear.
    expect(judgeQuotaExhaustion({ family: 'google', groups: gemini(null, 1) }))
      .toEqual({ state: 'unknown', reason: 'partial-reading' })
  })

  it('is unknown when the probe returned nothing', () => {
    expect(judgeQuotaExhaustion({ family: 'google', groups: [] }))
      .toEqual({ state: 'unknown', reason: 'probe-failed' })
  })

  it('is unknown when the ledger has no window for the requested family', () => {
    // The measured 2026-10-20 case: only the Claude/GPT group came back, so
    // nothing on the wire could say anything about Gemini — neither drained nor
    // available may be claimed for it.
    const claudeOnly = [group('Claude and GPT models', [
      { bucketId: '3p-5h', window: '5h', remainingFraction: 1 },
      { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 1 },
    ])]
    expect(judgeQuotaExhaustion({ family: 'google', groups: claudeOnly }))
      .toEqual({ state: 'unknown', reason: 'no-family-window' })
  })

  it('is unknown without a model to scope the family', () => {
    expect(judgeQuotaExhaustion({ family: undefined, groups: gemini(0, 1) }))
      .toEqual({ state: 'unknown', reason: 'no-model' })
  })

  it('reads each family from its own windows', () => {
    const mixed = [
      ...gemini(0, 1),
      group('Claude and GPT models', [
        { bucketId: '3p-5h', window: '5h', remainingFraction: 1 },
        { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 1 },
      ]),
    ]
    expect(judgeQuotaExhaustion({ family: 'google', groups: mixed })).toMatchObject({ state: 'drained', tier: '5h' })
    expect(judgeQuotaExhaustion({ family: 'anthropic', groups: mixed })).toEqual({ state: 'available' })
  })

  it('narrows to drained for the cooldown path', () => {
    expect(isQuotaDrained(judgeQuotaExhaustion({ family: 'google', groups: gemini(0, 1) }))).toBe(true)
    expect(isQuotaDrained(judgeQuotaExhaustion({ family: 'google', groups: gemini(1, 1) }))).toBe(false)
    expect(isQuotaDrained(undefined)).toBe(false)
  })

  describe('per-model reading outranks the grouped windows', () => {
    const inThreeHours = new Date(Date.now() + 3 * 3600_000).toISOString()
    const inThreeDays = new Date(Date.now() + 72 * 3600_000).toISOString()

    it('parks on a spent model even when the grouped window reads a flat 100%', () => {
      // The measured Gemini case: the grouped `gemini-5h` window never moved while
      // the per-model fraction was the number the requests actually drained.
      const verdict = judgeQuotaExhaustion({
        family: 'google',
        groups: gemini(1, 1),
        modelQuota: { remainingFraction: 0, resetTime: inThreeHours },
        modelId: 'gemini-3.8-flash-tiered',
      })
      expect(verdict).toEqual({ state: 'drained', tier: '5h', buckets: ['gemini-3.8-flash-tiered'] })
    })

    it('infers the weekly tier from a reset beyond the 5-hour horizon', () => {
      const verdict = judgeQuotaExhaustion({
        family: 'google',
        groups: gemini(1, 1),
        modelQuota: { remainingFraction: 0, resetTime: inThreeDays },
        modelId: 'gemini-3.8-flash-tiered',
      })
      expect(verdict).toMatchObject({ state: 'drained', tier: 'weekly' })
    })

    it('clears the account when the model still has quota, even if a grouped bucket reads zero', () => {
      expect(judgeQuotaExhaustion({
        family: 'google',
        groups: gemini(0, 1),
        modelQuota: { remainingFraction: 0.4, resetTime: inThreeHours },
      })).toEqual({ state: 'available' })
    })

    it('falls back to the grouped windows when the model reported no fraction', () => {
      expect(judgeQuotaExhaustion({
        family: 'google',
        groups: gemini(0, 1),
        modelQuota: { remainingFraction: null, resetTime: null },
      })).toMatchObject({ state: 'drained', tier: '5h' })
    })
  })
})
