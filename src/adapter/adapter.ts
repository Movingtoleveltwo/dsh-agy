/**
 * AgyAdapter: the DSH seam. A thin orchestrator over the deep modules —
 * account session resolution (shell-provided), request translation, SSE
 * parsing, failure classification, and rotation reporting. All wire details
 * live in translate.ts / parse.ts / models.ts.
 */

import {
  LlmAdapter,
  LlmError,
  ProviderRequestId,
  QUOTA_EXCEEDED_CODE,
  attributionHeaders,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
  ToolSchema,
} from '@deepseek-ai/dsh-llm'
import { AgyAuthError, AgyPoolBlockedError } from '../types.ts'
import type { AgyAccountSession, FailureKind, ManagedAccount, OAuthAuthDetails } from '../types.ts'
import type { RateLimitCategory } from '../runtime/classify.ts'
import { fetchAgyFirstOk } from '../oauth/constants.ts'
import { classifyFetchError, classifyHttpError } from '../runtime/classify.ts'
import { deriveAntigravitySessionId, generateAntigravityRequestId } from '../runtime/identity.ts'
import { setThoughtSignature } from '../runtime/signature-cache.ts'
import { toAgyRequestBody } from './translate.ts'
import type { AgyResolvedImage } from './translate.ts'
import { parseAgySse } from './parse.ts'
import { AGY_PROVIDER, catalogModelList, listAgyModels, resolveAgyModel } from './models.ts'

export type { AgyAccountSession }

/**
 * Structural view of the harness attachment service (ctx.attachments).
 * Deliberately not an import of @deepseek-ai/dsh-attachment: the CLI bundle
 * must stay free of harness runtime dependencies, and the real store
 * satisfies this shape.
 */
export interface AgyAttachmentStore {
  readImage(ref: {
    attachmentId: string
    mediaType: string
  }): Promise<{ ref: { mediaType: string }; data: Uint8Array }>
}

/** Collect image refs from user-message content only (spec scope: user images; tool-result nesting out of scope). */
function collectImageRefs(options: GenerateOptions): Array<{ attachmentId: string; mediaType: string }> {
  const refs: Array<{ attachmentId: string; mediaType: string }> = []
  for (const message of options.messages) {
    if (message.role !== 'user') continue
    for (const block of message.content) {
      if (block.type === 'image') refs.push(block.attachment)
    }
  }
  return refs
}

export interface AgyAdapterOptions {
  /** Resolve the active account for a request (model-aware: family-scoped quota ranking). */
  getSession(model?: string): Promise<AgyAccountSession | undefined>
  /** Report a classified upstream failure so the shell can cool/rotate/revoke. */
  reportFailure(
    kind: FailureKind,
    session: AgyAccountSession,
    info?: {
      retryAfterMs?: number
      status?: number
      rateLimitCategory?: RateLimitCategory
      /** Server-reported absolute reset time; drives precise cooldowns. */
      resetTime?: string
      /** Requested model id; drives family-scoped rate-limit bookkeeping. */
      model?: string
    },
  ): Promise<void>
  /** Report a clean stream completion (resets the failure counter). */
  markSuccess?(session: AgyAccountSession): Promise<void>
  /** Resolve the harness attachment store; undefined outside the harness (standalone CLI). */
  resolveAttachments?(): AgyAttachmentStore | undefined
}

const UPSTREAM_ERROR_CODE = 'UPSTREAM'

/** Build the impersonation headers for one request (per-request randomization applied by the shell). */
export function buildRequestHeaders(session: AgyAccountSession): Record<string, string> {
  return {
    authorization: `Bearer ${session.auth.access}`,
    'content-type': 'application/json',
    accept: 'text/event-stream',
    'x-goog-request-id': generateAntigravityRequestId(),
    ...attributionHeaders(),
    ...session.impersonation,
  }
}

export class AgyAdapter extends LlmAdapter {
  private readonly options: AgyAdapterOptions

  constructor(options: AgyAdapterOptions) {
    super()
    this.options = options
  }

  override providerInfo(_provider: string): LlmProviderInfo {
    return { id: AGY_PROVIDER, name: 'Antigravity (agy)' }
  }

  override async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    try {
      const session = await this.options.getSession()
      return await listAgyModels(session?.auth.access, session?.account.projectId)
    } catch (error) {
      if (error instanceof AgyPoolBlockedError || error instanceof AgyAuthError) {
        return catalogModelList()
      }
      throw error
    }
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return resolveAgyModel(provider, model)
  }

  async prepareCall(provider: string, model: string, signal?: AbortSignal) {
    return {
      model: await this.resolveModel(provider, model),
      stream: (options: GenerateOptions) => this.stream(options),
    }
  }

  /**
   * Pre-resolve every image attachment into base64 bytes before translation.
   * Image input hard-fails with UNSUPPORTED_CONTENT (terminal, never retried)
   * when the store is missing or a read fails — silently dropping images and
   * sending text-only is the exact failure mode this path exists to prevent.
   */
  private async resolveRequestImages(options: GenerateOptions): Promise<Map<string, AgyResolvedImage>> {
    const refs = collectImageRefs(options)
    const images = new Map<string, AgyResolvedImage>()
    if (refs.length === 0) return images
    const store = this.options.resolveAttachments?.()
    if (!store) {
      throw new LlmError(
        'agy image input requires the durable attachment service (in-harness plugin only)',
        'UNSUPPORTED_CONTENT',
      )
    }
    for (const ref of refs) {
      try {
        const stored = await store.readImage(ref)
        images.set(ref.attachmentId, {
          mediaType: stored.ref.mediaType,
          data: Buffer.from(stored.data).toString('base64'),
        })
      } catch (cause) {
        throw new LlmError(
          `agy image attachment "${ref.attachmentId}" could not be loaded: ${cause instanceof Error ? cause.message : String(cause)}`,
          'UNSUPPORTED_CONTENT',
          { cause: cause instanceof Error ? cause : undefined },
        )
      }
    }
    return images
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // Spec D1 sequence: resolve images first — a locally-failing image request
    // must surface UNSUPPORTED_CONTENT (user story 8) instead of being masked
    // by account-pool errors, and must not touch pool state at all.
    const images = await this.resolveRequestImages(options)
    let session: AgyAccountSession | undefined
    try {
      session = await this.options.getSession(options.model)
    } catch (error) {
      if (error instanceof AgyAuthError) {
        if (error.kind === 'transport') {
          throw new LlmError(error.message, 'TRANSPORT', { cause: error })
        }
        if (error.kind === 'rate-limit') {
          throw new LlmError(error.message, 'RATE_LIMIT', {
            requestId: ProviderRequestId(generateAntigravityRequestId()),
          })
        }
        throw new LlmError(error.message, 'INVALID_CREDENTIAL', { cause: error })
      }
      if (error instanceof AgyPoolBlockedError) {
        if (error.kind === 'quota-exhausted') {
          throw new LlmError(error.message, QUOTA_EXCEEDED_CODE)
        }
        const delta = Math.ceil(error.blockedUntil - Date.now())
        const providerRetryAfterMs = Number.isFinite(delta) && delta > 0 ? delta : 1
        throw new LlmError(error.message, 'RATE_LIMIT', {
          providerRetryAfterMs,
          requestId: ProviderRequestId(generateAntigravityRequestId()),
        })
      }
      throw error
    }
    if (!session) {
      throw new LlmError(
        'No agy account configured — run `dsh-agy login` to authenticate.',
        'NO_CREDENTIAL',
      )
    }

    const body = toAgyRequestBody(options, {
      projectId: session.account.projectId,
      sessionId: deriveAntigravitySessionId(session.account.email) ?? undefined,
      ...(images.size > 0 ? { images } : {}),
    })
    const headers = buildRequestHeaders(session)

    let response: Response
    try {
      response = await fetchAgyFirstOk('/v1internal:streamGenerateContent?alt=sse', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: options.signal,
      })
    } catch (error) {
      const classified = classifyFetchError(error)
      await this.options.reportFailure(classified.kind, session)
      throw new LlmError(classified.message ?? 'agy fetch failed', 'TRANSPORT', { cause: error })
    }

    if (!response.ok) {
      const bodyText = await response.text().catch(() => undefined)
      const classified = classifyHttpError(response.status, response.headers, bodyText)
      await this.options.reportFailure(classified.kind, session, {
        retryAfterMs: classified.retryAfterMs,
        status: response.status,
        rateLimitCategory: classified.rateLimitCategory,
        resetTime: classified.resetTime,
        model: options.model,
      })
      if (classified.kind === 'rate-limit') {
        // soft/rate limits are retryable by the harness (RATE_LIMIT + delay);
        // daily quota exhaustion is terminal (QUOTA, 24h cooldown already set).
        if (classified.rateLimitCategory === 'quota_exhausted') {
          throw new LlmError(
            `agy daily quota exhausted (${response.status}): ${classified.message ?? ''}`,
            QUOTA_EXCEEDED_CODE,
          )
        }
        throw new LlmError(
          `agy rate-limited (${response.status}): ${classified.message ?? ''}`,
          'RATE_LIMIT',
          {
            providerRetryAfterMs: classified.retryAfterMs ?? undefined,
            requestId: ProviderRequestId(generateAntigravityRequestId()),
          },
        )
      }
      if (classified.kind === 'auth-failure') {
        throw new LlmError(
          `agy authentication failed (${response.status}) — run \`dsh-agy login\``,
          'INVALID_CREDENTIAL',
        )
      }
      throw new LlmError(
        `agy upstream error (${response.status}): ${classified.message ?? ''}`,
        UPSTREAM_ERROR_CODE,
      )
    }

    if (!response.body) {
      throw new LlmError('agy stream returned no body', UPSTREAM_ERROR_CODE)
    }

    try {
      yield* parseAgySse(response.body, {
        signal: options.signal,
        onToolSignature: (toolCallId, signature) => {
          setThoughtSignature(toolCallId, signature)
        },
      })
      await this.options.markSuccess?.(session)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new LlmError('agy stream aborted', 'ABORTED', { cause: error })
      }
      await this.options.reportFailure('network-error', session)
      throw new LlmError(
        error instanceof Error ? error.message : 'agy stream parse failed',
        UPSTREAM_ERROR_CODE,
        { cause: error },
      )
    }
  }
}

export type { ToolSchema }
