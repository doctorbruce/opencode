import { describe, expect } from "bun:test"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { ConfigRuntime } from "@/config/runtime"
import { InstanceRef } from "@/effect/instance-ref"
import type { InstanceContext } from "@/project/instance-context"
import { Skill } from "@/skill"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ProjectV2 } from "@opencode-ai/core/project"
import { Effect, Exit, Fiber, Latch, Layer, Scope } from "effect"
import { it } from "../lib/effect"

function instance(directory: string): InstanceContext {
  return {
    directory,
    worktree: directory,
    project: {
      id: ProjectV2.ID.make("runtime-config-test"),
      worktree: directory,
      time: {
        created: 0,
        updated: 0,
      },
      sandboxes: [],
    },
  }
}

function runtimeLayer(reload: Config.Interface["reload"]) {
  return ConfigRuntime.layer.pipe(
    Layer.provide(
      Layer.mock(Config.Service)({
        invalidate: () => Effect.void,
        reload,
      }),
    ),
    Layer.provide(
      Layer.mock(Agent.Service)({
        reload: () => Effect.succeed([]),
      }),
    ),
    Layer.provide(
      Layer.mock(Skill.Service)({
        reload: () => Effect.succeed([]),
      }),
    ),
    Layer.provide(FSUtil.defaultLayer),
  )
}

const provideInstance = <A, E, R>(directory: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(InstanceRef, instance(directory)))

describe("ConfigRuntime", () => {
  it.live("shares one in-flight refresh for concurrent callers in the same directory", () =>
    Effect.gen(function* () {
      const started = yield* Latch.make()
      const release = yield* Latch.make()
      let reloads = 0

      yield* Effect.gen(function* () {
        const runtime = yield* ConfigRuntime.Service
        const scope = yield* Scope.Scope
        yield* runtime.invalidate()

        const first = yield* provideInstance("/workspace/a", runtime.ensure()).pipe(
          Effect.forkIn(scope, { startImmediately: true }),
        )
        yield* started.await
        const second = yield* provideInstance("/workspace/a", runtime.ensure()).pipe(
          Effect.forkIn(scope, { startImmediately: true }),
        )

        yield* release.open
        expect(yield* Fiber.join(first)).toBe(1)
        expect(yield* Fiber.join(second)).toBe(1)
        expect(reloads).toBe(1)
      }).pipe(
        Effect.provide(
          runtimeLayer(() =>
            Effect.gen(function* () {
              reloads++
              yield* started.open
              yield* release.await
              return {}
            }),
          ),
        ),
      )
    }),
  )

  it.live("keeps a shared refresh running when one waiter is cancelled", () =>
    Effect.gen(function* () {
      const started = yield* Latch.make()
      const release = yield* Latch.make()
      let reloads = 0

      yield* Effect.gen(function* () {
        const runtime = yield* ConfigRuntime.Service
        const scope = yield* Scope.Scope
        yield* runtime.invalidate()

        const cancelled = yield* provideInstance("/workspace/a", runtime.ensure()).pipe(
          Effect.forkIn(scope, { startImmediately: true }),
        )
        yield* started.await
        const waiting = yield* provideInstance("/workspace/a", runtime.ensure()).pipe(
          Effect.forkIn(scope, { startImmediately: true }),
        )

        yield* Fiber.interrupt(cancelled)
        yield* release.open
        expect(yield* Fiber.join(waiting)).toBe(1)
        expect(reloads).toBe(1)
      }).pipe(
        Effect.provide(
          runtimeLayer(() =>
            Effect.gen(function* () {
              reloads++
              yield* started.open
              yield* release.await
              return {}
            }),
          ),
        ),
      )
    }),
  )

  it.live("refreshes different directories concurrently", () =>
    Effect.gen(function* () {
      const bothStarted = yield* Latch.make()
      const release = yield* Latch.make()
      let reloads = 0

      yield* Effect.gen(function* () {
        const runtime = yield* ConfigRuntime.Service
        const scope = yield* Scope.Scope
        yield* runtime.invalidate()

        const first = yield* provideInstance("/workspace/a", runtime.ensure()).pipe(
          Effect.forkIn(scope, { startImmediately: true }),
        )
        const second = yield* provideInstance("/workspace/b", runtime.ensure()).pipe(
          Effect.forkIn(scope, { startImmediately: true }),
        )

        yield* bothStarted.await.pipe(Effect.timeout("1 second"))
        yield* release.open
        expect(yield* Fiber.join(first)).toBe(1)
        expect(yield* Fiber.join(second)).toBe(1)
        expect(reloads).toBe(2)
      }).pipe(
        Effect.provide(
          runtimeLayer(() =>
            Effect.gen(function* () {
              reloads++
              if (reloads === 2) yield* bothStarted.open
              yield* release.await
              return {}
            }),
          ),
        ),
      )
    }),
  )

  it.live("continues to the latest epoch when config changes during a refresh", () =>
    Effect.gen(function* () {
      const started = yield* Latch.make()
      const release = yield* Latch.make()
      let reloads = 0

      yield* Effect.gen(function* () {
        const runtime = yield* ConfigRuntime.Service
        const scope = yield* Scope.Scope
        yield* runtime.invalidate()

        const waiting = yield* provideInstance("/workspace/a", runtime.ensure()).pipe(
          Effect.forkIn(scope, { startImmediately: true }),
        )
        yield* started.await
        yield* runtime.invalidate()
        yield* release.open

        expect(yield* Fiber.join(waiting)).toBe(2)
        expect(reloads).toBe(2)
      }).pipe(
        Effect.provide(
          runtimeLayer(() =>
            Effect.gen(function* () {
              reloads++
              if (reloads === 1) {
                yield* started.open
                yield* release.await
              }
              return {}
            }),
          ),
        ),
      )
    }),
  )

  it.live("retries after a failed refresh without advancing the applied epoch", () =>
    Effect.gen(function* () {
      let reloads = 0

      yield* Effect.gen(function* () {
        const runtime = yield* ConfigRuntime.Service
        yield* runtime.invalidate()

        const failed = yield* provideInstance("/workspace/a", runtime.ensure()).pipe(Effect.exit)
        expect(Exit.isFailure(failed)).toBe(true)
        expect(yield* provideInstance("/workspace/a", runtime.ensure())).toBe(1)
        expect(reloads).toBe(2)
      }).pipe(
        Effect.provide(
          runtimeLayer(() =>
            Effect.suspend(() => {
              reloads++
              if (reloads === 1) return Effect.die("reload failed")
              return Effect.succeed({})
            }),
          ),
        ),
      )
    }),
  )

  it.live("adopts the current epoch for a newly loaded directory without reloading", () =>
    Effect.gen(function* () {
      let reloads = 0

      yield* Effect.gen(function* () {
        const runtime = yield* ConfigRuntime.Service
        const published = yield* runtime.invalidate()

        expect(yield* provideInstance("/workspace/cold", runtime.ensure({ freshEpoch: published.epoch }))).toBe(
          published.epoch,
        )
        expect(reloads).toBe(0)

        yield* runtime.invalidate()
        expect(yield* provideInstance("/workspace/cold", runtime.ensure())).toBe(2)
        expect(reloads).toBe(1)
      }).pipe(
        Effect.provide(
          runtimeLayer(() =>
            Effect.sync(() => {
              reloads++
              return {}
            }),
          ),
        ),
      )
    }),
  )
})
