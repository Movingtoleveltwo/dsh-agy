/**
 * Whether an account is REALLY out of quota, decided from the quota ledger
 * rather than from the wording of the failure that brought us here.
 *
 * WHY THIS EXISTS. A 429 says "this request was refused", not "which limit
 * refused it": the same status covers per-minute rate limits, token-throughput
 * limits, concurrency caps, capacity rejections, a shared project's budget and a
 * genuinely drained 5-hour or weekly bucket — recovery times from three seconds
 * to seven days. Classifying it from the response body's prose is guessing:
 * Google's own `RESOURCE_EXHAUSTED` enum carries BOTH quota and rate-limit
 * meanings, so the generic body (`Resource has been exhausted (e.g. check
 * quota)`) matches a quota keyword while describing a throttle. That guess is
 * how two healthy accounts got parked for five hours (2026-10-20).
 *
 * The ledger endpoint (`retrieveUserQuotaSummary`) answers the question
 * structurally instead: per family, per window, `remainingFraction` and
 * `resetTime`. A zero 5-hour bucket is a spent 5-hour bucket; a zero weekly
 * bucket is a spent week; anything else is NOT quota exhaustion.
 *
 * Three states, and the third one carries the policy: an unreadable ledger is
 * `unknown`, and `unknown` must never be treated as "spent" — the asymmetry is
 * deliberate, because parking an account that still had quota costs hours of
 * capacity silently, while letting an unclear failure through costs one retry.
 */

import type { QuotaGroup, QuotaWindow } from '../types.ts'
import { familiesForGroup } from './quota.ts'
import type { ModelFamily } from './quota.ts'
import { DEFAULT_QUOTA_COOLDOWN_MS, WEEKLY_QUOTA_THRESHOLD } from './rotation.ts'

/** Which window's exhaustion the verdict found. Drives the cooldown tier. */
export type QuotaVerdictTier = '5h' | 'weekly'

/**
 * Why a reading could not settle the question. Kept as distinct tokens because
 * they route differently in diagnostics: a failed probe is an upstream/egress
 * problem, a missing family is this account simply not reporting that family
 * (the measured `bthuhuong970` case — only the Claude/GPT group came back, so
 * nothing on the wire could have said anything about Gemini).
 */
export type QuotaVerdictUnknownReason =
  | 'probe-failed'
  | 'no-family-window'
  | 'no-model'
  | 'partial-reading'

/**
 * One model's `quotaInfo` from `fetchAvailableModels`.
 *
 * This is the reading that actually MOVES for the models in use, and it is a
 * different ledger from the grouped windows: measured 2026-10-20 on three live
 * accounts, `gemini-3.8-flash-tiered` reported 92.7% / 91.9% / 98.3% here while
 * `retrieveUserQuotaSummary`'s `gemini-5h` reported 100% for all three, with a
 * reset that was always "now + 5 hours". The grouped Gemini window does not
 * account for these models at all, so judging Gemini by it can only ever answer
 * "available" — which is why this outranks the groups whenever it is reported.
 */
export interface ModelQuotaReading {
  /** 0..1 remaining for that model, or null when upstream omitted the fraction. */
  remainingFraction: number | null
  /** That model's window reset (RFC3339), or null when omitted. */
  resetTime: string | null
}

export type QuotaVerdict =
  | {
    /** The family's quota is affirmatively spent in `tier`'s window. */
    state: 'drained'
    tier: QuotaVerdictTier
    /** Upstream bucket ids (or model ids) that carried the zero, for the ledger. */
    buckets: string[]
  }
  /** Affirmatively NOT spent: every reading we have says usable. */
  | { state: 'available' }
  /** The ledger could not answer. Nothing may be cooled on this. */
  | { state: 'unknown'; reason: QuotaVerdictUnknownReason }

/** Narrowing helper so callers read `drained` without a cast. */
export function isQuotaDrained(verdict: QuotaVerdict | undefined): verdict is Extract<QuotaVerdict, { state: 'drained' }> {
  return verdict?.state === 'drained'
}

/** A 5-hour bucket counts as spent only at a measured zero, matching `isFamilyQuotaExhausted`. */
function fiveHourSpent(window: QuotaWindow): boolean {
  return window.window === '5h' && window.remainingFraction !== null && window.remainingFraction <= 0
}

/**
 * A weekly bucket counts as spent at `WEEKLY_QUOTA_THRESHOLD`, not exactly zero:
 * 1% of a week is still usable work, but a week's wait is what the caller is
 * about to spend, so the softer bar is the safer one here (the rationale is on
 * the constant).
 */
function weeklySpent(window: QuotaWindow): boolean {
  return window.window === 'weekly'
    && window.remainingFraction !== null
    && window.remainingFraction <= WEEKLY_QUOTA_THRESHOLD
}

/**
 * Read ONE family's quota out of the ledger probes.
 *
 * EVIDENCE ORDER. `modelQuota` (the reading for the exact model being requested)
 * outranks `groups` whenever it carries a fraction, because it is the ledger the
 * requests actually draw from: the measured Gemini case above had the per-model
 * number falling (92.7%) while the grouped window sat at a flat 100% with a reset
 * that could never arrive. The grouped windows are the fallback, and they are the
 * primary source for the families whose two views agree (Claude/GPT: measured
 * identical fraction and identical reset).
 *
 * `groups` is the raw `retrieveUserQuotaSummary` result; an empty list means the
 * probe failed (the transport answers failures with `[]`, never a throw). Groups
 * are attributed to families by `familiesForGroup` — the same bucket-id-first,
 * label-second rule the cache uses — so a family is only judged by windows that
 * actually belong to it: another family's healthy reading says nothing about
 * this one.
 *
 * @param modelQuota - per-model reading for THIS request's model, when the probe
 *   reported one. `remainingFraction: null` means "reported but unmeasured" and
 *   falls through to the grouped windows.
 * @param modelId - label for the drained buckets when the per-model reading is
 *   the one that decided.
 * @param now - clock for the tier inference (defaults to `Date.now()`).
 */
export function judgeQuotaExhaustion(input: {
  family?: ModelFamily
  groups: readonly QuotaGroup[]
  modelQuota?: ModelQuotaReading
  modelId?: string
  now?: number
}): QuotaVerdict {
  const { family, groups, modelQuota, modelId } = input
  if (family === undefined) return { state: 'unknown', reason: 'no-model' }

  const modelFraction = modelQuota?.remainingFraction
  if (typeof modelFraction === 'number' && Number.isFinite(modelFraction)) {
    // A per-model zero is a spent window for that model, and it needs no family
    // grouping to read. `<= 0` rather than a soft threshold: a false park is the
    // expensive mistake here, and only a measured zero is unambiguous.
    if (modelFraction > 0) return { state: 'available' }
    return { state: 'drained', tier: tierForReset(modelQuota?.resetTime, input.now), buckets: [modelId ?? 'model'] }
  }

  if (groups.length === 0) return { state: 'unknown', reason: 'probe-failed' }

  const windows: QuotaWindow[] = []
  for (const group of groups) {
    if (familiesForGroup(group).includes(family)) windows.push(...group.windows)
  }
  if (windows.length === 0) return { state: 'unknown', reason: 'no-family-window' }

  // Weekly first: it is the longer rest and it bounds the shorter one (a drained
  // week says nothing about the 5-hour window, but it outlives it).
  const weekly = windows.filter(weeklySpent)
  if (weekly.length > 0) {
    return { state: 'drained', tier: 'weekly', buckets: weekly.map((window) => window.bucketId) }
  }
  const fiveHour = windows.filter(fiveHourSpent)
  if (fiveHour.length > 0) {
    return { state: 'drained', tier: '5h', buckets: fiveHour.map((window) => window.bucketId) }
  }

  // `available` is a claim about the whole family, so it needs a reading for
  // EVERY window: one `null` fraction leaves the family unmeasured, and calling
  // that "available" would turn a malformed probe into a false all-clear.
  if (windows.some((window) => window.remainingFraction === null)) {
    return { state: 'unknown', reason: 'partial-reading' }
  }
  return { state: 'available' }
}

/**
 * Which cooldown tier an exhausted PER-MODEL reading belongs to.
 *
 * `quotaInfo` carries no window token (measured: exactly `remainingFraction` and
 * `resetTime`), so the tier is inferred from the reset horizon: the 5-hour window
 * cannot extend past five hours from now, so a reset beyond that can only be the
 * weekly bucket. A missing or already-elapsed reset says nothing and is treated
 * as the shorter tier — the cheaper rest of the two.
 */
function tierForReset(resetTime: string | null | undefined, now = Date.now()): QuotaVerdictTier {
  if (!resetTime) return '5h'
  const reset = Date.parse(resetTime)
  if (Number.isNaN(reset)) return '5h'
  return reset - now > DEFAULT_QUOTA_COOLDOWN_MS ? 'weekly' : '5h'
}
