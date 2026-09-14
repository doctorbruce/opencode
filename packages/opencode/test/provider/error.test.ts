import { describe, expect, test } from "bun:test"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { streamText } from "ai"
import { ProviderError } from "@/provider/error"
import { MessageV2 } from "@/session/message-v2"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Cause, Effect, Exit, Stream } from "effect"
import { LLMAISDK } from "@/session/llm/ai-sdk"

describe("provider stream errors", () => {
  test.each([
    { message: "Invalid API key", code: 401 },
    { message: "Forbidden", status: 403 },
    { message: "Invalid parameter", status_code: 400 },
    { message: "Invalid API key", code: "invalid_api_key" },
    { message: "Unauthorized", type: "authentication_error" },
  ])("does not default plain client errors to retryable: %j", (error) => {
    expect(ProviderError.parseStreamError({ error })).toMatchObject({
      type: "api_error",
      message: error.message,
      isRetryable: false,
    })
  })

  test.each([429, 503])("retains retryable plain HTTP status %i", (code) => {
    expect(ProviderError.parseStreamError({ error: { message: "Request failed", code } })).toMatchObject({
      statusCode: code,
      isRetryable: true,
    })
  })

  test("preserves structured OpenAI-compatible stream error details", async () => {
    const detail = {
      message: "Upstream API error: 429",
      reason: "Upstream rate limit",
      upstream: {
        status_code: 429,
        headers: { "x-request-id": "req-upstream", "x-trace-id": "trace-upstream", "set-cookie": "secret-cookie" },
        body: {
          error: {
            message: "Upstream rate limit",
            metadata: {
              provider_name: "tencent-tokenhub-direct",
              raw: JSON.stringify({
                error: {
                  message_zh: "请求速率超过当前模型 TPM 阈值 1000000",
                  code: "429001",
                  request_id: "req-provider",
                },
              }),
            },
          },
        },
      },
      request: {
        provider: "deepseek",
        model: "deepseek/deepseek-flash",
        key: "secret-key",
        caller: { user_name: "private-user" },
      },
    }
    const model = createOpenAICompatible({
      name: "test",
      baseURL: "https://example.test/v1",
      apiKey: "test-key",
      fetch: Object.assign(
        async () =>
          new Response(`data: ${JSON.stringify({ error: detail })}\n\ndata: [DONE]\n\n`, {
            headers: { "content-type": "text/event-stream" },
          }),
        { preconnect() {} },
      ),
    })("test-model")
    const result = streamText({ model, prompt: "hello", maxRetries: 0, includeRawChunks: true, onError() {} })
    const state = LLMAISDK.adapterState()
    const exit = await Effect.runPromise(
      Stream.fromAsyncIterable(result.fullStream, (error) => error).pipe(
        Stream.mapEffect((event) => LLMAISDK.toLLMEvents(state, event)),
        Stream.runDrain,
        Effect.exit,
      ),
    )
    if (!Exit.isFailure(exit)) throw new Error("expected stream failure")
    const error = MessageV2.fromError(Cause.squash(exit.cause), { providerID: ProviderV2.ID.make("test") })
    expect(SessionV1.APIError.isInstance(error)).toBe(true)
    if (!SessionV1.APIError.isInstance(error)) throw new Error("expected APIError")
    expect(error.data.statusCode).toBe(429)
    expect(error.data.isRetryable).toBe(true)
    expect(error.data.metadata).toEqual({
      reason: "Upstream rate limit",
      detail: "请求速率超过当前模型 TPM 阈值 1000000",
      provider: "deepseek",
      model: "deepseek/deepseek-flash",
      upstreamProvider: "tencent-tokenhub-direct",
      requestId: "req-upstream",
      traceId: "trace-upstream",
      upstreamRequestId: "req-provider",
      upstreamCode: "429001",
    })
    expect(JSON.parse(error.data.responseBody ?? "null")).toMatchObject({
      error: { message: detail.message },
      statusCode: 429,
      metadata: error.data.metadata,
    })
    expect(error.data.responseBody).not.toContain("secret")
    expect(error.data.responseBody).not.toContain("private-user")
  })

  test("preserves the reason when the gateway truncates the provider JSON", () => {
    const error = ProviderError.parseStreamError({
      error: {
        message: "Upstream API error: 429",
        upstream: {
          status_code: 429,
          body: {
            error: {
              message: "Upstream rate limit",
              metadata: {
                raw: '{"error":{"message":"TPM limit 1000000","message_zh":"请求速率超过当前模型 TPM 阈值 1000000。","request_id":"fa7492…(truncated)',
              },
            },
          },
        },
      },
    })
    expect(error?.type).toBe("api_error")
    if (error?.type !== "api_error") throw new Error("expected API error")
    expect(error.metadata?.detail).toBe("请求速率超过当前模型 TPM 阈值 1000000。")
    expect(error.responseBody).not.toContain("fa7492")
  })

  test("retries provider stream errors without a code", () => {
    const messages = [
      "The model is currently at capacity due to high demand. Please try again in a few minutes, or use a higher service tier for priority processing: https://docs.x.ai/developers/advanced-api-usage/priority-processing",
      "The model is temporarily unavailable.",
    ]

    for (const message of messages)
      expect(
        ProviderError.parseStreamError({
          type: "error",
          error: { message },
        }),
      ).toEqual({
        type: "api_error",
        message,
        isRetryable: true,
        responseBody: JSON.stringify({ type: "error", error: { message } }),
      })
  })
})
