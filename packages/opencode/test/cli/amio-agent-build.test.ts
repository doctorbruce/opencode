import { describe, expect, test } from "bun:test"
import {
  buildBinaryName,
  buildEntrypoints,
  parseTargetOS,
  resolveBuildVersion,
  resolveCompileExecutablePath,
} from "../../script/build_target"

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

  test("defaults amio-agent builds to the package version", () => {
    expect(
      resolveBuildVersion({
        amioAgent: true,
        envVersion: undefined,
        packageVersion: "1.16.2",
      }),
    ).toBe("1.16.2")
    expect(
      resolveBuildVersion({
        amioAgent: true,
        envVersion: "1.16.2-amio.1",
        packageVersion: "1.16.2",
      }),
    ).toBe("1.16.2-amio.1")
    expect(
      resolveBuildVersion({
        amioAgent: false,
        envVersion: undefined,
        packageVersion: "1.16.2",
      }),
    ).toBeUndefined()
  })

  test("parses target os filters", () => {
    expect(parseTargetOS(undefined)).toBeUndefined()
    expect(parseTargetOS("win32,darwin")).toEqual(["win32", "darwin"])
    expect(parseTargetOS(" win32, darwin ,, ")).toEqual(["win32", "darwin"])
  })

  test("resolves explicit compile executable paths", () => {
    expect(
      resolveCompileExecutablePath({
        executableDir: undefined,
        target: "bun-darwin-arm64",
        windows: false,
      }),
    ).toBeUndefined()
    expect(
      resolveCompileExecutablePath({
        executableDir: "E:/runtimes",
        target: "bun-darwin-arm64",
        windows: false,
      }),
    ).toBe("E:/runtimes/bun-darwin-arm64/bun")
    expect(
      resolveCompileExecutablePath({
        executableDir: "E:/runtimes/",
        target: "bun-windows-x64",
        windows: true,
      }),
    ).toBe("E:/runtimes/bun-windows-x64/bun.exe")
  })
})
