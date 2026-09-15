export * as Artifact from "./artifact"

import { Schema } from "effect"
import { ToolArtifact } from "@opencode-ai/core/tool/artifact"

export const Role = ToolArtifact.Role.annotate({
  description:
    "Use final only for requested user-facing deliverables, including Markdown and JSON; use intermediate or temporary for supporting files.",
})

export const Outputs = Schema.Array(
  Schema.Struct({
    path: Schema.String.check(Schema.isMinLength(1)).annotate({
      description: "Output file path, not a directory or glob.",
    }),
    artifactRole: Role,
  }),
)

export type Output = (typeof Outputs.Type)[number]
