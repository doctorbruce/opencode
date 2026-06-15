import type {
  AgentSideConnection,
  PermissionOption,
  RequestPermissionResponse,
  ToolCallLocation,
} from "@agentclientprotocol/sdk"
import type { Event, OpencodeClient } from "@opencode-ai/sdk/v2"
import { applyPatch } from "diff"
import { exists, readText } from "@/util/filesystem"
import type { ACPSession } from "./session"
import { toLocations, toToolKind, type ToolInput } from "./tool"
import { Effect } from "effect"

type PermissionEvent = Extract<Event, { type: "permission.asked" }>
type Reply = "once" | "always" | "reject"
type Connection = Partial<Pick<AgentSideConnection, "requestPermission" | "writeTextFile">>
type PermissionDisplay = {
  uiKind?: string
  title?: string
  toolCallId?: string
  rawInput?: unknown
  locations?: Array<Record<string, unknown>>
  previewCard?: unknown
  formSchema?: unknown
}

const permissionOptions: PermissionOption[] = [
  { optionId: "once", kind: "allow_once", name: "Allow once" },
  { optionId: "always", kind: "allow_always", name: "Always allow" },
  { optionId: "reject", kind: "reject_once", name: "Reject" },
]

export class Handler {
  private readonly queues = new Map<string, Promise<void>>()

  constructor(
    private readonly input: {
      sdk: OpencodeClient
      connection: Connection
      session: ACPSession.Interface
    },
  ) {}

  handle(event: PermissionEvent) {
    const permission = event.properties
    const previous = this.queues.get(permission.sessionID) ?? Promise.resolve()
    const next = previous
      .then(() => this.process(event))
      .catch(() => {})
      .finally(() => {
        if (this.queues.get(permission.sessionID) === next) {
          this.queues.delete(permission.sessionID)
        }
      })
    this.queues.set(permission.sessionID, next)
  }

  private async process(event: PermissionEvent) {
    const permission = event.properties
    const session = await Effect.runPromise(this.input.session.tryGet(permission.sessionID))
    if (!session) return

    if (!this.input.connection.requestPermission) {
      await this.reply(permission.id, "reject", session.cwd)
      return
    }

    const display = permissionDisplay(permission)
    const result = await this.input.connection
      .requestPermission({
        sessionId: permission.sessionID,
        toolCall: {
          toolCallId: displayString(display.toolCallId) ?? permission.tool?.callID ?? permission.id,
          status: "pending",
          title: displayString(display.title) ?? permission.permission,
          rawInput: display.rawInput ?? permission.metadata,
          kind: toToolKind(permission.permission),
          locations: displayLocations(display.locations) ?? toLocations(permission.permission, permission.metadata),
        },
        options: permissionOptions,
      })
      .catch(async () => {
        await this.reply(permission.id, "reject", session.cwd)
        return undefined
      })

    if (!result) return

    const reply = selectedReply(result)
    if (reply !== "once" && reply !== "always") {
      await this.reply(permission.id, "reject", session.cwd)
      return
    }

    if (permission.permission === "edit") {
      await this.writeProposedEdit(session.id, permission.metadata).catch(() => {})
    }

    await this.reply(permission.id, reply, session.cwd)
  }

  private async reply(requestID: string, reply: Reply, directory: string) {
    await this.input.sdk.permission.reply({
      requestID,
      reply,
      directory,
    })
  }

  private async writeProposedEdit(sessionId: string, metadata: ToolInput) {
    const filepath = stringValue(metadata.filepath)
    const diff = stringValue(metadata.diff)
    if (!filepath || !diff || !this.input.connection.writeTextFile) return

    const content = (await exists(filepath)) ? await readText(filepath) : ""
    const next = applyPatch(content, diff)
    if (next === false) {
      return
    }

    void this.input.connection.writeTextFile({
      sessionId,
      path: filepath,
      content: next,
    })
  }
}

function selectedReply(result: RequestPermissionResponse): Reply {
  if (result.outcome.outcome !== "selected") return "reject"
  if (result.outcome.optionId === "once" || result.outcome.optionId === "always") return result.outcome.optionId
  return "reject"
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined
}

function displayString(value: unknown) {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

function displayLocations(locations: PermissionDisplay["locations"]): ToolCallLocation[] | undefined {
  if (!locations) return undefined
  return locations.flatMap((location): ToolCallLocation[] => {
    const path = displayString(location.path)
    return path ? [{ path }] : []
  })
}

function permissionDisplay(permission: PermissionEvent["properties"]): PermissionDisplay {
  const display = (permission as PermissionEvent["properties"] & { display?: unknown }).display
  if (!display || typeof display !== "object") return {}
  return display as PermissionDisplay
}

export * as ACPPermission from "./permission"
