import { OpenApi } from "effect/unstable/httpapi"
import { HttpApiApp } from "./routes/instance/httpapi/server"
import { PublicApi } from "./routes/instance/httpapi/public"
import type { CorsOptions } from "@opencode-ai/server/cors"
import { lazy } from "@/util/lazy"
import { ServerListener } from "./listener"

export type Listener = ServerListener.Listener

type ServerApp = {
  fetch(request: Request): Response | Promise<Response>
  request(input: string | URL | Request, init?: RequestInit): Response | Promise<Response>
}

type ListenOptions = CorsOptions &
  ServerListener.Options & {
    disableWebUiRoutes?: boolean
  }

export const Default = lazy(() => {
  const handler = HttpApiApp.webHandler().handler
  const app: ServerApp = {
    fetch: (request: Request) => handler(request, HttpApiApp.context),
    request(input, init) {
      return app.fetch(input instanceof Request ? input : new Request(new URL(input, "http://localhost"), init))
    },
  }
  return { app }
})

export async function openapi() {
  return OpenApi.fromApi(PublicApi)
}

export { url } from "./address"

export async function listen(opts: ListenOptions): Promise<Listener> {
  return ServerListener.listen({
    hostname: opts.hostname,
    port: opts.port,
    mdns: opts.mdns,
    mdnsDomain: opts.mdnsDomain,
    routes: HttpApiApp.createRoutes(opts),
    context: HttpApiApp.context,
  })
}

export * as Server from "./server"
