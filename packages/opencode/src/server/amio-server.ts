import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { Identifier } from "@/id/id"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { ServerAddress } from "./address"
import type { ServerListener } from "./listener"

// @ts-ignore This global suppresses ai-sdk warnings before the delegated graph is imported.
globalThis.AI_SDK_LOG_WARNINGS = false

type ListenOptions = ServerListener.Options & { readonly cors?: ReadonlyArray<string> }

export type Listener = ServerListener.Listener & {
  readonly applicationLoading: Promise<void>
}

type Inner = {
  request(request: Request): Promise<Response>
  dispose(): Promise<void>
}

const methods = "GET, HEAD, PUT, PATCH, POST, DELETE"

export async function listen(opts: ListenOptions): Promise<Listener> {
  let innerPromise: Promise<Inner> | undefined
  let stopPromise: Promise<void> | undefined
  let disposePromise: Promise<void> | undefined
  let forceRequested = false
  let unpublish = () => {}
  let announceApplicationLoading = () => {}
  const streams = new Set<() => void>()
  const shutdown = new AbortController()
  const applicationLoading = new Promise<void>((resolve) => {
    announceApplicationLoading = resolve
  })
  let releaseForce = () => {}
  const forced = new Promise<void>((resolve) => {
    releaseForce = resolve
  })
  const dispose = () =>
    (disposePromise ??= innerPromise?.then(
      (inner) => inner.dispose().catch(() => undefined),
      () => undefined,
    ) ?? Promise.resolve())
  const force = () => {
    if (forceRequested) return
    forceRequested = true
    shutdown.abort()
    void server.stop(true).catch(() => undefined)
    releaseForce()
  }
  const initialize = () => {
    if (innerPromise) return innerPromise
    announceApplicationLoading()
    const pending = createInner(opts).catch((error) => {
      if (innerPromise === pending) innerPromise = undefined
      throw error
    })
    innerPromise = pending
    return pending
  }
  const fetch = async (request: Request) => {
    const preflight = corsPreflight(request, opts)
    if (preflight) return preflight
    if (!authorized(request)) return withCors(request, unauthorized(), opts)

    const url = new URL(request.url)
    // Amio exposes transport readiness and its event stream before the typed
    // application graph is built. The same endpoints remain in the HttpApi.
    if (request.method === "GET" && url.pathname === "/global/health") {
      return withCors(request, Response.json({ healthy: true, version: InstallationVersion }), opts)
    }
    if (request.method === "GET" && url.pathname === "/global/event") {
      return withCors(request, eventStream(request, streams), opts)
    }
    if (
      request.method === "GET" &&
      url.pathname === "/session/status" &&
      !url.searchParams.has("workspace") &&
      !process.env.OPENCODE_WORKSPACE_ID &&
      innerPromise === undefined
    ) {
      return withCors(request, Response.json({}), opts)
    }
    const signal = AbortSignal.any([request.signal, shutdown.signal])
    const inner = await initialize()
    if (signal.aborted) return new Response(null, { status: 499 })
    return inner.request(new Request(request, { signal }))
  }
  const server = start(opts, fetch)
  const port = server.port!
  const url = makeURL(opts.hostname, port)
  ServerAddress.set(url)

  if (opts.mdns && !loopback(opts.hostname)) {
    const { MDNS } = await import("./mdns")
    MDNS.publish(port, opts.mdnsDomain)
    unpublish = MDNS.unpublish
  }

  return {
    hostname: opts.hostname,
    port,
    url,
    applicationLoading,
    stop(close?: boolean) {
      if (stopPromise) {
        if (close) force()
        return stopPromise
      }
      for (const stream of streams) stream()
      const stopped = close ? undefined : server.stop().catch(() => undefined)
      if (close) force()
      return (stopPromise = (async () => {
        if (stopped) await Promise.race([stopped, forced])
        if (forceRequested) {
          void dispose()
          return
        }
        await Promise.race([dispose(), forced])
      })().finally(() => {
        unpublish()
        ServerAddress.clear(url)
      }))
    },
  }
}

async function createInner(opts: ListenOptions): Promise<Inner> {
  const [, { AmioHttpApiApp }, { ConfigProvider, Layer }, { HttpRouter }, { disposeMiddleware }] = await Promise.all([
    import("./init-projectors"),
    import("./routes/instance/httpapi/amio"),
    import("effect"),
    import("effect/unstable/http"),
    import("./routes/instance/httpapi/lifecycle"),
  ])
  const web = HttpRouter.toWebHandler(
    AmioHttpApiApp.createRoutes(opts).pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv()))),
    { disableLogger: true, middleware: disposeMiddleware },
  )
  const inner = {
    request: (request: Request) => web.handler(request, AmioHttpApiApp.context),
    dispose: web.dispose,
  }
  try {
    const password = process.env.OPENCODE_SERVER_PASSWORD
    const response = await inner.request(
      new Request("http://localhost/global/health", {
        headers: password
          ? {
              authorization: `Basic ${Buffer.from(
                `${process.env.OPENCODE_SERVER_USERNAME ?? "opencode"}:${password}`,
              ).toString("base64")}`,
            }
          : undefined,
      }),
    )
    if (response.status !== 200) throw new Error(`Failed to initialize Amio HttpApi: ${response.status}`)
    return inner
  } catch (error) {
    await web.dispose().catch(() => undefined)
    throw error
  }
}

function start(opts: ListenOptions, fetch: (request: Request) => Promise<Response>) {
  if (opts.port !== 0) return Bun.serve({ hostname: opts.hostname, port: opts.port, idleTimeout: 0, fetch })
  try {
    return Bun.serve({ hostname: opts.hostname, port: 4096, idleTimeout: 0, fetch })
  } catch {
    return Bun.serve({ hostname: opts.hostname, port: 0, idleTimeout: 0, fetch })
  }
}

function authorized(request: Request) {
  const password = process.env.OPENCODE_SERVER_PASSWORD
  if (!password) return true
  const url = new URL(request.url)
  const credential =
    url.searchParams.get("auth_token") || /^Basic\s+(.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1]
  if (!credential) return false
  try {
    return (
      atob(credential) ===
      `${process.env.OPENCODE_SERVER_USERNAME ?? "opencode"}:${password}`
    )
  } catch {
    return false
  }
}

function unauthorized() {
  return new Response(null, {
    status: 401,
    headers: { "www-authenticate": 'Basic realm="Secure Area"' },
  })
}

function corsPreflight(request: Request, opts: ListenOptions) {
  if (request.method !== "OPTIONS") return
  const headers = corsHeaders(request, opts)
  headers.set("access-control-allow-methods", methods)
  headers.set("access-control-max-age", "86400")
  const requested = request.headers.get("access-control-request-headers")
  if (requested) {
    headers.set("access-control-allow-headers", requested)
    appendVary(headers, "Access-Control-Request-Headers")
  }
  return new Response(null, { status: 204, headers })
}

function withCors(request: Request, response: Response, opts: ListenOptions) {
  const headers = new Headers(response.headers)
  for (const [key, value] of corsHeaders(request, opts)) headers.set(key, value)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function corsHeaders(request: Request, opts: ListenOptions) {
  const headers = new Headers()
  const origin = request.headers.get("origin")
  if (!origin || !allowedOrigin(origin, opts)) return headers
  headers.set("access-control-allow-origin", origin)
  appendVary(headers, "Origin")
  return headers
}

function allowedOrigin(origin: string, opts: ListenOptions) {
  if (origin.startsWith("http://localhost:") || origin.startsWith("http://127.0.0.1:")) return true
  if (origin.startsWith("oc://renderer")) return true
  if (origin === "tauri://localhost" || origin === "http://tauri.localhost" || origin === "https://tauri.localhost") {
    return true
  }
  if (/^https:\/\/([a-z0-9-]+\.)*opencode\.ai$/.test(origin)) return true
  return opts.cors?.includes(origin) ?? false
}

function appendVary(headers: Headers, value: string) {
  const current = headers.get("vary")
  if (!current) {
    headers.set("vary", value)
    return
  }
  if (current.split(",").some((entry) => entry.trim().toLowerCase() === value.toLowerCase())) return
  headers.set("vary", `${current}, ${value}`)
}

function eventStream(request: Request, streams: Set<() => void>) {
  let cleanup = () => {}
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder()
      let active = true
      const send = (event: GlobalEvent) => {
        if (!active) return
        try {
          controller.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(event)}\n\n`))
        } catch {
          cleanup()
        }
      }
      const heartbeat = setInterval(
        () => send({ payload: { id: Identifier.create("evt", "ascending"), type: "server.heartbeat", properties: {} } }),
        10_000,
      )
      heartbeat.unref()
      cleanup = () => {
        if (!active) return
        active = false
        clearInterval(heartbeat)
        GlobalBus.off("event", send)
        streams.delete(cleanup)
        request.signal.removeEventListener("abort", cleanup)
        try {
          controller.close()
        } catch {}
      }
      GlobalBus.on("event", send)
      streams.add(cleanup)
      request.signal.addEventListener("abort", cleanup, { once: true })
      if (request.signal.aborted) return cleanup()
      send({ payload: { id: Identifier.create("evt", "ascending"), type: "server.connected", properties: {} } })
    },
    cancel() {
      cleanup()
    },
  })
  return new Response(body, {
    headers: {
      "cache-control": "no-cache, no-transform",
      "content-type": "text/event-stream",
      "x-accel-buffering": "no",
      "x-content-type-options": "nosniff",
    },
  })
}

function loopback(hostname: string) {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1"
}

function makeURL(hostname: string, port: number) {
  const result = new URL("http://localhost")
  result.hostname = hostname
  result.port = String(port)
  return result
}

export * as AmioServer from "./amio-server"
