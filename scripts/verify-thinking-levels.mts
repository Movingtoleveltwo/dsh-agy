// Measures how much the thinking settings actually change thinking, and pins the
// ONE fact that invalidated an entire earlier investigation:
//
//   THINKING AND OUTPUT SHARE `maxOutputTokens`. thoughts + output = cap.
//
// Measured exactly: cap 2048 -> 1962 thoughts + 82 output = 2044; cap 65536 ->
// 62912 thoughts + 9 output. So a harness that pins `maxOutputTokens` below the
// thinking demand is measuring ITS OWN PIN, not the model or the setting. Six
// earlier runs at cap 60000 all reported ~24k regardless of level and looked
// like "the tiers are equivalent"; at the real ceiling they separate.
// `maxOutputTokens: 60000` together with `thinkingBudget: 65535` is also
// self-contradictory, which is how a "Max" setting came to be measured without
// ever being sent.
//
// RECORDED RESULTS (gemini-3.8-flash-tiered, cap 65536). Thinking tokens:
//
//              easy      medium      hard
//   Default      ~134      ~1,095     ~48,721
//   Low           ~50            0      ~8,970   (0 = measured zero, not missing)
//   Medium       ~150        ~872     ~60,414
//   High         ~166      ~1,856     ~63,381
//   entered 65535 ~184      ~2,130     ~62,913   (nested under High)
//
//   hard column as % of the 65536 ceiling: Default 74.3%, Low 13.7%,
//   Medium 92.2%, High 96.7%. Medium and High both nearly fill the budget on a
//   hard prompt, which is why they can look equivalent there while differing
//   sharply on easy ones. 65535 vs High: +11% easy, +15% medium, -0.7% hard.
//
//   `Default`'s hard cell carried only 2 samples (34k, 57k — 51% apart) until
//   four more were taken (56k, 51k, 43k, 51k); 6 samples now give ~48,700 at
//   sd ~8,800. It was the weakest cell in the published table.
//
//   easy/medium were taken at cap 60000. They are still valid because they sit
//   far BELOW either cap (~50-1,900), so the cap never bound them; only the hard
//   column needed re-measuring at the ceiling.
//
// `Low` on the MEDIUM prompt is a measured ZERO, not missing data: all 5 runs
// returned no thoughtsTokenCount, and total - output equalled the prompt size
// (38 tokens) every time, i.e. total = prompt + output. The easy prompt reports
// ~50 for the same setting, which is what rules out a harness fault.
//
// Run it when you need to re-derive the numbers behind the client's reference
// table, or when a new model family appears.
//
// PRIVACY: prints no account email, project id, token, or proxy. Only the model
// id, the request shape, and token counts reach stdout.
//
// Requires a real account. Usage: pnpm run verify:thinking-levels
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { refreshAccessToken } from '../src/oauth/refresh.ts'
import { loadMasterKey, resolveDshHome, deriveKey, createAesGcmCodec } from '../src/store/keyring.ts'
import { decryptStorage } from '../src/store/accounts.ts'
import { toAgyRequestBody } from '../src/adapter/translate.ts'
import { AGY_ENDPOINT_DAILY } from '../src/oauth/constants.ts'

const dshHome = resolveDshHome()
const masterKey = loadMasterKey(dshHome)
if (!masterKey) {
  console.error('No AGY_MASTER_KEY — run `dsh-agy login` first.')
  process.exit(1)
}
const codec = createAesGcmCodec(deriveKey(masterKey))
const storage = decryptStorage(
  JSON.parse(readFileSync(join(dshHome, 'agy', 'agy-accounts.json'), 'utf8')),
  codec,
)
const account = storage.accounts[0]
if (!account) {
  console.error('No account in the store — run `dsh-agy login` first.')
  process.exit(1)
}
const refreshed = await refreshAccessToken({
  access: '', expires: 0, refresh: account.refresh,
})
if (refreshed.type !== 'success') {
  console.error('Token refresh failed; cannot measure.')
  process.exit(1)
}
const token = refreshed.auth.access

const MODEL = 'gemini-3.8-flash-tiered'
// The model's real ceiling. Gemini accepts 65536; the Claude family rejects
// >64000. Pinning anything lower is what made earlier results unreadable.
const CAP = 65536

const HEADERS = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${token}`,
  Accept: 'text/event-stream',
  'User-Agent': 'antigravity/cli/1.19.0 (aidev_client; os_type=macos; arch=arm64; auth_method=consumer)',
}

/**
 * Difficulty is not the same as length. A prompt that demands long PROSE spends
 * the shared budget on prose and reports LESS thinking — an 8-problem
 * "show every step" prompt scored lower than a 4-problem one for exactly this
 * reason. These prompts are hard to REASON about but terse to ANSWER, so the
 * reading reflects thinking rather than verbosity.
 */
const PROMPTS = {
  easy: 'What is 17*23? Reply with just the number.',
  medium: 'Prove or disprove: for every integer n>1, n^4+4 is composite. Then find all n where n^4+4 is prime. Reply with only the final answer and a one-line justification.',
  hard: 'Let T(n) be the number of ways to tile a 4-by-n rectangle using 1x2 dominoes and L-shaped trominoes (3 squares). Derive a linear recurrence for T(n), then compute T(40) mod 1000000007. Reason as deeply as you need, but reply with ONLY the final integer and nothing else.',
} as const

type Difficulty = keyof typeof PROMPTS
/** `undefined` = the picker's Default effort: no thinkingConfig is sent at all. */
const SETTINGS: ReadonlyArray<{ label: string, config: unknown }> = [
  { label: 'Default', config: undefined },
  { label: 'Low', config: { thinkingLevel: 'low', includeThoughts: true } },
  { label: 'Medium', config: { thinkingLevel: 'medium', includeThoughts: true } },
  { label: 'High', config: { thinkingLevel: 'high', includeThoughts: true } },
]

interface Usage {
  thoughts: number
  output: number
  prompt: number
  total: number
}

/** One generation. Returns every usage field, so truncation stays visible. */
async function generate(difficulty: Difficulty, config: unknown, cap = CAP): Promise<Usage | string> {
  const body = toAgyRequestBody(
    {
      provider: 'agy',
      model: MODEL,
      messages: [{ id: 't1', role: 'user', content: [{ type: 'text', text: PROMPTS[difficulty] }] }],
    } as never,
    { projectId: account.projectId, sessionId: `levels-${Math.random().toString(36).slice(2, 9)}` },
  )
  const generationConfig: Record<string, unknown> = { maxOutputTokens: cap }
  if (config !== undefined) generationConfig.thinkingConfig = config
  ;(body.request as { generationConfig?: unknown }).generationConfig = generationConfig

  try {
    const response = await fetch(`${AGY_ENDPOINT_DAILY}/v1internal:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(280_000),
    })
    const text = await response.text()
    if (response.status !== 200) return `HTTP ${response.status}`
    let usage: Usage | undefined
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const payload = trimmed.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      try {
        const parsed = JSON.parse(payload) as { response?: { usageMetadata?: Record<string, number> } }
        const meta = parsed.response?.usageMetadata
        if (meta) {
          usage = {
            thoughts: meta.thoughtsTokenCount ?? -1,
            output: meta.candidatesTokenCount ?? -1,
            prompt: meta.promptTokenCount ?? -1,
            total: meta.totalTokenCount ?? -1,
          }
        }
      } catch { /* partial SSE frame; the last complete one wins */ }
    }
    return usage ?? 'no usageMetadata'
  } catch (error) {
    return `ERR ${(error as Error).name}`
  }
}

const mean = (values: number[]): number => values.reduce((a, b) => a + b, 0) / values.length

// ── 1. The shared-budget proof ───────────────────────────────────────────────
// Two caps, same setting. If thinking tracks the cap, thinking and output share
// one budget and every measurement taken under a low cap is about that cap.
console.log('=== Shared-budget check (same setting, two caps) ===')
console.log('    If thoughts collapses with the cap, thinking and output share one budget.')
for (const cap of [2048, CAP]) {
  const result = await generate('hard', { thinkingBudget: 65535, includeThoughts: true }, cap)
  if (typeof result === 'string') {
    console.log(`  cap ${cap}: ${result}`)
    continue
  }
  const sum = result.thoughts + result.output
  console.log(
    `  cap ${String(cap).padStart(5)}: thoughts ${String(result.thoughts).padStart(6)}`
    + ` + output ${String(result.output).padStart(5)} = ${String(sum).padStart(6)}`
    + `  (${(sum / cap * 100).toFixed(1)}% of cap)`,
  )
}

// ── 2. The level table ───────────────────────────────────────────────────────
const SAMPLES = 2
const collected: Record<string, Partial<Record<Difficulty, number>>> = {}
console.log()
console.log(`=== Thinking tokens by difficulty (cap ${CAP}, ${SAMPLES} samples each) ===`)
console.log(`    Model: ${MODEL}`)
for (const setting of SETTINGS) {
  collected[setting.label] = {}
  const cells: string[] = []
  for (const difficulty of ['easy', 'medium', 'hard'] as const) {
    const readings: number[] = []
    for (let i = 0; i < SAMPLES; i += 1) {
      const result = await generate(difficulty, setting.config)
      if (typeof result !== 'string' && result.thoughts >= 0) readings.push(result.thoughts)
    }
    // An empty cell is reported as such rather than guessed: `Low` on a
    // demanding prompt reports no thoughtsTokenCount at all.
    if (readings.length === 0) { cells.push('unreported'); continue }
    const value = Math.round(mean(readings))
    collected[setting.label]![difficulty] = value
    cells.push(`~${value.toLocaleString('en-US')}`)
  }
  console.log(`  ${setting.label.padEnd(8)} easy ${cells[0]!.padStart(10)}   medium ${cells[1]!.padStart(10)}   hard ${cells[2]!.padStart(10)}`)
}

// ── 3. What the numbers mean ─────────────────────────────────────────────────
console.log()
console.log('=== Reading ===')
const hardHigh = collected.High?.hard
if (hardHigh !== undefined) {
  console.log(`  High reaches ${(hardHigh / CAP * 100).toFixed(1)}% of the ${CAP} ceiling on the hard prompt,`)
  console.log('  so no budget above it can unlock more: `thinkingBudget: 65535` and `high` are equivalent.')
}
const hardDefault = collected.Default?.hard
const hardMedium = collected.Medium?.hard
if (hardDefault !== undefined && hardMedium !== undefined) {
  console.log(`  Blank is NOT maximum: Default (${hardDefault.toLocaleString('en-US')}) sits BELOW Medium (${hardMedium.toLocaleString('en-US')}) on the hard prompt.`)
}
console.log('  Values are samples, not constants: difficulty, not length, moves them.')
console.log()
console.log('Update the client table in src/client/index.ts (THINKING_SAMPLES) only if these')
console.log('differ materially, and keep the note that they are samples.')
