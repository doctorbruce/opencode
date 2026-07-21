import { Effect, Schema } from "effect"
import { Agent } from "@/agent/agent"
import { Skill } from "../skill"
import { Tool } from "./tool"

export const SKILL_SEARCH_TOOL_ID = "skill_search"

export const Parameters = Schema.Struct({
  query: Schema.String.annotate({
    description: "Search available skills by intent, capability, or exact name. Use select:<skill_name> for exact names.",
  }),
  limit: Schema.optional(Schema.Number).annotate({
    description: "Maximum number of matching skills to return. Defaults to 5.",
  }),
})

export const SkillSearchTool = Tool.define(
  SKILL_SEARCH_TOOL_ID,
  Effect.gen(function* () {
    const skill = yield* Skill.Service
    const agents = yield* Agent.Service

    return {
      description:
        "Searches currently available skills without loading their full instructions. Use this before calling the skill tool when you do not know the exact skill name.",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const agent = yield* agents.get(ctx.agent)
          const matches = search(yield* skill.available(agent), params.query).slice(0, limit(params.limit))
          const names = matches.map((skill) => skill.name)
          yield* ctx.metadata({
            title: names.length ? `Found skills: ${names.join(", ")}` : "No skills matched",
            metadata: { skills: names },
          })

          if (matches.length === 0) {
            return {
              title: "No skills matched",
              output: `No skills matched "${params.query}". Try a broader query or use select:<skill_name> if you know the exact skill name.`,
              metadata: { skills: names },
            }
          }

          return {
            title: `Found ${matches.length} skill${matches.length === 1 ? "" : "s"}`,
            output: [
              "Matching skills:",
              "",
              ...matches.map(
                (skill) => `- ${skill.name}: ${firstLine(skill.description ?? "No description provided.")}`,
              ),
              "",
              "Call the skill tool with the exact returned skill name if one is relevant.",
            ].join("\n"),
            metadata: { skills: names },
          }
        }),
    }
  }),
)

function search(skills: Skill.Info[], query: string) {
  const normalized = query.trim().toLowerCase()
  if (normalized.startsWith("select:")) {
    const requested = new Set(
      normalized
        .slice("select:".length)
        .split(/[\s,]+/)
        .map((item) => item.trim())
        .filter(Boolean),
    )
    return skills.filter((skill) => requested.has(skill.name.toLowerCase()))
  }

  const terms = normalized.split(/\s+/).filter(Boolean)
  if (terms.length === 0) return skills.toSorted((a, b) => a.name.localeCompare(b.name))

  return skills
    .map((skill) => ({ skill, score: score(skill, terms) }))
    .filter((item) => item.score > 0)
    .toSorted((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
    .map((item) => item.skill)
}

function score(skill: Skill.Info, terms: string[]) {
  const name = skill.name.toLowerCase()
  const text = `${name} ${(skill.description ?? "").toLowerCase()}`
  if (!terms.every((term) => text.includes(term))) return 0
  return terms.reduce((sum, term) => sum + (name.includes(term) ? 3 : 1), 0)
}

function limit(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value)) return 5
  return Math.max(1, Math.min(20, Math.trunc(value)))
}

function firstLine(value: string) {
  return value.split(/\r?\n/)[0]?.trim() ?? ""
}
