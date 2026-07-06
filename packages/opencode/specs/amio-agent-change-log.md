# Amio Agent Change Log

This document records local fork changes made for Astron Cowork's opencode sidecar. Keep future fork-specific changes here so they can be reviewed without diffing the full upstream project.

## 2026-07-06

### Subagent permission inheritance

- Task-spawned subagents now inherit the parent agent's `external_directory` rules, so Astron full-access assistants do not re-prompt when a subagent reads the same external workspace.
- Kept parent session deny rules as hard child-session ceilings and preserved subagent-specific tool restrictions such as default `todowrite` and nested `task` denies.

## 2026-07-02

### Compaction summary tool suppression

- Forced compaction summary requests to use `toolChoice: "none"` so provider-side or gateway-side tools such as `webfetch` cannot interrupt summary generation.
- Derived compaction status `afterMessageID` from the raw transcript instead of the filtered model context, keeping the progress notice anchored after the visible transcript tail even after repeated manual compactions.

## 2026-07-01

### Cowork compaction controls

- Added `compaction.threshold_tokens` so Astron Cowork can set an explicit proactive auto-compaction trigger in tokens instead of relying only on model context limits.
- Kept `compaction.auto: false` as the switch that disables automatic compaction, including provider overflow recovery; `threshold_tokens` only controls the proactive threshold while auto-compaction remains enabled.
- Preserved v1-to-v2 config migration so generated Cowork config keeps the threshold in normalized config entries.
- Localized the synthetic auto-compaction continue prompt to Chinese for Astron Cowork sessions.
- Suppressed compaction summary assistant content in the ACP projection so Cowork can show status-only compaction progress while keeping the stored summary available for future turns.
- Added explicit `messageID` and `reason` metadata to `session.compacted` so Astron Cowork can finish manual compaction prompts without treating runtime idle as a fallback signal.
- Added `session.compaction.started` with explicit compaction summary message metadata so Cowork can hide summary usage and content before any summary parts finish.
- Added `afterMessageID` to compaction status events so Cowork can place compression progress after the visible transcript tail without inferring from client-side timing.

## 2026-06-30

### ACP tool update message identity

- Added `messageId` and `partId` to opencode's ACP `tool_call` and `tool_call_update` projections so downstream chat renderers can attach tool cards to the originating assistant message instead of inferring from the latest assistant bubble.
- Added regression coverage for the tool-first shell update path.

### Bundled external tool plugin runtime

- Added an amio-agent runtime fallback for external tool plugins that import `@opencode-ai/plugin` from user config directories without a local `node_modules`.
- The fallback bundles the external plugin entry with an opencode-provided plugin API shim instead of requiring Astron Cowork to copy an `opencode-runtime-template` dependency tree into each user profile.
- Added standalone binary regression coverage that loads an external tool plugin from an isolated directory with no local dependencies.
- Added standalone binary regression coverage for bundled provider dependencies such as `@ai-sdk/openai-compatible`, confirming they load without a user-profile dependency template.

## 2026-06-29

### Upstream dev sync

- Merged latest `upstream/dev` from the original opencode repository into the fork `dev` branch.
- Preserved fork-specific permission display metadata while adapting it to upstream's new `@opencode-ai/schema` package split.
- Preserved the sidecar behavior that does not auto-download ripgrep; runtime still requires `rg` on PATH or in the configured bin directory.
- Preserved Chinese prompt routing while adopting upstream MCP instruction injection and max-step prompt relocation.
- Regenerated the JavaScript SDK after resolving OpenAPI/schema merge conflicts.
- Relaxed the slow Windows shell-queue regression timeout after verifying the queued loop callers still coalesce to one LLM request.
- Materialized the app and enterprise custom-elements declarations so Windows checkouts do not typecheck upstream symlink targets as TypeScript source.

## 2026-06-16

### Assistant workspace prompt routing

- Added a config reload HTTP endpoint so Astron Cowork can reload generated assistant agents without disposing the sidecar instance.
- Local session-scoped HTTP routing now prefers explicit `directory` query/header hints over the stored session directory when no remote workspace target is selected.
- This keeps newly-created assistant prompts on the assistant workspace instance, allowing the generated `assistant-direct-*` agents to be resolved immediately.

## 2026-06-05

### Serve-only sidecar entry

- Added a dedicated `amio-agent` CLI entrypoint in `src/amio-agent.ts`.
- Added `src/cli/amio-agent.ts` to register only `serve`.
- Added `--amio-agent` support to `script/build.ts`.
- Added `script/build-target.ts` to separate binary naming and entrypoint selection.
- `--amio-agent` builds `dist/opencode-windows-x64/bin/amio-agent.exe`.
- Default `opencode` build behavior remains unchanged.

### Web UI and TUI trimming

- `amio-agent` does not import/register TUI or Web UI commands.
- `amio-agent` sets `OPENCODE_DISABLE_WEB_UI_ROUTES=1`.
- `serve` forwards `disableWebUiRoutes` into server route creation.
- HTTP API Web UI fallback routes are skipped when disabled.
- Web UI serving code is imported lazily only when Web UI routes are enabled.

### GitHub reference materialization disabled

- Removed automatic configured git reference materialization from `Reference.Service`.
- `Reference.init()` and `Reference.ensure(...)` no longer clone, fetch, or refresh GitHub repositories.
- `grep`, `glob`, and `read` still work against already-existing local reference cache paths, but they no longer trigger GitHub downloads.
- `RepositoryCache` source remains present, but the production `Reference` path no longer depends on it.

### Faster write tool defaults for sidecar

- Added runtime flags:
  - `OPENCODE_DISABLE_WRITE_FORMAT`
  - `OPENCODE_DISABLE_WRITE_DIAGNOSTICS`
- `write` skips formatter execution when `OPENCODE_DISABLE_WRITE_FORMAT=1`.
- `write` skips LSP touch/diagnostics when `OPENCODE_DISABLE_WRITE_DIAGNOSTICS=1`.
- `amio-agent` sets both flags by default for faster sidecar writes.
- Standard `opencode` keeps the original formatter and LSP diagnostics behavior unless those env vars are explicitly set.

### Windows read path fix

- `read` now handles Windows absolute paths without a drive prefix, such as `/Users/...`, by anchoring them to the current instance drive before normalization.
- This avoids resolving such paths against the wrong drive.

### Build and verification notes

- Latest verified amio-agent build command:

```powershell
cd E:\Projects\amio-opencode\opencode\packages\opencode
bun run script/build.ts --single --amio-agent --skip-install
```

- Latest verified output:

```text
dist/opencode-windows-x64/bin/amio-agent.exe
```

- Relevant verification commands run during this change set:

```powershell
bun test test/cli/amio-agent.test.ts test/cli/serve-options.test.ts test/cli/amio-agent-build.test.ts test/server/httpapi-ui.test.ts
bun test test/reference/reference.test.ts
bun test test/tool/grep.test.ts test/tool/glob.test.ts test/tool/read.test.ts
bun test test/session/prompt.test.ts -t "reference"
bun test test/tool/write.test.ts
bun test test/effect/runtime-flags.test.ts test/cli/amio-agent.test.ts
bun typecheck
bun run script/build.ts --single --amio-agent --skip-install
```

## 2026-06-08

### Continue prompt loop on unknown finish

- Fixed prompt loop handling for assistant messages with `finish="unknown"`.
- The outer loop no longer treats `unknown` as a confirmed terminal finish when there are no pending tool calls.
- This prevents silent early exits after empty or unrecognized provider stream finishes.
- Added a regression test that queues an `unknown` finish followed by a normal model response and verifies the loop continues to the second request.

### Stable amio-agent build version

- `--amio-agent` builds now default `OPENCODE_VERSION` to `packages/opencode/package.json` version when the env var is not explicitly set.
- This makes `amio-agent --version` return a published npm-compatible version such as `1.16.2` instead of `0.0.0-dev-...`.
- Explicit `OPENCODE_VERSION=...` still wins for custom builds.
- Standard opencode dev builds keep the original preview version behavior.
- `script/build.ts` now accepts `--target-os=win32,darwin` so sidecar builds can skip Linux cross-runtime downloads when only desktop Windows and macOS packages are needed.
- `script/build.ts` now accepts `--compile-executable-dir=<dir>` for predownloaded Bun runtimes, using `<dir>/bun-darwin-arm64/bun` and similar target folders to work around interrupted GitHub runtime downloads.

## 2026-06-10

### Shell prompt PowerShell guidance

- Strengthened the shell tool prompt for `powershell` and `pwsh` by documenting Windows PowerShell 5.1 versus PowerShell 7+ syntax differences.
- The prompt now warns that Windows PowerShell 5.1 does not support `&&`, `||`, ternary, null-coalescing, or null-conditional operators.
- The prompt now warns about native executable `2>&1` behavior, Windows PowerShell 5.1 default UTF-16 LE file encoding, and missing `ConvertFrom-Json -AsHashtable`.
- Added guidance for PowerShell interpolation before a colon, such as using `${name}:` or the `-f` format operator instead of `$name:`.
- Reworded PowerShell and cmd prompt text so those branches no longer describe commands as "bash tool calls" while keeping the exposed compatibility tool ID as `bash`.

## 2026-06-11

### Prompt-scoped completion events

- Added opencode `prompt.completed` and `prompt.failed` EventV2 events from `SessionPrompt.prompt`.
- `prompt.completed` includes `sessionID`, `promptID`, `userMessageID`, `assistantMessageID`, and `stopReason`.
- `prompt.failed` includes `sessionID`, `promptID`, `userMessageID`, optional `assistantMessageID`, and a normalized error payload.
- These events let the Astron sidecar finish a specific `session/prompt` request from prompt-scoped runtime events instead of inferring completion from deprecated `session.idle`.
- `session.idle` should now be treated as session status only by the Astron adapter; prompt result/error handling should use the new prompt events.

## 2026-06-12

### Prompt lifecycle finalization

- Added `requestID` to `SessionPrompt.PromptInput` so Astron can pass its JSON-RPC request id through the opencode prompt boundary.
- Extended `prompt.completed` with optional `requestID`, `finishReason`, and `usage` fields.
- Extended `prompt.failed` with optional `requestID`, `finishReason`, `usage`, plus `stopReason:"error"`.
- Added `prompt.cancelled` for cancelled prompt turns, so `MessageAbortedError` is no longer projected as a normal prompt failure.
- `usage` is emitted from the assistant message `cost` and `tokens` captured by opencode, keeping prompt-scoped accounting on the runtime side.

### Chinese prompt switch

- Added `prompt_language` config with `en` and `zh` values; `en` remains the default.
- Added Chinese prompt variants for built-in session prompts and native agent prompts.
- Routed `prompt_language: "zh"` through provider prompt selection, built-in agent prompts, environment context, skills context, plan/build reminders, structured-output reminders, max-step reminders, and invalid reference reminders.
- Kept custom user agent prompts unchanged and preserved tool/protocol identifiers, parameter names, tags, paths, and schema/tool names inside localized prompt text.
- The Chinese prompt set is native localized wording rather than a generic top-level language meta-instruction.
- Added regression coverage for completed, failed, and cancelled prompt-scoped events.

### Change log requirement

- Added a root `AGENTS.md` rule requiring every project modification to be recorded in `packages/opencode/specs/amio-agent-change-log.md` in the same change set.

### Session archive restore via HTTP API

- `PATCH /session/:sessionID` now accepts `{"time":{"archived":null}}` to clear `time.archived` and restore an archived session.
- `{"time":{}}` remains a no-op so omitted fields keep their existing update semantics.
- The session projector now writes `NULL` for unarchived session snapshots so clearing `time.archived` persists instead of leaving the old SQL value in place.
- The public OpenAPI schema and generated JavaScript SDK now expose `session.update` archive timestamps as `number | null`.
- Added HTTP API and OpenAPI regression coverage for archive clearing.

## 2026-06-15

### Prompt first-token diagnostics

- Added prompt size diagnostics to the session LLM runtime without logging prompt contents.
- The runtime now logs raw and prepared message counts, content part counts, estimated character totals, largest message size, role/type distributions, active tool counts, and max output tokens.
- The AI SDK path now logs when `streamText` is created, when the provider prompt is transformed, the first raw AI SDK stream event, the first normalized LLM event, and the first content delta.
- `SessionProcessor.process` now logs the time from processor start and `llm.stream` request to the first normalized LLM event and first content delta.
- These diagnostics help determine whether slow perceived first tokens come from oversized history, local preparation, AI SDK/provider TTFB, or downstream processor/event handling.

### Permission display metadata

- Added optional `display` to `PermissionV1.Request` / `PermissionV1.AskInput`.
- `display` can carry `uiKind`, `title`, `rawInput`, `locations`, `previewCard`, `formSchema`, and `toolCallId`.
- `Permission.ask` now preserves `display` in pending requests, `permission.asked` events, and permission list responses.
- The opencode ACP permission projection now prefers `display.toolCallId`, `display.title`, `display.rawInput`, and `display.locations` when present.
- Regenerated the JavaScript SDK v2 types so `permission.asked` consumers can see the new field.
- This gives Astron a prompt/runtime-produced permission UI contract and reduces adapter-side parsing of mail, credential, and edit preview metadata.

### Upstream dev merge preservation

- Merged the latest upstream `dev` branch while preserving Astron sidecar fork behavior.
- Kept `disableWebUiRoutes` support on the new upstream HTTP route graph so `amio-agent` can continue serving API-only sidecar routes.
- Adapted the `amio-agent` entrypoint to upstream's new observability environment variables after the old `core/util/log` helper was removed.
- Reapplied prompt first-token diagnostics on top of upstream's Effect logging path.
- Preserved `prompt_language` routing for provider prompts, environment context, skills, reminders, structured output, and max-step prompts while adopting upstream core reference guidance.
- Removed the new upstream ripgrep auto-download fallback; the runtime now uses `rg` from PATH or the local opencode bin directory and fails clearly if it is missing.
- Regenerated the JavaScript SDK v2 output after the merge so prompt lifecycle events, permission display metadata, session archive nullability, and upstream API additions stay in sync.

### ACP context usage

- Changed ACP `usage_update.used` to report the latest assistant message's total context tokens, preferring `tokens.total` and otherwise summing input, output, reasoning, and cache tokens.
- This aligns Astron context-window display with Codex-style current-window usage instead of reporting only non-cached input plus cache read tokens.
