import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Schema } from "effect"
import { MessageID, PartID, type SessionID } from "./schema"
import type { Session } from "./session"

export const TransferPart = Schema.Record(Schema.String, Schema.Unknown)
export const TransferMessage = Schema.Struct({
  id: Schema.optional(Schema.String),
  role: Schema.Literals(["user", "assistant", "system"]),
  content: Schema.Array(TransferPart),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  createdAt: Schema.optional(Schema.Finite),
})
export const SessionTransfer = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  source: Schema.Struct({
    astronSessionId: Schema.String,
    coreId: Schema.String,
    sessionId: Schema.String,
  }),
  title: Schema.optional(Schema.String),
  workspacePath: Schema.optional(Schema.String),
  persona: Schema.optional(Schema.String),
  transcript: Schema.Array(TransferMessage),
  createdAt: Schema.optional(Schema.Finite),
  updatedAt: Schema.optional(Schema.Finite),
})
export type SessionTransfer = typeof SessionTransfer.Type

const decodePart = Schema.decodeUnknownSync(SessionV1.Part)

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined
}

function number(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback
}

function jsonText(value: unknown, fallback = "") {
  if (typeof value === "string") return value
  return value === undefined ? fallback : JSON.stringify(value)
}

function nextMessageID(source: string | undefined, used: Set<string>) {
  const preferred = source?.startsWith("msg") && !used.has(source) ? source : undefined
  const id = MessageID.ascending(preferred)
  used.add(id)
  return id
}

function nextPartID(source: unknown, used: Set<string>) {
  const value = text(source)
  const preferred = value?.startsWith("prt") && !used.has(value) ? value : undefined
  const id = PartID.ascending(preferred)
  used.add(id)
  return id
}

function normalizeToolState(value: unknown, tool: string, createdAt: number) {
  const state = record(value) ?? {}
  const input = record(state.input) ?? {}
  const status = text(state.status)
  if (status === "completed") {
    const time = record(state.time)
    return {
      status,
      input,
      output: jsonText(state.output),
      title: text(state.title) ?? tool,
      metadata: record(state.metadata) ?? {},
      time: {
        start: number(time?.start, createdAt),
        end: number(time?.end, createdAt),
        ...(typeof time?.compacted === "number" ? { compacted: time.compacted } : {}),
      },
    }
  }
  if (status === "error") {
    const time = record(state.time)
    return {
      status,
      input,
      error: jsonText(state.error, "Imported tool failed"),
      metadata: record(state.metadata),
      time: { start: number(time?.start, createdAt), end: number(time?.end, createdAt) },
    }
  }
  if (status === "running") {
    const time = record(state.time)
    return {
      status,
      input,
      title: text(state.title),
      metadata: record(state.metadata),
      time: { start: number(time?.start, createdAt) },
    }
  }
  return { status: "pending" as const, input, raw: typeof state.raw === "string" ? state.raw : "" }
}

function nativePart(input: {
  source: Record<string, unknown>
  sessionID: SessionID
  messageID: MessageID
  createdAt: number
  used: Set<string>
}): SessionV1.Part {
  const { source, sessionID, messageID, createdAt, used } = input
  const id = nextPartID(source.id, used)
  const type = text(source.type)
  const base = { id, sessionID, messageID }
  if (type === "text") {
    return decodePart({ ...base, type, text: String(source.text ?? ""), metadata: record(source.metadata) }) as SessionV1.Part
  }
  if (type === "thought") {
    return decodePart({
      ...base,
      type: "reasoning",
      text: String(source.text ?? ""),
      metadata: record(source.metadata),
      time: { start: createdAt, end: createdAt },
    }) as SessionV1.Part
  }
  if (type === "file") {
    return decodePart({
      ...base,
      type,
      mime: text(source.mimeType) ?? "application/octet-stream",
      filename: text(source.name),
      url: text(source.uri) ?? "",
      source: record(source.source),
    }) as SessionV1.Part
  }
  if (type === "tool") {
    const tool = text(source.tool) ?? "imported_tool"
    return decodePart({
      ...base,
      type,
      callID: text(source.callID) ?? id,
      tool,
      state: normalizeToolState(source.state, tool, createdAt),
      metadata: record(source.metadata),
    }) as SessionV1.Part
  }
  return decodePart({ ...source, ...base }) as SessionV1.Part
}

export function toOpenCodeMessages(input: {
  transfer: SessionTransfer
  session: Session.Info
  defaultAgent: string
}): SessionV1.WithParts[] {
  const { transfer, session, defaultAgent } = input
  const messageIDs = new Set<string>()
  const partIDs = new Set<string>()
  const result: SessionV1.WithParts[] = []
  let parentID: MessageID | undefined
  const model = session.model ?? {
    providerID: ProviderV2.ID.make("imported"),
    id: ModelV2.ID.make("imported"),
  }
  for (const source of transfer.transcript) {
    const createdAt = number(source.createdAt, number(transfer.updatedAt, Date.now()))
    const id = nextMessageID(source.id, messageIDs)
    const metadata = source.metadata ?? {}
    if (source.role !== "assistant") {
      const info = SessionV1.User.make({
        id,
        sessionID: session.id,
        role: "user",
        time: { created: createdAt },
        agent: text(metadata.agent) ?? session.agent ?? defaultAgent,
        model: { providerID: model.providerID, modelID: model.id, variant: model.variant },
      }) as SessionV1.User
      const content =
        source.role === "system"
          ? [{ type: "text", text: `[System]\n${source.content.map((part) => text(part.text) ?? "").join("\n")}` }]
          : source.content
      const parts = content.map((part) =>
        nativePart({ source: part, sessionID: session.id, messageID: id, createdAt, used: partIDs }),
      )
      result.push({ info, parts })
      parentID = id
      continue
    }
    if (!parentID) {
      parentID = nextMessageID(undefined, messageIDs)
      result.push({
        info: SessionV1.User.make({
          id: parentID,
          sessionID: session.id,
          role: "user",
          time: { created: createdAt },
          agent: session.agent ?? defaultAgent,
          model: { providerID: model.providerID, modelID: model.id, variant: model.variant },
        }) as SessionV1.User,
        parts: [
          nativePart({
            source: { type: "text", text: "[Imported conversation]" },
            sessionID: session.id,
            messageID: parentID,
            createdAt,
            used: partIDs,
          }),
        ],
      })
    }
    const info = SessionV1.Assistant.make({
      id,
      sessionID: session.id,
      role: "assistant",
      time: { created: createdAt, completed: createdAt },
      parentID,
      modelID: model.id,
      providerID: model.providerID,
      mode: text(metadata.mode) ?? "build",
      agent: text(metadata.agent) ?? session.agent ?? defaultAgent,
      path: { cwd: session.directory, root: session.directory },
      summary: metadata.summary === true ? true : undefined,
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      finish: "stop",
    }) as SessionV1.Assistant
    result.push({
      info,
      parts: source.content.map((part) =>
        nativePart({ source: part, sessionID: session.id, messageID: id, createdAt, used: partIDs }),
      ),
    })
  }
  return result
}
