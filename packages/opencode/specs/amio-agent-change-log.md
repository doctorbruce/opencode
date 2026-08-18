# Amio Agent Change Log

This document records local fork changes made for Astron Cowork's opencode sidecar. Keep future fork-specific changes here so they can be reviewed without diffing the full upstream project.

## 2026-08-18

### Built-in Astron tool presentation

- Moved Astron's semantic tool activity title generation, execution-sidecar stripping, and tool-part presentation persistence into a built-in host plugin instead of loading a copied Cowork TypeScript plugin.
- Materialized host-owned Effect tool schemas into JSON Schema before invoking `tool.definition` hooks and added the optional `jsonSchema` field to the public plugin hook contract.
- Added regression coverage for built-in registration, schema extension, result metadata, running-part updates, and fast-tool terminal-state restoration.

## 2026-08-17

### Chronological legacy Session behavior across ID rollover

- Stopped the legacy `SessionPrompt` loop from treating lexicographically larger historical message IDs as newer than post-rollover user input.
- Made message selection and pending-task/reminder boundaries use `time.created`, with IDs retained only as same-millisecond tie-breakers, and required a completed assistant to reference the latest user through `parentID` before exiting the loop.
- Made Session forks and revert cleanup/range selection follow persisted chronology or exact message identity instead of ID ordering.
- Added regression coverage proving post-rollover prompts still call the model, forks retain the correct prefix, and revert cleanup keeps earlier history.

## 2026-08-11

### Lazy process-wide runtime config invalidation

- Added `POST /global/config/invalidate` so Astron can publish one process-wide config epoch without enumerating workspace directories or eagerly creating cold runtime instances.
- Made instance HTTP requests adopt the current epoch on first load and lazily refresh cached Config, Agent, and Skill state when an already-loaded directory is stale.
- Added per-directory single-flight refresh semantics so concurrent requests share one refresh, different directories remain independent, cancelled waiters do not cancel shared work, failed refreshes remain retryable, and epoch changes during refresh are followed through to the latest version.
- Kept the existing directory-scoped `/config/reload` endpoint as an explicit compatibility refresh boundary.
- Added focused service and HTTP regression coverage for global invalidation, cold-instance behavior, concurrency, cancellation, retry, and epoch advancement.

## 2026-08-07

### Chinese skill name search

- Made `skill_search` distinguish Chinese capability-list questions from ordinary searches that merely contain words such as `技能` or `能力`.
- Added direct matching when a natural-language query contains a complete Chinese skill name, while preserving exact `select:<skill_name>` lookup.
- Added regression coverage for Chinese skill names in both inventory and natural-language search results.

### Unicode skill IDs

- Corrected the built-in skill authoring guidance to describe the runtime's existing Unicode support: `SKILL.md` frontmatter `name` is the skill ID and may contain Chinese characters.
- Clarified that the containing folder is a safe discovery path segment and does not define or constrain the runtime skill ID.
- Added discovery regression coverage proving a Chinese frontmatter name remains the exact runtime lookup key even when the containing folder has a different safe name.

## 2026-08-06

### Agent Harness design documentation

- Added a narrative design document covering the Amio Agent Harness runtime boundary, prompt lifecycle, workspace routing, dynamic tool and skill loading, plugin runtime, context governance, host protocol, offline startup, and observability.

### Deferred tool discovery index

- Replaced the broad deferred-tool category sentence with a concise tool-family index and explicit guidance for intent search and exact `select:<tool_id>` loading.

## 2026-07-30

### Deferred tool search recall

- Changed `tool_search` from all-terms matching to relevance scoring across tool IDs and descriptions so broad mixed-language intent queries can still discover the appropriate deferred tools.
- Added regression coverage for scheduled-task searches that combine Chinese intent words with `schedule`, `cron`, automation, and workflow terms.

## 2026-07-29

### Offline config plugin runtime

- Removed config-directory dependency installation so the packaged Amio Agent never tries to fetch `@opencode-ai/plugin` while loading a workspace.
- Removed plugin and custom-tool waits for those background installs; external file plugins and tools continue to load through the bundled plugin runtime without local `node_modules`.
- Stopped writing dependency-only `.gitignore`, `package.json`, lockfile, and `node_modules` artifacts into config directories during runtime initialization.

### Offline model catalog

- Disabled runtime `models.dev` refreshes for the Amio Agent binary while retaining the model catalog snapshot embedded at build time as a local fallback.

## 2026-07-21

### Deferred custom tool loading

- Added a model-facing `tool_search` built-in tool so registered custom tools can stay out of the initial provider tool list and be loaded by intent when needed.
- Marked config/plugin custom tools as deferred by default while keeping built-in tools directly available; custom tools can opt out with `deferLoading: false`.
- Added session tool selection coverage so a completed `tool_search` result reveals only the matched deferred tools on the next model step.
- Added concise system guidance telling models to use `tool_search` when a task needs a specialized tool that is not currently in the active tool list, with a category-level hint for common deferred tool areas.
- Kept web search out of the deferred-tool category hint because Astron Cowork exposes `astron-web-search` directly as an active tool.

### Skill search prompt routing

- Added a model-facing `skill_search` built-in tool that returns a small set of currently available skill names and descriptions without loading full skill content or local paths.
- Replaced the full `<available_skills>` system prompt dump with a lightweight available-skill index containing only each skill name and one-line description; full skill bodies and local paths remain loaded only through `skill`.
- Updated the `skill` tool description and schema wording so models do not infer skill names from stale prompt memory.
- Consolidated model-facing skill invocation guidance into the runtime specialized-skills system section so Astron-side assistant boundary prompts can stay short and non-duplicative.
- Preferred `agents/openai.yaml` `interface.short_description` / localized `short_description` values for skill index descriptions, falling back to `SKILL.md` frontmatter only when UI metadata is absent.
- Listed every available skill in the lightweight skill index instead of truncating with an omitted-count placeholder.

### First text-delta latency logging

- Split LLM and session-processor stream latency logs into first reasoning delta and first text delta so Astron Cowork can measure visible assistant-body latency separately from hidden reasoning output.

### Astron Star location prewarm

- Added `POST /experimental/location/prewarm` so Astron Cowork can materialize the 星小妙 workspace's location-scoped services before the user's first model turn, without creating a session or sending a prompt.
- Allowed the prewarm endpoint to accept optional `provider`, `model`, and `agent` query parameters and materialize provider/model-specific tool definitions up front, moving first-turn tool registry initialization out of the visible user request path.

## 2026-07-09

### Preflight context compaction

- Added prompt-level context-window preflight before provider requests so long histories are automatically compacted before they can overflow the model window.
- Kept recoverable provider `ContextOverflowError` as an internal compaction signal when automatic compaction is enabled instead of publishing a user-visible failure first.
- Added regression coverage for preflight compaction and provider overflow recovery without `session.error` events.
- Forwarded opencode compaction start and finish events through ACP `command_status_update` so Astron Cowork shows status-only compression progress during automatic threshold compaction.

## 2026-07-07

### Runtime skill path reload

- Extended `/config/reload` to refresh the opencode Skill service cache after reloading generated config and agents.
- This lets Astron Cowork attach plugins whose app-level skills are exposed through `skills.paths` without disposing or restarting the sidecar instance.

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
- Routed config-scoped custom tools through the same bundled runtime fallback so `tools/*.ts` files also load when the user config directory has no local dependencies.
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

## 2026-07-27

### Bounded PDF reads

- Added Claude Code-style PDF page ranges to the `Read` tool through the optional `pages` parameter.
- PDFs longer than 10 pages now require an explicit range, and each read is limited to 20 pages.
- Full inline PDF reads are capped at 20 MiB; page extraction accepts source PDFs up to 100 MiB and emits a smaller PDF containing only the selected pages.
- Added PDF header validation and clear tool-level errors for invalid ranges, oversized files, and oversized extracted page sets.
- Prompt token estimation now replaces base64 media payloads with bounded metadata placeholders instead of counting encoded binary bytes as ordinary text tokens.
- Added focused regression coverage for small PDFs, required pagination, page extraction, full-file size limits, and media-aware prompt overflow estimation.

### Streaming Write previews over ACP

- Forwarded incremental tool input JSON through transient `message.part.delta` events without executing or persisting partial tool calls.
- The ACP adapter now parses valid partial tool input and emits pending `tool_call_update` payloads so external clients can render Write content while it is generated.
