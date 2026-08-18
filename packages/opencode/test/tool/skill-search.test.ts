import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Effect, Layer } from "effect"
import { afterEach, describe, expect } from "bun:test"
import path from "path"
import type { Tool } from "@/tool/tool"
import { SkillSearchTool } from "../../src/tool/skill-search"
import { ToolRegistry } from "@/tool/registry"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { SessionID, MessageID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

const baseCtx: Omit<Tool.Context, "ask"> = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
}

afterEach(async () => {
  await disposeAllInstances()
})

const node = CrossSpawnSpawner.defaultLayer

const it = testEffect(Layer.mergeAll(ToolRegistry.defaultLayer, node).pipe(Layer.provide(Ripgrep.defaultLayer)))

describe("tool.skill_search", () => {
  it.instance("returns matching skills without loading content or paths", () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      const review = path.join(dir, ".opencode", "skill", "review-skill")
      const deploy = path.join(dir, ".opencode", "skill", "deploy-skill")
      yield* writeSkill(review, "review-skill", "Review code changes before merging.")
      yield* writeSkill(deploy, "deploy-skill", "Deploy the project after release.")

      const home = process.env.OPENCODE_TEST_HOME
      process.env.OPENCODE_TEST_HOME = dir
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          process.env.OPENCODE_TEST_HOME = home
        }),
      )

      const registry = yield* ToolRegistry.Service
      const agent = { name: "build", mode: "primary" as const, permission: [], options: {} }
      const tool = (yield* registry.tools({
        providerID: ProviderV2.ID.opencode,
        modelID: ModelV2.ID.make("gpt-5"),
        agent,
      })).find((tool) => tool.id === SkillSearchTool.id)
      if (!tool) throw new Error("Skill search tool not found")

      const metadata: Array<{ title?: string; metadata?: Record<string, unknown> }> = []
      const result = yield* tool.execute(
        { query: "review-skill", limit: 1 },
        {
          ...baseCtx,
          metadata: (value) =>
            Effect.sync(() => {
              metadata.push(value)
            }),
          ask: (_req: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) => Effect.void,
        },
      )

      expect(result.title).toBe("Found 1 skill")
      expect(result.metadata.skills).toEqual(["review-skill"])
      expect(result.output).toContain("review-skill")
      expect(result.output).toContain("Review code changes before merging.")
      expect(result.output).not.toContain("deploy-skill")
      expect(result.output).not.toContain(review)
      expect(result.output).not.toContain("SKILL.md")
      expect(metadata[0]?.metadata?.skills).toEqual(["review-skill"])
    }),
  )

  it.instance("lists available skills for capability inventory questions", () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      yield* writeSkill(path.join(dir, ".opencode", "skill", "review-skill"), "review-skill", "Review code.")
      yield* writeSkill(path.join(dir, ".opencode", "skill", "deploy-skill"), "deploy-skill", "Deploy releases.")
      yield* writeSkill(path.join(dir, ".opencode", "skill", "docs-skill"), "docs-skill", "Write documentation.")
      yield* writeSkill(path.join(dir, ".opencode", "skill", "代码审查"), "代码审查", "审查代码变更。")
      yield* useTestHome(dir)

      const result = yield* executeSkillSearch({ query: "你有啥技能呀" })

      expect(result.metadata.skills).toContain("deploy-skill")
      expect(result.metadata.skills).toContain("docs-skill")
      expect(result.metadata.skills).toContain("review-skill")
      expect(result.metadata.skills).toContain("代码审查")
      expect(result.metadata.total).toBeGreaterThanOrEqual(3)
      expect(result.metadata.truncated).toBe(false)
      expect(result.output).toContain("Available skills:")
      expect(result.output).toContain("deploy-skill")
      expect(result.output).toContain("docs-skill")
      expect(result.output).toContain("review-skill")
      expect(result.output).toContain("代码审查")
    }),
  )

  it.instance("matches a Chinese skill name inside a natural-language query", () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      yield* writeSkill(path.join(dir, ".opencode", "skill", "代码审查"), "代码审查", "审查代码变更。")
      yield* writeSkill(path.join(dir, ".opencode", "skill", "部署发布"), "部署发布", "部署并发布项目。")
      yield* useTestHome(dir)

      const result = yield* executeSkillSearch({ query: "帮我使用代码审查技能" })

      expect(result.metadata.skills).toEqual(["代码审查"])
      expect(result.output).toContain("代码审查")
      expect(result.output).not.toContain("部署发布")
    }),
  )

  it.instance("matches any relevant query term instead of requiring every term", () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      yield* writeSkill(path.join(dir, ".opencode", "skill", "review-skill"), "review-skill", "Review code changes.")
      yield* writeSkill(path.join(dir, ".opencode", "skill", "deploy-skill"), "deploy-skill", "Deploy release builds.")
      yield* useTestHome(dir)

      const result = yield* executeSkillSearch({ query: "review release" })

      expect(result.metadata.skills).toContain("review-skill")
      expect(result.metadata.skills).toContain("deploy-skill")
      expect(result.output).toContain("review-skill")
      expect(result.output).toContain("deploy-skill")
    }),
  )
})

function useTestHome(dir: string) {
  const home = process.env.OPENCODE_TEST_HOME
  process.env.OPENCODE_TEST_HOME = dir
  return Effect.addFinalizer(() =>
    Effect.sync(() => {
      process.env.OPENCODE_TEST_HOME = home
    }),
  )
}

function executeSkillSearch(input: { query: string; limit?: number }) {
  return Effect.gen(function* () {
    const registry = yield* ToolRegistry.Service
    const agent = { name: "build", mode: "primary" as const, permission: [], options: {} }
    const tool = (yield* registry.tools({
      providerID: ProviderV2.ID.opencode,
      modelID: ModelV2.ID.make("gpt-5"),
      agent,
    })).find((tool) => tool.id === SkillSearchTool.id)
    if (!tool) throw new Error("Skill search tool not found")
    return yield* tool.execute(input, {
      ...baseCtx,
      ask: (_req: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) => Effect.void,
    })
  })
}

function writeSkill(dir: string, name: string, description: string) {
  return Effect.promise(() =>
    Bun.write(
      path.join(dir, "SKILL.md"),
      `---
name: ${name}
description: ${description}
---

# ${name}

Hidden body.
`,
    ),
  )
}
