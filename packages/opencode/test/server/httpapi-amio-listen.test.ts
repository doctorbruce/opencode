import { afterEach, describe, expect, test } from "bun:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { Flag } from "@opencode-ai/core/flag/flag"
import { AmioServer } from "../../src/server/amio-server"
import { ServerAddress } from "../../src/server/address"
import { GlobalPaths } from "../../src/server/routes/instance/httpapi/groups/global"
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

async function start() {
  Flag.OPENCODE_SERVER_PASSWORD = auth.password
  Flag.OPENCODE_SERVER_USERNAME = auth.username
  process.env.OPENCODE_SERVER_PASSWORD = auth.password
  process.env.OPENCODE_SERVER_USERNAME = auth.username
  return AmioServer.listen({ hostname: "127.0.0.1", port: 0 })
}

describe("amio-agent listener", () => {
  test("serves the Astron surface with auth and releases its address", async () => {
    const listener = await start()
    try {
      expect(ServerAddress.url).toEqual(listener.url)
      const unauthorized = await fetch(new URL(GlobalPaths.health, listener.url))
      expect(unauthorized.status).toBe(401)

      const health = await fetch(new URL(GlobalPaths.health, listener.url), {
        headers: { authorization: authorization() },
      })
      expect(health.status).toBe(200)

      const excluded = await fetch(new URL("/file", listener.url), {
        headers: { authorization: authorization() },
      })
      expect(excluded.status).toBe(404)
    } finally {
      await withTimeout(listener.stop(true), 10_000, "timed out stopping amio listener")
    }
    expect(ServerAddress.url).toBeUndefined()
  })

  test("plugin clients use the actual amio listener", async () => {
    await using tmp = await tmpdir({
      init: async (directory) => {
        const plugin = path.join(directory, "plugin.ts")
        const initialized = path.join(directory, "initialized.txt")
        const completed = path.join(directory, "completed.txt")
        await Bun.write(
          plugin,
          [
            "export default async function plugin(input) {",
            `  await Bun.write(${JSON.stringify(initialized)}, (await Bun.file(${JSON.stringify(initialized)}).text().catch(() => "")) + "initialized\\n")`,
            "  const provider = await input.client.provider.list()",
            `  await Bun.write(${JSON.stringify(initialized)}, (await Bun.file(${JSON.stringify(initialized)}).text()) + \`provider:\${provider.response.status}\\n\`)`,
            "  setTimeout(async () => {",
            "    const config = await input.client.config.get()",
            `    await Bun.write(${JSON.stringify(completed)}, JSON.stringify({ config: config.response.status }))`,
            "  }, 50)",
            "  return {}",
            "}",
            "",
          ].join("\n"),
        )
        await Bun.write(
          path.join(directory, "opencode.json"),
          JSON.stringify({ formatter: false, lsp: false, plugin: [pathToFileURL(plugin).href] }),
        )
        return { initialized, completed }
      },
    })
    const previous = process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS
    process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS = "1"
    const listener = await start()
    try {
      const response = await fetch(new URL("/config", listener.url), {
        headers: { authorization: authorization(), "x-opencode-directory": tmp.path },
      })
      expect(response.status).toBe(200)
      await withTimeout(
        (async () => {
          while (!(await Bun.file(tmp.extra.completed).exists())) await Bun.sleep(10)
        })(),
        5_000,
        "timed out waiting for amio plugin client",
      )
      expect(await Bun.file(tmp.extra.completed).json()).toEqual({ config: 200 })
      expect(await Bun.file(tmp.extra.initialized).text()).toBe("initialized\nprovider:404\n")
    } finally {
      await listener.stop(true)
      if (previous === undefined) delete process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS
      else process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS = previous
    }
  })
})
