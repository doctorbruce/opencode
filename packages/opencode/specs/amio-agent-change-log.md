# Amio Agent Change Log

This document records local fork changes made for Astron Cowork's opencode sidecar. Keep future fork-specific changes here so they can be reviewed without diffing the full upstream project.

## 2026-09-18

### Keep sessions usable when model output reaches its token limit

- Treat provider `finish=length` as an incomplete but valid completion instead of persisting `MessageOutputLengthError` and publishing `session.error` / `prompt.failed`.
- Preserve partial text and usage, publish `prompt.completed` with `stopReason=max_tokens` and `finishReason=length`, and keep the same Session available for the next prompt.
- Use the model's declared output limit by default instead of imposing the fork's 32,000-token cap. `OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX` remains available when an operator explicitly wants a lower ceiling.
- Preserve genuine provider errors even if the provider also reports `finish=length`; only an otherwise successful length finish uses the recoverable completion path.

## 2026-09-17

### Write the runtime layout under `amio` instead of `opencode`

- Renamed the path components this package creates inside its per-user root: the XDG directories resolve to `<XDG_*>/amio`, the database is `amio.db` (`amio-<channel>.db` when channel databases are enabled), and the file log is `<data>/log/amio.log`. The `%TEMP%/amio` scratch directory follows the same constant.
- Only on-disk names changed. Provider IDs, `@opencode-ai/*` package names and plugin specifiers, `OPENCODE_*` environment variable names, project-level `opencode.json`/`.opencode` discovery, `.git/opencode` project IDs, and `opencode.ai` URLs deliberately keep their upstream spelling.
- The rename is unconditional for this tree, so a standard `opencode` binary built from this fork also reads and writes `amio` directories.
- Astron Cowork's launcher owns the sibling names it sets explicitly (`config/amio`, `amio.generated.json`, `state/amio-runtime.{stdout,stderr}.log`) and renames an existing `opencode` layout to `amio` on the next launch, so sessions, credentials, and installed config tool assets carry over. That rename has to ship with a rebuilt `amio-agent` binary: an old binary only knows the `opencode` directory and would recreate an empty database after the launcher moved the data.

## 2026-09-11

### Require explicit roles for requested write deliverables

- Clarified both the write tool description and its `artifactRole` parameter description: writing the final file that fulfills a requested deliverable must use `final`, including when the agent chooses the filename or format. Added the novel/report example that was missing the role in observed sessions.
- Kept the parameter optional for compatibility and supporting files; intermediate scripts, assets, and source files may still omit it or use `intermediate`/`temporary`. Unrequested extra files must not be labeled `final`.
- This is a model instruction change, not a schema or output protocol change. Package typecheck passed. On September 14, a live write of `tetris/index.html` supplied `final`, returned the matching `metadata.outputs`, and reached Astron's artifact ledger as an explicit `tool_outputs` record; supporting files also used `temporary` and `intermediate`. This confirms observed usage, not guaranteed model compliance on every call.

### Start amio-agent with its dedicated HTTP surface

- Added an amio-agent route assembly for the global, config, session, MCP, permission, question, experimental, and auth endpoints used by Astron and runtime plugins. It does not mount the full UI, PTY, file, project, workspace, sync, control-plane, or V2 HTTP route groups.
- Added a Bun startup listener that makes authenticated `/global/health`, `/global/event`, and cold local `/session/status` available without building the Effect application graph. The declared HttpApi remains the source of the endpoint contracts and handles every other request after one shared lazy initialization.
- Kept authentication, CORS, mDNS, the preferred-port fallback, SSE heartbeats, and listener address publication available in the startup layer. Delegated requests still use the production schema errors, compression, observability, fencing, workspace routing, and instance lifecycle middleware.
- Warmed the delegated handler with a side-effect-free health request before dispatching the first business request, so a client cancellation during lazy initialization cannot execute a prompt or control action after the caller has already retried. The listener publishes when application loading starts so this cancellation boundary is tested deterministically. Failed initialization may be retried, and a later `stop(true)` can force an in-progress graceful stop.
- Moved the live listener address into a lightweight module so plugins use the supported amio-agent HTTP surface without importing the full server graph, while preserving the in-process fallback when no listener exists.
- Replaced the amio-agent yargs/UI command graph with `node:util.parseArgs`, deferred the heap snapshot module unless enabled, and read the local installation channel from its lightweight version module. The parser keeps Astron's launch flags, `--name=value`, repeated `--cors`, mDNS, help, and version; unsupported generic yargs forms such as space-separated boolean values and trailing positional arguments are outside the Amio CLI surface.
- In an interleaved compiled Windows benchmark, median authenticated health readiness improved from 1754.15 ms to 70.75 ms and the Astron sequence through `/session?roots=true` improved from 1837.1 ms to 1027.35 ms. A binary smoke received `server.connected` at 75.8 ms while the delegated API was still loading. Five cold-directory status reads created no instances and fell from 328.5 ms total to 65.6 ms.

### Preserve streamed provider failures and report runtime-owned retries

- Enabled raw OpenAI-compatible stream chunks and retained structured gateway errors before the SDK reduces them to a message string. API errors and `prompt.failed` now preserve status, retryability, and allowlisted diagnostics such as the upstream TPM reason, model, provider, and request IDs; gateway keys, caller identity, and arbitrary headers are excluded.
- Kept retry execution inside OpenCode: up to five retries with exponential backoff starting at two seconds, up to 25% jitter, and a thirty-second cap. Upstream `Retry-After` headers no longer determine scheduling. Existing `session.status` retry events carry the attempt, reason, and next retry time for Astron to display.
- Kept `retry` status through the in-flight retry request, not only its backoff. Non-empty text, reasoning, tool argument deltas or a tool call restore `busy`; a successful empty stream also clears retry on completion, while terminal errors and cancellation retain the existing idle cleanup. A gated SDK/SSE regression confirms retry remains visible before the second response arrives; success and terminal-failure cases both pass.
- Preserved complete provider message fields even when a gateway truncates the surrounding raw JSON, without displaying incomplete request IDs or arbitrary raw content.
- Avoided default retries for plain SSE authentication/client errors and excluded diagnostic IDs from retry classification, while retaining transient network-error message fallbacks.
- Advanced the retry-status regression with `TestClock` so its two backoff intervals do not exceed Bun's five-second test timeout; retained assertions for the published retry deadline and attempt count.
- Verified actual SSE 429 responses through the SDK and processor, retry-to-success and retry-to-terminal-error transitions, and structured terminal `prompt.failed` events. Targeted suites passed (64 provider/retry tests, 18 LLM/error mapping tests, two prompt error tests, and two processor retry tests); package `bun typecheck` passed. Sidecar binaries must be rebuilt/deployed for these source changes to take effect.

### Reload provider models through the config epoch

- Included each loaded workspace's provider state in `ConfigRuntime` refreshes, so `/global/config/invalidate` makes newly configured models available without disposing the workspace.
- Added an HTTP regression test that loads a provider, adds a model to the same workspace config, invalidates the global config epoch, and verifies the new model is returned.

## 2026-09-10

### Avoid inactive workspace bootstrap during status reads

- Made the amio-agent sidecar return an empty `/session/status` snapshot for directories that have not been loaded, instead of creating an instance and eagerly initializing config, plugins, LSP, formatting, VCS, snapshots, and project services.
- Preserved the existing status path for loaded or concurrently loading directories, and kept regular `opencode serve` behavior unchanged.

## 2026-09-09

### Shell timeout process-exit convergence

- Made process termination wait for the child process `exit` event instead of the later stdio `close` event, so inherited output handles cannot leave timed-out shell tools running indefinitely.
- Kept normal command completion waiting for `close` so successful command output is still fully drained.
- Added regression coverage for an exited parent whose detached child temporarily retains inherited output handles.

## 2026-09-08

### Selected upstream reliability fixes

- Omitted empty `movePath` values from `apply_patch` permission metadata so the request remains JSON encodable (upstream `f7da00f35e`).
- Retried underscored and hyphenated network error variants, and converted provider `network_error` finish reasons into retryable stream failures (upstream `40282c1d4d`, `e0b9e68a68`).
- Handled rejected SSE reader cancellation without producing an unhandled rejection (upstream `69c172e8a7`).
- Parsed Codex GPT model versions by numeric major and minor components, including integer and multi-digit versions, while filtering the unsupported bare `gpt-5.6` OAuth alias (upstream `f47684787a`, `500c46ec79`, `02a167e048`).
- Bounded provider retries with jitter, recognized retryable API error messages and bodies, normalized overload and request-limit reasons, preserved structured rate-limit parsing, and treated unknown stream errors as retryable failures (upstream `f929f8f100`, `61aefc0759`, `c78986831c`, `71d08e94d5`).
- Surfaced failed subagent messages and terminal tool failures with their resumable task IDs (upstream `c313504c82`, `35fe5b7212`).
- Sent OpenAI-compatible `textVerbosity` only when the model explicitly declares support (upstream `3a4c253969`).
- Tolerated Windows `AlreadyExists` directory-creation races only when the target is already a directory (upstream `656f299017`).
- Sanitized non-finite model prices before calculating session costs (upstream `9b0dd36cda`).
- Preserved a running tool call's original start time across metadata updates, with regression coverage adapted to the fork's current session and MCP interfaces (upstream `765ae641d7`).

## 2026-09-07

### Direct serve handler for the amio-agent sidecar

- Registered an amio-agent-specific `serve` command that calls `Server.listen` directly instead of going through `effectCmd` and `AppRuntime`.
- Kept the regular `opencode serve` command unchanged, including its global config resolution and Effect runtime path.
- The sidecar path keeps web UI routes disabled and resolves network options from explicit CLI arguments/defaults; Astron's launcher supplies `--hostname` and `--port` explicitly.

## 2026-09-02

### Output-length prompt terminalization

- Converted provider `length` finishes into the existing `MessageOutputLengthError` instead of completing the prompt as a normal end turn.
- Reused the existing ACP `max_tokens` mapping and added regression coverage for a length-limited response with no visible text.

## 2026-08-31

### Explicit workspace routing for existing sessions

- Kept local session-scoped prompt routing on the explicit `directory` query/header supplied by Astron, even when the session was created under another directory.
- Updated the prompt regression test to assert that an existing session executes with the current request workspace, matching the sidecar routing contract used when Astron changes a session workspace.

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

## 2026-08-19

### PowerShell UTF-8 shell output

- Initialized Windows PowerShell and PowerShell 7 shell tool processes with UTF-8 console and pipeline output encodings before running user commands.
- Prevented Chinese filenames and command output from being decoded into replacement characters when the runtime inherits a legacy Windows code page.
- Added regression coverage for both PowerShell variants, including their reported encodings and captured Unicode output.

## 2026-08-22

### Task subagent display names

- Added optional `displayName` to configured and runtime Agent records while preserving the technical `Agent.name` used for lookup, permissions, and child Session execution.
- Included display names in model-facing Task candidate descriptions without changing the required `subagent_type` identifier.
- Added `assistantName` to Task running, completed, and background metadata when the selected Agent has a display name, allowing Astron HTTP/SSE consumers to project the correct Assistant name.
- Added regression coverage proving Task metadata carries the display name while the child Session continues to use the technical Agent identity.
- Added `astron-task-assistant-name-handoff.md` with the required Astron config projection, history hydration, event fallback, rollout order, and acceptance tests for implementation on another machine.

## 2026-09-10

### Structured write artifact roles

- Added an optional `artifactRole` to the built-in `write` tool and return a structured `metadata.outputs` entry only after a successful write.
- Kept ordinary writes free of artifact declarations so consumers can distinguish explicit final deliverables from intermediate and temporary files.
- Updated the write tool instructions with the explicit user-facing deliverable rule.

## 2026-09-14

### Structured tool artifacts

- Added a unified `structured.artifacts` payload for local file-producing tools instead of introducing a separate file journal concept.
- `write`, `edit`, and `apply_patch` now return artifact evidence for their mutated files with `path`, optional `relativePath`, and `artifactRole`.
- `bash` now returns artifacts only for explicit `outputs` declared on the tool call, avoiding recursive worktree scans while still letting command-generated deliverables be associated with the exact session/tool call.
- Deliverable-oriented file extensions are marked `final`; script/config-style files remain `intermediate` unless a higher layer explicitly promotes them.
- Made `write` require an explicit artifact role in both legacy and core tool schemas, so Markdown and JSON deliverables can be promoted to `final` without making those extensions final by default.

### Restore dependency download sources

- Restored `bun.lock` to its state before the structured tool artifacts commit, removing the unrelated bulk switch to npmmirror download URLs.
- Kept the structured tool artifacts implementation unchanged.

### V1 tool artifact outputs for Astron

- Added explicit shell `outputs` to the active V1 tool schema and prompt. Only declared regular files are returned as absolute paths in completed `metadata.outputs` after exit code zero; failed, aborted, timed-out, and undeclared commands return an empty list. Output paths use existing external-directory permission checks, including resolved symlink targets; missing files produce warnings without losing the command result.
- Added optional edit roles and patch output declarations. Undeclared edit/patch files default to intermediate; patches only report surviving mutations and validate declared move destinations before applying changes.
- Astron treats completed metadata outputs, including empty lists, as authoritative over input, stdout and script inference. This implements the currently registered V1 path without switching Astron to Session V2.
- Added real shell tests across installed shells and edit/patch artifact regression coverage; corrected the existing streaming test command for Windows PowerShell 5.1.

## 2026-09-15

### Tool silence progress design draft

- Added `packages/opencode/specs/tool-silence-progress-design.md`: a design draft for moving Astron Cowork's Python-side tool heartbeat into the amio agent loop, emitting bounded progress for running tool calls on the existing part metadata surface, and ending passive waits with a model-visible silence-limit tool result.
- Recorded the architectural constraint that a provider turn awaits every local tool settlement before continuation, so informing the model about a silent call is equivalent to finishing that wait; recorded that upstream left `session.next.tool.progress` defined but without a producer.
- Compared the approach against DSH's background-job model, the ACP specification, Claude Code, Gemini CLI, Codex CLI, OpenHands, SWE-agent, Amp, and MCP progress notifications; recorded the two-clock rule (total-time cap versus silence window), the threshold cluster (30s soft / 2min background / 5min hard), the `_meta` requirement for ACP extensions, partial-output and injection-marking rules, and the V2 runner constraints that a heartbeat fiber must stay out of `toolFibers` and that a silence deadline must settle as a successful per-call failure publish rather than a fiber interrupt.
- Documentation only: no runtime behavior, schema, or test changes in this entry.

### Tool progress heartbeat and silence cap (V1)

- Added `src/session/tool-progress.ts`: a per-call activity clock plus a heartbeat that publishes `state.metadata.progress` (`message`, `health`, `quietMs`, `elapsedMs`, `lastActivityAt`, `runtimeActivity`) on the existing `message.part.updated` surface, so clients keep reading progress from part metadata instead of generating it themselves. Quiet windows are per tool family (read/write/edit/patch 60s, shell-like 180s, default 120s), and `possibly_stalled` requires three quiet ticks while the run stream reports idle.
- Wired the clock into the session processor: real activity (including streamed input) refreshes it through `updateToolCall`, heartbeat writes deliberately bypass that refresh so the silence window can expire, and settle/interrupt paths drop tracked calls. The heartbeat fiber runs per stream turn and is interrupted by the existing cleanup.
- Added the silence cap (P1) for shell-like tools only: default 300s, disabled with `AMIO_TOOL_PROGRESS_SILENCE_MS=0`. Each call gets its own `AbortController` linked to the request signal, so a silent call is terminated without touching the rest of the turn; the finished result is rewritten into a model-visible `[amio:silence-timeout]` outcome carrying the output tail and `metadata.timeout`. A tool that ignores the abort is settled by the loop after the grace window (`AMIO_TOOL_PROGRESS_SILENCE_GRACE_MS`, default 60s). Heartbeat cadence is `AMIO_TOOL_PROGRESS_HEARTBEAT_MS`, default 60s.
- Coverage: registry tools (including plugin-delivered Astron tools such as `knowledge-*`) and MCP server tools (the `mcp.tools()` registration path) both register with the activity clock, so they report progress when quiet. The silence cap stays limited to `bash`/`shell`; the MCP resource helper tools (`list_mcp_resources` and friends) are not tracked.
- Follow-up fix after live testing: the abort path now reads `ctx.abort.reason`, so the shell tool renders "Command terminated by the silence timeout" instead of the misleading "User aborted the command", and the silence result strips a trailing `<shell_metadata>` block so the model-visible text cannot contradict the notice. The observed failure was the model reporting a user abort for a silence timeout.
- Tests: added `test/session/tool-progress.test.ts` (11 tests covering thresholds, the no-self-refresh rule, escalation eligibility, the grace window, and result rewriting). Package typecheck plus the `session/tools`, `session/processor-effect`, and `session/prompt` suites pass.

## 2026-09-17

### Shell background jobs (V1)

- Added `src/tool/job.ts` with `job_output` and `job_kill`: reads are incremental over the job's spooled output (each call returns only new bytes, or `(no new output)`, plus a final `[status: ...]`), and cancellation terminates the job. Jobs owned by another session are refused, and an unknown id lists the running jobs.
- `bash` now waits `yieldMs` (default 15000 ms, overridable with `OPENCODE_BASH_YIELD_MS`; `0` detaches almost immediately) for a command to finish. A command still running when that window closes is registered as a `BackgroundJob`, and the tool returns a handle instead of a result: job id, spooled output path, the output captured so far, and the notification contract.
- The command keeps running inside the tool's scope, so it outlives the tool call; cancelling the job interrupts that fiber, which closes the spawn scope and kills the process. Completion injects a synthetic `[amio:background]` message into the session, reusing the task tool's notification path.
- Detached commands report no declared `outputs` artifacts: artifact reporting still requires a finished command with exit code zero. Jobs are process-local, so they do not survive an agent restart (the same is true of Codex exec sessions).
- Fix after live testing: a detached command inherited the turn's abort signal, so the turn ending killed it and the model was told "User aborted the command" with a null exit code. Detached commands now ignore the request abort for the rest of their life; only `job_kill` (or the command's own timeout) stops them, which is what Codex and Claude Code do for backgrounded work.
- Follow-up after the same review: `job_output` accepts `wait_ms` (bounded wait, capped at 300s), so the model can wait on a job in chunks instead of ending its turn. The tool and shell descriptions now state capabilities only — read incrementally, wait with `wait_ms`, stop with `job_kill`, and a completion notice — and leave the judgement (wait, continue elsewhere, or stop) to the model.
- The call `timeout` now only bounds waiting: a detached command is no longer terminated when it elapses (Codex semantics for interactive exec), and `job_kill` is what stops it. As the replacement guard for runaway producers, a detached command's spool file stops growing at 1 GiB and appends a truncation marker instead.
- Job status lines now carry wall time (`[status: completed] [wall time: 1m3s]`, plus `wallTimeMs` in the tool metadata) for `job_output`, `job_kill`, and the `bash` background handle, and completion notices report how long the job ran — Codex reports the same as `wall_time_seconds`.
- The job registry now drops settled jobs beyond 64 when a new job starts (`prune({ keep })` is exposed for explicit calls), so long sessions cannot accumulate finished job output in memory. This needed a small addition to the shared `packages/core/src/background-job.ts` registry — the same service the V1 wrapper and the background `task` mode already use; no V2 session or tool code was touched.
- Tests: `test/tool/job.test.ts` covers reads, bounded waits, cancellation, retention pruning, and ownership. Shell (111), job (7), and tool-progress (13) suites pass. Two failures elsewhere are pre-existing on this baseline: the MCP instruction wording mismatch and `tool.task > execute shapes child permissions`, which the `app = "amio"` rename moved by changing the truncation-dir permission pattern (both reproduce with these changes stashed).

## 2026-09-19

### MCP soft invalidation generations

- Added `MCP.invalidate()` and wired it into `ConfigRuntime.refreshAt()` after the config, provider, agent, and skill reloads.
- MCP invalidation now builds a new client generation in the background and swaps it only after all configured servers connect successfully; a failed generation leaves the active generation untouched.
- `MCP.tools()` leases the generation used by a prompt, so an in-flight prompt keeps its original MCP clients alive while later prompts use the new generation. Retired generations close after their leases are released.
- Coalesced repeated invalidations per instance directory and skipped reconnects when the MCP configuration fingerprint is unchanged.
- Added lifecycle coverage for generation swapping and ConfigRuntime coverage for MCP invalidation; package typecheck and the MCP lifecycle/config runtime suites pass.

## 2026-09-21

### Lazy Astron skill prompt index

- Added optional lightweight skill summaries to configured agents. Astron-projected agents now carry only each assigned skill's name and localized descriptions, so prompt construction does not initialize the workspace-wide skill catalog.
- Changed the `skill` loader to parse a directly named skill on first invocation and cache only that skill. Full catalog loading remains available for generic agents, explicit skill search/list operations, and compatibility with skill names that do not match their directory.
- Preserved the existing generic OpenCode fallback when an agent does not provide a skill summary list; an explicit empty list means the configured agent has no assigned skills.
- Added regression coverage for config preservation, catalog-free prompt rendering, direct lazy body loading, and Astron's runtime projection.

## 2026-09-24

### Safe automatic compaction threshold

- Automatic compaction now uses the smaller of 90% of the model context window and the input capacity after reserving the configured or practical output buffer.
- Models whose advertised maximum output equals their full context window no longer compact immediately on the first prompt.
- Explicit compaction thresholds can trigger earlier but are capped at the automatic safe limit, preventing a global threshold from exceeding a smaller model's usable context.
- Added regression coverage for equal context/output limits, the 90% boundary, explicit-threshold clamping, and equivalent input-limit behavior.

### Portable session import

- Added a typed `PUT /session/:sessionID/import` endpoint that replaces an idle session's messages from a versioned portable Agent Core transcript and optionally updates its title.
- Added conversion for user, system, and assistant transcript entries, including text, thought, file, and tool parts, while preserving valid source identifiers when possible.
- Rejects imports while the target session is busy and validates the complete payload before removing existing messages.
- Added HTTP API regression coverage for replacing an existing conversation and returning the imported transcript.
