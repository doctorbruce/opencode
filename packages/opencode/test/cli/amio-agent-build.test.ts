import { describe, expect, test } from "bun:test"
import { buildBinaryName, buildEntrypoints } from "../../script/build-target"

describe("amio-agent build target", () => {
  test("uses a serve-only entrypoint without tui worker or web ui bundle", () => {
    expect(
      buildEntrypoints({
        amioAgent: true,
        embeddedWebUi: true,
        parserWorker: "parser.worker.js",
        workerPath: "./src/cli/cmd/tui/worker.ts",
      }),
    ).toEqual(["./src/amio-agent.ts"])
    expect(buildBinaryName(true)).toBe("amio-agent")
  })

  test("keeps the full opencode entrypoints by default", () => {
    expect(
      buildEntrypoints({
        amioAgent: false,
        embeddedWebUi: true,
        parserWorker: "parser.worker.js",
        workerPath: "./src/cli/cmd/tui/worker.ts",
      }),
    ).toEqual(["./src/index.ts", "parser.worker.js", "./src/cli/cmd/tui/worker.ts", "opencode-web-ui.gen.ts"])
    expect(buildBinaryName(false)).toBe("opencode")
  })
})
