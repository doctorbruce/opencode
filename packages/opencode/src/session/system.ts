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
  readonly skills: (agent: Agent.Info, language?: PromptLanguage) => Effect.Effect<string | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SystemPrompt") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const skill = yield* Skill.Service

    return Service.of({
      environment: Effect.fn("SystemPrompt.environment")(function* (
        model: Provider.Model,
        language: PromptLanguage = "en",
      ) {
        const ctx = yield* InstanceState.context
        if (language === "zh")
          return [
            [
              `你正在使用的模型名称是 ${model.api.id}。精确模型 ID 是 ${model.providerID}/${model.api.id}`,
              `下面是当前环境的有用信息：`,
              `<env>`,
              `  当前目录: ${ctx.directory}`,
              `  工作区根目录: ${ctx.worktree}`,
              `  当前目录是否为 git repo: ${ctx.project.vcs === "git" ? "yes" : "no"}`,
              `  平台: ${process.platform}`,
              `  今天日期: ${new Date().toDateString()}`,
              `</env>`,
            ].join("\n"),
          ]
        return [
          [
            `You are powered by the model named ${model.api.id}. The exact model ID is ${model.providerID}/${model.api.id}`,
            `Here is some useful information about the environment you are running in:`,
            `<env>`,
            `  Working directory: ${ctx.directory}`,
            `  Workspace root folder: ${ctx.worktree}`,
            `  Is directory a git repo: ${ctx.project.vcs === "git" ? "yes" : "no"}`,
            `  Platform: ${process.platform}`,
            `  Today's date: ${new Date().toDateString()}`,
            `</env>`,
          ].join("\n"),
        ]
      }),

      skills: Effect.fn("SystemPrompt.skills")(function* (agent: Agent.Info, language: PromptLanguage = "en") {
        if (Permission.disabled(["skill"], agent.permission).has("skill")) return

        const list = yield* skill.available(agent)

        if (language === "zh")
          return [
            "技能提供面向特定任务的专门指令和工作流。",
            "当任务匹配某个技能描述时，使用 skill tool 加载该技能。",
            // the agents seem to ingest the information about skills a bit better if we present a more verbose
            // version of them here and a less verbose version in tool description, rather than vice versa.
            Skill.fmt(list, { verbose: true }),
          ].join("\n")

        return [
          "Skills provide specialized instructions and workflows for specific tasks.",
          "Use the skill tool to load a skill when a task matches its description.",
          // the agents seem to ingest the information about skills a bit better if we present a more verbose
          // version of them here and a less verbose version in tool description, rather than vice versa.
          Skill.fmt(list, { verbose: true }),
        ].join("\n")
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Skill.defaultLayer))

export * as SystemPrompt from "./system"
