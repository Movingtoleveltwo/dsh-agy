// Real verification of the Claude-path `contents[]` part contract on this
// channel. Pins the three part-shape rejections that are Claude-only (Gemini
// accepts all of them on the same endpoint):
//
//   1. an empty text part   -> "text.text: Field required"
//   2. functionResponse     -> needs `id` ("tool_result.tool_use_id: Field required")
//   3. a replayed thought   -> needs a valid `signature`; the
//                              skip_thought_signature_validator sentinel that
//                              works for functionCall parts is rejected here
//
// These are wire facts, not spec constants: the Anthropic-backed Claude path
// validates against its own schema. If this script disagrees with
// translate.ts, the measurement wins and the translation must change.
//
// Requires a real account. Usage: pnpm run verify:claude-parts
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
const CLAUDE = 'claude-opus-4-6-thinking'
const GEMINI = 'gemini-3-flash-agent'
const TOOL = {
  name: 'read',
  description: 'read a file',
  parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] },
}

/** Fire a raw request (bypassing translate.ts) so each shape is measured directly. */
async function raw(model: string, contents: unknown[]): Promise<number> {
  const body = JSON.stringify({
    project: account.projectId,
    requestId: `agent/${Date.now()}/verify`,
    model,
    userAgent: 'antigravity',
    requestType: 'agent',
    request: { contents, tools: [{ functionDeclarations: [TOOL] }], generationConfig: { maxOutputTokens: 1024 }, sessionId: 'verify-claude-parts' },
  })
  const response = await fetch(`${AGY_ENDPOINT_DAILY}/v1internal:streamGenerateContent?alt=sse`, { method: 'POST', headers, body })
  await response.text()
  return response.status
}

/** Send through the real adapter path (the fix under test). */
async function viaTranslate(model: string, messages: unknown[]): Promise<number> {
  const body = toAgyRequestBody({ provider: 'agy', model, messages, tools: [TOOL], maxTokens: 1024 } as never, {
    projectId: account.projectId,
    sessionId: 'verify-claude-parts',
  })
  const response = await fetch(`${AGY_ENDPOINT_DAILY}/v1internal:streamGenerateContent?alt=sse`, { method: 'POST', headers, body: JSON.stringify(body) })
  await response.text()
  return response.status
}

let failures = 0
function check(label: string, actual: number, expected: number): void {
  const ok = actual === expected
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: got ${actual}, expected ${expected}`)
}

const emptyText = [{ role: 'user', parts: [{ text: 'Reply OK' }, { text: '' }] }]
const toolPair = (id?: string) => [
  { role: 'user', parts: [{ text: 'Read /tmp/x' }] },
  { role: 'model', parts: [{ text: 'ok' }, { thoughtSignature: 'skip_thought_signature_validator', functionCall: { id: 'toolu_abc', name: 'read', args: { file_path: '/tmp/x' } } }] },
  { role: 'user', parts: [id ? { functionResponse: { id, name: 'read', response: { result: 'body' } } } : { functionResponse: { name: 'read', response: { result: 'body' } } }] },
]
const withThought = [
  { role: 'user', parts: [{ text: 'hi' }] },
  { role: 'model', parts: [{ thought: true, text: 'a thought' }, { text: 'answer' }] },
  { role: 'user', parts: [{ text: 'next' }] },
]

// 1. Baseline: these raw shapes must reproduce the rejections (proves the probe
//    is red-capable, not merely reporting whatever the server happens to say).
check('raw empty text 400s on Claude', await raw(CLAUDE, emptyText), 400)
check('raw functionResponse without id 400s on Claude', await raw(CLAUDE, toolPair()), 400)
check('raw replayed thought 400s on Claude', await raw(CLAUDE, withThought), 400)
// Gemini tolerates all three — the constraints are Claude-only.
check('raw empty text 200s on Gemini', await raw(GEMINI, emptyText), 200)
check('raw functionResponse without id 200s on Gemini', await raw(GEMINI, toolPair()), 200)
check('raw replayed thought 200s on Gemini', await raw(GEMINI, withThought), 200)

// 2. The adapter must normalize every one of them to a 200.
const messages = (parts: { type: string; text?: string }[], extra: unknown[] = []) => [
  { id: 'u1', role: 'user', content: [{ type: 'text', text: 'hi' }] },
  { id: 'a1', role: 'assistant', content: parts },
  { id: 'u2', role: 'user', content: [{ type: 'text', text: 'next' }] },
  ...extra,
]
check('translate drops empty text (Claude)', await viaTranslate(CLAUDE, messages([
  { type: 'text', text: 'answer' }, { type: 'text', text: '' },
])), 200)
check('translate drops replayed thought (Claude)', await viaTranslate(CLAUDE, messages([
  { type: 'reasoning', text: 'a thought' }, { type: 'text', text: 'answer' },
])), 200)
check('translate carries tool_use_id (Claude)', await viaTranslate(CLAUDE, [
  { id: 'u1', role: 'user', content: [{ type: 'text', text: 'Read /tmp/x' }] },
  { id: 'a1', role: 'assistant', content: [{ type: 'tool-call', id: 'toolu_abc', name: 'read', arguments: '{"file_path":"/tmp/x"}' }] },
  { id: 'u2', role: 'user', content: [{ type: 'tool-result', toolCallId: 'toolu_abc', content: [{ type: 'text', text: 'body' }] }] },
]), 200)
// Gemini keeps replayed thoughts (the drop is Claude-only).
check('translate keeps replayed thought (Gemini)', await viaTranslate(GEMINI, messages([
  { type: 'reasoning', text: 'a thought' }, { type: 'text', text: 'answer' },
])), 200)

console.log(failures === 0
  ? '\nPASS Claude part contract holds: empty text + thoughts dropped, tool_use_id carried'
  : `\nFAIL ${failures} check(s) drifted — revisit translate.ts against the measurements above`)
process.exit(failures === 0 ? 0 : 1)
