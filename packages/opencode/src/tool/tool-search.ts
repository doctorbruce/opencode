import { Effect, Schema } from "effect"
import { Tool } from "./tool"

export const TOOL_SEARCH_TOOL_ID = "tool_search"

export const Parameters = Schema.Struct({
  query: Schema.String.annotate({
    description:
      "Search deferred tools by intent, capability, or exact id. Use select:<tool_id> to load a specific tool.",
  }),
  limit: Schema.optional(Schema.Number).annotate({
    description: "Maximum number of matching tools to load for the next model step. Defaults to 8.",
  }),
})

type DeferredToolInfo = {
  id: string
  description: string
}

export const ToolSearchTool = Tool.define(
  TOOL_SEARCH_TOOL_ID,
  Effect.succeed({
    description:
      "Searches tools that are registered but not currently loaded in the model-facing tool list. Use this before calling a specialized custom tool that is not currently available.",
    parameters: Parameters,
    execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
      Effect.gen(function* () {
        const available = deferredTools(ctx.extra)
        const matches = search(available, params.query).slice(0, limit(params.limit))
        const names = matches.map((tool) => tool.id)
        yield* ctx.metadata({
          title: names.length ? `Loaded deferred tools: ${names.join(", ")}` : "No deferred tools matched",
          metadata: { tools: names },
        })

        if (matches.length === 0) {
          return {
            title: "No deferred tools matched",
            output: `No deferred tools matched "${params.query}". Try a broader query or use select:<tool_id> if you know the exact tool id.`,
            metadata: { tools: names },
          }
        }

        return {
          title: `Loaded ${matches.length} deferred tool${matches.length === 1 ? "" : "s"}`,
          output: [
            "Loaded deferred tools for the next model step:",
            "",
            ...matches.map((tool) => `- ${tool.id}: ${firstLine(tool.description)}`),
            "",
            "Call the matching tool directly in the next step if it is relevant.",
          ].join("\n"),
          metadata: { tools: names },
        }
      }),
  }),
)

function deferredTools(extra: Tool.Context["extra"]) {
  const value = extra?.deferredTools
  if (!Array.isArray(value)) return []
  return value.filter((item): item is DeferredToolInfo => {
    if (!item || typeof item !== "object") return false
    return "id" in item && typeof item.id === "string" && "description" in item && typeof item.description === "string"
  })
}

function search(tools: DeferredToolInfo[], query: string) {
  const normalized = query.trim().toLowerCase()
  if (normalized.startsWith("select:")) {
    const requested = new Set(
      normalized
        .slice("select:".length)
        .split(/[\s,]+/)
        .map((item) => item.trim())
        .filter(Boolean),
    )
    return tools.filter((tool) => requested.has(tool.id.toLowerCase()))
  }

  const terms = Array.from(new Set(normalized.match(/[a-z0-9][a-z0-9_-]*|[\p{Script=Han}]+/gu) ?? []))
  if (terms.length === 0) return tools

  return tools
    .map((tool) => ({ tool, score: score(tool, terms) }))
    .filter((item) => item.score > 0)
    .toSorted((a, b) => b.score - a.score || a.tool.id.localeCompare(b.tool.id))
    .map((item) => item.tool)
}

function score(tool: DeferredToolInfo, terms: string[]) {
  const id = tool.id.toLowerCase()
  const text = `${id} ${tool.description.toLowerCase()}`
  return terms.reduce((sum, term) => sum + (id.includes(term) ? 4 : text.includes(term) ? 1 : 0), 0)
}

function limit(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value)) return 8
  return Math.max(1, Math.min(20, Math.trunc(value)))
}

function firstLine(value: string) {
  return value.split(/\r?\n/)[0]?.trim() ?? ""
}
