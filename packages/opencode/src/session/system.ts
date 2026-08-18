import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Context, Effect, Layer } from "effect"

import { InstanceState } from "@/effect/instance-state"

import PROMPT_ANTHROPIC from "./prompt/anthropic.txt"
import PROMPT_DEFAULT from "./prompt/default.txt"
import PROMPT_BEAST from "./prompt/beast.txt"
import PROMPT_GEMINI from "./prompt/gemini.txt"
import PROMPT_GPT from "./prompt/gpt.txt"
import PROMPT_KIMI from "./prompt/kimi.txt"

import PROMPT_CODEX from "./prompt/codex.txt"
import PROMPT_TRINITY from "./prompt/trinity.txt"
import PROMPT_ZH_ANTHROPIC from "./prompt-zh/anthropic.txt"
import PROMPT_ZH_DEFAULT from "./prompt-zh/default.txt"
import PROMPT_ZH_BEAST from "./prompt-zh/beast.txt"
import PROMPT_ZH_GEMINI from "./prompt-zh/gemini.txt"
import PROMPT_ZH_GPT from "./prompt-zh/gpt.txt"
import PROMPT_ZH_KIMI from "./prompt-zh/kimi.txt"
import PROMPT_ZH_CODEX from "./prompt-zh/codex.txt"
import PROMPT_ZH_TRINITY from "./prompt-zh/trinity.txt"
import type { Provider } from "@/provider/provider"
import type { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import { Skill } from "@/skill"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap, locationServiceMapLayer } from "@opencode-ai/core/location-services"
import { Reference } from "@opencode-ai/core/reference"
import { MCP } from "@/mcp"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { TOOL_SEARCH_TOOL_ID } from "@/tool/tool-search"

export type PromptLanguage = "en" | "zh"

export function provider(model: Provider.Model, language: PromptLanguage = "en") {
  if (model.api.id.includes("gpt-4") || model.api.id.includes("o1") || model.api.id.includes("o3"))
    return [language === "zh" ? PROMPT_ZH_BEAST : PROMPT_BEAST]
  if (model.api.id.includes("gpt")) {
    if (model.api.id.includes("codex")) {
      return [language === "zh" ? PROMPT_ZH_CODEX : PROMPT_CODEX]
    }
    return [language === "zh" ? PROMPT_ZH_GPT : PROMPT_GPT]
  }
  if (model.api.id.includes("gemini-")) return [language === "zh" ? PROMPT_ZH_GEMINI : PROMPT_GEMINI]
  if (model.api.id.includes("claude")) return [language === "zh" ? PROMPT_ZH_ANTHROPIC : PROMPT_ANTHROPIC]
  if (model.api.id.toLowerCase().includes("trinity")) return [language === "zh" ? PROMPT_ZH_TRINITY : PROMPT_TRINITY]
  if (model.api.id.toLowerCase().includes("kimi")) return [language === "zh" ? PROMPT_ZH_KIMI : PROMPT_KIMI]
  return [language === "zh" ? PROMPT_ZH_DEFAULT : PROMPT_DEFAULT]
}

export interface Interface {
  readonly environment: (model: Provider.Model, language?: PromptLanguage) => Effect.Effect<string[]>
  readonly toolDiscovery: (agent: Agent.Info, language?: PromptLanguage) => Effect.Effect<string | undefined>
  readonly skills: (agent: Agent.Info, language?: PromptLanguage) => Effect.Effect<string | undefined>
  readonly mcp: (agent: Agent.Info, permission?: PermissionV1.Ruleset) => Effect.Effect<string | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SystemPrompt") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const mcp = yield* MCP.Service
    const skill = yield* Skill.Service
    const locations = yield* LocationServiceMap.Service

    return Service.of({
      environment: Effect.fn("SystemPrompt.environment")(function* (
        _model: Provider.Model,
        language: PromptLanguage = "en",
      ) {
        const ctx = yield* InstanceState.context
        const references = yield* Effect.gen(function* () {
          return (yield* (yield* Reference.Service).list()).filter((reference) => reference.description !== undefined)
        }).pipe(Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(ctx.directory) }))))
        if (references.length === 0) return []

        return [
          [
            language === "zh"
              ? "## 项目引用"
              : "## Project References",
            language === "zh"
              ? "相关时可以访问以下额外目录："
              : "These additional directories can be accessed when relevant:",
            ...references
              .toSorted((a, b) => a.name.localeCompare(b.name))
              .flatMap((reference) => [
                `- ${reference.name}`,
                `  - path: ${reference.path}`,
                ...(reference.description === undefined ? [] : [`  - description: ${reference.description}`]),
              ]),
          ].join("\n"),
        ]
      }),

      toolDiscovery: Effect.fn("SystemPrompt.toolDiscovery")(function* (
        agent: Agent.Info,
        language: PromptLanguage = "en",
      ) {
        const disabledTools = Permission.disabled([TOOL_SEARCH_TOOL_ID], agent.permission)
        if (disabledTools.has(TOOL_SEARCH_TOOL_ID)) return
        return language === "zh"
          ? [
              "## 工具发现",
              "以下专用工具已按需收起：",
              "- `ai-scheduled-task-*`：创建、查询、暂停和删除定时任务",
              "- `knowledge-*`：检索知识库和表格",
              "- `email-*`：邮件查询与发送",
              "- `memory-*`：读取和保存长期记忆",
              "需要这些能力时，先用 `tool_search` 按需求描述搜索；知道工具名称时可使用 `select:<tool_id>`。",
            ].join("\n")
          : [
              "## Tool Discovery",
              "The following specialized tools are deferred until needed:",
              "- `ai-scheduled-task-*`: create, query, pause, and delete scheduled tasks",
              "- `knowledge-*`: search knowledge bases and tables",
              "- `email-*`: query and send email",
              "- `memory-*`: read and save long-term memory",
              "When you need these capabilities, search by intent with `tool_search`; if you know the tool name, use `select:<tool_id>`.",
            ].join("\n")
      }),

      skills: Effect.fn("SystemPrompt.skills")(function* (agent: Agent.Info, language: PromptLanguage = "en") {
        const disabledTools = Permission.disabled(["skill", "skill_search"], agent.permission)
        if (disabledTools.has("skill")) return
        const searchAllowed = !disabledTools.has("skill_search")
        const skillIndex = renderSkillIndex(yield* skill.available(agent), language)

        if (language === "zh")
          return [
            "## 专项技能",
            "技能提供面向特定任务的专门指令和工作流。",
            skillIndex,
            searchAllowed
              ? "只用上方索引、用户输入或 `skill_search` 返回的精确 name 调用 `skill`；不确定、索引截断或用户问完整技能/能力清单时先调用 `skill_search`。"
              : "只有用户明确给出精确 skill 名称时，才调用 `skill`。",
            "面向用户用自然语言概述能力；除非明确询问，不暴露内部 skill name。",
          ].join("\n")

        return [
          "## Specialized Skills",
          "Skills provide specialized instructions and workflows for specific tasks.",
          skillIndex,
          searchAllowed
            ? "Call `skill` only with an exact name from the index above, the user, or `skill_search`; use `skill_search` when unsure, the index is truncated, or the user asks for the full skill/capability list."
            : "Only call `skill` when the user explicitly provides the exact skill name.",
          "Describe capabilities naturally; do not expose internal skill names unless asked.",
        ].join("\n")
      }),

      mcp: Effect.fn("SystemPrompt.mcp")(function* (agent: Agent.Info, permission?: PermissionV1.Ruleset) {
        const ruleset = Permission.merge(agent.permission, permission ?? [])
        const instructions = (yield* mcp.instructions()).filter(
          (item) => item.tools.length === 0 || Permission.disabled(item.tools, ruleset).size < item.tools.length,
        )
        if (instructions.length === 0) return

        return [
          "## MCP Instructions",
          ...instructions.flatMap((item) => [
            `### ${item.name}`,
            ...item.instructions.split("\n").map((line) => line.trim()).filter((line) => line.length > 0),
          ]),
        ].join("\n")
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Skill.defaultLayer),
  Layer.provide(MCP.defaultLayer),
  Layer.provide(locationServiceMapLayer),
)

const SKILL_DESCRIPTION_LIMIT = 160

function renderSkillIndex(skills: Skill.Info[], language: PromptLanguage) {
  if (skills.length === 0) {
    return language === "zh" ? "当前没有可用专项技能。" : "No specialized skills are currently available."
  }

  const shown = skills.toSorted((a, b) => a.name.localeCompare(b.name))
  const lines = [
    language === "zh"
      ? "当前可用专项技能（name + 一行 description；完整说明仅在调用 `skill` 后加载）："
      : "Available specialized skills (name + one-line description; full instructions are loaded only after calling `skill`):",
    ...shown.map((skill) => `- ${skill.name}: ${oneLineDescription(skillDescription(skill, language), language)}`),
  ]

  return lines.join("\n")
}

function skillDescription(skill: Skill.Info, language: PromptLanguage) {
  const localized =
    language === "zh"
      ? skill.descriptions?.["zh-CN"]
      : skill.descriptions?.["en-US"]
  return localized ?? skill.description
}

function oneLineDescription(description: string | undefined, language: PromptLanguage) {
  const text =
    description
      ?.split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ""
  const fallback = language === "zh" ? "无描述。" : "No description provided."
  if (text.length <= SKILL_DESCRIPTION_LIMIT) return text || fallback
  return `${text.slice(0, SKILL_DESCRIPTION_LIMIT - 3)}...`
}

const locationServiceMapNode = LayerNode.make({
  service: LocationServiceMap.Service,
  layer: locationServiceMapLayer,
  deps: [],
})

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Skill.node, MCP.node, locationServiceMapNode],
})

export * as SystemPrompt from "./system"
