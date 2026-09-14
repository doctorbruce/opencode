import { Observability } from "@opencode-ai/core/observability"
import { CorsConfig, isAllowedCorsOrigin, type CorsOptions } from "@opencode-ai/server/cors"
import { Layer } from "effect"
import { HttpMiddleware, HttpRouter, HttpServer } from "effect/unstable/http"
import { compressionLayer } from "./compression"
import { corsVaryFix } from "./cors-vary"
import { errorLayer } from "./error"
import { fenceLayer } from "./fence"

type RouteRequirements =
  | HttpRouter.HttpRouter
  | HttpRouter.Request<"Error", unknown>
  | HttpRouter.Request<"GlobalError", unknown>
  | HttpRouter.Request<"Requires", unknown>
  | HttpRouter.Request<"GlobalRequires", never>

const cors = (corsOptions?: CorsOptions) =>
  HttpRouter.middleware(
    HttpMiddleware.cors({
      allowedOrigins: (origin) => isAllowedCorsOrigin(origin, corsOptions),
      maxAge: 86_400,
    }),
    { global: true },
  )

export function withHttpRuntime<E, R>(routes: Layer.Layer<never, E, R | RouteRequirements>, corsOptions?: CorsOptions) {
  return routes.pipe(
    Layer.provide([errorLayer, compressionLayer, corsVaryFix, fenceLayer, cors(corsOptions), HttpServer.layerServices]),
    Layer.provide(Layer.succeed(CorsConfig)(corsOptions)),
    Layer.provideMerge(Observability.layer),
  )
}
