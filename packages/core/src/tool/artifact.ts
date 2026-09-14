export * as ToolArtifact from "./artifact"

import path from "path"
import { Schema } from "effect"

export const Role = Schema.Literals(["final", "intermediate", "temporary"])
export type Role = typeof Role.Type

export const Info = Schema.Struct({
  path: Schema.String,
  relativePath: Schema.String.pipe(Schema.optional),
  artifactRole: Role,
})
export type Info = typeof Info.Type

const finalExtensions = new Set([
  ".csv",
  ".doc",
  ".docx",
  ".gif",
  ".htm",
  ".html",
  ".jpeg",
  ".jpg",
  ".m4a",
  ".mp3",
  ".mp4",
  ".pdf",
  ".png",
  ".ppt",
  ".pptx",
  ".svg",
  ".txt",
  ".wav",
  ".webm",
  ".webp",
  ".xls",
  ".xlsx",
])

export const roleForPath = (value: string): Role => {
  const extension = path.extname(value.split(/[?#]/, 1)[0] ?? "").toLowerCase()
  return finalExtensions.has(extension) ? "final" : "intermediate"
}

export const fromWrite = (input: { readonly target: string; readonly resource: string }, role?: Role): Info => ({
  path: input.target,
  relativePath: path.isAbsolute(input.resource) ? undefined : input.resource,
  artifactRole: role ?? roleForPath(input.resource || input.target),
})

export const fromPaths = (paths: ReadonlyArray<{ readonly target: string; readonly resource: string }>) =>
  paths.map((item) => fromWrite(item))
