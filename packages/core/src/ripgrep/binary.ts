import path from "path"
import { Context, Effect, Layer } from "effect"
import { LayerNode } from "../effect/layer-node"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { which } from "../util/which"

export namespace RipgrepBinary {
  interface Interface {
    readonly filepath: Effect.Effect<string, Error>
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/RipgrepBinary") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service

      return Service.of({
        filepath: yield* Effect.cached(
          Effect.gen(function* () {
            const system = yield* Effect.sync(() => which(process.platform === "win32" ? "rg.exe" : "rg"))
            if (system && (yield* fs.isFile(system).pipe(Effect.orDie))) return system

            const target = path.join(Global.Path.bin, `rg${process.platform === "win32" ? ".exe" : ""}`)
            if (yield* fs.isFile(target).pipe(Effect.orDie)) return target

            throw new Error(
              `ripgrep executable not found. Install rg on PATH or place ${path.basename(target)} in ${Global.Path.bin}.`,
            )
          }),
        ),
      })
    }),
  )

  export const defaultLayer = layer.pipe(Layer.provide(FSUtil.defaultLayer))

  export const node = LayerNode.make(layer, [FSUtil.node])
}
