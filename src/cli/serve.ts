/** Standalone Node HTTP relay: no Cordis context or Web lifecycle. */
import { createServer, type Server } from 'node:http'
import { AgyAdapter } from '../adapter/adapter.ts'
import { ModelVisibility } from '../model-visibility.ts'
import { MultimodalConfigStore } from '../multimodal-config.ts'
import { RecentActivityStore } from '../recent-store.ts'
import { redactCredentials } from '../redact.ts'
import { AgySessionManager } from '../session.ts'
import { UsageStats } from '../stats.ts'
import { JsonAccountStore } from '../store/accounts.ts'
import { resolveDshHome, resolveMasterKeyCodec } from '../store/keyring.ts'
import { migrateToAgyDir } from '../store/paths.ts'
import { ThinkingBudgetStore } from '../thinking-budget.ts'
import { createOpenAiRelayHandler } from '../web/openai-relay.ts'

export interface ServeOptions {
  port?: number
  host?: string
}

export interface RelayServer {
  server: Server
  url: string
  /** Stop accepting requests, drain for up to five seconds, then flush usage. */
  close(): Promise<void>
}

const SHUTDOWN_TIMEOUT_MS = 5_000

/** Build the existing account/session/adapter chain without a DSH host. */
function createRelayRuntime() {
  const dshHome = resolveDshHome()
  const { codec } = resolveMasterKeyCodec(dshHome)
  const accounts = migrateToAgyDir('agy-accounts.json', dshHome)
  if (accounts.skew) {
    console.warn('dsh-agy: legacy account store detected; restart older dsh-agy processes to avoid invisible writes.')
  }
  const store = new JsonAccountStore({ file: accounts.file, codec })
  const warn = (message: string, error: unknown) => {
    console.warn(`dsh-agy: ${message}: ${redactCredentials(String(error))}`)
  }
  const recentStore = new RecentActivityStore({
    onFlushError: (error) => warn('recent activity could not be written; will retry', error),
  })
  const stats = new UsageStats({
    persistRecent: (entry) => recentStore.capture(entry),
    onFlushError: (error) => warn('usage ledger could not be written; will retry', error),
  })
  const modelVisibility = new ModelVisibility()
  const thinkingBudget = new ThinkingBudgetStore()
  const multimodalConfig = new MultimodalConfigStore()
  let invalidateModelCache = () => {}
  const sessions = new AgySessionManager({
    store,
    recordUsage: (record) => stats.record(record),
    onRotate: () => invalidateModelCache(),
  })
  const adapter = new AgyAdapter({
    getSession: (model, conversationKey) => sessions.getSession(model, undefined, conversationKey),
    reportFailure: (kind, session, info) => sessions.reportFailure(kind, session, info),
    markSuccess: (session) => sessions.markSuccess(session),
    noteRequestStarted: (account) => sessions.noteRequestStarted(account),
    noteRequestSettled: (account) => sessions.noteRequestSettled(account),
    modelVisibility,
    thinkingBudgetFor: (level) => thinkingBudget.budgetFor(level),
    claudeBudgetFor: () => thinkingBudget.claudeBudget(),
    tieredBudgetFor: () => thinkingBudget.tieredBudget(),
    maxInlineBytes: () => multimodalConfig.maxInlineBytes(),
    recordUsage: (record) => stats.record({ ...record, source: 'chat' }),
  })
  invalidateModelCache = () => adapter.invalidateModelCache()
  const flush = () => {
    stats.flushSync()
    recentStore.flushSync()
  }
  return { adapter, flush }
}

export async function startRelayServer(options: ServeOptions = {}): Promise<RelayServer> {
  const port = options.port ?? 3080
  const host = options.host ?? '127.0.0.1'
  const runtime = createRelayRuntime()
  const handler = createOpenAiRelayHandler({
    adapter: runtime.adapter,
    listAllModels: () => runtime.adapter.listAllModels(),
    logger: { warn: (message) => console.warn(redactCredentials(message)) },
  })
  const server = createServer((req, res) => {
    // The handler owns every /agy/v1 route, including streaming and errors.
    // Guard its outer promise as well (e.g. an invalid request URL).
    void handler(req, res).catch((error: unknown) => {
      console.warn(`dsh-agy relay: ${redactCredentials(String(error))}`)
      if (res.headersSent) {
        res.destroy()
      } else {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'Internal relay error', type: 'server_error' } }))
      }
    })
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, host, () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
  } catch (error) {
    runtime.flush()
    throw error
  }

  process.once('exit', runtime.flush)
  let closing: Promise<void> | undefined
  const close = (): Promise<void> => {
    closing ??= new Promise<void>((resolve, reject) => {
      // close() drains active requests; idle keep-alives must not hold exit up.
      const timer = setTimeout(() => server.closeAllConnections(), SHUTDOWN_TIMEOUT_MS)
      timer.unref()
      server.close((error) => {
        clearTimeout(timer)
        process.removeListener('exit', runtime.flush)
        runtime.flush()
        if (error) reject(error)
        else resolve()
      })
      server.closeIdleConnections()
    })
    return closing
  }
  const address = server.address()
  const boundPort = address && typeof address !== 'string' ? address.port : port
  const urlHost = host.includes(':') ? `[${host}]` : host
  return { server, url: `http://${urlHost}:${boundPort}/agy/v1`, close }
}

/** The CLI owns process signals; the reusable server itself installs none. */
export async function serveCommand(options: ServeOptions): Promise<void> {
  try {
    const relay = await startRelayServer(options)
    console.log(`dsh-agy relay listening at ${relay.url}`)
    console.log('OpenAI base URL: ' + relay.url)
    console.log('No authentication is provided; use loopback or a trusted, authenticated reverse proxy.')
    console.log('Press Ctrl+C to stop.')
    let stopping = false
    const shutdown = (signal: string) => {
      if (stopping) return
      stopping = true
      console.log(`\ndsh-agy relay: ${signal}, shutting down...`)
      void relay.close().then(() => {
        console.log('dsh-agy relay stopped.')
        process.exit(0)
      }, (error: unknown) => {
        console.error(`dsh-agy relay shutdown failed: ${redactCredentials(String(error))}`)
        process.exit(1)
      })
    }
    process.once('SIGINT', () => shutdown('SIGINT'))
    process.once('SIGTERM', () => shutdown('SIGTERM'))
  } catch (error) {
    console.error(`dsh-agy relay could not start: ${redactCredentials(String(error))}`)
    process.exitCode = 1
  }
}
