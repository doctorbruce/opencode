import { InstallationChannel, InstallationVersion } from "@opencode-ai/core/installation/version"
import { AmioAgentHelp, installAmioAgentEnvironment, parseAmioAgentArgs, serveAmioAgent } from "./cli/amio-agent"

installAmioAgentEnvironment()

try {
  const args = parseAmioAgentArgs(process.argv.slice(2))
  if (args.action === "help") {
    process.stdout.write(AmioAgentHelp)
    process.exit(0)
  }
  if (args.action === "version") {
    process.stdout.write(InstallationVersion + "\n")
    process.exit(0)
  }

  if (args.printLogs) process.env.OPENCODE_PRINT_LOGS = "1"
  if (args.logLevel) process.env.OPENCODE_LOG_LEVEL = args.logLevel
  if (args.pure) process.env.OPENCODE_PURE = "1"
  if (InstallationChannel === "local" && !process.env.OPENCODE_LOG_LEVEL) process.env.OPENCODE_LOG_LEVEL = "DEBUG"

  const heapSnapshot = process.env.OPENCODE_AUTO_HEAP_SNAPSHOT?.toLowerCase()
  if (heapSnapshot === "1" || heapSnapshot === "true") {
    const { Heap } = await import("./cli/heap")
    Heap.start()
  }

  process.env.AGENT = "1"
  process.env.OPENCODE = "1"
  process.env.OPENCODE_PID = String(process.pid)

  const server = await serveAmioAgent(args)
  console.log(`opencode server listening on http://${server.hostname}:${server.port}`)
  await new Promise<void>(() => {})
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n")
  process.exitCode = 1
} finally {
  process.exit()
}
