import { parseArgs } from "node:util"

const logLevels = ["DEBUG", "INFO", "WARN", "ERROR"] as const

type LogLevel = (typeof logLevels)[number]

export type AmioAgentArgs =
  | { action: "help" }
  | { action: "version" }
  | {
      action: "serve"
      printLogs: boolean
      logLevel?: LogLevel
      pure: boolean
      port: number
      hostname: string
      mdns: boolean
      mdnsDomain: string
      cors: string[]
    }

export const AmioAgentHelp = `Usage: amio-agent [options] serve [options]

Starts the amio-agent sidecar server.

Options:
  -h, --help              Show help
  -v, --version           Show version number
      --print-logs        Print logs to stderr
      --log-level LEVEL   DEBUG, INFO, WARN, or ERROR
      --pure              Run without external plugins
      --port PORT         Port to listen on (default: 0)
      --hostname HOST     Hostname to listen on (default: 127.0.0.1)
      --mdns              Enable mDNS service discovery
      --no-mdns           Disable mDNS service discovery
      --mdns-domain NAME  mDNS domain (default: opencode.local)
      --cors ORIGIN       Additional CORS origin; repeat for more origins
`

export function parseAmioAgentArgs(args: string[]): AmioAgentArgs {
  if (args.length === 0) return { action: "help" }

  const normalized = args.flatMap((arg) => {
    const match = arg.match(/^--(print-logs|pure|mdns)=(.*)$/)
    if (!match) return [arg]
    if (match[2].toLowerCase() === "true") return [`--${match[1]}`]
    if (match[2].toLowerCase() === "false") return [`--no-${match[1]}`]
    throw new Error(`Invalid --${match[1]} value "${match[2]}". Expected true or false.`)
  })
  const parsed = parseArgs({
    args: normalized,
    allowPositionals: true,
    allowNegative: true,
    strict: true,
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      "print-logs": { type: "boolean" },
      "log-level": { type: "string" },
      pure: { type: "boolean" },
      port: { type: "string" },
      hostname: { type: "string" },
      mdns: { type: "boolean" },
      "mdns-domain": { type: "string" },
      cors: { type: "string", multiple: true },
    },
  })

  if (parsed.values.help) return { action: "help" }
  if (parsed.values.version) return { action: "version" }
  if (parsed.positionals.length !== 1 || parsed.positionals[0] !== "serve") {
    const duplicate = parsed.positionals.length > 1 && parsed.positionals.every((arg) => arg === "serve")
    throw new Error(duplicate ? 'Command "serve" may only be provided once.' : 'Expected command "serve".')
  }

  const port = Number(parsed.values.port ?? "0")
  if (parsed.values.port === "" || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid --port value "${parsed.values.port}". Expected an integer from 0 to 65535.`)
  }
  if (parsed.values["log-level"] && !logLevels.includes(parsed.values["log-level"] as LogLevel)) {
    throw new Error(`Invalid --log-level value "${parsed.values["log-level"]}". Expected DEBUG, INFO, WARN, or ERROR.`)
  }

  return {
    action: "serve",
    printLogs: parsed.values["print-logs"] ?? false,
    logLevel: parsed.values["log-level"] as LogLevel | undefined,
    pure: parsed.values.pure ?? false,
    port,
    hostname: parsed.values.hostname ?? (parsed.values.mdns ? "0.0.0.0" : "127.0.0.1"),
    mdns: parsed.values.mdns ?? false,
    mdnsDomain: parsed.values["mdns-domain"] ?? "opencode.local",
    cors: parsed.values.cors ?? [],
  }
}

export async function serveAmioAgent(args: Extract<AmioAgentArgs, { action: "serve" }>) {
  const { AmioServer } = await import("../server/amio-server")
  if (!process.env.OPENCODE_SERVER_PASSWORD) {
    console.log("Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.")
  }
  return AmioServer.listen(args)
}

export function installAmioAgentEnvironment(env: Record<string, string | undefined> = process.env) {
  env.OPENCODE_DISABLE_WEB_UI_ROUTES = "1"
  env.OPENCODE_DISABLE_MODELS_FETCH = "1"
  env.OPENCODE_DISABLE_WRITE_FORMAT = "1"
  env.OPENCODE_DISABLE_WRITE_DIAGNOSTICS = "1"
}
