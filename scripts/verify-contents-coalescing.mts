// Live verification of the contents-coalescing wire shape (issue #93).
//
// Exercises the two shapes `coalesceContents` puts on the wire that had never
// been sent to this channel before, through the FULL adapter stack (refresh →
// store → session manager → adapter.translate → adapter.parse) so headers,
// dispatcher and impersonation match a real request:
//
//   1. fragmented user turns (prompt + injected context) merged into one turn
//   2. parallel tool results grouped into a SINGLE functionResponse turn, kept
//      unmixed from the following text turns
//
// Each scenario first asserts the translated shape locally, then fires it at
// the live backend and requires a completed stream with a sane answer. If this
// script disagrees with the wire, the measurement wins.
//
// Requires a real account (the first in the store). Usage:
//   pnpm run verify:contents-coalescing
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { refreshAccessToken } from '../src/oauth/refresh.ts'
import { loadMasterKey, resolveDshHome, deriveKey, createAesGcmCodec } from '../src/store/keyring.ts'
import { decryptStorage, JsonAccountStore } from '../src/store/accounts.ts'
import { upsertImportedAccount } from '../src/cli/import.ts'
import { AgySessionManager } from '../src/session.ts'
import { AgyAdapter } from '../src/adapter/adapter.ts'
import { listAgyModels } from '../src/adapter/models.ts'
import { toAgyRequestBody, type AgyContent } from '../src/adapter/translate.ts'

const dshHome = resolveDshHome()
const masterKey = loadMasterKey(dshHome)
if (!masterKey) {
  console.error('No AGY_MASTER_KEY — run `dsh-agy login` first.')
  process.exit(1)
}
const codec = createAesGcmCodec(deriveKey(masterKey))
const storage = decryptStorage(JSON.parse(readFileSync(join(dshHome, 'agy', 'agy-accounts.json'), 'utf8')), codec)
const stored = storage.accounts[0]
if (!stored) {
  console.error('No accounts. Run `dsh-agy login`.')
  process.exit(1)
}

// Bootstrap the full stack against a throwaway store seeded from the real
// account — never touch the live store.
const refreshed = await refreshAccessToken({ access: '', expires: 0, refresh: stored.refresh })
if (refreshed.type !== 'success') {
  console.error('refresh failed:', refreshed)
  process.exit(1)
}
const dir = mkdtempSync(join(tmpdir(), 'dsh-agy-verify-coalescing-'))
const store = new JsonAccountStore({
  file: join(dir, 'agy-accounts.json'),
  codec: createAesGcmCodec(deriveKey('verify-coalescing-master-key-000000000000')),
})
await upsertImportedAccount(store, {
  accessToken: refreshed.auth.access,
  refreshToken: stored.refresh,
  tokenType: 'Bearer',
  expiresAt: new Date(refreshed.auth.expires).toISOString(),
  authMethod: 'verify',
  email: stored.email ?? null,
  projectId: stored.projectId,
})
const sessions = new AgySessionManager({ store })
const session = await sessions.getSession()
if (!session) {
  console.error('getSession returned no session')
  process.exit(1)
}
const adapter = new AgyAdapter({
  getSession: () => sessions.getSession(),
  reportFailure: (kind, s, info) => sessions.reportFailure(kind, s, info),
  markSuccess: (s) => sessions.markSuccess(s),
})

const discovered = await listAgyModels(session.auth.access, session.account.projectId)
const ids = discovered.map((m) => m.id)
// Discovery still lists retired ids (a retired id answers 200 with a plain-text
// notice and NO finishReason — measured: "Gemini 3.5 Flash is no longer
// available…"), so prefer ids known live over discovery order.
const prefer = (candidates: string[], fallback: (id: string) => boolean) =>
  candidates.find((id) => ids.includes(id)) ?? ids.find(fallback)
const gemini = prefer(['gemini-3.8-flash-tiered', 'gemini-3.7-flash-tiered', 'gemini-3.8-flash-high'], (id) => id.startsWith('gemini-'))
const claude = prefer(['claude-opus-4-6-thinking', 'claude-sonnet-4-6'], (id) => id.startsWith('claude-'))
if (!gemini) {
  console.error('No Gemini chat model in discovery — cannot verify.')
  process.exit(1)
}
console.log(`models: gemini=${gemini}${claude ? ` claude=${claude}` : ' (no claude — skipping that pass)'}`)

const TOOL = {
  name: 'get_value',
  description: 'read a named value from the store',
  parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
}

interface Round {
  text: string
  calls: Array<{ id: string; name: string; arguments: string }>
  finish: string
}

/** One full adapter.stream() round; a thrown error propagates as failure. */
async function call(model: string, messages: unknown[], tools?: unknown[]): Promise<Round> {
  const round: Round = { text: '', calls: [], finish: '' }
  for await (const chunk of adapter.stream({
    provider: 'agy',
    model,
    messages,
    ...(tools ? { tools } : {}),
    maxTokens: 1024,
  } as never)) {
    if (chunk.type === 'text-delta') round.text += chunk.text
    if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
      round.calls.push({ id: chunk.block.id, name: chunk.block.name, arguments: String(chunk.block.arguments) })
    }
    if (chunk.type === 'finish') round.finish = chunk.reason.kind
  }
  return round
}

/** Role run-lengths of the translated contents, e.g. "user×2 | model×1". */
function shape(contents: AgyContent[]): string {
  const out: string[] = []
  for (let i = 0; i < contents.length;) {
    let j = i
    while (j < contents.length && contents[j]!.role === contents[i]!.role) j++
    out.push(`${contents[i]!.role}×${j - i}`)
    i = j
  }
  return out.join(' | ')
}

function translatedShape(model: string, messages: unknown[], tools?: unknown[]): string {
  return shape(toAgyRequestBody({ provider: 'agy', model, messages, ...(tools ? { tools } : {}) } as never, {
    projectId: session.account.projectId,
    sessionId: 'verify-contents-coalescing',
  }).request.contents)
}

const failures: string[] = []
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    console.log(`✓ ${name}`)
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
    console.error(`✗ ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

/** One attempt; premature stream cuts are the known transient failure class (issue #85). */
async function attempt(model: string, messages: unknown[], tools?: unknown[]): Promise<Round> {
  try {
    return await call(model, messages, tools)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!message.includes('terminated prematurely')) throw error
    console.log(`  premature stream cut, retrying once (issue #85 transient)…`)
    return call(model, messages, tools)
  }
}

// ── Canary: the plain single-turn shape, to separate channel health from shape rejection ──
await step('[canary] single-turn sanity', async () => {
  const canary = [{ id: 'v-0', role: 'user', content: [{ type: 'text', text: 'Reply with exactly: OK' }] }]
  const round = await attempt(gemini, canary)
  assert(round.finish !== '', 'canary stream produced no finish reason — channel unhealthy right now')
  assert(round.text.includes('OK'), `canary answer: ${round.text}`)
})

// ── Scenario 1: fragmented user turns merge into one ──────────────────────
const fragmented = [
  { id: 'v-1', role: 'user', content: [{ type: 'text', text: '用一句中文回答：1 加 1 等于几？' }] },
  { id: 'v-2', role: 'user', content: [{ type: 'text', text: 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.' }] },
]
await step(`[gemini] fragmented user turns merge (${gemini})`, async () => {
  assert(translatedShape(gemini, fragmented) === 'user×1', `expected user×1, got ${translatedShape(gemini, fragmented)}`)
  const round = await call(gemini, fragmented)
  assert(round.finish !== '', 'stream produced no finish reason')
  assert(round.text.includes('2'), `answer missing "2": ${round.text}`)
})

// ── Scenarios 2+3: parallel tool results grouped, unmixed from text turns ──
async function parallelTools(model: string, label: string): Promise<void> {
  const prompt = [
    { id: 'v-p', role: 'user', content: [{ type: 'text', text: 'Call the get_value tool TWICE in one turn: once with key "alpha" and once with key "beta". Do not answer until both results arrive.' }] },
  ]
  const toolCalls = (round: Round) => round.calls.map((c) => ({ type: 'tool-call', id: c.id, name: c.name, arguments: c.arguments }))
  const first = await attempt(model, prompt, [TOOL])
  assert(first.calls.length >= 2, `expected >=2 parallel tool calls, got ${first.calls.length}`)
  const [a, b] = first.calls
  const assistantTurn = { id: 'v-a', role: 'assistant', content: toolCalls(first) }
  const results = [
    { id: 'v-t1', role: 'user', content: [{ type: 'tool-result', toolCallId: a!.id, content: [{ type: 'text', text: 'value of alpha is 111' }] }] },
    { id: 'v-t2', role: 'user', content: [{ type: 'tool-result', toolCallId: b!.id, content: [{ type: 'text', text: 'value of beta is 222' }] }] },
  ]
  await step(`[${label}] parallel tool results grouped into one functionResponse turn`, async () => {
    // Round-1 ends on the assistant's tool-call turn; the Claude path strips
    // trailing model turns (assistant-prefill rejection), so that shape
    // assertion only holds on the Gemini path.
    if (!model.startsWith('claude-')) {
      assert(translatedShape(model, [...prompt, assistantTurn]) === 'user×1 | model×1', `round-1 shape: ${translatedShape(model, [...prompt, assistantTurn])}`)
    }
    const withResults = [...prompt, assistantTurn, ...results]
    assert(translatedShape(model, withResults) === 'user×1 | model×1 | user×1', `expected user×1 | model×1 | user×1, got ${translatedShape(model, withResults)}`)
    const frTurn = toAgyRequestBody({ provider: 'agy', model, messages: withResults } as never, {}).request.contents[2]!
    assert(frTurn.parts.length === 2 && frTurn.parts.every((p) => 'functionResponse' in p), `expected one turn with 2 functionResponse parts, got ${JSON.stringify(frTurn.parts).slice(0, 200)}`)
    const round = await call(model, withResults, [TOOL])
    assert(round.finish !== '', 'stream produced no finish reason')
    assert(round.text.includes('111') && round.text.includes('222'), `answer missing tool values: ${round.text}`)
  })
  await step(`[${label}] fr turn stays unmixed from a following text turn`, async () => {
    const withContext = [
      ...prompt,
      assistantTurn,
      ...results,
      { id: 'v-ctx', role: 'user', content: [{ type: 'text', text: 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.' }] },
    ]
    // The fr turn and the context turn are two ADJACENT user contents (the
    // family rule) — the run-lengths show them as one user×2 run.
    assert(translatedShape(model, withContext) === 'user×1 | model×1 | user×2', `expected user×1 | model×1 | user×2, got ${translatedShape(model, withContext)}`)
    const contents = toAgyRequestBody({ provider: 'agy', model, messages: withContext } as never, {}).request.contents
    assert(contents[2]!.parts.every((p) => 'functionResponse' in p), `contents[2] must be fr-only: ${JSON.stringify(contents[2]!.parts).slice(0, 120)}`)
    assert(contents[3]!.parts.every((p) => 'text' in p), `contents[3] must be text-only: ${JSON.stringify(contents[3]!.parts).slice(0, 120)}`)
    const round = await call(model, withContext, [TOOL])
    assert(round.finish !== '', 'stream produced no finish reason')
  })
}

await parallelTools(gemini, 'gemini')
if (claude) await parallelTools(claude, 'claude')

rmSync(dir, { recursive: true, force: true })
if (failures.length > 0) {
  console.error(`\n${failures.length} scenario(s) failed.`)
  process.exit(1)
}
console.log('\nAll coalescing scenarios verified against the live channel.')
