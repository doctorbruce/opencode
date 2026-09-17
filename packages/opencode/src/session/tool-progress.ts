export * as ToolProgress from "./tool-progress"

import { isRecord } from "@/util/record"

/**
 * Activity clock and silence supervision for running local tool calls.
 *
 * The clock is refreshed by every real tool activity event (tool output, title
 * change, streamed input) through the session processor's `updateToolCall`. The
 * heartbeat itself must never refresh the clock, otherwise the silence window
 * could never expire.
 *
 * Progress is published on the tool part as `state.metadata.progress`, so it
 * rides the existing `message.part.updated` surface that clients already read.
 * The silence cap is deliberately limited to shell-like tools: killing a tool
 * that is legitimately quiet for minutes would be worse than waiting.
 */

export type Health = "ok" | "quiet" | "possibly_stalled" | "silence_timeout"
export type RuntimeActivity = "busy" | "waiting" | "idle"

export interface Progress {
  readonly message: string
  readonly health: Health
  readonly quietMs: number
  readonly elapsedMs: number
  readonly lastActivityAt: number
  readonly runtimeActivity: RuntimeActivity
}

export interface SilenceReason {
  readonly kind: "silence_timeout"
  readonly quietMs: number
  readonly silenceMs: number
  readonly elapsedMs: number
  readonly lastActivityAt: number
  readonly runtimeActivity: RuntimeActivity
}

export interface Control {
  readonly abort: (reason: SilenceReason) => void
}

export interface Decision {
  readonly callID: string
  readonly progress: Progress
  /** First tick past the silence cap: abort this call through its registered control. */
  readonly escalate?: SilenceReason
  /** The tool ignored the abort for a full grace window: settle it from the loop. */
  readonly forceSettle?: SilenceReason
}

const HEARTBEAT_MS_DEFAULT = 60_000
const SILENCE_MS_DEFAULT = 300_000
const SILENCE_GRACE_MS_DEFAULT = 60_000

const QUIET_MS_SHORT = 60_000
const QUIET_MS_LONG = 180_000
const QUIET_MS_DEFAULT = 120_000
const STALLED_QUIET_COUNT = 3

const SHORT_TOOLS = new Set(["edit", "modify", "multiedit", "multi_edit", "patch", "apply_patch", "read", "write"])
const LONG_TOOLS = new Set(["bash", "shell", "install", "npm", "pnpm", "task", "test", "uv", "agent"])
const SILENCE_TOOLS = new Set(["bash", "shell"])

const envMs = (name: string, fallback: number) => {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === "") return fallback
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback
}

/** Heartbeat cadence. Also the unit of `quietCount`. */
export const heartbeatMs = () => envMs("AMIO_TOOL_PROGRESS_HEARTBEAT_MS", HEARTBEAT_MS_DEFAULT)
/** Silence cap for shell-like tools. `0` disables the cap. */
export const silenceMs = () => envMs("AMIO_TOOL_PROGRESS_SILENCE_MS", SILENCE_MS_DEFAULT)
/** How long a call may ignore its abort before the loop settles it. */
export const silenceGraceMs = () => envMs("AMIO_TOOL_PROGRESS_SILENCE_GRACE_MS", SILENCE_GRACE_MS_DEFAULT)

type Entry = {
  sessionID: string
  callID: string
  tool: string
  startedAt: number
  lastActivityAt: number
  quietCount: number
  escalatedAt?: number
  silence?: SilenceReason
  control?: Control
}

const active = new Map<string, Entry>()

/** Registers a running call. Called by the tool wrapper before execution starts. */
export const track = (input: { sessionID: string; callID: string; tool: string; now?: number }) => {
  const now = input.now ?? Date.now()
  active.set(input.callID, {
    sessionID: input.sessionID,
    callID: input.callID,
    tool: input.tool.toLowerCase(),
    startedAt: now,
    lastActivityAt: now,
    quietCount: 0,
  })
}

/** Records real tool activity. Never call this from the heartbeat itself. */
export const refresh = (callID: string, now = Date.now()) => {
  const entry = active.get(callID)
  if (!entry) return
  entry.lastActivityAt = now
  entry.quietCount = 0
}

/** Links a per-call controller to the request signal and returns the tool-visible signal. */
export const linkAbort = (parent: AbortSignal | undefined, controller: AbortController) => {
  if (!parent) return controller.signal
  if (parent.aborted) {
    controller.abort(parent.reason)
    return controller.signal
  }
  parent.addEventListener("abort", () => controller.abort(parent.reason), { once: true })
  return controller.signal
}

export const control = (callID: string, value: Control) => {
  const entry = active.get(callID)
  if (!entry) return
  entry.control = value
}

export const escalation = (callID: string) => active.get(callID)?.silence

export const settle = (callID: string) => {
  active.delete(callID)
}

export const clearSession = (sessionID: string) => {
  for (const [callID, entry] of active) {
    if (entry.sessionID === sessionID) active.delete(callID)
  }
}

export const tracking = (sessionID: string) => {
  for (const entry of active.values()) {
    if (entry.sessionID === sessionID) return true
  }
  return false
}

/** Test seam: drops all tracked calls. */
export const reset = () => active.clear()

export const abort = (callID: string, reason: SilenceReason) => {
  active.get(callID)?.control?.abort(reason)
}

/**
 * Advances every tracked call of one session and reports what the caller must
 * publish or enforce. Mutates heartbeat bookkeeping only.
 */
export const tick = (input: {
  sessionID: string
  activity: RuntimeActivity
  now?: number
  silenceMs?: number
  graceMs?: number
}): ReadonlyArray<Decision> => {
  const now = input.now ?? Date.now()
  const limit = input.silenceMs ?? silenceMs()
  const grace = input.graceMs ?? silenceGraceMs()
  const decisions: Decision[] = []
  for (const entry of active.values()) {
    if (entry.sessionID !== input.sessionID) continue
    const quietMs = Math.max(0, now - entry.lastActivityAt)
    const elapsedMs = Math.max(0, now - entry.startedAt)
    entry.quietCount = quietMs >= quietMsFor(entry.tool) ? entry.quietCount + 1 : 0
    const health = healthFor(entry.quietCount, input.activity)
    const progress: Progress = {
      message: messageFor(health, quietMs, input.activity),
      health,
      quietMs,
      elapsedMs,
      lastActivityAt: entry.lastActivityAt,
      runtimeActivity: input.activity,
    }
    const reason: SilenceReason = {
      kind: "silence_timeout",
      quietMs,
      silenceMs: limit,
      elapsedMs,
      lastActivityAt: entry.lastActivityAt,
      runtimeActivity: input.activity,
    }
    const eligible = limit > 0 && SILENCE_TOOLS.has(entry.tool)
    if (!eligible || quietMs < limit) {
      decisions.push({ callID: entry.callID, progress })
      continue
    }
    if (entry.escalatedAt === undefined) {
      entry.escalatedAt = now
      entry.silence = reason
      decisions.push({ callID: entry.callID, progress, escalate: reason })
      continue
    }
    if (now - entry.escalatedAt < grace) {
      decisions.push({ callID: entry.callID, progress })
      continue
    }
    entry.silence = reason
    decisions.push({ callID: entry.callID, progress, forceSettle: reason })
  }
  return decisions
}

/** Progress entry describing a call the loop cancelled for silence. */
export const silenceProgress = (reason: SilenceReason): Progress => ({
  message: `长时间没有新输出，已终止本次调用（静默 ${formatDuration(reason.quietMs)}）`,
  health: "silence_timeout",
  quietMs: reason.quietMs,
  elapsedMs: reason.elapsedMs,
  lastActivityAt: reason.lastActivityAt,
  runtimeActivity: reason.runtimeActivity,
})

export const SILENCE_NOTICE_PREFIX = "[amio:silence-timeout]"

export const isSilenceReason = (value: unknown): value is SilenceReason =>
  isRecord(value) && value.kind === "silence_timeout"

/**
 * Drops a trailing shell metadata block. The shell renders any abort as
 * "User aborted the command", which contradicts the silence notice we prepend.
 */
export const stripShellMetadata = (value: string | undefined) =>
  (value ?? "").replace(/\n*<shell_metadata>[\s\S]*?<\/shell_metadata>\s*$/, "")

export const silenceNotice = (reason: SilenceReason) =>
  `${SILENCE_NOTICE_PREFIX} No output for ${formatDuration(reason.quietMs)} (silence limit ${formatDuration(
    reason.silenceMs,
  )}); the command was cancelled. If it legitimately stays quiet that long, rerun it with explicit progress output (periodic echo/log) or split it into shorter steps.`

/** Rewrites a finished tool result into the model-visible silence outcome. */
export const silenceResult = <A extends { metadata: Record<string, any>; output: string }>(
  result: A,
  reason: SilenceReason,
): A => ({
  ...result,
  output: `${silenceNotice(reason)}\n\n${
    tail(stripShellMetadata(result.output)) || "(no output before cancellation)"
  }`,
  metadata: {
    ...result.metadata,
    timeout: true,
    silence: { quietMs: reason.quietMs, silenceMs: reason.silenceMs },
    progress: silenceProgress(reason),
  },
})

export const tail = (value: string | undefined, limit = 4_000) => {
  const text = value?.trim() ?? ""
  if (text.length <= limit) return text
  return `...${text.slice(-limit)}`
}

export const outputTail = (value: unknown) => {
  if (typeof value === "string") return tail(value)
  if (isRecord(value) && typeof value.output === "string") return tail(value.output)
  return ""
}

const quietMsFor = (tool: string) => {
  if (LONG_TOOLS.has(tool)) return QUIET_MS_LONG
  if (SHORT_TOOLS.has(tool)) return QUIET_MS_SHORT
  return QUIET_MS_DEFAULT
}

const healthFor = (quietCount: number, activity: RuntimeActivity): Health => {
  if (quietCount >= STALLED_QUIET_COUNT && activity === "idle") return "possibly_stalled"
  if (quietCount > 0) return "quiet"
  return "ok"
}

const messageFor = (health: Health, quietMs: number, activity: RuntimeActivity) => {
  const age = formatAge(quietMs)
  if (health === "possibly_stalled") return `运行流已结束但工具仍未完成，最近一次活动 ${age}`
  if (health === "quiet" && activity !== "idle") return `长时间没有新输出，运行流仍在执行，最近一次活动 ${age}`
  if (health === "quiet") return `长时间没有新输出，最近一次活动 ${age}`
  return "仍在执行"
}

const formatAge = (quietMs: number) => `${minutes(quietMs)} 分钟前`

const minutes = (value: number) => Math.max(1, Math.round(value / 60_000))

const formatDuration = (value: number) => {
  if (value < 60_000) return `${Math.max(1, Math.round(value / 1_000))}s`
  return `${minutes(value)}m`
}
