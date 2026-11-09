/**
 * Fresh Antigravity client version resolution: fetch from the product's own
 * release feeds (6h TTL, single in-flight dedupe), falling back to the pinned
 * pool. Keeps fingerprint User-Agent version strings current — a stale version
 * is the most detectable fingerprint anomaly.
 */

import { AGY_VERSION_FALLBACK, antigravityUserAgent, setResolvedAgyVersion } from '../oauth/constants.ts'
import { proxiedFetch } from '../proxy.ts'

const VERSION_CACHE_TTL_MS = 6 * 60 * 60 * 1000
const VERSION_FETCH_TIMEOUT_MS = 5_000

/** Source 1: Antigravity IDE auto-update release feed (array of {version}). */
const IDE_RELEASE_FEED_URL = 'https://antigravity-auto-updater-974169037036.us-central1.run.app/releases'
/** Source 2: agy CLI GitHub releases (object with tag_name). */
const CLI_RELEASE_URL = 'https://api.github.com/repos/google-antigravity/antigravity-cli/releases/latest'

export interface FetchLike {
  (input: string | URL, init?: RequestInit): Promise<Response>
}

export interface VersionState {
  cache?: { version: string; fetchedAt: number }
  inFlight: Promise<string | undefined> | null
}

function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number(n) || 0)
  const pb = b.split('.').map((n) => Number(n) || 0)
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

function pickNewestVersion(...versions: Array<unknown>): string | null {
  const valid = versions
    .filter((v): v is string => typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v))
  if (valid.length === 0) return null
  return valid.reduce<string | null>((best, v) => (!best || compareSemver(v, best) > 0 ? v : best), null)
}

/**
 * Highest version published so far in this process.
 *
 * Kept locally so publication is monotonic: the two feeds resolve independently
 * and either may finish first, so without this the slower (possibly older) source
 * could lower what a User-Agent already advertises. A version never goes
 * backwards here — only the cold-start floor can be below a published value.
 */
let publishedVersion: string | undefined

/**
 * Publish a newly observed version into the shared slot every User-Agent builder
 * reads ({@link setResolvedAgyVersion}), never lowering an already-published one.
 */
function publishVersion(version: string | null | undefined): void {
  if (version === null || version === undefined) return
  if (compareSemver(version, AGY_VERSION_FALLBACK) < 0) return
  const best = pickNewestVersion(version, publishedVersion)
  if (best === null || best === publishedVersion) return
  publishedVersion = best
  setResolvedAgyVersion(best)
}

function parseIdeReleaseFeed(payload: unknown): string | null {
  if (!Array.isArray(payload)) return null
  return pickNewestVersion(...payload.map((entry) => (entry as { version?: unknown })?.version))
}

function parseCliRelease(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null
  const release = payload as { name?: unknown; tag_name?: unknown }
  return pickNewestVersion(release.tag_name ?? release.name)
}

async function fetchJsonWithTimeout(fetchImpl: FetchLike, url: string): Promise<unknown> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), VERSION_FETCH_TIMEOUT_MS)
  try {
    const response = await fetchImpl(url, {
      // Both feeds are services the official Antigravity client ecosystem
      // already talks to, so the client User-Agent is the consistent choice.
      // This previously sent a hardcoded `dsh-agy/0.1` — a self-identifying
      // string that also never tracked the package version.
      headers: { Accept: 'application/json', 'User-Agent': antigravityUserAgent() },
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`Version source ${url} returned ${response.status}`)
    return response.json()
  } finally {
    clearTimeout(timeoutId)
  }
}

/**
 * Resolve the newest OBSERVED version from one feed, or `undefined` when the
 * feed yielded nothing.
 *
 * Returning `undefined` rather than the pinned fallback is what keeps the
 * fallback out of {@link resolveAntigravityVersion}'s cross-source `max`. When
 * this returned the fallback, a source that simply failed to parse contributed
 * the fallback as though it were evidence, and once the fallback was raised to
 * track the live feed it started outranking genuine — but older — feed data.
 * The fallback is a last resort and is applied once, at the public boundary.
 */
async function resolveObservedVersion(
  state: VersionState,
  sourceUrl: string,
  parse: (payload: unknown) => string | null,
  fetchImpl: FetchLike,
): Promise<string | undefined> {
  const now = Date.now()
  if (state.cache && now - state.cache.fetchedAt < VERSION_CACHE_TTL_MS) {
    publishVersion(state.cache.version)
    return state.cache.version
  }
  if (state.inFlight) return state.inFlight

  state.inFlight = (async () => {
    let resolved: string | null = null
    try {
      resolved = parse(await fetchJsonWithTimeout(fetchImpl, sourceUrl))
    } catch {
      resolved = null
    }
    const observed = pickNewestVersion(resolved, state.cache?.version)
    if (resolved) {
      state.cache = { version: observed ?? resolved, fetchedAt: Date.now() }
      // Publish only a genuinely observed version; the fallback is not evidence.
      publishVersion(resolved)
    }
    return observed ?? undefined
  })()

  try {
    return await state.inFlight
  } finally {
    state.inFlight = null
  }
}

/** Resolve the newest known Antigravity version from the IDE feed. */
export async function resolveAntigravityIdeVersion(fetchImpl: FetchLike = proxiedFetch): Promise<string> {
  return (await resolveObservedVersion(ideState, IDE_RELEASE_FEED_URL, parseIdeReleaseFeed, fetchImpl))
    ?? AGY_VERSION_FALLBACK
}

/** Resolve the newest known Antigravity version from the CLI releases. */
export async function resolveAntigravityCliVersion(fetchImpl: FetchLike = proxiedFetch): Promise<string> {
  return (await resolveObservedVersion(cliState, CLI_RELEASE_URL, parseCliRelease, fetchImpl))
    ?? AGY_VERSION_FALLBACK
}

/**
 * The newest version actually OBSERVED on the claimed product's feed, or
 * `undefined` when it yielded nothing.
 *
 * Reads the **CLI feed only**. This used to take the numeric max across the IDE
 * and CLI feeds, which is a category error: the three Antigravity lines are
 * separate version namespaces (IDE 2.x, hub 2.15.x, CLI 1.2.x), so "newest"
 * across them compares unrelated numbers and picks whichever line happens to
 * count higher. Since this client claims to be the CLI
 * (`docs/official-identity.json`), the CLI feed is the only one that can
 * describe the version we are entitled to advertise; the IDE resolver stays
 * exported for the freshness gate's cross-check, never for the wire.
 *
 * Distinct from {@link resolveAntigravityVersion}, which substitutes the pinned
 * fallback at the boundary. A caller that must tell "observed" from "assumed"
 * cannot use that one — and the freshness gate is exactly such a caller, since
 * the fallback is the value under test.
 */
export async function resolveObservedAgyVersion(fetchImpl: FetchLike = proxiedFetch): Promise<string | undefined> {
  const version = (await resolveObservedVersion(cliState, CLI_RELEASE_URL, parseCliRelease, fetchImpl)) ?? undefined
  if (version && compareSemver(version, AGY_VERSION_FALLBACK) < 0) {
    return undefined
  }
  return version
}

/** Best available version: the claimed product line, cached 6h. */
export async function resolveAntigravityVersion(fetchImpl: FetchLike = proxiedFetch): Promise<string> {
  return (await resolveObservedAgyVersion(fetchImpl)) ?? AGY_VERSION_FALLBACK
}

/**
 * Bounded resolve for fingerprint generation: never block the failure path on
 * cold version feeds. Resolves undefined on timeout/error so callers fall
 * back to the pinned version pool; the abandoned fetch keeps running and
 * populates the 6h cache for later calls.
 *
 * `fetchImpl` routes the probe: the feeds belong to no account, so the caller
 * decides which egress they use (the CLI passes the login proxy, the plugin
 * passes the pool's representative account).
 */
export async function resolveAntigravityVersionBounded(
  timeoutMs = 750,
  fetchImpl: FetchLike = proxiedFetch,
): Promise<string | undefined> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      resolveAntigravityVersion(fetchImpl).catch(() => undefined),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Synchronously peek at a fresh cached version (no network). */
export function peekCachedAntigravityVersion(): string | undefined {
  const now = Date.now()
  for (const state of [cliState, ideState]) {
    if (state.cache && now - state.cache.fetchedAt < VERSION_CACHE_TTL_MS) {
      // A fresh cache is an observation too — publish it so a synchronous peek
      // (the fingerprint failure path) reaches User-Agent builders without I/O.
      publishVersion(state.cache.version)
      return state.cache.version
    }
  }
  return undefined
}

const ideState: VersionState = { inFlight: null }
const cliState: VersionState = { inFlight: null }

/**
 * Drop both feeds' cached state so a test can exercise the cold-start path.
 *
 * `inFlight` is cleared with the cache: a test that lets a probe hang leaves its
 * single-flight promise pending, and the next test's resolve would return THAT
 * promise instead of issuing its own request — silently testing nothing.
 *
 * Deliberately does NOT clear the published version slot: that one is monotonic
 * process state, and dropping it would let a test's User-Agent move backwards.
 */
export function _clearVersionCacheForTest(): void {
  publishedVersion = undefined
  ideState.cache = undefined
  cliState.cache = undefined
  ideState.inFlight = null
  cliState.inFlight = null
}
