import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { BackgroundJob } from "../../src/background/job"
import { JobKillTool, JobOutputTool } from "../../src/tool/job"
import { MessageID, SessionID } from "../../src/session/schema"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "@/tool/truncate"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { testEffect } from "../lib/effect"
import { tmpdirScoped } from "../fixture/fixture"

const sessionID = SessionID.make("ses_job-test")
const otherSessionID = SessionID.make("ses_job-other")

const ctx = {
  sessionID,
  messageID: MessageID.make("msg_job-test"),
  agent: "test-agent",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const it = testEffect(
  Layer.mergeAll(
    BackgroundJob.defaultLayer,
    Truncate.defaultLayer,
    Agent.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
  ),
)

describe("tool.job", () => {
  it.instance("delivers a completed job's output once", () =>
    Effect.gen(function* () {
      const background = yield* BackgroundJob.Service
      const tool = yield* (yield* JobOutputTool).init()
      const job = yield* background.start({
        id: "job-completed",
        type: "test",
        metadata: { parentSessionId: sessionID },
        run: Effect.succeed("done text"),
      })
      yield* background.wait({ id: job.id })

      const first = yield* tool.execute({ job_id: job.id }, ctx)
      expect(first.output).toContain("done text")
      expect(first.output).toContain("[status: completed]")
      expect(first.output).toMatch(/\[status: completed\] \[wall time: \d+s\]/)
      expect(typeof first.metadata.wallTimeMs).toBe("number")

      const second = yield* tool.execute({ job_id: job.id }, ctx)
      expect(second.output).toContain("(no new output)")
      expect(second.output).toContain("[status: completed]")
    }),
  )

  it.instance("streams only new output from a running job and cancels it", () =>
    Effect.gen(function* () {
      const background = yield* BackgroundJob.Service
      const tool = yield* (yield* JobOutputTool).init()
      const kill = yield* (yield* JobKillTool).init()
      const directory = yield* tmpdirScoped()
      const outputPath = path.join(directory, "job.out")
      yield* Effect.promise(() => fs.writeFile(outputPath, "line A\n"))

      const job = yield* background.start({
        id: "job-live",
        type: "bash",
        title: "sleep forever",
        metadata: { parentSessionId: sessionID, background: true, outputPath },
        run: Effect.never,
      })

      const first = yield* tool.execute({ job_id: job.id }, ctx)
      expect(first.output).toContain("line A")
      expect(first.output).toContain("[status: running]")

      yield* Effect.promise(() => fs.appendFile(outputPath, "line B\n"))
      const second = yield* tool.execute({ job_id: job.id }, ctx)
      expect(second.output).toContain("line B")
      expect(second.output).not.toContain("line A")

      const third = yield* tool.execute({ job_id: job.id }, ctx)
      expect(third.output).toContain("(no new output)")

      const killed = yield* kill.execute({ job_id: job.id }, ctx)
      expect(killed.output).toContain(`requested cancellation of job ${job.id}`)

      const after = yield* tool.execute({ job_id: job.id }, ctx)
      expect(after.output).toContain("[status: cancelled]")
    }),
  )

  it.instance("waits for a job in bounded chunks", () =>
    Effect.gen(function* () {
      const background = yield* BackgroundJob.Service
      const tool = yield* (yield* JobOutputTool).init()
      const job = yield* background.start({
        id: "job-wait",
        type: "test",
        metadata: { parentSessionId: sessionID },
        run: Effect.sleep("200 millis").pipe(Effect.as("waited output")),
      })

      // A short wait returns while the job is still running.
      const early = yield* tool.execute({ job_id: job.id, wait_ms: 1 }, ctx)
      expect(early.output).toContain("[status: running]")

      // A longer wait returns the finished job's output.
      const settled = yield* tool.execute({ job_id: job.id, wait_ms: 5_000 }, ctx)
      expect(settled.output).toContain("waited output")
      expect(settled.output).toContain("[status: completed]")
    }),
  )

  it.instance("drops settled jobs beyond the retention cap", () =>
    Effect.gen(function* () {
      const background = yield* BackgroundJob.Service
      for (const id of ["job-a", "job-b", "job-c"]) {
        const job = yield* background.start({
          id,
          type: "test",
          metadata: { parentSessionId: sessionID },
          run: Effect.succeed(id),
        })
        yield* background.wait({ id: job.id })
      }

      const dropped = yield* background.prune({ keep: 1 })
      expect(dropped).toEqual(["job-a", "job-b"])
      expect(yield* background.get("job-a")).toBeUndefined()
      expect((yield* background.get("job-c"))?.status).toBe("completed")
    }),
  )

  it.instance("reports an unknown job with the running jobs", () =>
    Effect.gen(function* () {
      const background = yield* BackgroundJob.Service
      const tool = yield* (yield* JobOutputTool).init()
      yield* background.start({
        id: "job-running",
        type: "bash",
        metadata: { parentSessionId: sessionID, background: true },
        run: Effect.never,
      })

      const result = yield* tool.execute({ job_id: "job-missing" }, ctx)
      expect(result.output).toContain("Unknown job: job-missing")
      expect(result.output).toContain("job-running")
    }),
  )

  it.instance("refuses jobs owned by another session", () =>
    Effect.gen(function* () {
      const background = yield* BackgroundJob.Service
      const tool = yield* (yield* JobOutputTool).init()
      const kill = yield* (yield* JobKillTool).init()
      const job = yield* background.start({
        id: "job-foreign",
        type: "bash",
        metadata: { parentSessionId: otherSessionID, background: true },
        run: Effect.never,
      })

      const read = yield* tool.execute({ job_id: job.id }, ctx)
      expect(read.output).toBe(`Job ${job.id} belongs to another session.`)

      const killed = yield* kill.execute({ job_id: job.id }, ctx)
      expect(killed.output).toBe(`Job ${job.id} belongs to another session.`)

      const still = yield* background.get(job.id)
      expect(still?.status).toBe("running")
    }),
  )

  it.instance("reports an already finished job on kill", () =>
    Effect.gen(function* () {
      const background = yield* BackgroundJob.Service
      const kill = yield* (yield* JobKillTool).init()
      const job = yield* background.start({
        id: "job-finished",
        type: "test",
        metadata: { parentSessionId: sessionID },
        run: Effect.succeed("ok"),
      })
      yield* background.wait({ id: job.id })

      const result = yield* kill.execute({ job_id: job.id }, ctx)
      expect(result.output).toBe(`Job ${job.id} is already completed.`)
    }),
  )
})
