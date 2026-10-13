// Real maxOutputTokens ceiling verification for the Claude family on this
// channel. Pins the boundary the catalog default and the translate.ts clamp
// depend on: Claude rejects >64000 with 400 INVALID_ARGUMENT, while Gemini
// accepts 65536 on the same endpoint.
//
// This is a wire fact, not a spec constant: agy may front a self-hosted or
// otherwise gated Claude deployment with its own validation rules, so if this
// script ever disagrees with `AGY_CLAUDE_MAX_OUTPUT_TOKENS`, the measurement
// wins and the constant (plus the catalog entries) must be updated.
//
// Requires a real account. Usage: pnpm run verify:claude-cap
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { refreshAccessToken } from '../src/oauth/refresh.ts'
import { loadMasterKey, resolveDshHome, deriveKey, createAesGcmCodec } from '../src/store/keyring.ts'
import { decryptStorage } from '../src/store/accounts.ts'
import { toAgyRequestBody } from '../src/adapter/translate.ts'
import { AGY_CLAUDE_MAX_OUTPUT_TOKENS } from '../src/adapter/translate.ts'
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
 * Fire one minimal request at an EXACT maxOutputTokens and report the status.
 *
 * The value is written straight onto the translated body: going through
 * `toAgyRequestBody` alone would clamp an over-cap probe back down to the cap
 * (that clamp is the fix under test), so the boundary could never be observed.
 */
async function statusFor(model: string, maxTokens: number): Promise<number> {
  const body = toAgyRequestBody(
    {
      provider: 'agy',
      model,
      messages: [{ id: 't1', role: 'user', content: [{ type: 'text', text: 'Reply with exactly: OK' }] }],
      maxTokens,
    } as never,
    { projectId: account.projectId, sessionId: 'verify-claude-cap' },
  )
  body.request.generationConfig = { ...body.request.generationConfig, maxOutputTokens: maxTokens }
  const response = await fetch(`${AGY_ENDPOINT_DAILY}/v1internal:streamGenerateContent?alt=sse`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  await response.text()
  return response.status
}

const cap = AGY_CLAUDE_MAX_OUTPUT_TOKENS
let failures = 0

// Both Claude ids must pass at the cap and fail just above it.
for (const model of ['claude-opus-4-6-thinking', 'claude-sonnet-4-6']) {
  const atCap = await statusFor(model, cap)
  const overCap = await statusFor(model, cap + 1)
  const ok = atCap === 200 && overCap === 400
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${model}: cap=${cap} -> ${atCap}, cap+1 -> ${overCap}`)
}

// Gemini on the same endpoint keeps the larger ceiling (family-specific limit).
const gemini = await statusFor('gemini-3-flash-agent', 65536)
if (gemini !== 200) failures++
console.log(`${gemini === 200 ? 'PASS' : 'FAIL'} gemini-3-flash-agent: 65536 -> ${gemini}`)

console.log(failures === 0
  ? `\nPASS Claude ceiling is ${cap} (measured); catalog + clamp agree`
  : `\nFAIL ceiling drifted from ${cap} — update AGY_CLAUDE_MAX_OUTPUT_TOKENS and catalog.ts`)
process.exit(failures === 0 ? 0 : 1)
