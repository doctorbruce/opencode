import { describe, expect, test } from "bun:test"
import {
  PRESENTATION_SIDECAR_KEY,
  ToolPresentationPlugin,
  createToolPresentationHooks,
} from "@/plugin/tool-presentation"

describe("built-in tool presentation plugin", () => {
  test("adds an optional semantic title to the model-facing tool schema", async () => {
    const hooks = createToolPresentationHooks()
    const system = { system: ["Existing system prompt"] }
    const parameters = { effectSchema: true }
    const originalSchema = {
      type: "object",
      additionalProperties: false,
      properties: { url: { type: "string" } },
      required: ["url"],
    }
    const definition = {
      description: "Fetch a URL",
      parameters,
      jsonSchema: originalSchema,
    }

    await hooks["experimental.chat.system.transform"]({ sessionID: "session-1", model: {} }, system)
    await hooks["tool.definition"]({ toolID: "webfetch" }, definition)

    expect(system.system[1]).toContain(`Set ${PRESENTATION_SIDECAR_KEY}`)
    expect(system.system[1]).toContain("Do not include raw commands")
    expect(definition.jsonSchema).not.toBe(originalSchema)
    expect(definition.jsonSchema).toMatchObject({
      properties: {
        [PRESENTATION_SIDECAR_KEY]: {
          type: "string",
          minLength: 1,
          maxLength: 80,
        },
      },
      required: ["url"],
    })
    expect(originalSchema.properties).not.toHaveProperty(PRESENTATION_SIDECAR_KEY)
    expect(parameters).toEqual({ effectSchema: true })
  })

  test("removes the UI-only title before execution and persists it in result metadata", async () => {
    const hooks = createToolPresentationHooks()
    const args: Record<string, unknown> = {
      url: "https://react.dev/learn",
      [PRESENTATION_SIDECAR_KEY]: "读取 React 入门指南",
    }

    await hooks["tool.execute.before"]({ tool: "webfetch", sessionID: "session-1", callID: "call-1" }, { args })
    const output: { output: string; metadata: Record<string, unknown> } = {
      output: "React documentation",
      metadata: { url: "https://react.dev/learn", status: 200 },
    }
    await hooks["tool.execute.after"]({ tool: "webfetch", sessionID: "session-1", callID: "call-1", args }, output)

    expect(args).toEqual({ url: "https://react.dev/learn" })
    expect(output.metadata).toEqual({
      url: "https://react.dev/learn",
      status: 200,
      presentation: { title: "读取 React 入门指南" },
    })
  })

  test("keeps title input optional and drops blank presentation values", async () => {
    const hooks = createToolPresentationHooks()
    const withoutTitle: Record<string, unknown> = { query: "React" }
    const blankTitle: Record<string, unknown> = {
      query: "Effect",
      [PRESENTATION_SIDECAR_KEY]: "   ",
    }

    await hooks["tool.execute.before"](
      { tool: "search", sessionID: "session-1", callID: "call-without-title" },
      { args: withoutTitle },
    )
    await hooks["tool.execute.before"](
      { tool: "search", sessionID: "session-1", callID: "call-blank-title" },
      { args: blankTitle },
    )

    expect(withoutTitle).toEqual({ query: "React" })
    expect(blankTitle).toEqual({ query: "Effect" })
  })

  test("patches the indexed running part without scanning session history", async () => {
    let sessionReadCount = 0
    const patches: unknown[] = []
    const hooks = await ToolPresentationPlugin({
      client: {
        session: {
          messages: async () => {
            sessionReadCount += 1
          },
        },
        _client: {
          patch: async (input: unknown) => {
            patches.push(input)
          },
        },
      },
    } as never)
    const identity = {
      id: "part-1",
      sessionID: "session-1",
      messageID: "message-1",
      type: "tool",
      callID: "call-1",
      tool: "webfetch",
    }
    await hooks.event?.({
      event: {
        type: "message.part.updated",
        properties: { part: { ...identity, state: { status: "pending", input: {} } } },
      },
    } as never)
    const args: Record<string, unknown> = {
      url: "https://react.dev/learn",
      [PRESENTATION_SIDECAR_KEY]: "读取 React 入门指南",
    }

    await hooks["tool.execute.before"]?.({ tool: "webfetch", sessionID: "session-1", callID: "call-1" }, { args })
    await hooks.event?.({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            ...identity,
            state: {
              status: "running",
              input: {
                url: "https://react.dev/learn",
                [PRESENTATION_SIDECAR_KEY]: "读取 React 入门指南",
              },
            },
          },
        },
      },
    } as never)

    expect(sessionReadCount).toBe(0)
    expect(args).toEqual({ url: "https://react.dev/learn" })
    expect(patches).toHaveLength(1)
    expect(patches[0]).toMatchObject({
      path: { sessionID: "session-1", messageID: "message-1", partID: "part-1" },
      body: {
        state: {
          status: "running",
          input: { url: "https://react.dev/learn" },
          metadata: { presentation: { title: "读取 React 入门指南" } },
        },
      },
    })
  })

  test("restores a terminal snapshot that arrives during a running-state patch", async () => {
    const persisted: Array<{ part: { state: Record<string, unknown> }; title: string }> = []
    let finishRunningPatch: (() => void) | undefined
    const hooks = createToolPresentationHooks({
      persistPresentationPart: async (part, presentation) => {
        persisted.push({ part, title: presentation.title })
        if (persisted.length !== 1) return
        await new Promise<void>((resolve) => {
          finishRunningPatch = resolve
        })
      },
    })
    const identity = {
      id: "part-fast",
      sessionID: "session-fast",
      messageID: "message-fast",
      type: "tool" as const,
      callID: "call-fast",
      tool: "webfetch",
    }
    await hooks.event({
      event: {
        type: "message.part.updated",
        properties: {
          part: { ...identity, state: { status: "running", input: { url: "https://example.com" } } },
        },
      },
    })
    await hooks["tool.execute.before"](
      { tool: "webfetch", sessionID: "session-fast", callID: "call-fast" },
      { args: { url: "https://example.com", [PRESENTATION_SIDECAR_KEY]: "读取示例页面" } },
    )
    await hooks.event({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            ...identity,
            state: {
              status: "completed",
              input: { url: "https://example.com" },
              output: "Example",
              metadata: { presentation: { title: "读取示例页面" } },
            },
          },
        },
      },
    })

    expect(persisted).toHaveLength(1)
    finishRunningPatch?.()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(persisted).toHaveLength(2)
    expect(persisted[1]?.part.state.status).toBe("completed")
    expect(persisted[1]?.title).toBe("读取示例页面")
  })
})
