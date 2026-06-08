# Amio Agent Change Log

This document records local fork changes made for Astron Cowork's opencode sidecar. Keep future fork-specific changes here so they can be reviewed without diffing the full upstream project.

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

