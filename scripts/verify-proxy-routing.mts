/**
 * Real-network verification of per-account proxy routing (issue #29). Never runs
 * in CI: `scripts/` is the only place allowed to touch the network (AGENTS.md).
 *
 * Proves, against the live backend, the three behaviours the unit suite can only
 * approximate with stubs:
 *
 *   1. ROUTING   — an account-scoped request (quota/model discovery) leaves
 *                  through `account.proxy`, not the env/direct route.
 *   2. FAIL-CLOSED — when that proxy is unreachable the request fails WITHOUT
 *                  silently falling back to a direct connection (the anti-
 *                  correlation guarantee: a proxied account must never leak the
 *                  host's real IP).
 *   3. CREDENTIALS — a proxy password containing `@`/`:` arrives intact (the
 *                  double-encoding regression, spec #8 user story 22).
 *
 * Self-contained by design: it starts its own recording proxy on loopback rather
 * than requiring Clash or any particular proxy product. The recording proxy
 * either connects direct or chains to `--upstream`, so it works both for people
 * who need an upstream proxy to reach Google and for those who do not.
 *
 * It never writes to your account store — the account is read (read-only) and
 * used to build an in-memory store with the proxy applied, so your real
 * configuration is untouched.
 *
 * Usage:
 *   npx tsx scripts/verify-proxy-routing.mts
 *   npx tsx scripts/verify-proxy-routing.mts --upstream http://127.0.0.1:7897
 *   npx tsx scripts/verify-proxy-routing.mts --index 1 --model gemini-3.6-flash-high
 */
import http from 'node:http'
import net from 'node:net'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createAesGcmCodec, deriveKey, loadMasterKey, resolveDshHome } from '../src/store/keyring.ts'
import { InMemoryAccountStore, decryptStorage } from '../src/store/accounts.ts'
import { AgySessionManager } from '../src/session.ts'
import { AgyAdapter } from '../src/adapter/adapter.ts'
import { normalizeProxyUrl, proxiedFetch } from '../src/proxy.ts'

interface Options {
  upstream?: string
  index: number
  model: string
}

function parseArgs(argv: string[]): Options {
  const value = (name: string): string | undefined => {
    const inline = argv.find((arg) => arg.startsWith(`--${name}=`))
    if (inline) return inline.slice(name.length + 3)
    const at = argv.indexOf(`--${name}`)
    return at !== -1 ? argv[at + 1] : undefined
  }
  return {
    upstream: value('upstream'),
    index: Number(value('index') ?? 0),
    model: value('model') ?? 'gemini-3.6-flash-high',
  }
}

/** A loopback CONNECT proxy that records every tunnel target it is asked to open. */
interface RecordingProxy {
  url: string
  tunnels: string[]
  close(): Promise<void>
}

async function startRecordingProxy(upstream?: string): Promise<RecordingProxy> {
  const tunnels: string[] = []
  const server = http.createServer((_req, res) => {
    res.writeHead(405)
    res.end()
  })
  server.on('connect', (req, clientSocket, head) => {
    const target = String(req.url)
    tunnels.push(target)
    // `authority` form is host:port; plain HTTP proxying would be `http://...`.
    const [host, port] = target.split(':')
    const connect = upstream
      ? // Chain through the upstream proxy so this works behind a required proxy.
        ((cb: (socket: net.Socket) => void) => {
          const socket = net.connect(Number(new URL(upstream).port), new URL(upstream).hostname, () => {
            socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`)
          })
          socket.once('data', (chunk) => {
            if (!chunk.toString('utf8').includes('200')) {
              socket.destroy()
              return
            }
            cb(socket)
          })
          socket.on('error', () => clientSocket.destroy())
        })
      : ((cb: (socket: net.Socket) => void) => {
          const socket = net.connect(Number(port), host, () => cb(socket))
          socket.on('error', () => clientSocket.destroy())
        })

    connect((socket) => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head?.length) socket.write(head)
      clientSocket.pipe(socket)
      socket.pipe(clientSocket)
    })
    clientSocket.on('error', () => {})
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as net.AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    tunnels,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

/** A loopback proxy that REQUIRES Proxy-Authorization, recording what it received. */
interface AuthProxy {
  url: string
  received: () => string
  close(): Promise<void>
}

async function startAuthProxy(username: string, password: string): Promise<AuthProxy> {
  const expected = `${username}:${password}`
  let lastAuth = '(none)'
  const server = http.createServer((_req, res) => {
    res.writeHead(405)
    res.end()
  })
  server.on('connect', (req, clientSocket) => {
    const header = req.headers['proxy-authorization'] ?? ''
    lastAuth = header.startsWith('Basic ')
      ? Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8')
      : `(scheme) ${header}`
    if (lastAuth !== expected) {
      clientSocket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="verify"\r\n\r\n')
      return
    }
    clientSocket.end('HTTP/1.1 200 Connection Established\r\n\r\n')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as net.AddressInfo).port
  return {
    // Credentials are percent-encoded as a user would supply them.
    url: `http://${username}:${encodeURIComponent(password)}@127.0.0.1:${port}`,
    received: () => lastAuth,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

function loadAccount(index: number) {
  const dshHome = resolveDshHome()
  const masterKey = loadMasterKey(dshHome)
  if (!masterKey) throw new Error(`No agy account store found in ${dshHome} — run \`dsh-agy login\` first.`)
  const codec = createAesGcmCodec(deriveKey(masterKey))
  const storage = decryptStorage(
    JSON.parse(readFileSync(join(dshHome, 'agy', 'agy-accounts.json'), 'utf8')),
    codec,
  )
  const account = storage.accounts[index]
  if (!account) throw new Error(`No account at index ${index} (found ${storage.accounts.length}).`)
  return account
}

/** Build an in-memory store for the account with a specific proxy applied. */
async function sessionWithProxy(
  account: ReturnType<typeof loadAccount>,
  proxyUrl: string | undefined,
  model: string,
) {
  const store = new InMemoryAccountStore({
    version: 4,
    activeIndex: 0,
    // Two copies so the quota-refresh path (the defect this verifies) runs: it is
    // only reached when more than one account is eligible.
    accounts: [
      { ...account, ...(proxyUrl ? { proxy: proxyUrl } : {}) },
      { ...account, id: 'verify-proxy-routing-2', email: 'verify@local.invalid', ...(proxyUrl ? { proxy: proxyUrl } : {}) },
    ],
  })
  return new AgySessionManager({ store }).getSession(model)
}

const results: Array<{ name: string; pass: boolean; detail: string }> = []
function record(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const account = loadAccount(options.index)
  console.log(`account: ${account.email ?? '(no email)'} (index ${options.index})`)
  console.log(`model:   ${options.model}`)
  if (options.upstream) console.log(`upstream: ${options.upstream}`)

  // ── 1. ROUTING ────────────────────────────────────────────────────────────
  // Drives `AgyAdapter` (listModels + a generation stream), NOT the session
  // quota path: the latter already threaded the proxy before #29, so asserting on
  // it passes even against the broken code. The adapter's own calls are the ones
  // that silently went direct.
  const proxy = await startRecordingProxy(options.upstream)
  try {
    const session = await sessionWithProxy(account, proxy.url, options.model)
    if (!session) throw new Error('getSession returned no session')

    const adapter = new AgyAdapter({
      getSession: async () => session,
      reportFailure: async () => {},
      markSuccess: async () => {},
    })
    // Count only tunnels opened BY the adapter call: session creation already
    // opens some (the quota path was proxied before #29), so measuring the raw
    // total would pass even when the adapter itself went direct.
    const beforeList = proxy.tunnels.length
    const models = await adapter.listModels('agy')
    const discovered = proxy.tunnels.length - beforeList
    record(
      'routing: adapter.listModels uses account.proxy',
      models.length > 0 && discovered > 0,
      `${models.length} models, ${discovered} tunnel(s) opened by the adapter call`,
    )

    // A generation stream is the path the issue opened with.
    const before = proxy.tunnels.length
    const text: string[] = []
    for await (const chunk of adapter.stream({
      provider: 'agy',
      model: options.model,
      messages: [{ id: 'verify-1', role: 'user', content: [{ type: 'text', text: 'Reply with exactly: OK' }] }],
      maxTokens: 512,
    } as never)) {
      if ((chunk as { type: string }).type === 'text-delta') text.push((chunk as { text: string }).text)
    }
    const streamed = proxy.tunnels.length - before
    record(
      'routing: generation stream uses account.proxy',
      streamed > 0,
      `${streamed} new tunnel(s); reply ${JSON.stringify(text.join('').trim().slice(0, 40))}`,
    )
  } catch (error) {
    record('routing: adapter uses account.proxy', false, (error as Error).message)
  } finally {
    await proxy.close()
  }

  // ── 2. FAIL-CLOSED ────────────────────────────────────────────────────────
  // A dead port: if anything falls back to direct, this account would still work.
  const dead = await startRecordingProxy(options.upstream)
  const deadUrl = dead.url
  await dead.close()
  try {
    const session = await sessionWithProxy(account, deadUrl, options.model)
    record(
      'fail-closed: unreachable proxy does not fall back to direct',
      session === undefined,
      session ? 'a session was returned — the request may have gone direct' : 'no session, as required',
    )
  } catch (error) {
    // Any transport/proxy error is acceptable; success is not.
    record(
      'fail-closed: unreachable proxy does not fall back to direct',
      true,
      `${(error as Error).name}: ${(error as Error).message.slice(0, 60)}`,
    )
  }

  // ── 3. CREDENTIALS ────────────────────────────────────────────────────────
  // The password carries both characters from the regression: `@` and `:`.
  const username = 'verifyuser'
  const password = 'p@ss:word'
  const auth = await startAuthProxy(username, password)
  try {
    // Round-trip through the REAL path: normalize (as the store does) and then
    // fetch through that proxy, so the proxy sees whatever the client sends.
    const normalized = normalizeProxyUrl(auth.url)
    await proxiedFetch('https://daily-cloudcode-pa.googleapis.com/', {}, { proxyUrl: normalized }).catch(() => undefined)
    const received = auth.received()
    record(
      'credentials: password with @ and : reaches the proxy intact',
      received === `${username}:${password}`,
      received === `${username}:${password}`
        ? 'proxy authenticated the decoded credentials'
        : `proxy received ${JSON.stringify(received)}`,
    )
  } catch (error) {
    record('credentials: password with @ and : reaches the proxy intact', false, (error as Error).message)
  } finally {
    await auth.close()
  }

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length > 0) process.exit(1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
