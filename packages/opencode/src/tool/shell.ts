import { Effect, Exit, Cause, Deferred, Fiber, Option, Scope, Stream } from "effect"
import os from "os"
import { createWriteStream } from "node:fs"
import * as Tool from "./tool"
import path from "path"
import { containsPath, type InstanceContext } from "../project/instance-context"
import { InstanceState } from "@/effect/instance-state"
import { lazy } from "@/util/lazy"
import { Language, type Node } from "web-tree-sitter"

import { FSUtil } from "@opencode-ai/core/fs-util"
import { fileURLToPath } from "url"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Shell } from "@opencode-ai/core/shell"
import { ShellID } from "./shell/id"

import * as Truncate from "./truncate"
import { Plugin } from "@/plugin"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { ShellPrompt, type Parameters } from "./shell/prompt"
import { BashArity } from "@/permission/arity"
import { assertExternalDirectoryEffect } from "./external-directory"
import { Artifact } from "./artifact"
import { ToolProgress } from "@/session/tool-progress"
import { BackgroundJob } from "@/background/job"
import type { TaskPromptOps } from "./task"

export { Parameters } from "./shell/prompt"

const MAX_METADATA_LENGTH = 30_000
const CWD = new Set(["cd", "chdir", "popd", "pushd", "push-location", "set-location"])
const FILES = new Set([
  ...CWD,
  "rm",
  "cp",
  "mv",
  "mkdir",
  "touch",
  "chmod",
  "chown",
  "cat",
  // Leave PowerShell aliases out for now. Common ones like cat/cp/mv/rm/mkdir
  // already hit the entries above, and alias normalization should happen in one
  // place later so we do not risk double-prompting.
  "get-content",
  "set-content",
  "add-content",
  "copy-item",
  "move-item",
  "remove-item",
  "new-item",
  "rename-item",
])
const CMD_FILES = new Set([
  "copy",
  "del",
  "dir",
  "erase",
  "md",
  "mkdir",
  "move",
  "rd",
  "ren",
  "rename",
  "rmdir",
  "type",
])
const FLAGS = new Set(["-destination", "-literalpath", "-path"])
const SWITCHES = new Set(["-confirm", "-debug", "-force", "-nonewline", "-recurse", "-verbose", "-whatif"])

type Part = {
  type: string
  text: string
}

type Scan = {
  dirs: Set<string>
  patterns: Set<string>
  always: Set<string>
}

type Chunk = {
  text: string
  size: number
}

const resolveWasm = (asset: string) => {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  const url = new URL(asset, import.meta.url)
  return fileURLToPath(url)
}

function parts(node: Node) {
  const out: Part[] = []
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (!child) continue
    if (child.type === "command_elements") {
      for (let j = 0; j < child.childCount; j++) {
        const item = child.child(j)
        if (!item || item.type === "command_argument_sep" || item.type === "redirection") continue
        out.push({ type: item.type, text: item.text })
      }
      continue
    }
    if (
      child.type !== "command_name" &&
      child.type !== "command_name_expr" &&
      child.type !== "word" &&
      child.type !== "string" &&
      child.type !== "raw_string" &&
      child.type !== "concatenation"
    ) {
      continue
    }
    out.push({ type: child.type, text: child.text })
  }
  return out
}

function source(node: Node) {
  return (node.parent?.type === "redirected_statement" ? node.parent.text : node.text).trim()
}

function commands(node: Node) {
  return node.descendantsOfType("command").filter((child): child is Node => Boolean(child))
}

function unquote(text: string) {
  if (text.length < 2) return text
  const first = text[0]
  const last = text[text.length - 1]
  if ((first === '"' || first === "'") && first === last) return text.slice(1, -1)
  return text
}

function home(text: string) {
  if (text === "~") return os.homedir()
  if (text.startsWith("~/") || text.startsWith("~\\")) return path.join(os.homedir(), text.slice(2))
  return text
}

function envValue(key: string) {
  if (process.platform !== "win32") return process.env[key]
  const name = Object.keys(process.env).find((item) => item.toLowerCase() === key.toLowerCase())
  return name ? process.env[name] : undefined
}

function auto(key: string, cwd: string, shell: string) {
  const name = key.toUpperCase()
  if (name === "HOME") return os.homedir()
  if (name === "PWD") return cwd
  if (name === "PSHOME") return path.dirname(shell)
}

function expand(text: string, cwd: string, shell: string) {
  const out = unquote(text)
    .replace(/\$\{env:([^}]+)\}/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$(HOME|PWD|PSHOME)(?=$|[\\/])/gi, (_, key: string) => auto(key, cwd, shell) || "")
  return home(out)
}

function provider(text: string) {
  const match = text.match(/^([A-Za-z]+)::(.*)$/)
  if (match) {
    if (match[1].toLowerCase() !== "filesystem") return
    return match[2]
  }
  const prefix = text.match(/^([A-Za-z]+):(.*)$/)
  if (!prefix) return text
  if (prefix[1].length === 1) return text
  return
}

function dynamic(text: string, ps: boolean) {
  if (text.startsWith("(") || text.startsWith("@(")) return true
  if (text.includes("$(") || text.includes("${") || text.includes("`")) return true
  if (ps) return /\$(?!env:)/i.test(text)
  return text.includes("$")
}

function prefix(text: string) {
  const match = /[?*[]/.exec(text)
  if (!match) return text
  if (match.index === 0) return
  return text.slice(0, match.index)
}

function pathArgs(list: Part[], ps: boolean, cmd = false) {
  if (!ps) {
    return list
      .slice(1)
      .filter(
        (item) =>
          !item.text.startsWith("-") &&
          !(cmd && item.text.startsWith("/")) &&
          !(list[0]?.text === "chmod" && item.text.startsWith("+")),
      )
      .map((item) => item.text)
  }

  const out: string[] = []
  let want = false
  for (const item of list.slice(1)) {
    if (want) {
      out.push(item.text)
      want = false
      continue
    }
    if (item.type === "command_parameter") {
      const flag = item.text.toLowerCase()
      if (SWITCHES.has(flag)) continue
      want = FLAGS.has(flag)
      continue
    }
    out.push(item.text)
  }
  return out
}

function preview(text: string) {
  if (text.length <= MAX_METADATA_LENGTH) return text
  return "...\n\n" + text.slice(-MAX_METADATA_LENGTH)
}

function tail(text: string, maxLines: number, maxBytes: number) {
  const lines = text.split("\n")
  if (lines.length <= maxLines && Buffer.byteLength(text, "utf-8") <= maxBytes) {
    return {
      text,
      cut: false,
    }
  }

  const out: string[] = []
  let bytes = 0
  for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
    const size = Buffer.byteLength(lines[i], "utf-8") + (out.length > 0 ? 1 : 0)
    if (bytes + size > maxBytes) {
      if (out.length === 0) {
        const buf = Buffer.from(lines[i], "utf-8")
        let start = buf.length - maxBytes
        if (start < 0) start = 0
        while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++
        out.unshift(buf.subarray(start).toString("utf-8"))
      }
      break
    }
    out.unshift(lines[i])
    bytes += size
  }
  return {
    text: out.join("\n"),
    cut: true,
  }
}

const parse = Effect.fn("ShellTool.parse")(function* (command: string, ps: boolean) {
  const tree = yield* Effect.promise(() => parser().then((p) => (ps ? p.ps : p.bash).parse(command)))
  if (!tree) throw new Error("Failed to parse command")
  return tree
})

const ask = Effect.fn("ShellTool.ask")(function* (ctx: Tool.Context, scan: Scan, input: { command: string }) {
  if (scan.dirs.size > 0) {
    const directories = Array.from(scan.dirs)
    const globs = directories.map((dir) => {
      if (process.platform === "win32") return FSUtil.normalizePathPattern(path.join(dir, "*"))
      return path.join(dir, "*")
    })
    yield* ctx.ask({
      permission: "external_directory",
      patterns: globs,
      always: globs,
      metadata: {
        command: input.command,
        directories,
        patterns: globs,
      },
    })
  }

  if (scan.patterns.size === 0) return
  yield* ctx.ask({
    permission: ShellID.ToolID,
    patterns: Array.from(scan.patterns),
    always: Array.from(scan.always),
    metadata: {
      command: input.command,
    },
  })
})

function cmd(shell: string, command: string, cwd: string, env: NodeJS.ProcessEnv) {
  if (process.platform === "win32" && Shell.ps(shell)) {
    // PowerShell inherits the service code page, while shell output is decoded as UTF-8 below.
    return ChildProcess.make(
      shell,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding; ${command}`,
      ],
      {
        cwd,
        env,
        stdin: "ignore",
        detached: false,
      },
    )
  }

  return ChildProcess.make(command, [], {
    shell,
    cwd,
    env,
    stdin: "ignore",
    detached: process.platform !== "win32",
  })
}
const parser = lazy(async () => {
  const { Parser } = await import("web-tree-sitter")
  const { default: treeWasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, {
    with: { type: "wasm" },
  })
  const treePath = resolveWasm(treeWasm)
  await Parser.init({
    locateFile() {
      return treePath
    },
  })
  const { default: bashWasm } = await import("tree-sitter-bash/tree-sitter-bash.wasm" as string, {
    with: { type: "wasm" },
  })
  const { default: psWasm } = await import("tree-sitter-powershell/tree-sitter-powershell.wasm" as string, {
    with: { type: "wasm" },
  })
  const bashPath = resolveWasm(bashWasm)
  const psPath = resolveWasm(psWasm)
  const [bashLanguage, psLanguage] = await Promise.all([Language.load(bashPath), Language.load(psPath)])
  const bash = new Parser()
  bash.setLanguage(bashLanguage)
  const ps = new Parser()
  ps.setLanguage(psLanguage)
  return { bash, ps }
})

/** Cap for a detached command's spooled output file; the process keeps running. */
const SPOOL_LIMIT_BYTES = 1024 * 1024 * 1024

/** Shared state between the foreground call and a command that outlives it. */
type ShellProgress = {
  preview: string
  detached: boolean
  spool?: { stream: ReturnType<typeof createWriteStream>; written: number; truncated: boolean }
}

type ShellRunResult = {
  title: string
  metadata: { output: string; exit: number | null; truncated: boolean; outputPath?: string }
  output: string
}

type ShellMetadata = {
  output: string
  exit: number | null
  truncated: boolean
  outputPath?: string
  outputs: Artifact.Output[]
  background?: boolean
  jobId?: string
  wallTimeMs?: number
}

export const ShellTool = Tool.define(
  ShellID.ToolID,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const spawner = yield* ChildProcessSpawner
    const fs = yield* FSUtil.Service
    const trunc = yield* Truncate.Service
    const plugin = yield* Plugin.Service
    const flags = yield* RuntimeFlags.Service
    const background = yield* BackgroundJob.Service
    const scope = yield* Scope.Scope
    const defaultTimeoutMs = flags.bashDefaultTimeoutMs ?? 2 * 60 * 1000
    const defaultYieldMs = flags.bashYieldMs ?? 15_000

    const cygpath = Effect.fn("ShellTool.cygpath")(function* (shell: string, text: string) {
      const lines = yield* spawner
        .lines(ChildProcess.make(shell, ["-lc", 'cygpath -w -- "$1"', "_", text]))
        .pipe(Effect.catch(() => Effect.succeed([] as string[])))
      const file = lines[0]?.trim()
      if (!file) return
      return FSUtil.normalizePath(file)
    })

    const resolvePath = Effect.fn("ShellTool.resolvePath")(function* (text: string, root: string, shell: string) {
      if (process.platform === "win32") {
        if (Shell.posix(shell) && text.startsWith("/") && FSUtil.windowsPath(text) === text) {
          const file = yield* cygpath(shell, text)
          if (file) return file
        }
        return FSUtil.normalizePath(path.resolve(root, FSUtil.windowsPath(text)))
      }
      return path.resolve(root, text)
    })

    const argPath = Effect.fn("ShellTool.argPath")(function* (arg: string, cwd: string, ps: boolean, shell: string) {
      const text = ps ? expand(arg, cwd, shell) : home(unquote(arg))
      const file = text && prefix(text)
      if (!file || dynamic(file, ps)) return
      const next = ps ? provider(file) : file
      if (!next) return
      return yield* resolvePath(next, cwd, shell)
    })

    const collect = Effect.fn("ShellTool.collect")(function* (
      root: Node,
      cwd: string,
      ps: boolean,
      shell: string,
      instance: InstanceContext,
    ) {
      const scan: Scan = {
        dirs: new Set<string>(),
        patterns: new Set<string>(),
        always: new Set<string>(),
      }
      const shellKind = ShellID.toKind(Shell.name(shell))

      for (const node of commands(root)) {
        const command = parts(node)
        const tokens = command.map((item) => item.text)
        const cmd = ps || shellKind === "cmd" ? tokens[0]?.toLowerCase() : tokens[0]

        if (cmd && (FILES.has(cmd) || (shellKind === "cmd" && CMD_FILES.has(cmd)))) {
          for (const arg of pathArgs(command, ps, shellKind === "cmd")) {
            const resolved = yield* argPath(arg, cwd, ps, shell)
            yield* Effect.logInfo("resolved path", { arg, resolved })
            if (!resolved || containsPath(resolved, instance)) continue
            const dir = (yield* fs.isDir(resolved)) ? resolved : path.dirname(resolved)
            scan.dirs.add(dir)
          }
        }

        if (tokens.length && (!cmd || !CWD.has(cmd))) {
          scan.patterns.add(source(node))
          scan.always.add(BashArity.prefix(tokens).join(" ") + " *")
        }
      }

      return scan
    })

    const shellEnv = Effect.fn("ShellTool.shellEnv")(function* (ctx: Tool.Context, cwd: string) {
      const extra = yield* plugin.trigger(
        "shell.env",
        { cwd, sessionID: ctx.sessionID, callID: ctx.callID },
        { env: {} },
      )
      return {
        ...process.env,
        ...extra.env,
      }
    })

    const run = Effect.fn("ShellTool.run")(function* (
      input: {
        shell: string
        command: string
        cwd: string
        env: NodeJS.ProcessEnv
        timeout: number
      },
      ctx: Tool.Context,
      progress: ShellProgress,
    ) {
      const limits = yield* trunc.limits()
      const keep = limits.maxBytes * 2
      let full = ""
      let last = ""
      const list: Chunk[] = []
      let used = 0
      let file = ""
      let sink: ReturnType<typeof createWriteStream> | undefined
      let cut = false
      let expired = false
      let aborted = false

      const closeSink = Effect.fnUntraced(function* () {
        const stream = sink
        if (!stream) return
        sink = undefined
        if (stream.destroyed || stream.closed) return
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              let settled = false
              const done = () => {
                if (settled) return
                settled = true
                stream.off("close", done)
                stream.off("error", done)
                stream.off("finish", done)
                resolve()
              }
              stream.once("close", done)
              stream.once("error", done)
              stream.once("finish", done)
              stream.end(done)
            }),
        ).pipe(Effect.catch(() => Effect.void))
      })

      yield* ctx.metadata({
        metadata: {
          output: "",
        },
      })

      const code: number | null = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.addFinalizer(closeSink)
          const handle = yield* spawner.spawn(cmd(input.shell, input.command, input.cwd, input.env))

          yield* Effect.forkScoped(
            Stream.runForEach(Stream.decodeText(handle.all), (chunk) => {
              const size = Buffer.byteLength(chunk, "utf-8")
              list.push({ text: chunk, size })
              used += size
              while (used > keep && list.length > 1) {
                const item = list.shift()
                if (!item) break
                used -= item.size
                cut = true
              }

              last = preview(last + chunk)
              progress.preview = last

              // A command that outlives its tool call keeps writing here so the
              // job stays readable while it runs. The detach path seeds the file
              // with everything captured up to that point. The cap keeps a
              // runaway producer from filling the disk now that a detached
              // command is no longer bounded by the call timeout.
              if (progress.spool) {
                if (progress.spool.written < SPOOL_LIMIT_BYTES) {
                  progress.spool.stream.write(chunk)
                  progress.spool.written += size
                } else if (!progress.spool.truncated) {
                  progress.spool.truncated = true
                  progress.spool.stream.write(
                    `\n[output spool truncated at ${SPOOL_LIMIT_BYTES} bytes; the command keeps running]\n`,
                  )
                }
              }

              if (file) {
                sink?.write(chunk)
              } else {
                full += chunk
                if (Buffer.byteLength(full, "utf-8") > limits.maxBytes) {
                  return trunc.write(full).pipe(
                    Effect.andThen((next) =>
                      Effect.sync(() => {
                        file = next
                        cut = true
                        sink = createWriteStream(next, { flags: "a" })
                        full = ""
                      }),
                    ),
                    Effect.andThen(
                      ctx.metadata({
                        metadata: {
                          output: last,
                        },
                      }),
                    ),
                  )
                }
              }

              return ctx.metadata({
                metadata: {
                  output: last,
                },
              })
            }),
          )

          const abort = Effect.callback<void>((resume) => {
            // A detached command outlives its turn: the request signal aborts
            // when the turn ends, and following it would kill the job that the
            // model was told is still running. Job cancellation is what stops a
            // detached command.
            const handler = () => {
              if (progress.detached) return
              resume(Effect.void)
            }
            if (ctx.abort.aborted) {
              handler()
              return
            }
            ctx.abort.addEventListener("abort", handler, { once: true })
            return Effect.sync(() => ctx.abort.removeEventListener("abort", handler))
          })

          // The call timeout only bounds waiting on the command. Once it moves
          // to the background it stops applying: the model stops that job with
          // `job_kill` instead.
          const timeout = Effect.sleep(`${input.timeout + 100} millis`).pipe(
            Effect.flatMap(() => (progress.detached ? Effect.never : Effect.void)),
          )

          const exit = yield* Effect.raceAll([
            handle.exitCode.pipe(Effect.map((code) => ({ kind: "exit" as const, code }))),
            abort.pipe(Effect.map(() => ({ kind: "abort" as const, code: null }))),
            timeout.pipe(Effect.map(() => ({ kind: "timeout" as const, code: null }))),
          ])

          if (exit.kind === "abort") {
            aborted = true
            yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
          }
          if (exit.kind === "timeout") {
            expired = true
            yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
          }

          return exit.kind === "exit" ? exit.code : null
        }),
      ).pipe(Effect.orDie)

      const meta: string[] = []
      if (expired) {
        meta.push(
          `shell tool terminated command after exceeding timeout ${input.timeout} ms. If this command is expected to take longer and is not waiting for interactive input, retry with a larger timeout value in milliseconds.`,
        )
      }
      if (aborted) {
        // Distinguish a silence timeout from a user abort: both surface through
        // `ctx.abort`, and mislabeling the former makes the model report the
        // wrong cause to the user.
        meta.push(
          ToolProgress.isSilenceReason(ctx.abort.reason)
            ? `Command terminated by the silence timeout: no output for ${Math.max(
                1,
                Math.round(ctx.abort.reason.quietMs / 60_000),
              )} minutes.`
            : "User aborted the command",
        )
      }
      const raw = list.map((item) => item.text).join("")
      const end = tail(raw, limits.maxLines, limits.maxBytes)
      if (end.cut) cut = true
      if (!file && end.cut) {
        file = yield* trunc.write(raw)
      }

      let output = end.text
      if (!output) output = "(no output)"

      if (cut && file) {
        output = `...output truncated...\n\nFull output saved to: ${file}\n\n` + output
      }

      if (meta.length > 0) {
        output += "\n\n<shell_metadata>\n" + meta.join("\n") + "\n</shell_metadata>"
      }
      return {
        title: input.command,
        metadata: {
          output: last || preview(output),
          exit: code,
          truncated: cut,
          ...(cut && file ? { outputPath: file } : {}),
        },
        output,
      }
    })

    // Both the foreground and the detached branch return this shape; annotating
    // it keeps the tool's metadata type from collapsing to one branch.
    const toolResult = (input: {
      title: string
      metadata: ShellMetadata
      output: string
    }): Tool.ExecuteResult<ShellMetadata> => input

    // Moves an unfinished command to a background job and hands the model a
    // handle instead of a result. The command keeps running in the tool scope.
    const detach = Effect.fn("ShellTool.detach")(function* (
      params: Parameters,
      ctx: Tool.Context,
      progress: ShellProgress,
      done: Deferred.Deferred<Exit.Exit<ShellRunResult, unknown>>,
      fiber: Fiber.Fiber<ShellRunResult, unknown>,
      cwd: string,
    ) {
      // Ignore the turn's abort from here on: the command is no longer this
      // call's work, and job cancellation is what stops it.
      progress.detached = true

      // Seed through the truncation writer so the initial output is durable
      // before the first job_output read; the stream only appends later chunks.
      const outputPath = yield* trunc.write(progress.preview)
      const stream = createWriteStream(outputPath, { flags: "a" })
      progress.spool = { stream, written: Buffer.byteLength(progress.preview, "utf-8"), truncated: false }

      const info = yield* background.start({
        type: "bash",
        title: params.command,
        metadata: {
          parentSessionId: ctx.sessionID,
          background: true,
          outputPath,
          command: params.command,
          workdir: cwd,
        },
        run: Deferred.await(done).pipe(
          Effect.flatMap((exit) =>
            Exit.isSuccess(exit) ? Effect.succeed(exit.value.output) : Effect.failCause(exit.cause),
          ),
          Effect.onInterrupt(() => Fiber.interrupt(fiber)),
        ),
      })

      yield* notifyBackgroundResult(ctx, done, info, outputPath)

      return toolResult({
        title: params.command,
        metadata: {
          output: progress.preview,
          exit: null,
          truncated: false,
          background: true,
          jobId: info.id,
          outputPath,
          wallTimeMs: Math.max(0, Date.now() - info.started_at),
          outputs: [] as Artifact.Output[],
        },
        output: [
          progress.preview || "(no output yet)",
          "",
          `Background job ${info.id}: the command is still running ([wall time: ${ToolProgress.formatWallTime(
            Date.now() - info.started_at,
          )}]). Output is written to: ${outputPath}`,
          "`job_output` reads it (or waits with `wait_ms`), `job_kill` stops it, and you are notified when it finishes.",
        ].join("\n"),
      })
    })

    const notifyBackgroundResult = Effect.fnUntraced(function* (
      ctx: Tool.Context,
      done: Deferred.Deferred<Exit.Exit<ShellRunResult, unknown>>,
      info: BackgroundJob.Info,
      outputPath: string,
    ) {
      const ops = ctx.extra?.promptOps as TaskPromptOps | undefined
      if (!ops) return
      yield* Deferred.await(done).pipe(
        Effect.flatMap((exit) => {
          const wall = ToolProgress.formatWallTime(Math.max(0, Date.now() - info.started_at))
          const summary = Exit.isSuccess(exit)
            ? [
                `Background job ${info.id} finished with exit code ${exit.value.metadata.exit ?? "null"} after ${wall}.`,
                "",
                ToolProgress.tail(exit.value.output),
                "",
                `Full output: ${outputPath}`,
              ].join("\n")
            : Cause.hasInterruptsOnly(exit.cause)
              ? `Background job ${info.id} was cancelled after ${wall}.`
              : `Background job ${info.id} failed after ${wall}: ${String(Cause.squash(exit.cause))}`
          return ops.prompt({
            sessionID: ctx.sessionID,
            agent: ctx.agent,
            parts: [{ type: "text", synthetic: true, text: `[amio:background]\n${summary}` }],
          })
        }),
        Effect.ignore,
        Effect.forkIn(scope, { startImmediately: true }),
      )
    })

    return () =>
      Effect.gen(function* () {
        const cfg = yield* config.get()
        const shell = Shell.acceptable(cfg.shell)
        const name = Shell.name(shell)
        const limits = yield* trunc.limits()
        const prompt = ShellPrompt.render(name, process.platform, limits, defaultTimeoutMs, defaultYieldMs)
        yield* Effect.logInfo("shell tool using shell", { shell })

        return {
          description: prompt.description,
          parameters: prompt.parameters,
          execute: (params: Parameters, ctx: Tool.Context) =>
            Effect.gen(function* () {
              const instanceCtx = yield* InstanceState.context
              const cwd = params.workdir
                ? yield* resolvePath(params.workdir, instanceCtx.directory, shell)
                : instanceCtx.directory
              if (params.timeout !== undefined && params.timeout < 0) {
                throw new Error(`Invalid timeout value: ${params.timeout}. Timeout must be a positive number.`)
              }
              const timeout = params.timeout ?? defaultTimeoutMs
              const declared = yield* Effect.forEach(params.outputs ?? [], (item) =>
                Effect.gen(function* () {
                  const filepath = yield* resolvePath(item.path, cwd, shell)
                  yield* assertExternalDirectoryEffect(ctx, filepath)
                  return { path: filepath, artifactRole: item.artifactRole }
                }),
              )
              const ps = Shell.ps(shell)
              yield* Effect.scoped(
                Effect.gen(function* () {
                  const tree = yield* Effect.acquireRelease(parse(params.command, ps), (tree) =>
                    Effect.sync(() => tree.delete()),
                  )
                  const scan = yield* collect(tree.rootNode, cwd, ps, shell, instanceCtx)
                  if (!containsPath(cwd, instanceCtx)) scan.dirs.add(cwd)
                  yield* ask(ctx, scan, params)
                }),
              )

              const yieldMs = params.yieldMs ?? defaultYieldMs
              const progress: ShellProgress = { preview: "", detached: false }
              const done = yield* Deferred.make<Exit.Exit<ShellRunResult, unknown>>()
              // The command runs in the tool layer's scope so a detached command
              // outlives this call; job cancellation interrupts this fiber, which
              // closes the spawn scope and kills the process.
              const fiber = yield* run(
                {
                  shell,
                  command: params.command,
                  cwd,
                  env: yield* shellEnv(ctx, cwd),
                  timeout,
                },
                ctx,
                progress,
              ).pipe(
                Effect.onExit((exit) => Deferred.succeed(done, exit).pipe(Effect.asVoid)),
                Effect.forkIn(scope, { startImmediately: true }),
              )

              const settled = yield* Deferred.await(done).pipe(Effect.timeoutOption(`${Math.max(1, yieldMs)} millis`))
              if (Option.isNone(settled)) return yield* detach(params, ctx, progress, done, fiber, cwd)

              const exit = settled.value
              // The caller's tool wrapper already turns failures into defects, so
              // keep this effect's error channel empty.
              if (Exit.isFailure(exit)) return yield* Effect.die(Cause.squash(exit.cause))
              const result = exit.value
              const outputs: Artifact.Output[] = []
              const warnings: string[] = []
              if (result.metadata.exit === 0 && !ctx.abort.aborted) {
                for (const item of declared) {
                  const canonical = yield* fs.realPath(item.path).pipe(Effect.option)
                  if (canonical._tag === "None") {
                    warnings.push(`Declared output is missing or unreadable: ${item.path}`)
                    continue
                  }
                  yield* assertExternalDirectoryEffect(ctx, canonical.value)
                  const stat = yield* fs.stat(canonical.value).pipe(Effect.option)
                  if (stat._tag === "None" || stat.value.type !== "File") {
                    warnings.push(`Declared output is not a readable regular file: ${item.path}`)
                    continue
                  }
                  if (!outputs.some((output) => output.path === canonical.value))
                    outputs.push({ path: canonical.value, artifactRole: item.artifactRole })
                }
              }
              return toolResult({
                ...result,
                metadata: { ...result.metadata, outputs },
                output: warnings.length
                  ? `${result.output}\n\nArtifact warnings:\n${warnings.join("\n")}`
                  : result.output,
              })
            }),
        }
      })
  }),
)
