import { describe, expect, test } from "bun:test"
import { AmioAgentCommands, installAmioAgentEnvironment } from "../../src/cli/amio-agent"

describe("amio-agent CLI surface", () => {
  test("registers only serve", () => {
    expect(AmioAgentCommands.map((command) => command.command)).toEqual(["serve"])
  })

  test("marks the server as a web-ui-free runtime", () => {
    const env: Record<string, string | undefined> = {}
    installAmioAgentEnvironment(env)
    expect(env.OPENCODE_DISABLE_WEB_UI_ROUTES).toBe("1")
  })

  test("uses the embedded model catalog without runtime refreshes", () => {
    const env: Record<string, string | undefined> = {}
    installAmioAgentEnvironment(env)
    expect(env.OPENCODE_DISABLE_MODELS_FETCH).toBe("1")
  })

  test("uses fast write defaults for sidecar usage", () => {
    const env: Record<string, string | undefined> = {}
    installAmioAgentEnvironment(env)
    expect(env.OPENCODE_DISABLE_WRITE_FORMAT).toBe("1")
    expect(env.OPENCODE_DISABLE_WRITE_DIAGNOSTICS).toBe("1")
  })
})
