import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createServer: vi.fn(),
  adapter: vi.fn(),
  sessions: vi.fn(),
  listAllModels: vi.fn(),
  stream: vi.fn(),
  invalidateModelCache: vi.fn(),
  getSession: vi.fn(),
  reportFailure: vi.fn(),
  markSuccess: vi.fn(),
  noteRequestStarted: vi.fn(),
  noteRequestSettled: vi.fn(),
}))
vi.mock('node:http', () => ({ createServer: mocks.createServer }))
vi.mock('../src/adapter/adapter.ts', () => ({ AgyAdapter: mocks.adapter }))
vi.mock('../src/session.ts', () => ({ AgySessionManager: mocks.sessions }))

import { serveCommand, startRelayServer } from '../src/cli/serve.ts'
import { JsonAccountStore } from '../src/store/accounts.ts'
import { resolveMasterKeyCodec } from '../src/store/keyring.ts'

type RequestHandler = (req: IncomingMessage, res: ServerResponse) => void

class FakeServer extends EventEmitter {
  draining = false
  onClosed?: (error?: Error) => void
  listen = vi.fn((_port: number, _host: string, callback: () => void) => { callback() })
  address = vi.fn(() => ({ address: '127.0.0.1', family: 'IPv4', port: 3089 }))
  close = vi.fn((callback: (error?: Error) => void) => {
    this.onClosed = callback
    if (!this.draining) callback()
  })
  closeIdleConnections = vi.fn()
  closeAllConnections = vi.fn(() => { this.onClosed?.() })
}

class FakeResponse extends EventEmitter {
  headersSent = false
  writableEnded = false
  status = 0
  headers: Record<string, unknown> = {}
  body = ''
  done: Promise<void>
  private finish!: () => void
  constructor() {
    super()
    this.done = new Promise((resolve) => { this.finish = resolve })
  }
  writeHead(status: number, headers: Record<string, unknown> = {}) {
    this.status = status
    this.headers = headers
    this.headersSent = true
    return this
  }
  write(chunk: string) { this.body += chunk; return true }
  end(chunk = '') { this.body += chunk; this.writableEnded = true; this.finish() }
  destroy() { this.finish() }
}

let server: FakeServer
let handler: RequestHandler
let home: string
let relay: Awaited<ReturnType<typeof startRelayServer>> | undefined
let exitListeners: ReturnType<typeof process.listeners>
let intListeners: ReturnType<typeof process.listeners>
let termListeners: ReturnType<typeof process.listeners>

beforeEach(() => {
  vi.clearAllMocks()
  home = mkdtempSync(join(tmpdir(), 'agy-serve-test-'))
  vi.stubEnv('DSH_HOME', home)
  // No test may reach an upstream endpoint (the HTTP server is mocked too).
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network request') }))
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  exitListeners = process.listeners('exit')
  intListeners = process.listeners('SIGINT')
  termListeners = process.listeners('SIGTERM')
  server = new FakeServer()
  mocks.createServer.mockImplementation((callback: RequestHandler) => { handler = callback; return server })
  mocks.adapter.mockImplementation(() => ({
    listAllModels: mocks.listAllModels,
    stream: mocks.stream,
    invalidateModelCache: mocks.invalidateModelCache,
  }))
  mocks.sessions.mockImplementation(() => ({
    getSession: mocks.getSession,
    reportFailure: mocks.reportFailure,
    markSuccess: mocks.markSuccess,
    noteRequestStarted: mocks.noteRequestStarted,
    noteRequestSettled: mocks.noteRequestSettled,
  }))
  mocks.listAllModels.mockResolvedValue([{ id: 'gemini-3.8-flash-tiered' }])
  mocks.stream.mockImplementation(async function* () {
    yield { type: 'text-delta', text: 'relay works' }
    yield { type: 'done', finishReason: 'stop' }
  })
})

afterEach(async () => {
  // Finish any simulated drain before awaiting close; then leave no hooks/files.
  server.onClosed?.()
  await relay?.close()
  relay = undefined
  for (const [event, original] of [
    ['exit', exitListeners], ['SIGINT', intListeners], ['SIGTERM', termListeners],
  ] as const) {
    for (const listener of process.listeners(event)) {
      if (!original.includes(listener)) process.removeListener(event, listener)
    }
  }
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  rmSync(home, { recursive: true, force: true })
})

async function request(method: string, url: string, body?: unknown) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  Object.assign(req, { method, url, headers: {} })
  const res = new FakeResponse()
  handler(req as IncomingMessage, res as unknown as ServerResponse)
  await res.done
  return res
}

describe('standalone relay', () => {
  it('uses native HTTP with loopback/3080 defaults and no signal hooks', async () => {
    relay = await startRelayServer()
    expect(server.listen).toHaveBeenCalledWith(3080, '127.0.0.1', expect.any(Function))
    expect(process.listeners('SIGINT')).toEqual(intListeners)
    expect(process.listeners('SIGTERM')).toEqual(termListeners)
    expect(await mocks.sessions.mock.calls[0]![0].store.load()).toMatchObject({ accounts: [] })
  })

  it('inherits and migrates an encrypted legacy account store without changing credentials', async () => {
    const { codec } = resolveMasterKeyCodec(home)
    const legacy = join(home, 'agy-accounts.json')
    const store = new JsonAccountStore({ file: legacy, codec })
    await store.mutate((state) => {
      state.accounts.push({ email: 'relay@example.test', refresh: 'test-refresh|test-project', addedAt: 1, lastUsed: 1 })
    })
    expect(readFileSync(legacy, 'utf8')).not.toContain('test-refresh')
    relay = await startRelayServer()
    const inherited = await mocks.sessions.mock.calls[0]![0].store.load()
    expect(inherited.accounts[0]).toMatchObject({ email: 'relay@example.test', refresh: 'test-refresh|test-project' })
    expect(existsSync(legacy)).toBe(false)
    expect(existsSync(join(home, 'agy', 'agy-accounts.json'))).toBe(true)
  })

  it('flushes adapter usage and pool events into the existing ledger and recent ring', async () => {
    relay = await startRelayServer()
    const options = mocks.adapter.mock.calls[0]![0]
    const sessions = mocks.sessions.mock.calls[0]![0]
    options.recordUsage({ account: 'relay@example.test', model: 'test-model', ok: true,
      usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 0 } })
    sessions.recordUsage({ account: 'relay@example.test', model: 'test-model', source: 'chat',
      ok: false, poolEvent: true, rotated: true, reason: 'quota-exhausted' })
    await relay.close()
    const ledger = JSON.parse(readFileSync(join(home, 'agy', 'agy-stats.json'), 'utf8'))
    expect(ledger.totals).toMatchObject({ requests: 1, succeeded: 1, rotations: 1, input: 10, output: 5, cacheRead: 2 })
    expect(ledger.accounts['relay@example.test'].sources.chat).toBe(1)
    const recent = JSON.parse(readFileSync(join(home, 'agy', 'agy-recent.json'), 'utf8'))
    expect(recent).toHaveLength(2)
  })

  it('supports custom host/port and an IPv6 base URL', async () => {
    relay = await startRelayServer({ port: 3089, host: '::1' })
    expect(server.listen).toHaveBeenCalledWith(3089, '::1', expect.any(Function))
    expect(relay.url).toBe('http://[::1]:3089/agy/v1')
  })

  it('serves health and models through the existing relay handler', async () => {
    relay = await startRelayServer()
    const health = await request('GET', '/agy/v1/health')
    expect(health.status).toBe(200)
    expect(JSON.parse(health.body).status).toBe('ok')
    const models = await request('GET', '/agy/v1/models')
    expect(models.status).toBe(200)
    expect(JSON.parse(models.body)).toMatchObject({ object: 'list', data: [{ object: 'model' }] })
    expect(mocks.listAllModels).toHaveBeenCalledOnce()
  })

  it('keeps the catalog fallback when discovery fails', async () => {
    relay = await startRelayServer()
    mocks.listAllModels.mockRejectedValueOnce(new Error('No accounts'))
    const res = await request('GET', '/agy/v1/models')
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body).data.length).toBeGreaterThan(0)
  })

  it.each([false, true])('forwards chat completions without rewriting the handler (stream=%s)', async (stream) => {
    relay = await startRelayServer()
    const res = await request('POST', '/agy/v1/chat/completions', {
      model: 'gemini-3.8-flash-tiered', messages: [{ role: 'user', content: 'hello' }], stream,
    })
    expect(res.status).toBe(200)
    expect(res.body).toContain('relay works')
    expect(mocks.stream).toHaveBeenCalledOnce()
    expect(mocks.stream.mock.calls[0]![0]).toMatchObject({ provider: 'agy', model: 'gemini-3.8-flash-tiered' })
    if (stream) expect(res.body).toContain('data: [DONE]')
  })

  it('does not expose DSH management or OAuth routes', async () => {
    relay = await startRelayServer()
    for (const path of ['/api/agy', '/oauth-callback', '/agy/v10/health']) {
      expect((await request('GET', path)).status).toBe(404)
    }
  })

  it('wires rotation, affinity, success/failure and in-flight accounting unchanged', async () => {
    relay = await startRelayServer()
    const options = mocks.adapter.mock.calls[0]![0]
    const sessions = mocks.sessions.mock.calls[0]![0]
    const account = { email: 'relay@example.test' }
    options.getSession('model', 'conversation')
    expect(mocks.getSession).toHaveBeenCalledWith('model', undefined, 'conversation')
    options.reportFailure('rate-limit', account, { status: 429 })
    expect(mocks.reportFailure).toHaveBeenCalledWith('rate-limit', account, { status: 429 })
    options.markSuccess(account)
    options.noteRequestStarted(account)
    options.noteRequestSettled(account)
    expect(mocks.markSuccess).toHaveBeenCalledWith(account)
    expect(mocks.noteRequestStarted).toHaveBeenCalledWith(account)
    expect(mocks.noteRequestSettled).toHaveBeenCalledWith(account)
    sessions.onRotate()
    expect(mocks.invalidateModelCache).toHaveBeenCalledOnce()
    expect(options.maxInlineBytes()).toBe(20 * 1024 * 1024)
  })

  it('has idempotent close and removes its exit hook', async () => {
    relay = await startRelayServer()
    const first = relay.close()
    expect(relay.close()).toBe(first)
    await first
    expect(server.close).toHaveBeenCalledOnce()
    expect(server.closeIdleConnections).toHaveBeenCalledOnce()
    expect(process.listeners('exit')).toEqual(exitListeners)
  })

  it('bounds active-stream shutdown to five seconds', async () => {
    vi.useFakeTimers()
    relay = await startRelayServer()
    server.draining = true
    const closed = relay.close()
    await vi.advanceTimersByTimeAsync(4999)
    expect(server.closeAllConnections).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await closed
    expect(server.closeAllConnections).toHaveBeenCalledOnce()
  })

  it('rejects a bind failure without leaving exit hooks', async () => {
    const error = Object.assign(new Error('address already in use'), { code: 'EADDRINUSE' })
    server.listen.mockImplementationOnce(() => { server.emit('error', error) })
    await expect(startRelayServer({ port: 3089 })).rejects.toBe(error)
    expect(process.listeners('exit')).toEqual(exitListeners)
  })

  it.each(['SIGINT', 'SIGTERM'] as const)('handles %s with a clean CLI exit', async (signal) => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    await serveCommand({ port: 3089 })
    expect(console.log).toHaveBeenCalledWith('dsh-agy relay listening at http://127.0.0.1:3089/agy/v1')
    const shutdown = process.listeners(signal).at(-1)!
    shutdown(signal)
    await Promise.resolve()
    expect(server.close).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('reports CLI startup errors with a failing exit code', async () => {
    const originalExitCode = process.exitCode
    try {
      server.listen.mockImplementationOnce(() => { server.emit('error', new Error('address already in use')) })
      await serveCommand({ port: 3089 })
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('could not start'))
      expect(process.exitCode).toBe(1)
    } finally {
      process.exitCode = originalExitCode
    }
  })
})
