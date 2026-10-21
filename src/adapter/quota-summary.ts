/**
 * `v1internal:retrieveUserQuotaSummary` — the grouped 5-hour / weekly quota
 * windows, as distinct from `fetchAvailableModels`' per-model `quotaInfo`.
 *
 * WHY THIS ENDPOINT EXISTS HERE AT ALL. `fetchAvailableModels` reports only
 * `remainingFraction` + `resetTime` per model, with NO window field: measured
 * across every id, the only keys under `quotaInfo` are those two. So a "5-hour
 * vs weekly" view is not derivable from it, and the summary endpoint is the only
 * source for both windows. Recorded in docs/ANTIGRAVITY-API.md §3, which
 * previously stated the opposite ("no retrieveUserQuota path").
 *
 * The shapes differ meaningfully and must not be merged:
 *   - `fetchAvailableModels` -> per MODEL (used for ranking/rotation)
 *   - `retrieveUserQuotaSummary` -> per GROUP (Gemini, Claude+GPT), 2 windows each
 * The group split is upstream's own, so it is carried through verbatim rather
 * than re-derived from model-id prefixes: `3p-*` covers Claude AND GPT, which no
 * prefix rule in `modelFamilyOf` would group together.
 *
 * Measured response (live account):
 *   { groups: [ { displayName, buckets: [
 *       { bucketId: "gemini-5h", window: "5h", remainingFraction, resetTime },
 *       { bucketId: "gemini-weekly", window: "weekly", ... } ] } ] }
 *
 * The identity used is the same bootstrap User-Agent as `fetchAvailableModels`
 * (that pair is what answers 200 here), so nothing new is impersonated.
 */

import { AGY_ENDPOINT_FALLBACKS, AGY_ENDPOINT_PROD, getAgyBootstrapUserAgent } from '../oauth/constants.ts'
import { proxiedFetch } from '../proxy.ts'
import { QUOTA_WINDOWS } from '../types.ts'
import type { QuotaGroup, QuotaWindow } from '../types.ts'

export type { QuotaGroup, QuotaWindow } from '../types.ts'

export const QUOTA_SUMMARY_PATH = '/v1internal:retrieveUserQuotaSummary'

/** The raw response, structurally. */
interface RawQuotaSummary {
  groups?: Array<{
    displayName?: unknown
    buckets?: Array<{
      bucketId?: unknown
      window?: unknown
      remainingFraction?: unknown
      resetTime?: unknown
    }>
  }>
}

/**
 * Sort rank for an upstream window token: shorter windows first.
 *
 * The order comes from `QUOTA_WINDOWS` (`types.ts`), the same table the scheduler
 * reads its window kinds from, so the parser and the scheduler cannot drift
 * apart — they used to keep separate tables, and the `daily` token only one of
 * them knew about silently destroyed a real measurement. Unknown tokens rank last
 * (and tie-break alphabetically) so a window added upstream later is still shown,
 * just after the ones we understand.
 */
function windowRank(window: string): number {
  return QUOTA_WINDOWS[window]?.rank ?? Number.MAX_SAFE_INTEGER
}

/** Clamp to 0..1; a non-number is "unknown" rather than zero. */
function fractionOf(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null
  return Math.max(0, Math.min(1, raw))
}

/** A non-empty string, else null. */
function stringOf(raw: unknown): string | null {
  return typeof raw === 'string' && raw !== '' ? raw : null
}

/**
 * Parse a summary payload into groups.
 *
 * Defensive like the rest of the wire parsing: a group with no usable window is
 * DROPPED rather than rendered as an empty card, because a group row with no
 * windows tells the user nothing and would push a real group off screen. Buckets
 * are ordered with the shorter window first so a group reads "immediate pressure,
 * then the weekly budget" consistently regardless of upstream order.
 */
export function parseQuotaSummary(raw: unknown): QuotaGroup[] {
  const data = raw as RawQuotaSummary | null
  if (typeof data !== 'object' || data === null) return []
  const groups: QuotaGroup[] = []
  for (const group of Array.isArray(data.groups) ? data.groups : []) {
    if (typeof group !== 'object' || group === null) continue
    const windows: QuotaWindow[] = []
    for (const bucket of Array.isArray(group.buckets) ? group.buckets : []) {
      if (typeof bucket !== 'object' || bucket === null) continue
      const bucketId = stringOf(bucket.bucketId)
      const window = stringOf(bucket.window)
      if (bucketId === null || window === null) continue
      windows.push({
        bucketId,
        window,
        remainingFraction: fractionOf(bucket.remainingFraction),
        resetTime: stringOf(bucket.resetTime),
      })
    }
    if (windows.length === 0) continue
    // Shortest window first, by an explicit table rather than by token length.
    // Length happens to order today's vocabulary correctly (`5h` < `weekly`), and
    // would even survive `daily`/`monthly`, but it ranks by a coincidence of
    // spelling instead of by the duration the token names — `daily` (5 chars)
    // would sort BEFORE `weekly` (6) for the wrong reason. An unknown token sorts
    // last, so a window upstream adds later appears after the known ones instead
    // of landing somewhere arbitrary.
    windows.sort((a, b) => windowRank(a.window) - windowRank(b.window) || a.window.localeCompare(b.window))
    groups.push({ name: stringOf(group.displayName) ?? '', windows })
  }
  return groups
}

/**
 * Fetch and parse the grouped windows for one account.
 *
 * Mirrors `fetchAvailableModels`: the endpoint chain is walked here, and the
 * caller injects only the routed+time-bounded fetch, so the account's proxy is
 * honoured (omitting it would go direct and leak the account's real IP) and one
 * shared budget bounds both calls.
 *
 * ORDER DIFFERS FROM GENERATION, ON PURPOSE. The endpoints do not report the same
 * group set. Measured on all four accounts, 2026-10-20, with identical numbers
 * wherever they overlap:
 *
 *   prod           -> Claude and GPT AND Gemini
 *   daily          -> Claude and GPT only
 *   daily-sandbox  -> Claude and GPT only
 *   autopush       -> 3p-weekly only
 *
 * Taking the first 200 in the GENERATION order (daily) therefore hid the whole
 * Gemini card and left the `google` family unreadable, which the rotation verdict
 * can only call "unknown" — no Gemini limit could ever be judged. The prod host is
 * the superset for this READ, so it is asked first here and the rest of the chain
 * stays as the fallback. This is deliberately scoped to this read: the generation
 * path's `daily -> prod -> ...` order is untouched, because prod answers
 * RESOURCE_EXHAUSTED to consumer accounts for GENERATION (see `oauth/constants.ts`).
 *
 * @param accessToken - a live access token for the account.
 * @param projectId - the account's Cloud Code project id, when known.
 * @param fetchImpl - routed, time-bounded fetch implementation.
 * @returns the parsed groups; empty when no endpoint answers (never throws, so a
 *   summary failure cannot discard the ranking data fetched alongside it).
 */
export async function fetchQuotaSummary(
  accessToken: string,
  projectId: string | undefined,
  fetchImpl: typeof fetch = proxiedFetch,
): Promise<QuotaGroup[]> {
  const body = JSON.stringify(projectId ? { project: projectId } : {})
  const attempt = async (baseEndpoint: string): Promise<QuotaGroup[] | undefined> => {
    const response = await fetchImpl(`${baseEndpoint}${QUOTA_SUMMARY_PATH}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': getAgyBootstrapUserAgent(),
      },
      body,
    })
    if (!response.ok) return undefined
    const groups = parseQuotaSummary(await response.json())
    return groups.length > 0 ? groups : undefined
  }

  // Richest-and-earliest: the prod host first (see above), then the chain, so a
  // prod outage degrades to a smaller answer instead of an empty one.
  for (const baseEndpoint of [AGY_ENDPOINT_PROD, ...AGY_ENDPOINT_FALLBACKS.filter((e) => e !== AGY_ENDPOINT_PROD)]) {
    try {
      const groups = await attempt(baseEndpoint)
      if (groups !== undefined) return groups
    } catch {
      // Try the next endpoint; the caller treats an empty result as "unknown".
    }
  }
  return []
}
