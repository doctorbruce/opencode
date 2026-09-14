import { APICallError } from "ai"
import { STATUS_CODES } from "http"
import { iife } from "@/util/iife"
import type { ProviderV2 } from "@opencode-ai/core/provider"
import { isContextOverflow } from "@opencode-ai/llm"
import { isRecord } from "@/util/record"

export class HeaderTimeoutError extends Error {
  public override readonly name = "ProviderHeaderTimeoutError"

  constructor(public readonly ms: number) {
    super(`Provider response headers timed out after ${ms}ms`)
  }
}

export class ResponseStreamError extends Error {
  public override readonly name = "ProviderResponseStreamError"

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
  }
}

function isOpenAiErrorRetryable(e: APICallError) {
  const status = e.statusCode
  if (!status) return e.isRetryable
  // openai sometimes returns 404 for models that are actually available
  return status === 404 || e.isRetryable
}

// Providers not reliably handled in this function:
// - z.ai: can accept overflow silently (needs token-count/context-window checks)
function message(providerID: ProviderV2.ID, e: APICallError) {
  return iife(() => {
    const msg = e.message
    if (msg === "") {
      if (e.responseBody) return e.responseBody
      if (e.statusCode) {
        const err = STATUS_CODES[e.statusCode]
        if (err) return err
      }
      return "Unknown error"
    }

    if (!e.responseBody || (e.statusCode && msg !== STATUS_CODES[e.statusCode])) {
      return msg
    }

    try {
      const body = JSON.parse(e.responseBody)
      // try to extract common error message fields
      const errMsg = body.message || body.error || body.error?.message
      if (errMsg && typeof errMsg === "string") {
        return `${msg}: ${errMsg}`
      }
    } catch {}

    // If responseBody is HTML (e.g. from a gateway or proxy error page),
    // provide a human-readable message instead of dumping raw markup
    if (/^\s*<!doctype|^\s*<html/i.test(e.responseBody)) {
      if (e.statusCode === 401) {
        return "Unauthorized: request was blocked by a gateway or proxy. Your authentication token may be missing or expired — try running `opencode auth login <your provider URL>` to re-authenticate."
      }
      if (e.statusCode === 403) {
        return "Forbidden: request was blocked by a gateway or proxy. You may not have permission to access this resource — check your account and provider settings."
      }
      return msg
    }

    return `${msg}: ${e.responseBody}`
  }).trim()
}

function json(input: unknown) {
  if (typeof input === "string") {
    try {
      const result = JSON.parse(input)
      if (result && typeof result === "object") return result
      return undefined
    } catch {
      return undefined
    }
  }
  if (typeof input === "object" && input !== null) {
    return input
  }
  return undefined
}

export type ParsedStreamError =
  | {
      type: "context_overflow"
      message: string
      responseBody: string
    }
  | {
      type: "api_error"
      message: string
      isRetryable: boolean
      responseBody: string
      statusCode?: number
      metadata?: Record<string, string>
    }

export function parseStreamError(input: unknown): ParsedStreamError | undefined {
  const raw = json(input)
  const body = typeof raw?.message === "string" ? (json(raw.message) ?? raw) : raw
  if (!body) return

  if (body.type !== "error" && !(isRecord(body.error) && typeof body.error.message === "string")) return

  const detail = streamDiagnostics(body.error)
  const status = Number(detail?.statusCode ?? body.error?.status_code ?? body.error?.status ?? body.error?.code)
  const statusCode = Number.isInteger(status) && status >= 400 && status <= 599 ? status : undefined
  const responseBody = JSON.stringify(detail ?? body)
  const diagnostics = {
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(detail ? { metadata: detail.metadata } : {}),
  }

  switch (body?.error?.code) {
    case "context_length_exceeded":
      return {
        type: "context_overflow",
        message: "Input exceeds context window of this model",
        responseBody,
      }
    case "insufficient_quota":
      return {
        type: "api_error",
        message: "Quota exceeded. Check your plan and billing details.",
        isRetryable: false,
        responseBody,
        ...diagnostics,
      }
    case "usage_not_included":
      return {
        type: "api_error",
        message: "To use Codex with your ChatGPT plan, upgrade to Plus: https://chatgpt.com/explore/plus.",
        isRetryable: false,
        responseBody,
        ...diagnostics,
      }
    case "invalid_prompt":
      return {
        type: "api_error",
        message: typeof body?.error?.message === "string" ? body?.error?.message : "Invalid prompt.",
        isRetryable: false,
        responseBody,
        ...diagnostics,
      }
    case "server_is_overloaded":
    case "server_error":
      return {
        type: "api_error",
        message: typeof body?.error?.message === "string" ? body?.error?.message : "Server error.",
        isRetryable: true,
        responseBody,
        ...diagnostics,
      }
  }

  return {
    type: "api_error",
    message: typeof body?.error?.message === "string" ? body.error.message : "Server error.",
    isRetryable: statusCode !== undefined ? statusCode === 429 || statusCode >= 500 : body.type === "error",
    responseBody,
    ...diagnostics,
  }
}

// Gateway diagnostics contain caller identities and key fingerprints. Persist only displayable fields.
function streamDiagnostics(error: unknown) {
  if (!isRecord(error) || !isRecord(error.upstream)) return
  const upstream = error.upstream
  const headers = isRecord(upstream.headers) ? upstream.headers : {}
  const request = isRecord(error.request) ? error.request : {}
  const body = json(upstream.body)
  const provider = isRecord(body?.error) ? body.error : {}
  const metadata = isRecord(provider.metadata) ? provider.metadata : {}
  const raw = json(metadata.raw)
  const original = isRecord(raw?.error) ? raw.error : {}
  const statusCode = Number(upstream.status_code)
  return {
    type: "error",
    error: {
      message: typeof error.message === "string" ? error.message.slice(0, 4000) : "Provider request failed",
      ...(typeof error.code === "string" || typeof error.code === "number" ? { code: error.code } : {}),
      ...(typeof error.type === "string" ? { type: error.type } : {}),
    },
    ...(Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599 ? { statusCode } : {}),
    metadata: Object.fromEntries(
      Object.entries({
        reason: error.reason,
        detail: original.message_zh ?? original.message ?? partialProviderMessage(metadata.raw) ?? provider.message,
        provider: request.provider,
        model: request.model,
        upstreamProvider: metadata.provider_name,
        requestId: headers["x-request-id"],
        traceId: headers["x-trace-id"],
        upstreamRequestId: original.request_id,
        upstreamCode: original.code ?? provider.code,
      }).flatMap(([key, value]) =>
        typeof value === "string" || typeof value === "number" ? [[key, String(value).slice(0, 4000)]] : [],
      ),
    ),
  }
}

// A gateway may truncate the JSON after a complete message but before the closing braces.
function partialProviderMessage(raw: unknown) {
  if (typeof raw !== "string") return
  for (const pattern of [/"message_zh"\s*:\s*"(?:\\.|[^"\\])*"/, /"message"\s*:\s*"(?:\\.|[^"\\])*"/]) {
    const match = raw.slice(0, 16_000).match(pattern)
    if (!match) continue
    const value = json(`{${match[0]}}`)
    const message = value?.message_zh ?? value?.message
    if (typeof message === "string") return message
  }
}

export type ParsedAPICallError =
  | {
      type: "context_overflow"
      message: string
      responseBody?: string
    }
  | {
      type: "api_error"
      message: string
      statusCode?: number
      isRetryable: boolean
      responseHeaders?: Record<string, string>
      responseBody?: string
      metadata?: Record<string, string>
    }

export function parseAPICallError(input: { providerID: ProviderV2.ID; error: APICallError }): ParsedAPICallError {
  const m = message(input.providerID, input.error)
  const body = json(input.error.responseBody)
  if (isContextOverflow(m) || input.error.statusCode === 413 || body?.error?.code === "context_length_exceeded") {
    return {
      type: "context_overflow",
      message: m,
      responseBody: input.error.responseBody,
    }
  }

  const metadata = input.error.url ? { url: input.error.url } : undefined
  return {
    type: "api_error",
    message: m,
    statusCode: input.error.statusCode,
    isRetryable: input.providerID.startsWith("openai") ? isOpenAiErrorRetryable(input.error) : input.error.isRetryable,
    responseHeaders: input.error.responseHeaders,
    responseBody: input.error.responseBody,
    metadata,
  }
}

export * as ProviderError from "./error"
