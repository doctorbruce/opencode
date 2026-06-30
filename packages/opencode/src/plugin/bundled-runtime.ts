import fs from "fs/promises"
import path from "path"
import { fileURLToPath, pathToFileURL } from "url"
import { Global } from "@opencode-ai/core/global"
import { z } from "zod"

const namespace = "opencode-bundled-plugin-runtime"
const schemaKeyName = "opencode.bundledPluginRuntime.schema"
const schemaKey = Symbol.for(schemaKeyName)

export async function importExternalPluginModule(entry: string): Promise<Record<string, unknown>> {
  registerBundledPluginRuntime()
  try {
    return (await import(entry)) as Record<string, unknown>
  } catch (error) {
    if (!shouldBundleExternalPlugin(error)) throw error
    return importBundledExternalPlugin(entry)
  }
}

export function registerBundledPluginRuntime() {
  const store = globalThis as Record<PropertyKey, unknown>
  store[schemaKey] = z
}

function shouldBundleExternalPlugin(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes("Cannot find module '@opencode-ai/plugin")
}

async function importBundledExternalPlugin(entry: string) {
  const file = entryFile(entry)
  const outdir = await fs.mkdtemp(path.join(Global.Path.tmp, "plugin-runtime-"))
  const result = await Bun.build({
    entrypoints: [file],
    outdir,
    format: "esm",
    target: "bun",
    packages: "external",
    plugins: [bundledPluginRuntimeBuildPlugin()],
  })
  if (!result.success) throw new Error(result.logs.map((log) => log.message).join("\n"))

  const output = result.outputs.find((item) => item.path.endsWith(".js"))
  if (!output) throw new Error(`Failed to bundle external plugin ${entry}`)
  return (await import(pathToFileURL(output.path).href)) as Record<string, unknown>
}

function entryFile(entry: string) {
  if (entry.startsWith("file://")) return fileURLToPath(entry)
  if (path.isAbsolute(entry)) return entry
  throw new Error(`Cannot bundle external plugin entry ${entry}`)
}

function bundledPluginRuntimeBuildPlugin() {
  return {
    name: namespace,
    setup(build) {
      build.onResolve({ filter: /^@opencode-ai\/plugin(?:\/tool)?$/ }, (args) => ({
        path: args.path,
        namespace,
      }))
      build.onLoad({ filter: /.*/, namespace }, () => ({
        loader: "js",
        contents: [
          `const schema = globalThis[Symbol.for(${JSON.stringify(schemaKeyName)})]`,
          "export function tool(input) {",
          "  return input",
          "}",
          "tool.schema = schema",
          "export default { tool }",
          "",
        ].join("\n"),
      }))
    },
  } satisfies Bun.BunPlugin
}
