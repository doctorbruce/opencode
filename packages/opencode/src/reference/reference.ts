import path from "path"
import { Effect, Context, Layer } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Config } from "@/config/config"
import { ConfigReference } from "@/config/reference"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { parseRepositoryReference, repositoryCachePath, type RemoteReference } from "@/util/repository"

export type Resolved =
  | {
      name: string
      kind: "local"
      path: string
    }
  | {
      name: string
      kind: "git"
      repository: string
      reference: RemoteReference
      path: string
      branch?: string
    }
  | {
      name: string
      kind: "invalid"
      repository?: string
      message: string
    }

type State = {
  references: Resolved[]
}

export interface Interface {
  readonly init: () => Effect.Effect<void>
  readonly list: () => Effect.Effect<Resolved[]>
  readonly get: (name: string) => Effect.Effect<Resolved | undefined>
  readonly ensure: (target?: string) => Effect.Effect<void>
  readonly contains: (target?: string) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Reference") {}

export function referencePath(input: { directory: string; worktree: string; value: string }) {
  if (input.value.startsWith("~/")) return path.join(Global.Path.home, input.value.slice(2))
  return path.isAbsolute(input.value)
    ? input.value
    : path.resolve(input.worktree === "/" ? input.directory : input.worktree, input.value)
}

function resolveGit(
  input: { name: string; repository: string } | { name: string; repository: string; branch: string | undefined },
): Resolved {
  const parsed = parseRepositoryReference(input.repository)
  if (!parsed || parsed.protocol === "file:") {
    return {
      name: input.name,
      kind: "invalid",
      repository: input.repository,
      message: "Repository must be a git URL, host/path reference, or GitHub owner/repo shorthand",
    }
  }
  return {
    name: input.name,
    kind: "git",
    repository: input.repository,
    reference: parsed,
    path: repositoryCachePath(parsed),
    ...("branch" in input ? { branch: input.branch } : {}),
  }
}

function branchLabel(branch: string | undefined) {
  return branch ?? "default branch"
}

function normalizedTarget(target?: string) {
  if (!target) return
  return process.platform === "win32" ? FSUtil.normalizePath(target) : target
}

function containsReferencePath(referencePath: string, target: string) {
  return FSUtil.contains(normalizedTarget(referencePath) ?? referencePath, target)
}


function containsGitReferencePath(references: Resolved[], target: string) {
  return references.some((reference) => reference.kind === "git" && containsReferencePath(reference.path, target))
}

export function resolve(input: {
  name: string
  reference: ConfigReference.NormalizedEntry
  directory: string
  worktree: string
}): Resolved {
  if (input.reference.kind === "invalid") {
    return { name: input.name, kind: "invalid", message: input.reference.message }
  }
  if (input.reference.kind === "local") {
    return { name: input.name, kind: "local", path: referencePath({ ...input, value: input.reference.path }) }
  }
  return resolveGit({ name: input.name, repository: input.reference.repository, branch: input.reference.branch })
}

export function resolveAll(input: { references: ConfigReference.NormalizedInfo; directory: string; worktree: string }) {
  const seen = new Map<string, { name: string; branch?: string }>()
  return Object.entries(input.references).map(([name, reference]) => {
    const resolved = resolve({ name, reference, directory: input.directory, worktree: input.worktree })
    if (resolved.kind !== "git") return resolved

    const existing = seen.get(resolved.path)
    if (!existing) {
      seen.set(resolved.path, { name, branch: resolved.branch })
      return resolved
    }
    if (existing.branch === resolved.branch) return resolved

    return {
      name,
      kind: "invalid" as const,
      repository: resolved.repository,
      message: `Reference conflicts with @${existing.name}: both use ${resolved.path}, but @${existing.name} requests ${branchLabel(existing.branch)} and @${name} requests ${branchLabel(resolved.branch)}`,
    }
  })
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const flags = yield* RuntimeFlags.Service

    const state = yield* InstanceState.make<State>(
      Effect.fn("Reference.state")(function* (ctx) {
        const cfg = yield* config.get()
        const references = resolveAll({
          references: ConfigReference.normalize(cfg.reference ?? {}),
          directory: ctx.directory,
          worktree: ctx.worktree,
        })

        return { references }
      }),
    )

    return Service.of({
      init: Effect.fn("Reference.init")(function* () {}),
      list: Effect.fn("Reference.list")(function* () {
        return yield* InstanceState.use(state, (s) => s.references)
      }),
      get: Effect.fn("Reference.get")(function* (name: string) {
        return yield* InstanceState.use(state, (s) => s.references.find((reference) => reference.name === name))
      }),
      ensure: Effect.fn("Reference.ensure")(function* (_target?: string) {}),
      contains: Effect.fn("Reference.contains")(function* (target?: string) {
        if (!flags.experimentalReferences) return false
        const full = normalizedTarget(target)
        if (!full) return false
        return yield* InstanceState.use(state, (s) => containsGitReferencePath(s.references, full))
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Config.defaultLayer),
  Layer.provide(RuntimeFlags.defaultLayer),
)

export * as Reference from "./reference"
