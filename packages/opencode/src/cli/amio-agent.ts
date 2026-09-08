import { Flag } from "@opencode-ai/core/flag/flag"
import { cmd } from "./cmd/cmd"
import { resolveNetworkOptionsNoConfig, withNetworkOptions } from "./network"

export const AmioServeCommand = cmd({
  command: "serve",
  builder: (yargs) => withNetworkOptions(yargs),
  describe: "starts a headless opencode server",
  async handler(args) {
    const { Server } = await import("../server/server")
    if (!Flag.OPENCODE_SERVER_PASSWORD) {
      console.log("Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.")
    }
    const opts = resolveNetworkOptionsNoConfig(args)
    const server = await Server.listen({ ...opts, disableWebUiRoutes: true })
    console.log(`opencode server listening on http://${server.hostname}:${server.port}`)

    // Keep the yargs handler pending while the listener owns the process.
    await new Promise<void>(() => {})
  },
})

export const AmioAgentCommands = [AmioServeCommand]

export function installAmioAgentEnvironment(env: Record<string, string | undefined> = process.env) {
  env.OPENCODE_DISABLE_WEB_UI_ROUTES = "1"
  env.OPENCODE_DISABLE_MODELS_FETCH = "1"
  env.OPENCODE_DISABLE_WRITE_FORMAT = "1"
  env.OPENCODE_DISABLE_WRITE_DIAGNOSTICS = "1"
}
