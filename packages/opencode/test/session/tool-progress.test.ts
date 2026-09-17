import { describe, expect, test } from "bun:test"
import { ToolProgress } from "../../src/session/tool-progress"

const sessionID = "ses_tool_progress"

const track = (callID: string, tool: string, now: number) =>
  ToolProgress.track({ sessionID, callID, tool, now })

const decide = (input: { now: number; activity: ToolProgress.RuntimeActivity; silenceMs?: number; graceMs?: number }) =>
  ToolProgress.tick({
    sessionID,
    activity: input.activity,
    now: input.now,
    silenceMs: input.silenceMs ?? 300_000,
    graceMs: input.graceMs ?? 60_000,
  })

describe("ToolProgress", () => {
  test("uses per-tool quiet windows", () => {
    ToolProgress.reset()
    track("read-1", "read", 0)
    track("bash-1", "bash", 0)
    track("other-1", "webfetch", 0)

    const decisions = new Map(decide({ now: 90_000, activity: "busy" }).map((item) => [item.callID, item]))

    expect(decisions.get("read-1")?.progress.health).toBe("quiet")
    expect(decisions.get("bash-1")?.progress.health).toBe("ok")
    expect(decisions.get("other-1")?.progress.health).toBe("ok")
  })

  test("heartbeat ticks never refresh the silence clock", () => {
    ToolProgress.reset()
    track("read-1", "read", 0)

    decide({ now: 90_000, activity: "busy" })
    decide({ now: 150_000, activity: "busy" })
    const third = decide({ now: 210_000, activity: "idle" })

    expect(third[0]?.progress.quietMs).toBe(210_000)
    expect(third[0]?.progress.health).toBe("possibly_stalled")
    expect(third[0]?.progress.message).toContain("运行流已结束但工具仍未完成")
  })

  test("reports the run stream as still executing while the session is busy", () => {
    ToolProgress.reset()
    track("bash-1", "bash", 0)

    const [decision] = decide({ now: 240_000, activity: "busy" })

    expect(decision?.progress.health).toBe("quiet")
    expect(decision?.progress.message).toBe("长时间没有新输出，运行流仍在执行，最近一次活动 4 分钟前")
  })

  test("real activity resets quiet counting", () => {
    ToolProgress.reset()
    track("read-1", "read", 0)

    decide({ now: 90_000, activity: "busy" })
    ToolProgress.refresh("read-1", 120_000)
    const decisions = decide({ now: 150_000, activity: "busy" })

    expect(decisions[0]?.progress.health).toBe("ok")
    expect(decisions[0]?.progress.quietMs).toBe(30_000)
  })

  test("escalates once past the silence cap for shell-like tools only", () => {
    ToolProgress.reset()
    track("bash-1", "bash", 0)
    track("fetch-1", "webfetch", 0)

    const before = new Map(decide({ now: 299_000, activity: "busy" }).map((item) => [item.callID, item]))
    expect(before.get("bash-1")?.escalate).toBeUndefined()

    const at = new Map(decide({ now: 300_000, activity: "busy" }).map((item) => [item.callID, item]))
    expect(at.get("bash-1")?.escalate?.quietMs).toBe(300_000)
    expect(at.get("bash-1")?.escalate?.silenceMs).toBe(300_000)
    expect(at.get("fetch-1")?.escalate).toBeUndefined()

    const after = new Map(decide({ now: 600_000, activity: "busy" }).map((item) => [item.callID, item]))
    expect(after.get("bash-1")?.escalate).toBeUndefined()
    expect(after.get("bash-1")?.forceSettle).toBeDefined()
  })

  test("respects a disabled silence cap", () => {
    ToolProgress.reset()
    track("bash-1", "bash", 0)

    const [decision] = decide({ now: 900_000, activity: "busy", silenceMs: 0 })

    expect(decision?.escalate).toBeUndefined()
    expect(decision?.forceSettle).toBeUndefined()
  })

  test("keeps the grace window before forcing a settlement", () => {
    ToolProgress.reset()
    track("bash-1", "bash", 0)

    decide({ now: 300_000, activity: "busy", graceMs: 60_000 })
    const early = decide({ now: 330_000, activity: "busy", graceMs: 60_000 })
    const late = decide({ now: 360_000, activity: "busy", graceMs: 60_000 })

    expect(early[0]?.forceSettle).toBeUndefined()
    expect(late[0]?.forceSettle?.quietMs).toBe(360_000)
  })

  test("tracks, settles, and clears per session", () => {
    ToolProgress.reset()
    track("bash-1", "bash", 0)

    expect(ToolProgress.tracking(sessionID)).toBe(true)
    expect(ToolProgress.escalation("bash-1")).toBeUndefined()

    ToolProgress.settle("bash-1")
    expect(ToolProgress.tracking(sessionID)).toBe(false)
    expect(decide({ now: 900_000, activity: "busy" })).toEqual([])

    track("bash-1", "bash", 0)
    track("bash-2", "bash", 0)
    ToolProgress.clearSession(sessionID)
    expect(decide({ now: 900_000, activity: "busy" })).toEqual([])
  })

  test("records the escalation reason for the wrapper to read", () => {
    ToolProgress.reset()
    track("bash-1", "bash", 0)

    decide({ now: 300_000, activity: "busy" })
    const reason = ToolProgress.escalation("bash-1")

    expect(reason?.kind).toBe("silence_timeout")
    expect(reason?.runtimeActivity).toBe("busy")
    expect(reason?.elapsedMs).toBe(300_000)
  })

  test("rewrites a finished result into a model-visible silence outcome", () => {
    const reason: ToolProgress.SilenceReason = {
      kind: "silence_timeout",
      quietMs: 300_000,
      silenceMs: 300_000,
      elapsedMs: 310_000,
      lastActivityAt: 10_000,
      runtimeActivity: "busy",
    }

    const executed: { title: string; metadata: Record<string, any>; output: string } = {
      title: "uv run python script.py",
      metadata: { output: "partial tail" },
      output: "line one\nline two",
    }
    const result = ToolProgress.silenceResult(executed, reason)

    expect(result.output.startsWith(ToolProgress.SILENCE_NOTICE_PREFIX)).toBe(true)
    expect(result.output).toContain("line two")
    expect(result.metadata.timeout).toBe(true)
    expect(result.metadata.progress.health).toBe("silence_timeout")
    expect(result.metadata.silence).toEqual({ quietMs: 300_000, silenceMs: 300_000 })
  })

  test("strips the shell's user-abort metadata from a silence result", () => {
    const reason: ToolProgress.SilenceReason = {
      kind: "silence_timeout",
      quietMs: 360_000,
      silenceMs: 300_000,
      elapsedMs: 370_000,
      lastActivityAt: 10_000,
      runtimeActivity: "busy",
    }

    const result = ToolProgress.silenceResult(
      {
        metadata: { output: "cleaned" },
        output: "cleaned\n\n<shell_metadata>\nUser aborted the command\n</shell_metadata>",
      },
      reason,
    )

    expect(result.output.startsWith(ToolProgress.SILENCE_NOTICE_PREFIX)).toBe(true)
    expect(result.output).toContain("cleaned")
    expect(result.output).not.toContain("User aborted")
    expect(result.output).not.toContain("shell_metadata")
  })

  test("recognizes the silence abort reason", () => {
    expect(ToolProgress.isSilenceReason({ kind: "silence_timeout" })).toBe(true)
    expect(ToolProgress.isSilenceReason({ kind: "user" })).toBe(false)
    expect(ToolProgress.isSilenceReason(undefined)).toBe(false)
    expect(ToolProgress.isSilenceReason("silence_timeout")).toBe(false)
  })

  test("links the per-call controller to the request signal", () => {
    const request = new AbortController()
    const perCall = new AbortController()
    const signal = ToolProgress.linkAbort(request.signal, perCall)

    perCall.abort({ kind: "silence_timeout" })
    expect(signal.aborted).toBe(true)
    expect(signal.reason).toEqual({ kind: "silence_timeout" })

    const abortedRequest = new AbortController()
    abortedRequest.abort(new Error("user"))
    const late = new AbortController()
    const lateSignal = ToolProgress.linkAbort(abortedRequest.signal, late)
    expect(lateSignal.aborted).toBe(true)

    const live = new AbortController()
    const child = new AbortController()
    const childSignal = ToolProgress.linkAbort(live.signal, child)
    expect(childSignal.aborted).toBe(false)
    live.abort(new Error("interrupt"))
    expect(childSignal.aborted).toBe(true)
  })
})
