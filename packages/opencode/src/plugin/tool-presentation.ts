import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin"

export const PRESENTATION_SIDECAR_KEY = "astronActivityTitle"

const MAX_TITLE_LENGTH = 80
const PRESENTATION_DESCRIPTION = [
  "UI-only activity title for this tool call; the schema keeps it optional for compatibility.",
  "Provide it on every call as a short user-visible title in the user's language that describes the intent, not the implementation.",
  "Do not include raw commands, technical tool names, URLs, or file paths already present in other arguments.",
].join(" ")

const TITLE_DESCRIPTION = [
  "Short user-visible activity title describing why this tool is being used.",
  "Use the user's language and an action phrase.",
  "Do not include raw commands or technical tool names; do not repeat URLs or file paths already present in other arguments.",
].join(" ")

const PRESENTATION_SYSTEM_INSTRUCTION = [
  "For every tool call, always provide the UI-only activity title argument described below.",
  `Set ${PRESENTATION_SIDECAR_KEY} to a short user-visible action phrase in the user's language that describes the intent, not the implementation.`,
  "Do not include raw commands, technical tool names, credentials, URLs, or file paths already present in other arguments.",
].join(" ")

type JsonRecord = Record<string, unknown>

export type PresentationSidecar = {
  title: string
}

type PresentationHookOptions = {
  persistPresentationPart?: (part: ToolPart, presentation: PresentationSidecar) => Promise<void>
}

type ToolDefinitionOutput = {
  description: string
  parameters: unknown
  jsonSchema?: unknown
}

type ToolPart = {
  id: string
  sessionID: string
  messageID: string
  type: "tool"
  callID: string
  tool: string
  state: JsonRecord
}

type PresentationPatch = {
  presentation: PresentationSidecar
  restorePart?: ToolPart
}

export function createToolPresentationHooks(options: PresentationHookOptions = {}) {
  const presentations = new Map<string, PresentationSidecar>()
  const toolParts = new Map<string, ToolPart>()
  const patches = new Map<string, PresentationPatch>()

  function trimIndexes() {
    const maxTrackedCalls = 2048
    if (toolParts.size <= maxTrackedCalls) return
    for (const key of [...toolParts.keys()].slice(0, maxTrackedCalls / 2)) {
      if (patches.has(key)) continue
      toolParts.delete(key)
      presentations.delete(key)
    }
  }

  function startPresentationPatch(key: string, part: ToolPart, presentation: PresentationSidecar) {
    if (!options.persistPresentationPart || patches.has(key)) return
    if (presentationTitleFromPart(part) === presentation.title) return

    const patch: PresentationPatch = { presentation }
    patches.set(key, patch)
    void options
      .persistPresentationPart(part, presentation)
      .catch(() => {
        // Presentation is progressive enhancement. Persistence failures never block or fail the real tool.
      })
      .finally(() => {
        const restorePart = patch.restorePart
        if (!restorePart) {
          patches.delete(key)
          return
        }

        // A very fast tool may complete while the running-state PATCH is in flight. Reapply the
        // terminal snapshot after that PATCH settles so presentation metadata cannot regress state.
        void options
          .persistPresentationPart?.(restorePart, patch.presentation)
          .catch(() => {})
          .finally(() => {
            patches.delete(key)
            toolParts.delete(key)
            presentations.delete(key)
          })
      })
  }

  function persistIndexedRunningPresentation(key: string) {
    const part = toolParts.get(key)
    const presentation = presentations.get(key)
    if (!part || !presentation || !isRunningToolPart(part)) return
    startPresentationPatch(key, part, presentation)
  }

  return {
    async "experimental.chat.system.transform"(
      _input: { sessionID?: string; model: unknown },
      output: { system: string[] },
    ) {
      if (!output.system.some((item) => item.includes(PRESENTATION_SIDECAR_KEY))) {
        output.system.push(PRESENTATION_SYSTEM_INSTRUCTION)
      }
    },

    async "tool.definition"(_input: { toolID: string }, output: ToolDefinitionOutput) {
      addPresentationSidecar(output)
    },

    async "tool.execute.before"(input: { tool: string; sessionID: string; callID: string }, output: { args: unknown }) {
      const presentation = takePresentation(output.args)
      if (!presentation) return
      const key = callKey(input.sessionID, input.callID)
      presentations.set(key, presentation)
      const indexedPart = toolParts.get(key)
      // Most tools publish a pending part before this hook and a running part immediately after it.
      // Only patch an already-running part here; otherwise the event hook will use the fresher snapshot.
      if (indexedPart?.state.status === "running") persistIndexedRunningPresentation(key)
    },

    async "tool.execute.after"(
      input: { tool: string; sessionID: string; callID: string; args: unknown },
      output: JsonRecord,
    ) {
      const key = callKey(input.sessionID, input.callID)
      const presentation = presentations.get(key)
      if (presentation) mergePresentationMetadata(output, presentation)
      if (!patches.has(key)) {
        presentations.delete(key)
        toolParts.delete(key)
      }
    },

    async event(input: { event: { type?: string; properties?: unknown } }) {
      if (input.event.type !== "message.part.updated" || !isRecord(input.event.properties)) return
      const part = input.event.properties.part
      if (!isToolPart(part)) return
      const key = callKey(part.sessionID, part.callID)
      const status = part.state.status
      if (status === "completed" || status === "error" || status === "cancelled" || status === "canceled") {
        const patch = patches.get(key)
        if (patch) patch.restorePart = part
        if (!patch) {
          presentations.delete(key)
          toolParts.delete(key)
        }
        return
      }
      if (!isRunningToolPart(part)) return
      toolParts.set(key, part)
      trimIndexes()
      persistIndexedRunningPresentation(key)
    },
  }
}

export const ToolPresentationPlugin: Plugin = async ({ client }) =>
  createToolPresentationHooks({
    persistPresentationPart: (part, presentation) => persistPresentationPart(client, part, presentation),
  }) as Hooks

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function isToolPart(value: unknown): value is ToolPart {
  return (
    isRecord(value) &&
    value.type === "tool" &&
    typeof value.id === "string" &&
    typeof value.sessionID === "string" &&
    typeof value.messageID === "string" &&
    typeof value.callID === "string" &&
    typeof value.tool === "string" &&
    isRecord(value.state)
  )
}

function presentationParameterSchema() {
  return {
    type: "string",
    minLength: 1,
    maxLength: MAX_TITLE_LENGTH,
    description: TITLE_DESCRIPTION,
  }
}

function jsonSchemaObject(output: ToolDefinitionOutput): JsonRecord | null {
  if (isRecord(output.jsonSchema)) return output.jsonSchema
  if (isRecord(output.parameters) && (output.parameters.type === "object" || isRecord(output.parameters.properties))) {
    return output.parameters
  }
  return null
}

function addPresentationSidecar(output: ToolDefinitionOutput) {
  const schema = jsonSchemaObject(output)
  if (!schema) return
  const properties = isRecord(schema.properties) ? schema.properties : {}
  const extended = {
    ...schema,
    properties: {
      ...properties,
      [PRESENTATION_SIDECAR_KEY]: presentationParameterSchema(),
    },
    ...(Array.isArray(schema.required)
      ? { required: schema.required.filter((key) => key !== PRESENTATION_SIDECAR_KEY) }
      : {}),
  }
  const usesJsonSchema = schema === output.jsonSchema
  if (usesJsonSchema) output.jsonSchema = extended
  if (!usesJsonSchema) output.parameters = extended

  if (!output.description.includes(PRESENTATION_SIDECAR_KEY)) {
    output.description = `${output.description}\n\n${PRESENTATION_DESCRIPTION} Set ${PRESENTATION_SIDECAR_KEY} on every call.`
  }
}

function takePresentation(args: unknown): PresentationSidecar | null {
  if (!isRecord(args)) return null
  const raw = args[PRESENTATION_SIDECAR_KEY]
  delete args[PRESENTATION_SIDECAR_KEY]
  if (typeof raw !== "string") return null
  const title = raw.trim().slice(0, MAX_TITLE_LENGTH)
  return title ? { title } : null
}

function callKey(sessionID: string, callID: string) {
  return `${sessionID}\u0000${callID}`
}

function mergePresentationMetadata(output: JsonRecord, presentation: PresentationSidecar) {
  const metadata = isRecord(output.metadata) ? output.metadata : {}
  const existing = isRecord(metadata.presentation) ? metadata.presentation : {}
  output.metadata = {
    ...metadata,
    presentation: {
      ...existing,
      title: presentation.title,
    },
  }
}

function presentationTitleFromPart(part: ToolPart) {
  const metadata = isRecord(part.state.metadata) ? part.state.metadata : {}
  const presentation = isRecord(metadata.presentation) ? metadata.presentation : {}
  return typeof presentation.title === "string" ? presentation.title.trim() : ""
}

function isRunningToolPart(part: ToolPart) {
  return part.state.status === "pending" || part.state.status === "running"
}

async function persistPresentationPart(
  client: PluginInput["client"],
  part: ToolPart,
  presentation: PresentationSidecar,
) {
  const metadata = isRecord(part.state.metadata) ? part.state.metadata : {}
  const existingPresentation = isRecord(metadata.presentation) ? metadata.presentation : {}
  const stateInput = isRecord(part.state.input) ? { ...part.state.input } : part.state.input
  if (isRecord(stateInput)) delete stateInput[PRESENTATION_SIDECAR_KEY]
  const nextPart: ToolPart = {
    ...part,
    state: {
      ...part.state,
      input: stateInput,
      metadata: {
        ...metadata,
        presentation: {
          ...existingPresentation,
          title: presentation.title,
        },
      },
    },
  }

  type CoreClient = {
    patch: (options: JsonRecord) => Promise<unknown>
  }
  const coreClient = (client as unknown as { _client?: CoreClient })._client
  if (!coreClient) return
  await coreClient.patch({
    url: "/session/{sessionID}/message/{messageID}/part/{partID}",
    path: {
      sessionID: part.sessionID,
      messageID: part.messageID,
      partID: part.id,
    },
    body: nextPart,
    headers: {
      "Content-Type": "application/json",
    },
  })
}
