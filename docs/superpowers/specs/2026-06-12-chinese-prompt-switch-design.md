# Chinese Prompt Switch Design

## Goal

Add a configurable Chinese prompt set so the runtime can load Chinese model-facing instructions without rewriting the existing English prompts in place.

## Scope

- Add a config switch named `prompt_language` with values `en` and `zh`.
- Keep `en` as the default to preserve current behavior unless explicitly configured.
- Add Chinese prompt variants for core session prompts and built-in agent prompts.
- Translate inline system and synthetic prompt text that is sent to the model when `prompt_language` is `zh`.
- Do not add a generic top-level language meta-instruction; the Chinese prompt set should be native Chinese wording.
- Preserve protocol identifiers, tool names, parameter names, JSON fields, XML-like tags, placeholders, file paths, shell commands, and error text when they are part of an interface.

## Out Of Scope

- Historical test recordings and provider fixtures.
- User-authored custom agent prompts.
- Tool description localization in the first change set. Tool descriptions are registered through the tool registry and should be handled as a separate, narrower change to avoid changing tool-call behavior at the same time as the core agent behavior.

## Architecture

Prompt selection should stay close to the existing prompt ownership:

- `ConfigV1.Info` owns `prompt_language`.
- `SystemPrompt.provider(...)` receives the selected language and chooses the matching prompt set.
- `Agent.Service` chooses Chinese built-in agent prompts when configured.
- `SessionReminders`, `ReferencePrompt`, and structured-output reminders render Chinese inline text only when configured.

The switch should not mutate runtime messages after they are built. Each prompt owner should choose the correct string at the source.

## Testing

- Add config schema tests for accepted and rejected `prompt_language` values.
- Add prompt-selection tests proving English remains default and Chinese is selected when configured.
- Add focused tests for built-in agent prompt selection and inline reminder/reference text where practical.
- Run package-level tests from `packages/opencode`, then `bun typecheck`.
