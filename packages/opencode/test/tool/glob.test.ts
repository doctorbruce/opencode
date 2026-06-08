import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { describe, expect } from "bun:test"
import path from "path"
import { Cause, Effect, Exit, Layer } from "effect"
import { GlobTool } from "../../src/tool/glob"
import { SessionID, MessageID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Search } from "@opencode-ai/core/filesystem/search"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Truncate } from "@/tool/truncate"
import { Agent } from "../../src/agent/agent"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Reference } from "@/reference/reference"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Filesystem } from "@/util/filesystem"
import { Permission } from "../../src/permission"
import type * as Tool from "../../src/tool/tool"

const referenceLayer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  Reference.layer.pipe(
    Layer.provide(Config.defaultLayer),
    Layer.provide(RuntimeFlags.layer(flags)),
  )

const toolLayer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  Layer.mergeAll(
    CrossSpawnSpawner.defaultLayer,
    FSUtil.defaultLayer,
    Search.defaultLayer,
    Truncate.defaultLayer,
    Agent.defaultLayer,
    referenceLayer(flags),
  )

const it = testEffect(toolLayer())
const references = testEffect(toolLayer({ experimentalReferences: true }))
const full = (p: string) => (process.platform === "win32" ? Filesystem.normalizePath(p) : p)

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const asks = () => {
  const items: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
  return {
    items,
    next: {
      ...ctx,
      ask: (req: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) =>
        Effect.sync(() => {
          items.push(req)
        }),
    } satisfies Tool.Context,
  }
}

describe("tool.glob", () => {
  it.instance("matches files from a directory path", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "a.ts"), "export const a = 1\n"))
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "b.txt"), "hello\n"))
      const info = yield* GlobTool
      const glob = yield* info.init()
      const result = yield* glob.execute(
        {
          pattern: "*.ts",
          path: test.directory,
        },
        ctx,
      )
      expect(result.metadata.count).toBe(1)
      expect(result.output).toContain(path.join(test.directory, "a.ts"))
      expect(result.output).not.toContain(path.join(test.directory, "b.txt"))
    }),
  )

  it.instance("rejects exact file paths", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const file = path.join(test.directory, "a.ts")
      yield* Effect.promise(() => Bun.write(file, "export const a = 1\n"))
      const info = yield* GlobTool
      const glob = yield* info.init()
      const exit = yield* glob
        .execute(
          {
            pattern: "*.ts",
            path: file,
          },
          ctx,
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause)
        expect(err instanceof Error ? err.message : String(err)).toContain("glob path must be a directory")
      }
    }),
  )

  references.instance(
    "does not ask for external_directory permission inside configured git references",
    () =>
      Effect.gen(function* () {
        yield* TestInstance
        const fs = yield* FSUtil.Service
        const cache = path.join(Global.Path.repos, "github.com", "opencode-glob-reference", "repo")
        yield* fs.remove(cache, { recursive: true }).pipe(Effect.ignore)
        yield* Effect.addFinalizer(() => fs.remove(cache, { recursive: true }).pipe(Effect.ignore))
        yield* fs.writeWithDirs(path.join(cache, "src", "index.ts"), "export const value = 1\n")

        const { items, next } = asks()
        const info = yield* GlobTool
        const glob = yield* info.init()
        const result = yield* glob.execute({ pattern: "*.ts", path: path.join(cache, "src") }, next)

        expect(result.metadata.count).toBe(1)
        expect(full(result.output)).toContain(full(path.join(cache, "src", "index.ts")))
        expect(items.find((item) => item.permission === "external_directory")).toBeUndefined()
      }),
    {
      config: {
        reference: {
          docs: "opencode-glob-reference/repo",
        },
      },
    },
  )
})
