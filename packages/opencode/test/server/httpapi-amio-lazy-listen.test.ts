import { afterEach, describe, expect, test } from "bun:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { Flag } from "@opencode-ai/core/flag/flag"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { GlobalBus } from "@/bus/global"
import { AmioServer } from "../../src/server/amio-server"
import { ServerAddress } from "../../src/server/address"
import { withTimeout } from "../../src/util/timeout"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

const original = {
  password: Flag.OPENCODE_SERVER_PASSWORD,
  username: Flag.OPENCODE_SERVER_USERNAME,
  envPassword: process.env.OPENCODE_SERVER_PASSWORD,
  envUsername: process.env.OPENCODE_SERVER_USERNAME,
}
const auth = { username: "opencode", password: "amio-secret" }

afterEach(async () => {
  Flag.OPENCODE_SERVER_PASSWORD = original.password
  Flag.OPENCODE_SERVER_USERNAME = original.username
  if (original.envPassword === undefined) delete process.env.OPENCODE_SERVER_PASSWORD
  else process.env.OPENCODE_SERVER_PASSWORD = original.envPassword
  if (original.envUsername === undefined) delete process.env.OPENCODE_SERVER_USERNAME
  else process.env.OPENCODE_SERVER_USERNAME = original.envUsername
  await disposeAllInstances()
  await resetDatabase()
})

function authorization() {
  return `Basic ${btoa(`${auth.username}:${auth.password}`)}`
}

function headers(directory?: string) {
  return {
    authorization: authorization(),
    ...(directory ? { "x-opencode-directory": directory } : {}),
  }
}

async function start() {
  Flag.OPENCODE_SERVER_PASSWORD = auth.password
  Flag.OPENCODE_SERVER_USERNAME = auth.username
  process.env.OPENCODE_SERVER_PASSWORD = auth.password
  process.env.OPENCODE_SERVER_USERNAME = auth.username
  return AmioServer.listen({ hostname: "127.0.0.1", port: 0 })
}

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, needle: string) {
  const decoder = new TextDecoder()
  let output = ""
  while (!output.includes(needle)) {
    const chunk = await reader.read()
    if (chunk.done) break
    output += decoder.decode(chunk.value, { stream: true })
  }
  return output
}

describe("amio-agent lazy listener", () => {
  test("serves startup routes with auth and CORS", async () => {
    const listener = await start()
    try {
      expect(ServerAddress.url).toEqual(listener.url)

      const unauthorized = await fetch(new URL("/global/health", listener.url), {
        headers: { origin: "http://localhost:3000" },
      })
      expect(unauthorized.status).toBe(401)
      expect(unauthorized.headers.get("www-authenticate")).toBe('Basic realm="Secure Area"')
      expect(unauthorized.headers.get("access-control-allow-origin")).toBe("http://localhost:3000")

      const preflight = await fetch(new URL("/global/health", listener.url), {
        method: "OPTIONS",
        headers: {
          origin: "http://localhost:3000",
          "access-control-request-method": "GET",
          "access-control-request-headers": "authorization",
        },
      })
      expect(preflight.status).toBe(204)
      expect(preflight.headers.get("access-control-allow-origin")).toBe("http://localhost:3000")
      expect(preflight.headers.get("access-control-allow-headers")).toBe("authorization")
      expect(preflight.headers.get("vary")).toContain("Origin")

      const health = await fetch(new URL("/global/health", listener.url), { headers: headers() })
      expect(health.status).toBe(200)
      expect(await health.json()).toEqual({ healthy: true, version: InstallationVersion })

      const token = new URL("/global/health", listener.url)
      token.searchParams.set("auth_token", authorization().slice("Basic ".length))
      expect((await fetch(token)).status).toBe(200)
      token.searchParams.set("auth_token", "")
      expect((await fetch(token, { headers: headers() })).status).toBe(200)
    } finally {
      await withTimeout(listener.stop(true), 10_000, "timed out stopping lazy amio listener")
    }
    expect(ServerAddress.url).toBeUndefined()
  })

  test("streams global events before delegated routes initialize", async () => {
    const listener = await start()
    const abort = new AbortController()
    try {
      const response = await fetch(new URL("/global/event", listener.url), {
        headers: headers(),
        signal: abort.signal,
      })
      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toContain("text/event-stream")
      const reader = response.body!.getReader()
      expect(await withTimeout(readUntil(reader, "server.connected"), 2_000, "missing connected event")).toContain(
        "server.connected",
      )

      GlobalBus.emit("event", {
        directory: "lazy-listener-test",
        payload: { type: "test.lazy-listener", properties: { ready: true } },
      })
      expect(await withTimeout(readUntil(reader, "test.lazy-listener"), 2_000, "missing forwarded event")).toContain(
        '"ready":true',
      )
      abort.abort()
      await reader.cancel().catch(() => undefined)
    } finally {
      abort.abort()
      await listener.stop(true)
    }
  })

  test("does not dispatch requests canceled while delegated routes initialize", async () => {
    await using tmp = await tmpdir({
      init: async (directory) => {
        await Bun.write(path.join(directory, "opencode.json"), JSON.stringify({ formatter: false, lsp: false }))
      },
    })
    const listener = await start()
    const abort = new AbortController()
    let disposed = 0
    const onEvent = (event: { payload?: { type?: string } }) => {
      if (event.payload?.type === "global.disposed") disposed++
    }
    GlobalBus.on("event", onEvent)
    try {
      const requests = Array.from({ length: 4 }, () =>
        fetch(new URL("/global/dispose", listener.url), {
          method: "POST",
          headers: headers(),
          signal: abort.signal,
        }).catch(() => undefined),
      )
      await withTimeout(listener.applicationLoading, 2_000, "timed out waiting for delegated routes to start loading")
      abort.abort()
      await Promise.all(requests)

      const ready = await fetch(new URL("/config", listener.url), { headers: headers(tmp.path) })
      expect(ready.status).toBe(200)
      await Bun.sleep(10)
      expect(disposed).toBe(0)
    } finally {
      GlobalBus.off("event", onEvent)
      abort.abort()
      await listener.stop(true)
    }
  })

  test("keeps status cold and initializes one delegated handler for concurrent requests", async () => {
    await using tmp = await tmpdir({
      init: async (directory) => {
        const initialized = path.join(directory, "initialized.txt")
        const plugin = path.join(directory, "plugin.ts")
        await Bun.write(
          plugin,
          [
            'import { appendFile } from "node:fs/promises"',
            "export default async function plugin() {",
            `  await appendFile(${JSON.stringify(initialized)}, "initialized\\n")`,
            "  await Bun.sleep(100)",
            "  return {}",
            "}",
            "",
          ].join("\n"),
        )
        await Bun.write(
          path.join(directory, "opencode.json"),
          JSON.stringify({ formatter: false, lsp: false, plugin: [pathToFileURL(plugin).href] }),
        )
        return { initialized }
      },
    })
    const previous = process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS
    process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS = "1"
    const listener = await start()
    try {
      const status = await fetch(new URL("/session/status", listener.url), { headers: headers(tmp.path) })
      expect(status.status).toBe(200)
      expect(await status.json()).toEqual({})
      expect(await Bun.file(tmp.extra.initialized).exists()).toBe(false)

      const responses = await Promise.all([
        fetch(new URL("/config", listener.url), {
          headers: { ...headers(tmp.path), origin: "http://localhost:3000" },
        }),
        fetch(new URL("/config", listener.url), { headers: headers(tmp.path) }),
      ])
      expect(responses.map((response) => response.status)).toEqual([200, 200])
      expect(responses[0]!.headers.get("access-control-allow-origin")).toBe("http://localhost:3000")
      expect(responses[0]!.headers.get("vary")).toBe("Origin")
      expect((await Bun.file(tmp.extra.initialized).text()).trim().split("\n")).toHaveLength(1)
    } finally {
      await listener.stop(true)
      if (previous === undefined) delete process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS
      else process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS = previous
    }
  })

  test("delegates workspace-scoped status instead of taking the cold fast path", async () => {
    const listener = await start()
    try {
      const url = new URL("/session/status", listener.url)
      url.searchParams.set("workspace", "wrk_missing")
      const response = await fetch(url, { headers: headers() })
      expect(response.status).not.toBe(200)
    } finally {
      await listener.stop(true)
    }
  })

  test("upgrades graceful stop to force while a request is active", async () => {
    await using tmp = await tmpdir({
      init: async (directory) => {
        const started = path.join(directory, "started.txt")
        const plugin = path.join(directory, "slow-plugin.ts")
        await Bun.write(
          plugin,
          [
            "export default async function plugin() {",
            `  await Bun.write(${JSON.stringify(started)}, "started")`,
            "  await new Promise(() => {})",
            "  return {}",
            "}",
            "",
          ].join("\n"),
        )
        await Bun.write(
          path.join(directory, "opencode.json"),
          JSON.stringify({ formatter: false, lsp: false, plugin: [pathToFileURL(plugin).href] }),
        )
        return { started }
      },
    })
    const previous = process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS
    process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS = "1"
    const listener = await start()
    const request = fetch(new URL("/config", listener.url), { headers: headers(tmp.path) }).catch(() => undefined)
    try {
      await withTimeout(
        (async () => {
          while (!(await Bun.file(tmp.extra.started).exists())) await Bun.sleep(10)
        })(),
        5_000,
        "timed out waiting for active request",
      )
      let settled = false
      const graceful = listener.stop()
      void graceful.then(() => {
        settled = true
      })
      await Bun.sleep(50)
      expect(settled).toBe(false)
      expect(listener.stop(true)).toBe(graceful)
      await withTimeout(graceful, 2_000, "timed out upgrading graceful stop to force")
      await request
    } finally {
      await listener.stop(true)
      if (previous === undefined) delete process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS
      else process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS = previous
    }
  })

  test("stops idempotently after delegated routes initialize", async () => {
    await using tmp = await tmpdir({
      init: async (directory) => {
        await Bun.write(path.join(directory, "opencode.json"), JSON.stringify({ formatter: false, lsp: false }))
      },
    })
    const previous = process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS
    process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS = "1"
    const listener = await start()
    try {
      const response = await fetch(new URL("/config", listener.url), { headers: headers(tmp.path) })
      expect(response.status).toBe(200)
      await withTimeout(
        Promise.all([listener.stop(true), listener.stop(true)]).then(() => undefined),
        10_000,
        "timed out stopping initialized lazy listener",
      )
      expect(ServerAddress.url).toBeUndefined()
      expect(
        await fetch(new URL("/global/health", listener.url)).then(
          () => false,
          () => true,
        ),
      ).toBe(true)
    } finally {
      await listener.stop(true)
      if (previous === undefined) delete process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS
      else process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS = previous
    }
  })
})
