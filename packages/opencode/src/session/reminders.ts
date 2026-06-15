import path from "path"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect } from "effect"
import { Agent } from "@/agent/agent"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { PartID } from "./schema"
import { MessageV2 } from "./message-v2"
import { Session } from "./session"
import PROMPT_PLAN from "./prompt/plan.txt"
import BUILD_SWITCH from "./prompt/build-switch.txt"
import PLAN_MODE from "./prompt/plan-mode.txt"
import PROMPT_PLAN_ZH from "./prompt-zh/plan.txt"
import BUILD_SWITCH_ZH from "./prompt-zh/build-switch.txt"
import PLAN_MODE_ZH from "./prompt-zh/plan-mode.txt"
import type { PromptLanguage } from "./system"

export const apply = Effect.fn("SessionReminders.apply")(function* (input: {
  messages: SessionV1.WithParts[]
  agent: Agent.Info
  session: Session.Info
  promptLanguage?: PromptLanguage
}) {
  const flags = yield* RuntimeFlags.Service
  const fsys = yield* FSUtil.Service
  const sessions = yield* Session.Service
  const promptPlan = input.promptLanguage === "zh" ? PROMPT_PLAN_ZH : PROMPT_PLAN
  const buildSwitch = input.promptLanguage === "zh" ? BUILD_SWITCH_ZH : BUILD_SWITCH
  const planMode = input.promptLanguage === "zh" ? PLAN_MODE_ZH : PLAN_MODE
  const userMessage = input.messages.findLast((msg) => msg.info.role === "user")
  if (!userMessage) return input.messages

  if (!flags.experimentalPlanMode) {
    if (input.agent.name === "plan") {
      userMessage.parts.push({
        id: PartID.ascending(),
        messageID: userMessage.info.id,
        sessionID: userMessage.info.sessionID,
        type: "text",
        text: promptPlan,
        synthetic: true,
      })
    }
    const wasPlan = input.messages.some((msg) => msg.info.role === "assistant" && msg.info.agent === "plan")
    if (wasPlan && input.agent.name === "build") {
      userMessage.parts.push({
        id: PartID.ascending(),
        messageID: userMessage.info.id,
        sessionID: userMessage.info.sessionID,
        type: "text",
        text: buildSwitch,
        synthetic: true,
      })
    }
    return input.messages
  }

  const assistantMessage = input.messages.findLast((msg) => msg.info.role === "assistant")
  if (input.agent.name !== "plan" && assistantMessage?.info.agent === "plan") {
    const ctx = yield* InstanceState.context
    const plan = Session.plan(input.session, ctx)
    const exists = yield* fsys.existsSafe(plan)
    const part = yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: userMessage.info.id,
      sessionID: userMessage.info.sessionID,
      type: "text",
      text: exists
        ? input.promptLanguage === "zh"
          ? `${buildSwitch}\n\n计划文件已存在于 ${plan}。你应该执行其中定义的计划。`
          : `${buildSwitch}\n\nA plan file exists at ${plan}. You should execute on the plan defined within it`
        : buildSwitch,
      synthetic: true,
    })
    userMessage.parts.push(part)
    return input.messages
  }

  if (input.agent.name !== "plan" || assistantMessage?.info.agent === "plan") return input.messages

  const ctx = yield* InstanceState.context
  const plan = Session.plan(input.session, ctx)
  const exists = yield* fsys.existsSafe(plan)
  if (!exists) yield* fsys.ensureDir(path.dirname(plan)).pipe(Effect.catch(Effect.die))
  const part = yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: userMessage.info.id,
    sessionID: userMessage.info.sessionID,
    type: "text",
    text: planMode.replace("${planInfo}", () =>
      input.promptLanguage === "zh"
        ? exists
          ? `计划文件已存在于 ${plan}。你可以读取它，并使用 edit tool 做增量修改。`
          : `尚无计划文件。你应该使用 write tool 在 ${plan} 创建计划。`
        : exists
          ? `A plan file already exists at ${plan}. You can read it and make incremental edits using the edit tool.`
          : `No plan file exists yet. You should create your plan at ${plan} using the write tool.`,
    ),
    synthetic: true,
  })
  userMessage.parts.push(part)
  return input.messages
})

export * as SessionReminders from "./reminders"
