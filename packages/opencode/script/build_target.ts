export function buildBinaryName(amioAgent: boolean) {
  return amioAgent ? "amio-agent" : "opencode"
}

export function resolveBuildVersion(input: {
  amioAgent: boolean
  envVersion: string | undefined
  packageVersion: string
}) {
  if (input.envVersion) return input.envVersion
  if (input.amioAgent) return input.packageVersion
  return undefined
}

export function parseTargetOS(input: string | undefined) {
  if (!input) return undefined
  return input
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
}

export function resolveCompileExecutablePath(input: {
  executableDir: string | undefined
  target: string
  windows: boolean
}) {
  if (!input.executableDir) return undefined
  return `${input.executableDir.replace(/[\\/]+$/, "")}/${input.target}/${input.windows ? "bun.exe" : "bun"}`
}

export function buildEntrypoints(input: {
  amioAgent: boolean
  embeddedWebUi: boolean
  parserWorker: string
  workerPath: string
}) {
  if (input.amioAgent) return ["./src/amio-agent.ts"]
  return [
    "./src/index.ts",
    input.parserWorker,
    input.workerPath,
    ...(input.embeddedWebUi ? ["opencode-web-ui.gen.ts"] : []),
  ]
}
