import { BackgroundJob } from "@/background/job"
import { ToolProgress } from "@/session/tool-progress"
import { Effect, Schema } from "effect"
import * as Tool from "./tool"

const READ_LIMIT = 16_000

/** Incremental read cursors, keyed by output path. Reads never repeat consumed output. */
const fileOffsets = new Map<string, number>()
/** Jobs whose final in-memory output was already delivered once. */
const delivered = new Set<string>()

const MAX_WAIT_MS = 300_000

const Parameters = Schema.Struct({
  job_id: Schema.String.annotate({ description: "Background job id returned by the bash or task tool." }),
  wait_ms: Schema.optional(Schema.Number).annotate({
    description: `Optional bounded wait in milliseconds before reading, up to ${MAX_WAIT_MS}. Use it to wait in chunks (for example 30000) when you are blocked on this job; never sleep or spin in a tight loop.`,
  }),
})

type Metadata = {
  jobId: string
  status: BackgroundJob.Status
  wallTimeMs?: number
}

function jobSession(job: BackgroundJob.Info) {
  const metadata = job.metadata ?? {}
  const value = metadata.parentSessionId ?? metadata.sessionId
  return typeof value === "string" && value ? value : undefined
}

function visibleTo(job: BackgroundJob.Info, sessionID: string) {
  const owner = jobSession(job)
  return owner === undefined || owner === sessionID
}

function unknownJob(background: BackgroundJob.Interface, id: string) {
  return Effect.gen(function* () {
    const running = (yield* background.list()).filter((job) => job.status === "running")
    if (running.length === 0) return `Unknown job: ${id}. There are no running background jobs.`
    return `Unknown job: ${id}. Running jobs: ${running.map((job) => job.id).join(", ")}.`
  })
}

function outputPath(job: BackgroundJob.Info) {
  const value = job.metadata?.outputPath
  return typeof value === "string" && value ? value : undefined
}

function readDelta(path: string) {
  return Effect.promise(async () => {
    const file = Bun.file(path)
    if (!(await file.exists())) return undefined
    const text = await file.text()
    const offset = fileOffsets.get(path) ?? 0
    if (text.length <= offset) return ""
    const delta = text.slice(offset, offset + READ_LIMIT)
    fileOffsets.set(path, offset + delta.length)
    return delta
  })
}

function wallTimeMs(job: BackgroundJob.Info, now = Date.now()) {
  return Math.max(0, (job.completed_at ?? now) - job.started_at)
}

function statusLine(job: BackgroundJob.Info) {
  const status = `[status: ${job.status}] [wall time: ${ToolProgress.formatWallTime(wallTimeMs(job))}]`
  if (job.status !== "error" || !job.error) return status
  return `${status}\n[error: ${job.error}]`
}

function jobResult(job: BackgroundJob.Info, output: string): { title: string; metadata: Metadata; output: string } {
  return {
    title: job.title ?? job.id,
    metadata: { jobId: job.id, status: job.status, wallTimeMs: wallTimeMs(job) },
    output,
  }
}

export const JobOutputTool = Tool.define<typeof Parameters, Metadata, BackgroundJob.Service>(
  "job_output",
  Effect.gen(function* () {
    const background = yield* BackgroundJob.Service

    return {
      description: [
        "Read new output from a background job started by `bash` or `task`.",
        "Reads are incremental: each call returns only what was produced since the previous call, or `(no new output)`, plus a final `[status: running|completed|error|cancelled]`.",
        "Pass `wait_ms` to block until the job settles or that many milliseconds elapse, which is how you wait on a job without ending your turn.",
        "You are also notified automatically when a job finishes, so you can keep working on something else instead of waiting.",
      ].join(" "),
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const initial = yield* background.get(params.job_id)
          if (!initial) {
            return {
              title: params.job_id,
              metadata: { jobId: params.job_id, status: "error" as const },
              output: yield* unknownJob(background, params.job_id),
            }
          }
          if (!visibleTo(initial, ctx.sessionID)) {
            return {
              title: params.job_id,
              metadata: { jobId: initial.id, status: initial.status },
              output: `Job ${initial.id} belongs to another session.`,
            }
          }

          const waitMs = params.wait_ms === undefined ? 0 : Math.max(0, Math.min(params.wait_ms, MAX_WAIT_MS))
          const waited = waitMs > 0 ? yield* background.wait({ id: initial.id, timeout: waitMs }) : undefined
          const job = waited?.info ?? initial
          const path = outputPath(job)
          const delta = path ? yield* readDelta(path) : undefined
          if (delta !== undefined) {
            if (delta) return jobResult(job, `${delta}\n${statusLine(job)}`)
            // The spooled file can be empty when the command was silent after it
            // was detached; fall back to the job's final output once.
            if (job.status !== "running" && !delivered.has(job.id)) {
              delivered.add(job.id)
              return jobResult(job, `${job.output ?? "(no output)"}\n${statusLine(job)}`)
            }
            return jobResult(job, `(no new output)\n${statusLine(job)}`)
          }

          if (job.status === "running") return jobResult(job, `(no new output)\n${statusLine(job)}`)
          if (!delivered.has(job.id)) {
            delivered.add(job.id)
            return jobResult(job, `${job.output ?? "(no output)"}\n${statusLine(job)}`)
          }
          return jobResult(job, `(no new output)\n${statusLine(job)}`)
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)

export const JobKillTool = Tool.define<typeof Parameters, Metadata, BackgroundJob.Service>(
  "job_kill",
  Effect.gen(function* () {
    const background = yield* BackgroundJob.Service

    return {
      description:
        "Cancel a running background job and terminate what it is running (the shell process, or the subagent's session). Returns the resulting status.",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const job = yield* background.get(params.job_id)
          if (!job) {
            return {
              title: params.job_id,
              metadata: { jobId: params.job_id, status: "error" as const },
              output: yield* unknownJob(background, params.job_id),
            }
          }
          if (!visibleTo(job, ctx.sessionID)) {
            return {
              title: params.job_id,
              metadata: { jobId: job.id, status: job.status },
              output: `Job ${job.id} belongs to another session.`,
            }
          }
          if (job.status !== "running") return jobResult(job, `Job ${job.id} is already ${job.status}.`)
          const cancelled = yield* background.cancel(job.id)
          const settled = cancelled ?? job
          return jobResult(
            settled,
            `requested cancellation of job ${job.id}\n[status: ${settled.status}] [wall time: ${ToolProgress.formatWallTime(wallTimeMs(settled))}]`,
          )
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
