import { ServeCommand } from "./cmd/serve"

export const AmioAgentCommands = [ServeCommand]

export function installAmioAgentEnvironment(env: Record<string, string | undefined> = process.env) {
  env.OPENCODE_DISABLE_WEB_UI_ROUTES = "1"
  env.OPENCODE_DISABLE_MODELS_FETCH = "1"
  env.OPENCODE_DISABLE_WRITE_FORMAT = "1"
  env.OPENCODE_DISABLE_WRITE_DIAGNOSTICS = "1"
}
