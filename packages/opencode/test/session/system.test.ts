import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import type { Agent } from "../../src/agent/agent"
import { NamedError } from "@opencode-ai/core/util/error"
import { Skill } from "../../src/skill"
import { Permission } from "../../src/permission"
import { SystemPrompt } from "../../src/session/system"
import type { Provider } from "../../src/provider/provider"
import { MCP } from "../../src/mcp"
import { LocationServiceMap, locationServiceMapLayer } from "@opencode-ai/core/location-services"
import { testEffect } from "../lib/effect"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"

const skills: Skill.Info[] = [
  {
    name: "zeta-skill",
    description: "Zeta skill.",
    location: "/tmp/zeta-skill/SKILL.md",
    content: "# zeta-skill",
  },
  {
    name: "alpha-skill",
    description: "Alpha skill.",
    descriptions: {
      "zh-CN": "Alpha 中文短描述",
      "en-US": "Alpha English short description",
    },
    location: "/tmp/alpha-skill/SKILL.md",
    content: "# alpha-skill",
  },
  {
    name: "middle-skill",
    description: "Middle skill.",
    location: "/tmp/middle-skill/SKILL.md",
    content: "# middle-skill",
  },
  {
    name: "manual-skill",
    location: "/tmp/manual-skill/SKILL.md",
    content: "# manual-skill",
  },
]

const build: Agent.Info = {
  name: "build",
  mode: "primary",
  permission: Permission.fromConfig({ "*": "allow" }),
  options: {},
}

function model(id: string): Provider.Model {
  return {
    id: ModelV2.ID.make(id),
    providerID: ProviderV2.ID.make("test"),
    api: {
      id,
      url: "https://example.com",
      npm: "@ai-sdk/openai",
    },
    name: id,
    capabilities: {
      attachment: false,
      temperature: true,
      toolcall: true,
      reasoning: false,
      input: {
        text: true,
        audio: false,
        image: false,
        video: false,
        pdf: false,
      },
      output: {
        text: true,
        audio: false,
        image: false,
        video: false,
        pdf: false,
      },
      interleaved: false,
    },
    cost: {
      input: 0,
      output: 0,
      cache: {
        read: 0,
        write: 0,
      },
    },
    limit: {
      context: 128000,
      output: 4096,
    },
    status: "active",
    options: {},
    headers: {},
    release_date: "2026-01-01",
  }
}

function skillServiceLayer(skillList: Skill.Info[]) {
  return Layer.succeed(
    Skill.Service,
    Skill.Service.of({
      get: (name) => Effect.succeed(skillList.find((skill) => skill.name === name)),
      require: (name) => {
        const info = skillList.find((skill) => skill.name === name)
        if (info) return Effect.succeed(info)
        return Effect.fail(new Skill.NotFoundError({ name, available: skillList.map((skill) => skill.name) }))
      },
      all: () => Effect.succeed(skillList),
      reload: () => Effect.succeed(skillList),
      dirs: () => Effect.succeed([]),
      available: () => Effect.succeed(skillList),
    }),
  )
}

const mcpTestLayer = Layer.mock(MCP.Service, {
  instructions: () =>
    Effect.succeed([
      {
        name: "guide-server",
        instructions: "Use lookup before mutate.",
        tools: [],
      },
      {
        name: "tool-server",
        instructions: "Prefer search before update.",
        tools: ["tool-server_search", "tool-server_update"],
      },
    ]),
})

function systemPromptTestLayer(skillList: Skill.Info[]) {
  return SystemPrompt.layer.pipe(
    Layer.provide(locationServiceMapLayer),
    Layer.provide(mcpTestLayer),
    Layer.provide(skillServiceLayer(skillList)),
  )
}

const it = testEffect(systemPromptTestLayer(skills))
const bulkSkills: Skill.Info[] = Array.from({ length: 55 }, (_, index) => ({
  name: `bulk-skill-${String(index + 1).padStart(2, "0")}`,
  description: `Bulk skill ${index + 1}.`,
  location: `/tmp/bulk-skill-${index + 1}/SKILL.md`,
  content: `# bulk-skill-${index + 1}`,
}))
const bulkIt = testEffect(systemPromptTestLayer(bulkSkills))

describe("session.system", () => {
  test("uses the English provider prompt by default", () => {
    expect(SystemPrompt.provider(model("gpt-5"))[0]).toContain("You are")
  })

  test("uses the Chinese provider prompt when prompt_language is zh", () => {
    expect(SystemPrompt.provider(model("gpt-5"), "zh")[0]).toContain("你是")
  })

  it.instance("omits the built-in environment details", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const output = yield* prompt.environment(model("gpt-5"), "zh")
      expect(output.join("\n")).not.toContain("当前环境")
      expect(output.join("\n")).not.toContain("Working directory")
      expect(output.join("\n")).not.toContain("当前目录")
    }),
  )

  it.effect("adds concise tool discovery guidance", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const zh = yield* prompt.toolDiscovery(build, "zh")
      const en = yield* prompt.toolDiscovery(build, "en")

      expect(zh).toContain("## 工具发现")
      expect(zh).toContain("以下专用工具已按需收起")
      expect(zh).toContain("`ai-scheduled-task-*`：创建、查询、暂停和删除定时任务")
      expect(zh).toContain("`knowledge-*`：检索知识库和表格")
      expect(zh).toContain("`email-*`：邮件查询与发送")
      expect(zh).toContain("`memory-*`：读取和保存长期记忆")
      expect(zh).not.toContain("网页搜索")
      expect(zh).toContain("先用 `tool_search` 按需求描述搜索")
      expect(zh).toContain("`select:<tool_id>`")
      expect(en).toContain("## Tool Discovery")
      expect(en).toContain("The following specialized tools are deferred until needed")
      expect(en).toContain("`ai-scheduled-task-*`: create, query, pause, and delete scheduled tasks")
      expect(en).toContain("`knowledge-*`: search knowledge bases and tables")
      expect(en).toContain("`email-*`: query and send email")
      expect(en).toContain("`memory-*`: read and save long-term memory")
      expect(en).not.toContain("web search")
      expect(en).toContain("search by intent with `tool_search`")
      expect(en).toContain("`select:<tool_id>`")
    }),
  )

  it.effect("omits tool discovery guidance when tool_search is denied", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const output = yield* prompt.toolDiscovery({
        ...build,
        permission: Permission.fromConfig({ "*": "allow", tool_search: "deny" }),
      }, "zh")

      expect(output).toBeUndefined()
    }),
  )

  it.effect("localizes lightweight skill index text when prompt_language is zh", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const output = yield* prompt.skills(build, "zh")
      expect(output).toContain("## 专项技能")
      expect(output).toContain("skill_search")
      expect(output).toContain("当前可用专项技能")
      expect(output).toContain("- alpha-skill: Alpha 中文短描述")
      expect(output).toContain("- manual-skill: 无描述。")
      expect(output).toContain("用户问完整技能/能力清单")
      expect(output).toContain("只用上方索引、用户输入或 `skill_search` 返回的精确 name")
      expect(output).toContain("不暴露内部 skill name")
      expect(output).not.toContain("<available_skills>")
      expect(output).not.toContain("/tmp/alpha-skill")
      expect(output).not.toContain("# alpha-skill")
    }),
  )

  it.effect("skills output renders lightweight index without dumping bodies or paths", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const first = yield* prompt.skills(build)
      const second = yield* prompt.skills(build)
      const output = first ?? (yield* Effect.fail(new NamedError.Unknown({ message: "missing skills output" })))

      expect(first).toBe(second)
      expect(output).toContain("## Specialized Skills")
      expect(output).toContain("skill_search")
      expect(output).toContain("Available specialized skills")
      expect(output).toContain("- alpha-skill: Alpha English short description")
      expect(output).toContain("- manual-skill: No description provided.")
      expect(output).toContain("the user asks for the full skill/capability list")
      expect(output).toContain("Call `skill` only with an exact name")
      expect(output).toContain("do not expose internal skill names unless asked")
      expect(output).not.toContain("<available_skills>")
      expect(output).not.toContain("/tmp/alpha-skill")
      expect(output).not.toContain("/tmp/zeta-skill")
      expect(output).not.toContain("# alpha-skill")
      expect(output).not.toContain("# manual-skill")
    }),
  )

  bulkIt.effect("skills output lists every available skill without truncation", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const output = yield* prompt.skills(build, "zh")

      expect(output).toContain("- bulk-skill-01: Bulk skill 1.")
      expect(output).toContain("- bulk-skill-55: Bulk skill 55.")
      expect(output).not.toContain("还有")
      expect(output).not.toContain("未列出")
      expect(output).not.toContain("more skills omitted")
    }),
  )

  it.effect("MCP output includes connected server instructions", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const output = yield* prompt.mcp(build)

      expect(output).toBe(
        [
          "## MCP Instructions",
          "### guide-server",
          "Use lookup before mutate.",
          "### tool-server",
          "Prefer search before update.",
        ].join("\n"),
      )
    }),
  )

  it.effect("MCP output omits servers when all advertised tools are denied", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const output = yield* prompt.mcp(build, Permission.fromConfig({ "tool-server_*": "deny" }))

      expect(output).toBe(
        [
          "## MCP Instructions",
          "### guide-server",
          "Use lookup before mutate.",
        ].join("\n"),
      )
    }),
  )
})
