import { Effect, Schema } from "effect"
import { Agent } from "@/agent/agent"
import { Skill } from "../skill"
import { Tool } from "./tool"

export const SKILL_SEARCH_TOOL_ID = "skill_search"

export const Parameters = Schema.Struct({
  query: Schema.String.annotate({
    description:
      'Search available skills by intent, capability, or exact name. Use select:<skill_name> for exact names. Use "list" or the user\'s capability-list question to list available skills.',
  }),
  limit: Schema.optional(Schema.Number).annotate({
    description: "Maximum number of matching skills to return. Defaults to 20 for searches and 100 for list queries.",
  }),
})

export const SkillSearchTool = Tool.define(
  SKILL_SEARCH_TOOL_ID,
  Effect.gen(function* () {
    const skill = yield* Skill.Service
    const agents = yield* Agent.Service

    return {
      description:
        "Searches or lists currently available skills without loading their full instructions. Use this before calling the skill tool when you do not know the exact skill name, and use it when users ask which skills or callable capabilities are available.",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const agent = yield* agents.get(ctx.agent)
          const result = search(yield* skill.available(agent), params.query)
          const matches = result.skills.slice(0, limit(params.limit, result.inventory))
          const names = matches.map((skill) => skill.name)
          const truncated = matches.length < result.skills.length
          yield* ctx.metadata({
            title: names.length ? skillTitle(matches.length, result.skills.length) : "No skills matched",
            metadata: { skills: names, total: result.skills.length, shown: matches.length, truncated },
          })

          if (matches.length === 0) {
            return {
              title: "No skills matched",
              output: `No skills matched "${params.query}". Try a broader query, use "list" to see available skills, or use select:<skill_name> if you know the exact skill name.`,
              metadata: { skills: names, total: result.skills.length, shown: matches.length, truncated },
            }
          }

          return {
            title: skillTitle(matches.length, result.skills.length),
            output: [
              result.inventory ? "Available skills:" : "Matching skills:",
              "",
              ...matches.map(
                (skill) => `- ${skill.name}: ${firstLine(skill.description ?? "No description provided.")}`,
              ),
              ...(truncated
                ? [
                    "",
                    `Showing ${matches.length} of ${result.skills.length} skills. Call skill_search with a more specific query or a higher limit up to ${MAX_LIMIT}.`,
                  ]
                : []),
              "",
              "Call the skill tool with the exact returned skill name if one is relevant.",
            ].join("\n"),
            metadata: { skills: names, total: result.skills.length, shown: matches.length, truncated },
          }
        }),
    }
  }),
)

function search(skills: Skill.Info[], query: string) {
  const normalized = normalizeQuery(query)
  const sorted = skills.toSorted((a, b) => a.name.localeCompare(b.name))
  if (normalized.startsWith("select:")) {
    const requested = new Set(
      normalized
        .slice("select:".length)
        .split(/[\s,]+/)
        .map((item) => item.trim())
        .filter(Boolean),
    )
    return { inventory: false, skills: sorted.filter((skill) => requested.has(skill.name.toLowerCase())) }
  }

  if (isInventoryQuery(normalized)) return { inventory: true, skills: sorted }

  const terms = searchTerms(normalized)
  if (terms.length === 0) return { inventory: true, skills: sorted }

  return {
    inventory: false,
    skills: sorted
      .map((skill) => ({ skill, score: score(skill, terms, normalized) }))
      .filter((item) => item.score > 0)
      .toSorted((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
      .map((item) => item.skill),
  }
}

function score(skill: Skill.Info, terms: string[], query: string) {
  const name = skill.name.toLowerCase()
  const text = `${name} ${(skill.description ?? "").toLowerCase()}`
  const direct = query.includes(name) || name.includes(query) ? 8 : 0
  return direct + terms.reduce((sum, term) => sum + (name.includes(term) ? 4 : text.includes(term) ? 1 : 0), 0)
}

function normalizeQuery(query: string) {
  return query.trim().toLowerCase()
}

function isInventoryQuery(query: string) {
  if (query.length === 0) return true
  if (["list", "all", "skills", "capabilities", "available skills", "available capabilities"].includes(query)) {
    return true
  }
  if (/what.*(skills|capabilities|can you do)|which.*skills/.test(query)) return true
  const compact = query.replace(/[\s，,。.!！？?、；;：:]/g, "")
  return (
    /^(?:你|您|我)?(?:有|会|拥有|具备|能用|可以用|可以使用)?(?:哪些|什么|啥|多少|可用|可用的|所有|全部)?(?:技能|能力|工具)(?:吗|呢|呀|啊)?$/.test(
      compact,
    ) ||
    /^(?:你|您|我)?(?:能做什么|会什么|有什么|有哪些)(?:吗|呢|呀|啊)?$/.test(compact) ||
    /^(?:技能|能力|工具)(?:列表|有哪些|有什么|是什么)(?:吗|呢|呀|啊)?$/.test(compact) ||
    /^(?:列出|列一下|展示|显示)(?:所有|全部|可用|可用的)?(?:技能|能力|工具)(?:列表)?$/.test(compact)
  )
}

function searchTerms(query: string) {
  const terms = query.match(/[a-z0-9][a-z0-9_-]*|[\p{Script=Han}]+/gu) ?? []
  return Array.from(new Set(terms.filter((term) => !STOP_TERMS.has(term))))
}

const STOP_TERMS = new Set([
  "skill",
  "skills",
  "capability",
  "capabilities",
  "available",
  "tool",
  "tools",
  "use",
  "using",
  "find",
  "search",
  "技能",
  "能力",
  "工具",
  "可用",
  "可以",
  "哪些",
  "什么",
  "帮我",
  "一下",
])

const DEFAULT_SEARCH_LIMIT = 20
const DEFAULT_INVENTORY_LIMIT = 100
const MAX_LIMIT = 100

function limit(value: number | undefined, inventory: boolean) {
  if (value === undefined || !Number.isFinite(value)) return inventory ? DEFAULT_INVENTORY_LIMIT : DEFAULT_SEARCH_LIMIT
  return Math.max(1, Math.min(MAX_LIMIT, Math.trunc(value)))
}

function firstLine(value: string) {
  return value.split(/\r?\n/)[0]?.trim() ?? ""
}

function skillTitle(shown: number, total: number) {
  if (shown === total) return `Found ${shown} skill${shown === 1 ? "" : "s"}`
  return `Found ${shown} of ${total} skills`
}
