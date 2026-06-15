# Chinese Prompt Switch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a configurable Chinese prompt set for runtime model-facing prompts.

**Architecture:** Add `prompt_language` to config, keep English as default, and make each prompt owner choose from English or Chinese strings at source. Avoid a generic language-instruction injection so the Chinese behavior comes from native Chinese prompt variants.

**Tech Stack:** TypeScript, Bun tests, Effect services, existing text prompt imports.

---

### Task 1: Config Schema

**Files:**
- Modify: `packages/core/src/v1/config/config.ts`
- Modify: `packages/opencode/test/config/config.test.ts`

- [ ] Add `prompt_language?: "en" | "zh"` to `ConfigV1.Info`.
- [ ] Write a schema test that accepts `{ prompt_language: "zh" }`.
- [ ] Write a schema test that rejects `{ prompt_language: "cn" }`.
- [ ] Run: `cd packages/opencode; bun test test/config/config.test.ts -t prompt_language`

### Task 2: Prompt Selector

**Files:**
- Modify: `packages/opencode/src/session/system.ts`
- Create: `packages/opencode/src/session/prompt-zh/*.txt`
- Modify: `packages/opencode/test/session/system.test.ts`

- [ ] Add a language-aware prompt selector without changing the existing English default.
- [ ] Add Chinese variants for session prompts used by `SystemPrompt.provider(...)`.
- [ ] Test that English remains the default.
- [ ] Test that `zh` returns Chinese prompt text for a representative provider.
- [ ] Run: `cd packages/opencode; bun test test/session/system.test.ts`

### Task 3: Built-in Agent Prompts

**Files:**
- Modify: `packages/opencode/src/agent/agent.ts`
- Create: `packages/opencode/src/agent/prompt-zh/*.txt`
- Create: `packages/opencode/src/agent/generate.zh.txt`
- Test: add or extend an agent test under `packages/opencode/test/agent`

- [ ] Add Chinese variants for built-in generate, explore, compaction, title, and summary prompts.
- [ ] Select Chinese built-in agent prompts when `prompt_language` is `zh`.
- [ ] Keep user-configured custom prompts unchanged.
- [ ] Run the focused agent test from `packages/opencode`.

### Task 4: Inline Runtime Text

**Files:**
- Modify: `packages/opencode/src/session/system.ts`
- Modify: `packages/opencode/src/session/reminders.ts`
- Modify: `packages/opencode/src/session/prompt.ts`
- Modify: `packages/opencode/src/session/prompt/reference.ts`
- Test: extend focused session tests

- [ ] Localize environment, skills, plan reminder, build-switch reminder, structured-output reminder, and reference synthetic text when `prompt_language` is `zh`.
- [ ] Preserve tags, placeholders, paths, command names, and schema/tool names.
- [ ] Run focused session tests from `packages/opencode`.

### Task 5: Change Log And Verification

**Files:**
- Modify: `packages/opencode/specs/amio-agent-change-log.md`

- [ ] Record the fork-specific prompt language switch.
- [ ] Run `cd packages/opencode; bun typecheck`.
- [ ] Run the focused tests touched by this change.

