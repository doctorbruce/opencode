import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"

describe("plugin.bundled-runtime", () => {
  test("standalone binary loads external tool plugins without local node_modules", async () => {
    const tmp = path.resolve(import.meta.dir, "../../../../tmp", `bundled-runtime-${Date.now()}`)
    const entry = path.join(tmp, "entry.ts")
    const plugin = path.join(tmp, "external-tool.ts")
    const executable = path.join(tmp, process.platform === "win32" ? "probe.exe" : "probe")
    const runtime = path
      .relative(tmp, path.resolve(import.meta.dir, "../../src/plugin/bundled-runtime.ts"))
      .replaceAll("\\", "/")

    try {
      await fs.mkdir(tmp, { recursive: true })
      await Bun.write(
        entry,
        [
          'import { pathToFileURL } from "node:url"',
          `import { importExternalPluginModule } from ${JSON.stringify(runtime.startsWith(".") ? runtime : `./${runtime}`)}`,
          "const mod = await importExternalPluginModule(pathToFileURL(process.argv[2]).href)",
          'console.log(JSON.stringify({ tool: typeof mod.toolValue, schema: typeof mod.schemaValue }))',
          "",
        ].join("\n"),
      )
      await Bun.write(
        plugin,
        [
          'import { tool } from "@opencode-ai/plugin"',
          "export const toolValue = tool",
          "export const schemaValue = tool.schema.string",
          "",
        ].join("\n"),
      )

      const build = await Bun.build({
        entrypoints: [entry],
        compile: {
          outfile: executable,
        },
      })
      expect(build.success, build.logs.map((log) => log.message).join("\n")).toBe(true)

      const proc = Bun.spawn([executable, plugin], {
        cwd: tmp,
        stderr: "pipe",
        stdout: "pipe",
      })
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])

      expect(stderr).toBe("")
      expect(exitCode).toBe(0)
      expect(JSON.parse(stdout.trim())).toEqual({ tool: "function", schema: "function" })
    } finally {
      await fs.rm(tmp, { recursive: true, force: true })
    }
  }, 30_000)

  test("standalone binary loads bundled provider dependencies without local node_modules", async () => {
    const sourceTmp = path.resolve(import.meta.dir, "../../tmp", `bundled-provider-source-${Date.now()}`)
    const runTmp = path.resolve(import.meta.dir, "../../../../tmp", `bundled-provider-run-${Date.now()}`)
    const entry = path.join(sourceTmp, "entry.ts")
    const executable = path.join(runTmp, process.platform === "win32" ? "provider-probe.exe" : "provider-probe")

    try {
      await fs.mkdir(sourceTmp, { recursive: true })
      await fs.mkdir(runTmp, { recursive: true })
      await Bun.write(
        entry,
        [
          'const mod = await import("@ai-sdk/openai-compatible")',
          'const provider = mod.createOpenAICompatible({ name: "test", baseURL: "http://127.0.0.1", apiKey: "test" })',
          'console.log(JSON.stringify({ factory: typeof mod.createOpenAICompatible, model: typeof provider.languageModel("test") }))',
          "",
        ].join("\n"),
      )

      const build = await Bun.build({
        entrypoints: [entry],
        compile: {
          outfile: executable,
        },
      })
      expect(build.success, build.logs.map((log) => log.message).join("\n")).toBe(true)

      const proc = Bun.spawn([executable], {
        cwd: runTmp,
        stderr: "pipe",
        stdout: "pipe",
      })
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])

      expect(stderr).toBe("")
      expect(exitCode).toBe(0)
      expect(JSON.parse(stdout.trim())).toEqual({ factory: "function", model: "object" })
    } finally {
      await fs.rm(sourceTmp, { recursive: true, force: true })
      await fs.rm(runTmp, { recursive: true, force: true })
    }
  }, 30_000)
})
