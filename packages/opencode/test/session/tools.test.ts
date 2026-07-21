import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { selectModelFacingToolDefs, TOOL_SEARCH_TOOL_ID } from "../../src/session/tools"
import { Tool } from "../../src/tool/tool"

function toolDef(id: string, defer = false): Tool.Def {
  return {
    id,
    defer,
    description: `${id} description`,
    parameters: Schema.Struct({}),
    execute: () => Effect.succeed({ title: "", output: "", metadata: {} }),
  }
}

function completedToolSearch(...tools: string[]): SessionV1.WithParts {
  return {
    info: { role: "assistant" },
    parts: [
      {
        id: "part_1",
        type: "tool",
        tool: TOOL_SEARCH_TOOL_ID,
        callID: "call_1",
        state: {
          status: "completed",
          input: { query: "knowledge" },
          output: "",
          metadata: { tools },
          time: { start: 1, end: 2 },
        },
      },
    ],
  } as unknown as SessionV1.WithParts
}

describe("session tools", () => {
  test("hides deferred tools from the initial model-facing tool set", () => {
    const tools = [
      toolDef("read"),
      toolDef(TOOL_SEARCH_TOOL_ID),
      toolDef("search_knowledge", true),
      toolDef("query_table", true),
    ]

    expect(selectModelFacingToolDefs({ tools, messages: [] }).map((tool) => tool.id)).toEqual([
      "read",
      TOOL_SEARCH_TOOL_ID,
    ])
  })

  test("reveals deferred tools selected by a completed tool_search call", () => {
    const tools = [
      toolDef("read"),
      toolDef(TOOL_SEARCH_TOOL_ID),
      toolDef("search_knowledge", true),
      toolDef("query_table", true),
    ]

    expect(
      selectModelFacingToolDefs({ tools, messages: [completedToolSearch("search_knowledge")] }).map((tool) => tool.id),
    ).toEqual(["read", TOOL_SEARCH_TOOL_ID, "search_knowledge"])
  })
})
