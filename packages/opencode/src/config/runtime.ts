export * as ConfigRuntime from "./runtime"

import { Agent } from "@/agent/agent"
import { InstanceState } from "@/effect/instance-state"
import { Skill } from "@/skill"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { KeyedMutex } from "@opencode-ai/core/effect/keyed-mutex"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Context, Effect, Layer, Ref, Schema, Scope, Semaphore } from "effect"
import { Config } from "./config"
import { ConfigParse } from "./parse"

export class InvalidSourceError extends Schema.TaggedErrorClass<InvalidSourceError>()(
  "ConfigRuntime.InvalidSourceError",
  {
    path: Schema.String,
    message: Schema.String,
  },
) {}

export interface Interface {
  readonly currentEpoch: () => Effect.Effect<number>
  readonly invalidate: () => Effect.Effect<{ epoch: number }, InvalidSourceError>
  readonly ensure: (input?: { freshEpoch?: number }) => Effect.Effect<number>
  readonly reload: () => Effect.Effect<number>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ConfigRuntime") {}

export const use = serviceUse(Service)

type Flight = {
  readonly epoch: number
  readonly run: Effect.Effect<number>
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const config = yield* Config.Service
    const fs = yield* FSUtil.Service
    const skill = yield* Skill.Service
    const scope = yield* Scope.Scope
    const publication = Semaphore.makeUnsafe(1)
    const locks = KeyedMutex.makeUnsafe<string>()
    const applied = new Map<string, number>()
    const flights = new Map<string, Flight>()
    const epoch = yield* Ref.make(0)

    const validateSource = Effect.fnUntraced(function* () {
      const source = Flag.OPENCODE_CONFIG
      if (!source) return
      const text = yield* fs.readFileStringSafe(source).pipe(
        Effect.mapError(
          (error) =>
            new InvalidSourceError({
              path: source,
              message: error instanceof Error ? error.message : String(error),
            }),
        ),
      )
      if (text === undefined) {
        return yield* new InvalidSourceError({
          path: source,
          message: "Configured OPENCODE_CONFIG file does not exist",
        })
      }
      yield* Effect.try({
        try: () => ConfigParse.jsonc(text, source),
        catch: (error) =>
          new InvalidSourceError({
            path: source,
            message: error instanceof Error ? error.message : String(error),
          }),
      })
    })

    const currentEpoch = Effect.fn("ConfigRuntime.currentEpoch")(function* () {
      return yield* Ref.get(epoch)
    })

    const invalidate = Effect.fn("ConfigRuntime.invalidate")(function* () {
      return yield* publication.withPermit(
        Effect.gen(function* () {
          yield* validateSource()
          yield* config.invalidate()
          const next = yield* Ref.updateAndGet(epoch, (value) => value + 1)
          yield* Effect.logInfo("runtime config invalidated", { epoch: next })
          return { epoch: next }
        }),
      )
    })

    const refreshAt = Effect.fnUntraced(function* (directory: string, target: number) {
      yield* config.reload()
      yield* agent.reload()
      yield* skill.reload()
      applied.set(directory, target)
      yield* Effect.logInfo("runtime config applied", { directory, epoch: target })
      return target
    })

    const flight = Effect.fnUntraced(function* (directory: string, target: number) {
      const run = yield* locks.withLock(directory)(
        Effect.gen(function* () {
          const existing = flights.get(directory)
          if (existing) return existing.run

          const cached = yield* Effect.cached(
            refreshAt(directory, target).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  if (flights.get(directory)?.epoch === target) flights.delete(directory)
                }),
              ),
            ),
          )
          flights.set(directory, { epoch: target, run: cached })
          yield* cached.pipe(Effect.forkIn(scope, { startImmediately: true }))
          return cached
        }),
      )
      return yield* run
    })

    const ensureDirectory = (directory: string, freshEpoch?: number): Effect.Effect<number> =>
      Effect.gen(function* () {
        const target = yield* Ref.get(epoch)
        if (freshEpoch === target) {
          applied.set(directory, target)
          return target
        }
        if ((applied.get(directory) ?? -1) >= target) return target
        yield* flight(directory, target)
        return yield* ensureDirectory(directory)
      })

    const ensure = Effect.fn("ConfigRuntime.ensure")(function* (input?: { freshEpoch?: number }) {
      return yield* ensureDirectory(yield* InstanceState.directory, input?.freshEpoch)
    })

    const reload = Effect.fn("ConfigRuntime.reload")(function* () {
      const directory = yield* InstanceState.directory
      yield* flight(directory, yield* Ref.get(epoch))
      return yield* ensureDirectory(directory)
    })

    return Service.of({
      currentEpoch,
      invalidate,
      ensure,
      reload,
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Agent.defaultLayer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(Skill.defaultLayer),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Agent.node, Config.node, FSUtil.node, Skill.node],
})
