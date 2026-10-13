// Does the backend ACCEPT the identity metadata this client now sends?
//
// `loadCodeAssist` / `onboardUser` carry `metadata` (the ClientMetadata message)
// in their request BODY, and this round added `ideVersion` + `platform` to it.
// `platform` was previously believed forbidden: a live probe had returned
// INVALID_ARGUMENT, and the rule written down was "send ideType only". Reading
// the official descriptor showed the error was on the VALUE ("MACOS", not a
// member of ClientMetadata.Platform), not the FIELD — so the rule was a
// misreading, and `DARWIN_ARM64` should be accepted.
//
// Should, not does. This path is LOGIN and ONBOARDING, so a wrong field there
// breaks new accounts outright rather than degrading a generation. This script
// settles it against the real backend before anyone finds out the hard way.
//
// It runs an A/B: the SAME request twice, differing only in the metadata object
// — the real `bootstrapMetadata()` versus the legacy `{ ideType }` control.
// Without the control a 400 is ambiguous: it could be the credentials, the
// endpoint, or our new field. With it, a divergence names the cause exactly.
//
// `dsh-agy verify` CANNOT answer this: it refreshes the token and calls
// googleapis.com/oauth2/v1/userinfo, which never touches the Cloud Code backend.
//
// Read-only with respect to the store and to quota: no generation, no store
// write. Requires a real account. Usage: pnpm run verify:metadata-acceptance
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { AGY_ENDPOINT_FALLBACKS, AGY_IDE_TYPE, currentAgyVersion } from '../src/oauth/constants.ts'
import { bootstrapMetadata } from '../src/oauth/exchange.ts'
import { refreshAccessToken } from '../src/oauth/refresh.ts'
import { proxiedFetch } from '../src/proxy.ts'
import { decryptStorage } from '../src/store/accounts.ts'
import { createAesGcmCodec, deriveKey, loadMasterKey, resolveDshHome } from '../src/store/keyring.ts'
import { getAgyBootstrapUserAgent } from '../src/oauth/constants.ts'
import type { ManagedAccount } from '../src/types.ts'

const args = process.argv.slice(2)
const indexFlag = args.indexOf('--index')
const accountIndex = indexFlag >= 0 ? Number(args[indexFlag + 1]) : 0

const dshHome = resolveDshHome()
const masterKey = loadMasterKey(dshHome)
if (!masterKey) {
  console.error('No AGY_MASTER_KEY — run `dsh-agy login` first.')
  process.exit(2)
}
const codec = createAesGcmCodec(deriveKey(masterKey))
const storage = decryptStorage(
  JSON.parse(readFileSync(join(dshHome, 'agy', 'agy-accounts.json'), 'utf8')),
  codec,
)
const account: ManagedAccount | undefined = storage.accounts[accountIndex]
if (!account) {
  console.error(`No account at index ${accountIndex}. Run \`dsh-agy status\` to list them.`)
  process.exit(2)
}

const refreshed = await refreshAccessToken({ access: '', expires: 0, refresh: account.refresh })
if (refreshed.type !== 'success') {
  console.error(`refresh failed for ${account.email ?? account.id} — cannot probe (unmeasurable).`)
  process.exit(2)
}
const access = refreshed.auth.access
const routing = account.proxy ? { proxyUrl: account.proxy } : undefined

interface Probe {
  status: number
  body: string
}

async function probe(metadata: Record<string, string>): Promise<Probe> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20_000)
  try {
    for (const endpoint of AGY_ENDPOINT_FALLBACKS) {
      try {
        const response = await proxiedFetch(
          `${endpoint}/v1internal:loadCodeAssist`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${access}`,
              'Content-Type': 'application/json',
              'User-Agent': getAgyBootstrapUserAgent(),
            },
            body: JSON.stringify({ metadata }),
            signal: controller.signal,
          },
          routing,
        )
        const text = await response.text()
        // The first endpoint that answers at all is the measurement; a 4xx here
        // is the interesting case, so do NOT fall through to the next host.
        if (response.status < 500) return { status: response.status, body: text }
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') throw error
      }
    }
    return { status: 0, body: 'no endpoint answered' }
  } finally {
    clearTimeout(timer)
  }
}

/** `error.message` from a Google API error body, or a trimmed raw body. */
function errorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string; status?: string } }
    const message = parsed.error?.message
    if (typeof message === 'string') return message.slice(0, 200)
  } catch {
    // not JSON — fall through
  }
  return body.slice(0, 200)
}

const next = bootstrapMetadata()
const legacy = { ideType: AGY_IDE_TYPE }

console.log(`account:  ${account.email ?? account.id} (index ${accountIndex})`)
console.log(`proxy:    ${account.proxy ? 'per-account proxy in use' : 'direct / env'}`)
console.log(`version:  ${currentAgyVersion()}`)
console.log(`new:      metadata = ${JSON.stringify(next)}`)
console.log(`legacy:   metadata = ${JSON.stringify(legacy)}`)
console.log('')

const withNew = await probe(next)
console.log(`A (current)  ${withNew.status} ${withNew.status === 200 ? '' : errorMessage(withNew.body)}`)

if (withNew.status === 200) {
  console.log('\nPASS the backend accepts the metadata this client sends.')
  process.exit(0)
}

const withLegacy = await probe(legacy)
console.log(`B (legacy)   ${withLegacy.status} ${withLegacy.status === 200 ? '' : errorMessage(withLegacy.body)}`)

if (withLegacy.status === 200) {
  console.log(
    '\nFAIL the legacy `{ ideType }` body is accepted while the current one is not — OUR ADDED FIELDS ARE THE CAUSE.\n' +
      '     Fix: drop `platform` (and then test `ideVersion`) from `bootstrapMetadata()` in src/oauth/exchange.ts,\n' +
      '     and record the measured rejection in docs/official-identity.json.',
  )
  process.exit(1)
}

console.log(
  `\nUNMEASURABLE both bodies failed (${withNew.status} / ${withLegacy.status}), so this is not about our metadata ` +
    'field — check the credentials, the proxy, or the endpoint. Nothing to change.',
)
process.exit(2)
