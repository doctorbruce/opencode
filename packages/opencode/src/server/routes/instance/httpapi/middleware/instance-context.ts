import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { ConfigRuntime } from "@/config/runtime"
import { InstanceStore } from "@/project/instance-store"
import { Effect, Layer } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { WorkspaceRouteContext } from "./workspace-routing"

export class InstanceContextMiddleware extends HttpApiMiddleware.Service<
  InstanceContextMiddleware,
  {
    requires: WorkspaceRouteContext
  }
>()("@opencode/ExperimentalHttpApiInstanceContext") {}

type InstanceContextOptions = {
  skipUnloadedSessionStatusBootstrap?: boolean
}

function decode(input: string): string {
  try {
    return decodeURIComponent(input)
  } catch {
    return input
  }
}

function provideInstanceContext<E>(
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E>,
  store: InstanceStore.Interface,
  configRuntime: ConfigRuntime.Interface,
  options?: InstanceContextOptions,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  E,
  WorkspaceRouteContext | HttpServerRequest.HttpServerRequest
> {
  return Effect.gen(function* () {
    const route = yield* WorkspaceRouteContext
    const directory = decode(route.directory)
    const loaded = yield* store.isLoaded(directory)
    // Astron reads status for every saved workspace at bootstrap. A directory
    // without an instance cannot have process-local session activity yet.
    if (options?.skipUnloadedSessionStatusBootstrap && !loaded) {
      const request = yield* HttpServerRequest.HttpServerRequest
      if (request.method === "GET" && new URL(request.url, "http://localhost").pathname === "/session/status") {
        return HttpServerResponse.jsonUnsafe({})
      }
    }
    const freshEpoch = loaded ? undefined : yield* configRuntime.currentEpoch()
    const ctx = yield* store.load({ directory })
    const provideContext = <A, E2, R>(self: Effect.Effect<A, E2, R>) =>
      self.pipe(Effect.provideService(InstanceRef, ctx), Effect.provideService(WorkspaceRef, route.workspaceID))
    yield* configRuntime.ensure({ freshEpoch }).pipe(provideContext)
    return yield* effect.pipe(
      Effect.provideService(InstanceRef, ctx),
      Effect.provideService(WorkspaceRef, route.workspaceID),
    )
  })
}

export const createInstanceContextLayer = (options?: InstanceContextOptions) =>
  Layer.effect(
    InstanceContextMiddleware,
    Effect.gen(function* () {
      const configRuntime = yield* ConfigRuntime.Service
      const store = yield* InstanceStore.Service
      return InstanceContextMiddleware.of((effect) => provideInstanceContext(effect, store, configRuntime, options))
    }),
  )

export const instanceContextLayer = createInstanceContextLayer()
