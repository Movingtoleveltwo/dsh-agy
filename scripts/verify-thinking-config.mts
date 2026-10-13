// Real acceptance measurement for `generationConfig.thinkingConfig` on this
// channel. Pins the boundaries any thinking-budget setting depends on, and
// settles two claims currently recorded as UNVERIFIED in
// docs/ANTIGRAVITY-API.md §3 (EN + zh):
//
//   1. The accepted `thinkingBudget` interval is [-1, 65535], with `0` meaning
//      "thinking off" and `-1` meaning "adaptive". -1 being ACCEPTED matters:
//      another implementation's changelog states the backend rejects it and
//      therefore omits the field to express adaptive. Both work here; a client
//      may send -1 explicitly.
//   2. The docs say upstream rejects a `thinkingLevel` on an ID-BOUND model
//      (e.g. `gemini-3.6-flash-high`) with 400. It did not reproduce: such
//      models answered 200 with `thoughtsTokenCount` still tracking the level.
//      Our own wire behavior is unaffected (translate.ts emits a level only for
//      `thinking:'level'`, i.e. `*-tiered`), but the stated REASON may be wrong,
//      so this script asserts the measurement rather than the doc.
//
// Also pinned: `minThinkingBudget` is NOT a validation. A budget below a
// model's own reported minimum is accepted (200), so it must never be used as a
// client-side clamp — doing so would refuse values the backend takes.
//
// Measurement wins over both the docs and any constant: if this script ever
// disagrees with the recorded text, the text is what gets corrected.
//
// Requires a real account. Usage: pnpm run verify:thinking-config
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { refreshAccessToken } from '../src/oauth/refresh.ts'
import { loadMasterKey, resolveDshHome, deriveKey, createAesGcmCodec } from '../src/store/keyring.ts'
import { decryptStorage } from '../src/store/accounts.ts'
import { toAgyRequestBody } from '../src/adapter/translate.ts'
import { fetchAvailableModels } from '../src/adapter/models.ts'
import { AGY_ENDPOINT_DAILY } from '../src/oauth/constants.ts'

const dshHome = resolveDshHome()
const masterKey = loadMasterKey(dshHome)
if (!masterKey) {
  console.error('No AGY_MASTER_KEY — run `dsh-agy login` first.')
  process.exit(1)
}
const codec = createAesGcmCodec(deriveKey(masterKey))
const storage = decryptStorage(JSON.parse(readFileSync(join(dshHome, 'agy', 'agy-accounts.json'), 'utf8')), codec)
const account = storage.accounts[0]
if (!account) {
  console.error('No accounts. Run `dsh-agy login`.')
  process.exit(1)
}

const refreshed = await refreshAccessToken({ access: '', expires: 0, refresh: account.refresh })
if (refreshed.type !== 'success') {
  console.error('refresh failed')
  process.exit(1)
}
const access = refreshed.auth.access

const headers = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${access}`,
  Accept: 'text/event-stream',
  'User-Agent': 'antigravity/cli/1.19.0 (aidev_client; os_type=macos; arch=arm64; auth_method=consumer)',
}

/**
 * The accepted interval, stated once. Every range assertion below is derived
 * from it so a drift is reportable as "the interval moved", not as three
 * unrelated status mismatches.
 */
const BUDGET_MIN = -1
const BUDGET_MAX = 65535

/** A request's outcome: the status, plus the thoughts the turn actually spent. */
interface Outcome {
  status: number | 'transport'
  thoughts: number
  /** Upstream's own message on a non-200, for a self-explaining failure. */
  message: string
}

/**
 * Fire one request with an EXACT thinkingConfig and report what came back.
 *
 * The config is written straight onto the translated body (as
 * `verify-claude-cap` does with maxOutputTokens) so `translate.ts`'s own
 * level→config mapping cannot mask the value under test.
 *
 * Transport failures are retried, because this channel intermittently stalls a
 * reasoning request: without the retry a flaky timeout would be reported as a
 * rejection, which is exactly the false signal this script exists to avoid. A
 * definitive HTTP status is never retried — that IS the measurement.
 */
async function probe(model: string, thinkingConfig: unknown, attempts = 3): Promise<Outcome> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const body = toAgyRequestBody(
      {
        provider: 'agy',
        model,
        messages: [{ id: 't1', role: 'user', content: [{ type: 'text', text: 'What is 17*23? Think briefly, then answer.' }] }],
      } as never,
      { projectId: account.projectId, sessionId: `verify-thinking-${model}-${attempt}` },
    )
    // Overwrite wholesale: a merged config could carry a level translate.ts set.
    const request = body.request as { generationConfig?: unknown }
    request.generationConfig = {
      maxOutputTokens: 4096,
      ...(thinkingConfig === undefined ? {} : { thinkingConfig }),
    }
    try {
      const response = await fetch(`${AGY_ENDPOINT_DAILY}/v1internal:streamGenerateContent?alt=sse`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      })
      const text = await response.text()
      if (response.status !== 200) {
        const message = /"message"\s*:\s*"([^"]{0,200})/.exec(text)?.[1] ?? text.slice(0, 200)
        return { status: response.status, thoughts: -1, message }
      }
      // usageMetadata is nested under `response`, and thoughts are not reliably
      // streamed as parts, so the token count is the signal (not part presence).
      let thoughts = 0
      for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const payload = trimmed.slice(5).trim()
        if (payload === '' || payload === '[DONE]') continue
        try {
          const frame = JSON.parse(payload) as { response?: { usageMetadata?: { thoughtsTokenCount?: number } } }
          const count = frame.response?.usageMetadata?.thoughtsTokenCount
          if (typeof count === 'number') thoughts = count
        } catch {
          // A partial frame is not a finding; the next one carries the same usage.
        }
      }
      return { status: 200, thoughts, message: '' }
    } catch {
      // Transport failure: retry — a flaky timeout is not a rejection.
    }
  }
  return { status: 'transport', thoughts: -1, message: `no response after ${attempts} attempts` }
}

let failures = 0
/** Report one expectation, and count a mismatch. */
function expectStatus(label: string, outcome: Outcome, expected: number | 'any'): boolean {
  const ok = expected === 'any' ? outcome.status !== 'transport' : outcome.status === expected
  if (!ok) failures++
  const detail = outcome.status === 200 ? `200 (thoughts=${outcome.thoughts})` : `${outcome.status}${outcome.message ? ` ${outcome.message}` : ''}`
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label.padEnd(52)} -> ${detail}`)
  return ok
}

// ── Pick models from discovery: a pinned id can be retired, and the point is to
// measure whatever this account can actually call.
const discovered = await fetchAvailableModels(access, account.projectId)
const ids = Object.keys(discovered.models ?? {})
const tiered = ids.filter((id) => id.endsWith('-tiered'))
const idBound = ids.filter((id) => /-((high|medium|low|extra-low))$/.test(id) || id.startsWith('claude-'))
if (tiered.length === 0) {
  console.error('No *-tiered model on this account — cannot measure the level path.')
  process.exit(1)
}
const tieredModel = tiered[0]!
const idBoundModel = idBound[0]
/** The model's own reported floor; the interval assertion below needs it. */
const reportedMin = (discovered.models?.[tieredModel] as { minThinkingBudget?: number } | undefined)?.minThinkingBudget
console.log(`tiered:   ${tieredModel}`)
console.log(`id-bound: ${idBoundModel ?? '(none on this account)'}`)
console.log()

// ── The adaptive path our selector relies on: no config at all.
console.log('— adaptive (no thinkingConfig; the "Default" selector entry) —')
expectStatus('omitted thinkingConfig', await probe(tieredModel, undefined), 200)

console.log()
console.log(`— accepted thinkingBudget interval [${BUDGET_MIN}, ${BUDGET_MAX}] —`)
expectStatus(`budget ${BUDGET_MIN} (adaptive sentinel)`, await probe(tieredModel, { thinkingBudget: BUDGET_MIN }), 200)
// NOT labelled "thinking off": measured, 0 reduces thinking but does not zero
// thoughtsTokenCount (see the interval note in the header).
expectStatus('budget 0 (accepted; reduces, does not disable)', await probe(tieredModel, { thinkingBudget: 0 }), 200)
expectStatus('budget 8192', await probe(tieredModel, { thinkingBudget: 8192 }), 200)
expectStatus(`budget ${BUDGET_MAX} (upper bound)`, await probe(tieredModel, { thinkingBudget: BUDGET_MAX }), 200)
// Controls: without these, a run that accepted EVERYTHING would look like a pass.
expectStatus(`budget ${BUDGET_MIN - 1} (below range)`, await probe(tieredModel, { thinkingBudget: BUDGET_MIN - 1 }), 400)
expectStatus(`budget ${BUDGET_MAX + 1} (above range)`, await probe(tieredModel, { thinkingBudget: BUDGET_MAX + 1 }), 400)

console.log()
console.log('— minThinkingBudget is NOT a client-side clamp —')
if (typeof reportedMin === 'number' && reportedMin > 1) {
  const below = await probe(tieredModel, { thinkingBudget: 1 })
  const ok = below.status === 200
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} budget 1 below reported min ${reportedMin}`.padEnd(72) + `-> ${below.status === 200 ? '200' : `${below.status}`}`)
} else {
  console.log(`SKIP no minThinkingBudget reported for ${tieredModel}`)
}

console.log()
console.log('— thinkingLevel vocabulary is closed to low/medium/high —')
expectStatus('level "high"', await probe(tieredModel, { thinkingLevel: 'high', includeThoughts: true }), 200)
expectStatus('level "low"', await probe(tieredModel, { thinkingLevel: 'low', includeThoughts: true }), 200)
expectStatus('level "auto" (must be rejected)', await probe(tieredModel, { thinkingLevel: 'auto', includeThoughts: true }), 400)

console.log()
console.log(`— CONTRADICTION CHECK: docs claim an id-bound level is rejected with 400 —`)
if (idBoundModel === undefined) {
  console.log('SKIP no id-bound model on this account')
} else {
  // Assert the MEASUREMENT (200), not the doc: if upstream ever starts
  // rejecting, this line goes red and the doc sentence becomes true.
  expectStatus(`${idBoundModel} + level "high"`, await probe(idBoundModel, { thinkingLevel: 'high', includeThoughts: true }), 200)
  console.log('     (200 here means docs/ANTIGRAVITY-API.md §3\'s stated reason is wrong: our code still')
  console.log('      never sends a level for an id-bound model, but not because upstream refuses it.)')
}

console.log()
console.log(failures === 0
  ? `PASS thinkingConfig behaves as recorded (interval [${BUDGET_MIN}, ${BUDGET_MAX}]; adaptive omit and -1 both 200)`
  : `FAIL ${failures} expectation(s) drifted — the measurement wins: update docs/ANTIGRAVITY-API.md §3 (EN + zh) and src/adapter/translate.ts`)
process.exit(failures === 0 ? 0 : 1)
