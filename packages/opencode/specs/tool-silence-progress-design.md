# amio agent loop：工具静默心跳与「静默上报」设计（草案 v1）

> 状态：P0（心跳）与 P1（静默上限）已在 V1 路径实现（`src/session/tool-progress.ts` + `session/processor.ts` + `session/tools.ts`，测试见 `test/session/tool-progress.test.ts`）；L3 后台化仍未开始。目标是把 Astron Cowork 目前在 Python ACP server 里做的工具心跳，下沉到 amio 自己的 agent loop，并让「长时间无输出」这件事不只停留在 UI 提示上，而是能结束干等、让模型自己决策。Cowork 侧按单源决定只做转发、不再生成也不再兜底。
>
> 证据基线：fork `dev` @ `22cd443e41`（2026-09-15）；上游 `upstream/dev` @ `ecbc6ccac8`（2026-09-07，本地 ref 由 2026-09-15 fetch）。实施前需重新确认上游是否已补齐（本轮 `git fetch upstream` 因代理 `127.0.0.1:7899` 拒绝连接失败）。

## 1. 问题

线上观察到的提示 `长时间没有新输出，运行流仍在执行，最近一次活动 9 分钟前` 来自 Cowork 的 Python ACP server，而不是 amio：

- `engine/servers/astronverse-agent/src/astronverse/agent/acp/server.py:4038` `_track_tool_call_update`：收到 `tool_call`/`tool_call_update`（`pending`/`in_progress`）就登记 `startedAt`/`lastActivityAt`/`quietCount`，`completed`/`failed` 出列。
- `server.py:4080` `_tool_heartbeat_loop`：只要还有活跃工具，每 `TOOL_HEARTBEAT_INTERVAL_SECONDS = 60` 秒跑一轮，无次数上限。
- `server.py:4091` `_emit_tool_heartbeat`：按静默时长与「运行流」状态（`busy`/`waiting`/`idle`/`unknown`）分级，产出 `progressMessage` + `health`，阈值按工具名分档（短工具 60s、长工具 180s、默认 120s，`server.py:211-216,361-370`）。
- 前端渲染：`frontend/packages/chat-window-react/src/snapshot/ReasoningTimeline.tsx:2370-2375`（`.cw-tool-progress-message` + `data-health`），`possibly_stalled` 用琥珀色（`:632-634`）。

问题不在功能，而在归属：

1. **只有 Cowork 受益**：TUI、desktop、其他 ACP/HTTP 客户端看不到这套静默监测。
2. **事实来源在外面**：Python 只能从「有没有收到 `tool_call_update`」推断静默，无法区分「命令真的没输出」和「runtime 没上报」。上游 V2 里 `Tool.Progress` 事件（`packages/schema/src/session-event.ts:331`）本就是为这类「有界节奏的运行中状态」设计的，但**上游至今没有任何生产端**（详见 §7）。
3. **模型完全不知情**：静默期间 agent loop 一直在 await tool settlement，模型既看不到心跳，也无法介入，只能等工具自己超时或永远等下去。

## 2. 目标与非目标

目标：

- **G1 心跳下沉**：agent loop 持有每个运行中 tool call 的活动时钟，并按有界节奏把进度发到常规客户端面（Astron 走 `/global/event` SSE；TUI/app 走各自消费端）。
- **G2 不干等**：静默超过上限时，loop 主动结束该次等待，把「静默事实 + 已产出的输出尾部 + 处置结果」作为**模型可见的 tool result** 交给模型，由模型决定重试（更大 timeout）、换方案还是放弃。
- **G3 客户端契约不变**：字段名与文案保持 Cowork 现有渲染契约（`progressMessage`/`health`/`elapsedMs`/`lastActivityAt`），使 Cowork 可以**彻底删除本地心跳（单源，无兜底）**，只做转发与展示。

非目标：

- 不改 ACP 协议本身，不新增 ACP 方法。
- P0 不新增持久化实体（不新建表），进度在 P0 走 part metadata。
- P2 的「后台 job」不在本轮实现（core 侧有前置依赖，见 §5.3）。

## 3. 硬约束（决定了设计形状）

### 3.1 静默期间模型不可能「收到」新输入

一次 provider turn 只有一次 `llm.stream`，且**所有本地工具结算后才继续下一轮**：

- V2：`packages/core/src/session/runner/llm.ts:72` 清单项「Start each recorded local call eagerly and await all settlements before continuation」，实现见 `:140` `awaitToolFibers` 与 `:247` 的 `toolMaterialization.settle(...)`。
- V1：`packages/opencode/src/session/processor.ts:581-604` 用 `Deferred.await(call.done)` 等全部工具（超时 250ms 仅用于清理），完成后才回到 prompt loop。
- 用户转向/steering 也只在安全边界提升（V2 `runner/llm.ts:77` 清单项），边界同样在结算之后。
- `SystemContext`/Context Epoch 只在 provider turn 之间刷新（`packages/core/src/session/context-epoch.ts:40-78`），所以把静默写进系统上下文，最早也只能在「工具结束后」的那一轮被模型看到。

结论：**「向模型上报」在本架构里等价于「结束这次等待」。**任何声称能在线注入模型上下文的方案，都要先违背上面三条之一，因此不作为方案（§5.2 给出唯一例外，且是 next-turn 语义）。

### 3.2 活动信号的现状

- V1（Astron 今天跑的路径）：工具通过 `Tool.Context.metadata()` 写 part，`packages/opencode/src/session/tools.ts:86-99` → `processor.updateToolCall` → `session.updatePart` → `message.part.updated`。所以「有输出的命令」天然刷新活动时钟，静默的命令不产生任何事件。
- V2：`Tool.Context` 只有 4 个字段（`packages/core/src/tool/tool.ts:9-14`），**没有 progress 通道**；`packages/core/src/tool/bash.ts:71` 的 TODO 正是在等这件事。
- Astron 的取数方式是 `/global/event` SSE（`adapters/opencode/transport.py:889-890`）+ Python 翻译器 `OpencodeAcpTranslator`（`adapters/opencode/events.py:1188`），翻译器**已经会读 tool part 的 `state.metadata`**（`events.py:686-688,728-767`）。

### 3.3 已有的「不干等」只有总量上限，且由模型自己猜

V1 shell 工具默认总时长上限 2 分钟（`packages/opencode/src/tool/shell.ts`：`defaultTimeoutMs = flags.bashDefaultTimeoutMs ?? 2 * 60 * 1000`），超时后杀掉命令并返回模型可见的结果：

```
shell tool terminated command after exceeding timeout ${input.timeout} ms. If this command is expected to take longer and is not waiting for interactive input, retry with a larger timeout value in milliseconds.
```

这解释了截图：模型给了一个很大的 `timeout`，命令既不输出也不退出，于是整轮只能干等。**缺的不是「杀」，而是「按静默（而不是按总时长）判断，并且由 loop 而不是模型来兜底」。**这是本设计要补的核心缺口。

## 4. 分层设计

四层，职责不同，可独立上线：

| 层 | 语义 | 谁主导 | 消费者 | 状态 |
|---|---|---|---|---|
| L0 总量上限 | 这次调用最多跑多久 | 模型（`timeout` 参数） | 模型（tool result） | 已有（V1 shell / V2 bash） |
| L1 静默心跳 | 还在跑、多久没输出 | **loop** | UI / ACP / TUI | 本设计 P0 |
| L2 静默上限 | 静默太久，必须结束等待 | **loop** | 模型（tool result）+ UI | 本设计 P1 |
| L3 后台化 | 不结束工作，只结束等待 | loop + 模型轮询 | 模型（job 工具） | P2（受 core 前置依赖阻塞） |

### 4.1 L1：活动时钟 + 心跳（P0）

新模块（V1 路径）：

- `packages/opencode/src/session/tool-progress.ts`（按 `packages/opencode/AGENTS.md` 的模块形状：`export * as ToolProgress from "./tool-progress"`）。职责：
  - 每 session 维护 `Map<callID, { startedAt, lastActivityAt, quietCount, tool, title, kind, lastOutputTail }>`；
  - 写点：工具开始（`session/tools.ts:119` 附近的 execute 包装）、每次 `ctx.metadata()`（`:86`）、每次 `updateToolCall`、每次结算（`processor.ts:186,204`）与中断清理（`processor.ts:587-603`）；
  - 心跳：一个 scoped fiber，`Effect.repeat(Schedule.spaced(heartbeatMs))`，在存在活跃 call 时对每个 call 计算 `quietMs`/`elapsedMs`，按阈值分档产出 `health`，写回 part metadata：

```ts
// 期望落到 part 上的形状（字段名与 Cowork 现有契约一致）
state.metadata.progress = {
  message: "长时间没有新输出，运行流仍在执行，最近一次活动 9 分钟前",
  health: "quiet" | "ok" | "possibly_stalled" | "silence_timeout",
  quietMs, elapsedMs, lastActivityAt,
  runtimeActivity: "busy" | "waiting" | "idle" | "unknown",
}
```

写回走 `processor.updateToolCall`，因此**自动复用现有 SSE 通道**（`message.part.updated`），Astron 侧只需在翻译器里读 `metadata.progress`，TUI/app 也顺带可见。

阈值默认值与 Cowork 对齐（`server.py:211-216,339-370`），并放进 fork 配置而不是硬编码：

| 项 | 默认 | 说明 |
|---|---|---|
| `heartbeat_ms` | 60000 | 心跳周期，同时是 `quietCount` 的计数单位 |
| `quiet_ms.short` | 60000 | `read`/`write`/`edit`/`patch`/`multiedit` |
| `quiet_ms.long` | 180000 | `bash`/`shell`/`test`/`uv`/`agent`/`task`/`install`/`npm`/`pnpm` |
| `quiet_ms.default` | 120000 | 其余工具 |
| `stalled_quiet_count` | 3 | 连续静默次数；配合 `runtimeActivity == idle` 才升级为 `possibly_stalled` |

`possibly_stalled` 的判据（运行流已结束但工具仍未完成）需要 session 状态：V1 已有 `packages/opencode/src/session/status.ts` 的 `busy`/`idle`/`retry`，可直接作为 `runtimeActivity` 来源，不再依赖 Python 侧的记账。

P0 已实现的开关（env，配置块留待后续）：`AMIO_TOOL_PROGRESS_HEARTBEAT_MS`（默认 60000）、`AMIO_TOOL_PROGRESS_SILENCE_MS`（默认 300000，`0` 关闭静默上限）、`AMIO_TOOL_PROGRESS_SILENCE_GRACE_MS`（默认 60000，工具无视 abort 后由 loop 强制结算的宽限）。

实现细节（借自 Claude Code 已验证的 tick 设计，见 §6.2）：

- **「没有新输出」的 tick 必须是一等事件，不能当空操作跳过**：Claude Code 的轮询注释明确写了这一点 —— 「Always call onProgress even when content is empty, so the progress loop wakes up and can check for backgrounding. Commands like `git log -S` produce no output for long periods.」（`src/tasks/TaskOutput.ts:119-125`）。我们的心跳循环同理：空 tick 是判定静默、触发升级的唯一时机。
- **低开销取数**：Claude Code 把子进程 stdout/stderr 直接重定向到一个文件 fd，然后每 1s 读文件尾部 4KB（`src/utils/Shell.ts:289-313`、`TaskOutput.ts:10-11,109-164`），不在写路径上过 JS。V1 shell 目前是 sink + `ctx.metadata`（`tool/shell.ts:540` 区域），P0 直接用现有通道即可；若将来要降开销，可换成同样的「文件尾部轮询」。
- **两段式 UX**：2s 以内的调用完全不走进度机制（`BashTool.tsx:55,1003-1025`），避免短命令被心跳噪声污染 —— 我们的 `heartbeat_ms` 首次触发同理应从「调用开始」而不是「事件到达」计时。
- **区分「本来就没输出」与「暂时没输出」**：Claude Code 用 `BASH_SILENT_COMMANDS`（mv/cp/rm/mkdir/chmod…）把前者在 UI 上显示为 Done 而非 `(No output)`（`BashTool.tsx:81,176-217`）。我们的 `health: ok` 分支应对这类工具直接静默。

### 4.2 L2：静默上限 → 模型可见的结束（P1）

在同一层实现，判据是**静默**而不是总时长 —— 也就是把「两个时钟」彻底分开（三家产品已经这样做了，见 §4.2.3）：

- 监督器：`ToolProgress` 暴露一个 `Deferred`/`Queue`，静默达到 `silence_ms` 时触发 `SilenceExceeded { callID, quietMs, elapsedMs, lastOutputTail }`。
- `session/tools.ts` 的 execute 包装里用 `Effect.raceFirst` 让「工具执行」与「静默触发」竞争；触发时：
  1. 为**这一次调用**建 `AbortController`，与请求信号合并（`AbortSignal.any([requestSignal, perCall.signal])`）后作为 `ctx.abort` 传入，abort 掉命令/子进程 —— 只杀这一次调用，不影响整轮（`processor.ts:587-603` 的整轮中断路径不动）；
  2. 由 processor 以**模型可见**的方式结算该 call：优先复用 shell 超时的既有形状（`completed` + 明确文案 + `metadata.timeout = true`），否则 `failToolCall`；
  3. 文案带三件事：静默了多久、最后一段输出（有界截断）、已终止 + 下一步建议。例如：

```
no output for 9 minutes (silence limit 5 minutes); the command was terminated.
last output:
  ...（有界尾部）
If this command is legitimately quiet, retry with a larger silence budget
(tool param `silenceMs`, or `timeout` for the overall cap) or run it as a background job.
```

  4. part 上保留 `metadata.progress.health = "silence_timeout"`，UI 能解释「为什么被杀了」。

- 配置：`silence_ms` 按工具分档，`0` = 关闭；**默认只在满足 §4.2.2 可操作性门控的地方开启**（初期建议只有 `bash`/`shell` 且显式配置）；`task`/`agent` 等长任务默认不开硬上限（子代理几分钟无输出是正常的），只保留 L1 心跳。
- 交互：模型在下一轮看到的是**普通 tool result**，因此可以选择重跑（更大 `silenceMs`/`timeout`）、换实现、或询问用户 —— 这就是「不干等」。
- **自证不重置**：心跳/进度事件本身**绝不能**刷新 `lastActivityAt`，只有工具产出的真实输出（V1 的 `ctx.metadata`、V2 的输出片）才能重置。否则监控自己在监控自己，静默上限永远不会触发（这也是 Claude Code 把「progress 重置 idle 窗口」与「wall clock 不变」分开的原因）。
- **合成文本必须可识别为「注入内容」而不是工具真实输出**：OpenHands 用 `[Below is the output of the previous command.]` 前缀，Gemini 把整条工具结果 `wrapUntrusted(...)`。凡是注入进对话的文本都是注入面，我们的静默文案必须带自己的标记（例如固定前缀 `[amio:silence-timeout]`），并保持不可信语义。

#### 4.2.1 实现提示：复用 V1 shell 已有的 race 与 abort 通道

V1 shell 工具已经在工具内部实现了「总时长」版本的同一模式，可直接复用其结构：

- `packages/opencode/src/tool/shell.ts:546-551` 监听 `ctx.abort`；
- `:553-559` `Effect.raceAll([exitCode, abort, timeout])`，`:561-568` 分别 kill 进程；
- `:574-580` 组装模型可见文案（`shell tool terminated command after exceeding timeout …` / `User aborted the command`）。

因此 L2 的通用监督器只需要：**per-call AbortController + `controller.abort(reason)`**。工具侧既有的 abort 处理会负责杀进程，监督器只负责结算与文案。两个必须处理的细节（**均已实现**）：

1. **区分中止原因**：shell 原先把 abort 一律渲染为 `User aborted the command`。现在监督器用带 `reason` 的 abort（`AbortSignal.reason` 放 `SilenceReason`），shell 读 `ctx.abort.reason` 后渲染「Command terminated by the silence timeout: no output for N minutes.」；静默改写（`ToolProgress.silenceResult`）还会剥掉尾部残留的 `<shell_metadata>` 块，保证模型可见文本不自相矛盾。上线实测确认了这个问题：模型曾把静默超时汇报成「用户中止」。
2. **不要双杀**：静默中止与工具自身 timeout 可能同时触发，结算路径需要幂等（`processor.completeToolCall`/`failToolCall` 已对 `status !== "running"` 早退，见 `processor.ts:173,191`）。

#### 4.2.2 升级的触发条件：可操作性门控，而不是「慢就报」

Claude Code 唯一的「静默 → 模型」机制刻意做得很窄，值得照抄这个思路（`src/tasks/LocalShellTask/LocalShellTask.tsx:24-104`）：

- 每 5s stat 输出文件；45s 没增长后，取尾部 1KB，**只有尾部匹配交互式提示模式**（`(y/n)`、`[y/n]`、`Do you…?`、`Press any key`、`Overwrite?` …）才升级；
- 升级文案带**具体处置建议**（改成 `echo y | command` 或加非交互 flag），并附 task id 与输出文件路径，模型一次到位；
- 源码注释写明了取舍：「we stay silent on commands that are merely slow (git log -S, long builds) and only notify when the tail looks like an interactive prompt the model can act on. See CC-1175」；
- 而且它**只对已后台化的任务**布防，前台调用完全不布防。

对本设计的启示：

1. L1（UI/客户端心跳）可以无条件按阈值发，因为那是给人看的；**L2（打扰模型）必须有可操作性判据**，否则一个安静跑 9 分钟的正常脚本会被无意义地杀掉。
2. 可操作性判据至少有三种，建议按优先级组合：**尾部像交互式提示**（可判定）> **工具声明了自己预期从静默到产出**（如 `test`/`build` 有输出节奏约定）> **用户/配置显式开启该工具的静默上限**。
3. 真正「合法但安静」的长任务，正确答案不是杀，而是 §4.3 的后台化 —— Claude Code 的默认行为正是「超时即转入后台」，连错误都不报（`ShellCommand.ts:135-141`、`BashTool.tsx:880`）。

#### 4.2.3 两个时钟与默认值（三家产品共识）

本设计最重要的对齐点：**总时长（wall clock）与静默（silence/idle）必须是两个独立的钟**，用同一个 `timeout` 兼做两件事就会得到截图里的结果。

- **Gemini CLI**：shell 工具有独立的 `shellToolInactivityTimeout`，默认 **300s**，而且**每收到一个输出事件就重置**（`packages/core/src/config/config.ts:1308-1309`、`packages/core/src/tools/shell.ts:646-654,662,669`）；到期后取消命令并给模型一段合成结果：`Command was automatically cancelled because it exceeded the timeout of ${N} minutes without output.` + 取消前的部分输出（`shell.ts:839-855,1107`）。这段文本 UI 与模型共用，**明确不是 UI-only**。来源：<https://github.com/google-gemini/gemini-cli>（PR #13531 引入该行为）。
- **Claude Code（官方文档版，比 2026-03-31 泄露的 `src/` 更新）**：MCP 调用的 `timeout` 是硬性 wall clock，且明确「progress notifications from the server don't extend it」；另有一条独立的 **idle window**（HTTP/SSE/WS 5 分钟、stdio 30 分钟，`CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` 可关），窗口内既无响应也无 progress 通知就以错误中止 —— 也就是说**心跳只负责重置 idle 看门狗，绝不允许延长总时长**。
- **Codex CLI**：干脆不设「等多久」这个概念 —— `exec_command` 只在 `yield_time_ms`（默认 10s，Windows 有效范围 10-30s）内等待，超时立刻返回 `session_id`；`write_stdin` 用 `yield_time_ms` 轮询；结果结构里带 `session_id` / `exit_code` / `wall_time_seconds`，**把已等时长交给模型**，由模型决定继续等还是先干别的。

对本设计的三条直接结论：

1. **L0（总时长）保持由模型/配置给定**，并保持现有语义（V1 shell 默认 2 分钟、V2 bash 默认 2 分钟/上限 10 分钟）。
2. **L2（静默）默认应为开启且默认值取 ~5 分钟**（Gemini 的 300s 是现成先例），对 shell 类工具按「有输出就重置」计时；`task`/`agent` 等天然静默的长任务单独放宽或只发 L1。
3. **心跳只喂看门狗与 UI，不改变总时长上限**（Claude Code MCP 的规则），且到期文案必须带上**取消前的部分输出**与一句可执行的下一步建议 —— Gemini 的用词可以直接借用（`… exceeded the timeout of N minutes without output`），比我们自造措辞更容易被模型正确处理。

Gemini 已知未修的问题恰好是我们的补充项：交互式 PTY 提示不产生输出，inactivity 计时器永远不会因为「提示在等输入」而重置，于是模型盲等满 5 分钟（[issue #24707](https://github.com/google-gemini/gemini-cli/issues/24707)，已 stale 关闭）。我们的 §4.2.2 提示形态门控正好能识别这种情形并给出「用管道喂输入 / 加非交互 flag」的建议，因此**两者应当叠加，而不是二选一**：静默计时器负责兜底，提示形态识别负责把文案升级成可操作的诊断。

阈值不必自己拍脑袋，行业里已经形成三个明显聚集点（都可配置）：

| 档位 | 参考值 | 谁在用 | 在我们设计里的位置 |
|---|---|---|---|
| 软阈值「久无新输出」 | ~30s | OpenHands `NO_CHANGE_TIMEOUT_SECONDS = 30`（软超时：暂停并返回带部分输出的 observation，`exit_code = -1` 表示仍在跑）；SWE-agent `execution_timeout = 30`（直接 Ctrl+C） | 相当于 L1 的首个 `health: quiet`，**不动模型** |
| 「别再阻塞模型这一轮」 | ~2min | Claude Code Bash `BASH_DEFAULT_TIMEOUT_MS = 120000`、MCP 自动后台化 2min、子代理后台化 | L3 的目标触发点（转后台/交句柄） |
| 硬停滞上限 | ~5min | Gemini `shellToolInactivityTimeout = 300s`；Claude Code MCP idle window 5min（HTTP/SSE/WS） | L2 的 `silence_ms`（默认 300s），到期必须给模型结果 |

注意别混淆「常量恰好相等」：Gemini 的 300s inactivity 与 undici 的 300000ms body timeout 是两个互不相关的值。阈值也不要写死 —— issue #24707 的教训正是「用户以为超时是硬的，结果不是」。

### 4.3 L3：后台化（P2，目标态）

P1 的代价是「杀掉正在做的事」。更好的形态是 Claude Code / Codex / DSH 的做法：**结束的是等待，不是工作** —— tool call 立刻返回句柄，模型用 `job_output`/`job_kill` 轮询。DSH 的本地实现可直接作为参考实现（§6），但 core 侧有明确前置依赖：

- `packages/core/src/tool/bash.ts:88` 「Persist background job status and define restart recovery before exposing remote observation」
- `packages/core/src/tool/bash.ts:89` 「Re-add model-facing background launch only with owner-bound get/wait/cancel tools and completion delivery」

L3 的契约要点（Claude Code 已验证，可直接借用为验收标准）：

- **超时即转入后台，而不是失败**：默认路径下命令到点不报错、不被杀，而是变成后台任务；tool result 立刻返回 `Command running in background with ID: <id>. Output is being written to: <path>`（`BashTool.tsx:607-615,989-1001`）。
- **明确告诉模型「不要轮询、不用 sleep」**：提示词写死「you will be notified when it completes — do not poll」「No sleep needed」（`BashTool/prompt.ts:319,317`），并且**把反模式在工具层堵掉** —— `sleep N`（N≥2）直接被拒并给出替代方案（`BashTool.tsx:524-533`）。
- **通知在轮次边界投递，且对人类隐藏、对模型可见**：通知入队后在下一轮 agent loop 顶部作为 attachment 注入（`query.ts:1570-1590`），`isMeta: true` 的含义正是「transcript UI 里看不到、模型能看到」（`types/textInputTypes.ts:329-335`）。对应到 V2，就是本设计 §4.4 的 `Synthetic`/`System` 通道 —— 注意这两个通道目前**没有生产端**。
- **完成通知要防重复**：后台化与「刚好完成」会竞争，用 `notified` latch 去重（`LocalShellTask.tsx:105-122,476-486`）。
- **压缩时的兜底**：上下文压缩时若任务仍在跑，合成一条 `<system-reminder>` 说明「仍在运行 + 输出路径 + 不要重复起一个」（`messages.ts:3971-3994`）。
- **Codex CLI 的形态最接近「不干等」的本质**：交互式 `exec_command` **根本没有硬超时**，只有 `yield_time_ms`（默认 10s，钳制 250–30000ms，Windows 下限 10s），到点就返回 `Process running with session ID N` 而不是继续阻塞；后续用 `write_stdin`（`chars: ""` 即轮询，空轮询钳制 5s–`background_terminal_max_timeout` 默认 300s）带着同一个 `session_id` 继续；响应头里带 `Wall time: N seconds`，输出 schema 里带 `session_id`/`exit_code`/`wall_time_seconds`。**等待有界、句柄稳定、时长模型可见**。细节：
  - 单次模式（策略禁用 unified exec）才用 `timeout_ms`（默认 10s），到期 exit code 变成 **124**，模型拿到 `command timed out after N milliseconds\n<partial aggregated output>` —— 超时是普通工具结果 + 机器可读的退出码 + 部分输出（`core/src/tools/mod.rs:131-142`、`exec.rs:68,766-787`）。我们的 L2 用 `structured.timeout = true` 是同一思路。
  - 增量输出 `ExecCommandOutputDelta` **只给 UI**：不进模型输入（`core/src/session/turn.rs:1836,1876` 的 `realtime_text_for_event` 返回 None）、不持久化、MCP runner 也忽略；模型只看到最终工具体（`core/src/tools/context.rs:490-541`）。这再次印证「有输出才更新」不等于「模型知道在跑」。
  - 会话跨轮次与中断存活（`unified_exec.rs:2755-2942`），最多 64 个 live + LRU；单次模式不存活。**这正是我们要做 L3 必须先补的持久化能力**（对应 core 的两条 TODO）。
- **code-mode 的 `yield_control()` 是「只能靠结束调用来触达模型」的又一实证**：`notify()` 注入的 `CustomToolCallOutput` 也只在**下一次采样请求**才被投递，所以必须配合 `yield_control()` 结束这次工具调用、让脚本在可恢复 cell 里继续跑（`core/src/tools/code_mode/mod.rs:300-324`）。和我们在 §5.2.1 得到的 V2 结论一致：**先结算，才有下一轮**。
- **中断要留两种痕迹，而不是只丢一条结果**：Codex 在 turn 被中断时，把 `Wall time: N seconds\naborted by user` 作为**普通工具结果记入历史**（`session/turn.rs:2159-2182`），并在下一轮追加 `<turn_aborted>` 片段说明「后台进程可能仍在跑、被中止的工具可能已部分执行」（`context/turn_aborted.rs:10-11`）；还有测试断言这段文本确实出现在**后续请求**里（`abort_tasks.rs:213-301,306-372`）。我们的静默终止同理：结果里要写清「已终止」，下一轮要有「该命令可能已产生副作用/后台仍有残留进程」的提示。
- **可被新输入打断的等待**：Codex 的 `clock.sleep`（有界、新输入即返回）与 `wait_agent`（mailbox/steer 事件即返回）让「静默等待」能被人插话打断。我们的 V2 里 steer 只在下一次 provider turn 边界生效（§3.1），所以「用户插话打断静默等待」同样必须先结算该 call —— 记为 P2 之后的增强项。
- **Claude Code 官方文档版的「自动后台化」同样值得照抄**：主对话里仍在跑的 MCP 调用超过 `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`（默认 2 分钟）会自动转后台，「Claude receives the task ID immediately and keeps working, and the result arrives as a task notification when the call settles」；子代理另有 `CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS`（默认 600000），计时器**每次流式 progress 事件重置**，停滞后中止子代理并**把停滞上报给父模型**（不是只给 UI）。
- **OpenHands 的「软超时 + 续跑句柄」是同一思路的另一种落地**：软超时（30s 无变化）只**暂停并返回带部分输出的 observation**，用 `exit_code == -1` 表示「还没结束」，模型用空命令继续轮询；只有真到硬超时才按超时处理。它还做了一条我们值得抄的防护：前台命令的 `timeout` 若超过运行时 idle 超时的 90%（`MAX_FOREGROUND_TIMEOUT_RATIO`）会被**直接拒绝**并给出模型可见的说明 —— 这正是本设计「模型可以把 `silenceMs` 调大、但不能把兜底关掉」的现成实现。
- **SWE-agent 是反例**：超时后 Ctrl+C，给模型一条明确的取消说明（`command_cancelled_timeout_template`），但**丢弃部分输出**，并且连续 3 次超时就结束整个 run。它的阈值（30s）与「三次熔断」值得借鉴，丢弃部分输出则明确**不要**学。

所以 L3 作为独立阶段，与上游计划对齐后再做；P1 是它落地前就能交付「不能干等」的过渡形态。若 P1 与 L3 同时可用，**默认应走 L3（后台化），只有工具明确不可后台化时才走 P1 的终止语义**。

#### 4.3.1 已实现（V1，2026-09-17）

已经按本节落地，全部在 `packages/opencode/src`（未动 V2）：

- `src/tool/job.ts` 新增 `job_output` / `job_kill`：增量读取 job 的输出（只给新字节，或 `(no new output)`，末尾附 `[status: …]`），以及取消。跨 session 的 job 拒绝读取/终止；未知 id 会列出正在运行的 job。
- `bash` 增加有界等待 `yieldMs`（默认 15000ms，`OPENCODE_BASH_YIELD_MS` 覆盖，`0` 表示几乎立即转后台）：窗口内结束就照旧返回结果；仍在运行则登记为 `BackgroundJob` 并返回句柄（jobId + 输出文件 + 已捕获输出 + 通知约定）。
- 命令在**工具层的 scope** 里继续跑，因此能活过这次调用；取消 job 会中断该 fiber → 关闭 spawn scope → 杀掉进程。完成时向会话注入一条 synthetic 的 `[amio:background]` 消息（复用 `task` 的通知路径）。
- 已知缺口：转后台的命令**不报 `outputs` artifacts**（artifact 仍要求命令在窗口内结束且退出码为 0）；job 是进程内的，agent 重启即消失（与 Codex 的 exec session 同级）。
- 实测修掉的一个坑：转后台的命令原先**继承本轮的 abort 信号**，于是回合结束就被当成「用户中止」杀掉（exit code null）。现在转后台后忽略请求信号，只有 `job_kill`（或命令自己的 timeout）能停它 —— 与 Codex / Claude Code 对后台任务的处理一致。
- 与 Codex 的手感对齐：Codex 那边「还在跑 / 看着不对，杀掉重跑」并不是看门狗，而是**模型自己用 `write_stdin` 空轮询（5s–300s）**分次等待后自己判断。我们现在提供同样的能力：`job_output` 支持 `wait_ms`（有界等待，上限 300s），提示词**只陈述能力**（增量读、可等待、可 `job_kill`、完成会自动通知），要不要等、要不要杀由模型自己判断。注意 V1 默认 `steps` 为无限（`prompt.ts:1219`），轮询次数没有硬上限。
- 总时长语义对齐 Codex：`timeout` 只约束**前台等待**，命令转后台后不再被它杀掉，只能由 `job_kill` 停（`shell.ts` 的 race 在 detach 后走 `Effect.never`）。作为替代保险，后台任务的 spool 文件在 1 GiB 处停止增长并写入截断标记。
- 已等时长回传（对齐 Codex 的 `wall_time_seconds`）：`job_output` / `job_kill` / `bash` 的转后台句柄都输出 `[status: …] [wall time: 2m30s]`，metadata 里带 `wallTimeMs`，完成通知写「after 1m3s」。
- job 回收：注册表在每次 `start` 时丢弃超过 64 个的终态 job，并暴露 `prune({ keep })` 供显式调用，避免长会话把已结束 job 的输出一直留在内存里。这一条动了共享注册表 `packages/core/src/background-job.ts`（V1 wrapper 与 `task` 后台模式本来就在用它），未触及任何 V2 的 session/tool 代码。

### 4.4 可选：静默事实的 next-turn 记录（P2.5）

如果希望「工具最终完成、但中途静默很久」这件事也留痕给模型，可以加一个 `SystemContext` source（`packages/core/src/system-context/index.ts:32-39` 的 `Source` 已支持 `baseline`/`update`/`removed`），key 如 `amio/tool-silence`，值为最近静默过的 call 列表（带 TTL 与 `removed` 渲染）。注意它只在下一个 provider turn 生效，**不能**替代 L2。

另外，V2 已经有两条「对人类隐藏、对模型可见」的消息通道，但**都没有生产端**，可作为 Claude Code `isMeta` 通知在 amio 里的落点：

- `SessionMessage.Synthetic` → 翻译成 `user` 消息（`runner/to-llm-message.ts:132-133`、`message-updater.ts:149-159`、`schema/session-event.ts:112-120`）；
- `SessionMessage.System` → `Message.system`（`to-llm-message.ts:134-135`），目前唯一生产端是 `SessionContextEpoch.prepare` 发的 `ContextUpdated`（`context-epoch.ts:72-76`）。

两者都只在 turn 开始时被读取（`history.ts:44-47`），所以它们的定位是「下一轮的通知」，与 L3 的完成通知语义一致。

另有一个更直接的前例：Gemini CLI 的后台完成通知走的是**模型专用注入通道** —— `executionLifecycleService` 调 `injectionService.addInjection(text, 'background_completion')`，注释写明「Inject directly into the model conversation from the backend」，注入来源枚举为 `'user_steering' | 'background_completion'`。这相当于在 amio 里给 `Synthetic` 通道定了一个用途明确的来源标签（`background_completion` / `silence_watchdog`），比无标签地塞消息更可控、也更容易在回放与 UI 中被过滤。

## 5. 落点清单

### 5.1 V1（Astron 今天实际使用的路径）

| 文件 | 改动 |
|---|---|
| `packages/opencode/src/session/tool-progress.ts`（新增） | 活动时钟、心跳 fiber、静默监督器、阈值判定 |
| `packages/opencode/src/session/tools.ts` | execute 包装登记活动/开始时间；`ctx.metadata()` 与结算刷新时钟；racing 静默触发；per-call AbortController |
| `packages/opencode/src/session/processor.ts` | 新增「以静默超时结算」的 processor API（或在 `completeToolCall` 上加显式 timeout 分支）；中断/完成时清理时钟（对齐 `:587-603`） |
| `packages/opencode/src/config/config.ts` | 新增 `tool_progress` 配置块（周期、阈值、上限、开关） |
| `packages/opencode/src/tool/shell.ts` | 可选：把总时长上限与静默上限的关系写进工具描述，避免模型误以为调大 `timeout` 就万事大吉 |

### 5.2 V2（未来切换后）

| 文件 | 改动 |
|---|---|
| `packages/core/src/tool/tool.ts` | `Tool.Context` 增加 progress 上报通道（补齐 `bash.ts:71` 所说 "once V2 tool invocation progress context is wired"）；同时补 per-call 取消/信号能力 |
| `packages/core/src/session/runner/llm.ts` | 在工具分支 `:238-266`（紧跟 `:244`）挂心跳 fiber，发布 `SessionEvent.Tool.Progress`；`:245-266` 的 settle 分支外包一层「静默 deadline → 按 callID 发布失败结果」 |
| `packages/core/src/session/runner/publish-llm-event.ts` | `createLLMEventPublisher` 的返回面（`publish/flush/failUnsettledTools/...`，`:411-422`）新增 `progress(callID, structured, content)` 与按 callID 的 `failTool(...)` |
| `packages/core/src/tool/registry.ts` | `Materialization.settle`（`:31-32`）/ `ExecuteInput`（`:16-21`）可选地接受 per-call deadline；registry 目前**没有** `EventV2` 依赖（`:44-48`），progress 通道只能由 runner 注入 |
| `packages/core/src/tool/bash.ts` | 按 chunk/节奏上报进度，删除 `:71` 的 TODO；并把已存在但未接线的进程级取消接上（`RunOptions.signal`，`process.ts:32,101-110,189-195`） |
| `packages/core/test/tool-bash.test.ts:429` | 该 TODO 字面量被测试钉住，实现后必须同步改 |
| `packages/schema/src/session-event.ts` / `projector.ts` / `message-updater.ts` / `packages/tui/src/context/data.tsx` | **无需改动**：事件、投影、TUI 消费端上游已就绪 |
| `packages/opencode/src/acp/event.ts` | 上游该文件没有 `session.next.tool.progress` 分支；若要服务非 Astron 的 ACP 客户端（Zed 等），补一个 case，字段走 `_meta`（见 §5.4） |

#### 5.2.1 V2 实现约束（runner 实测，容易踩）

1. **心跳 fiber 不能放进 `toolFibers`**：`awaitToolFibers = Effect.raceFirst(FiberSet.join, FiberSet.awaitEmpty)`（`runner/llm.ts:140-141`，`:291` 调用）要求该集合排空，塞一个永不结束的 fiber 会直接死锁整轮。心跳要用 turn scope（`Effect.fn(..., Effect.scoped)`，`:343`）下的 `Effect.forkScoped`。
2. **静默到期不能靠 interrupt fiber 实现**：单次 settle 的 interrupt cause 会走到 `:297-305` / `:338-339` 从而**拆掉整个 drain**；而 `publisher.failUnsettledTools`（`:306-310`）会把所有未结算的 call 一起失败掉。正确做法是让 `:245-266` 的 fork「按时完成」：deadline 触发时为**该 callID** 发布一条模型可读的失败结果，`needsContinuation` 已在 `:243` 置位，于是下一轮 provider turn 立刻开始，模型读到这条结果。
3. **今天没有 start time / last-activity**：publisher 的 per-call 记录只有布尔量（`runner/publish-llm-event.ts:55-66`），`time.ran` 只存在于投影后的 message（`message-updater.ts:276`）。活动时钟需要一个新增的 `Ref`/时间戳 sink。
4. **运行中工具的进度对模型不可见**：`to-llm-message.ts:88-107` 对本地工具只产出 `ToolCallPart`；`toolResult()`（`:39-68`）仅在 `completed`/`error` 时返回值，`running` 返回 `undefined` 并被过滤。因此「在工具未结算时另起一轮」会让模型看到没有结果的 `ToolCallPart` —— 任何方案都必须先结算该 call（本设计 L2 正是这么做的）。
5. **进度内容只有在失败路径下才会进入模型**：`Tool.Failed` 投影会把 running 期的 `structured`/`content` 拷进 error state（`message-updater.ts:335-336`），error 翻译会带上它们（`to-llm-message.ts:62`）；成功路径会用最终值覆盖并丢弃（`:307-315`）。这给了一个免费的好处：**静默超时应走「失败/超时」语义，才能把最后进度带给模型**。
6. **已有的恢复钩子**：drain 开始时 `failInterruptedTools` 会把 pending/running 的工具重新发布为 `Tool.Failed`（`llm.ts:118-138`），可复用于进程崩溃后清理静默工具。
7. **本项目与上游在以上各点行为一致**：`git diff upstream/dev dev` 在 `runner/llm.ts`/`projector.ts`/`registry.ts`/`execution/local.ts`/`tool/bash.ts` 上只有 artifact、session-affinity header、`defaultLayer` 一类差异；`schema/session-event.ts`、`message-updater.ts`、`to-llm-message.ts`、`input.ts`、`session.ts` 与上游完全相同。所以这不是 fork 自造的差异，而是上游本身的空白。

### 5.3 Cowork 侧（下游配合：只转发，不再生成）

单源原则：进度一律由 amio 产生，Cowork 只做转发与展示，**不再自己合成 progressMessage**。

| 文件 | 改动 |
|---|---|
| `adapters/opencode/events.py`（`OpencodeAcpTranslator`） | 读 tool part 的 `metadata.progress` → 产出 `tool_call_update.progressMessage/health/elapsedMs/lastActivityAt`（字段沿用现值，前端 `ReasoningTimeline` 不改；合规性见 §5.4） |
| `acp/server.py` `_tool_heartbeat_loop` / `_emit_tool_heartbeat` / `_track_tool_call_update` | **删除生成逻辑**（整套心跳连同 60s 循环、`quietCount`、阈值表一起下线）；Cowork 不再产生任何进度文案 |
| amio 侧（配套补全） | `possibly_stalled`（运行流已结束但工具仍未完成）的交叉判断必须由 amio 承担 —— Python 不再算它。amio 用 V1 `packages/opencode/src/session/status.ts` 的 `busy`/`idle` 状态即可得到同样的结论，三档 `health`（`ok`/`quiet`/`possibly_stalled`）全部由 amio 产出 |
| 版本/能力门控 | 启动时探测 fork 是否上报 `metadata.progress`：**不满足就不显示进度**，而不是回退到 Python 自己生成。同时把 Electron 侧绑定的 amio-agent 最低版本写进发布要求，避免旧 sidecar 上出现「没有任何进度提示」的静默降级 |

### 5.4 ACP 字段合规性（重要）

核对 ACP 规范（`E:\Projects\agent-client-protocol-main`）后，Cowork 今天用的根级 `progressMessage` / `health` / `elapsedMs` **不是规范字段**：

- 规范对 tool call 只定义 `toolCallId`(必填) / `title` / `kind` / `status` / `content` / `locations` / `rawInput` / `rawOutput` / `_meta`（`schema/schema.json:3120-3179` `ToolCall`、`:3287-3351` `ToolCallUpdate`）；`status` 仅 `pending | in_progress | completed | failed`（`:3262-3285`）。**没有**进度百分比、进度文案、elapsed、ETA、时间戳或心跳字段；稳定版与 unstable 都没有任何含 "progress" 的 JSON-RPC 方法。
- 根级自定义字段违反规范正文：`docs/protocol/extensibility.mdx:39` "Implementations MUST NOT add any custom fields at the root of a type that's part of the specification."。注意实现细节：生成的 JSON Schema 从不设 `additionalProperties:false`，所以这类字段仍能通过校验；但 Rust SDK 类型没有 `deny_unknown_fields`，标准 ACP 客户端会**静默丢弃**它 —— 只有 `_meta` 能存活（`Meta = Map<String, Value>`，`src/ext.rs:15`）。
- 结论与决策：
  1. **P0 不动 Cowork 内部线格式**：fork 侧产出的是 opencode 自己的事件面（part metadata），**根本不涉及 ACP 字段**；只有 Python server → Cowork 前端那一跳是 ACP 形状，而两端都是自己的，保留 `progressMessage`/`health` 现值等于前端 `ReasoningTimeline` 零改动，风险最低。
  2. **对外 ACP 面一律走 `_meta`**：fork 的 `packages/opencode/src/acp/*`（以及未来接 Zed 这类标准客户端）用命名空间扩展，例如 `_meta: { "amio/toolProgress": { message, health, quietMs, elapsedMs, lastActivityAt } }`。
  3. 若要把 Cowork 也迁到 `_meta`，作为独立小改动排期（改前端读取字段），不要和 P0/P1 混在一起。
- 取消粒度：`session/cancel` 是 session/turn 粒度（`CancelNotification = {sessionId}`，`schema.json:509-530`），稳定版**没有** per-tool-call cancel；unstable 的 `$/cancel_request`（按 `requestId` 取消单个 in-flight 请求）是唯一能只中止一个 `terminal/wait_for_exit` 的机制。本设计的 L2 per-call abort 属于 agent 内部行为，不需要 ACP 面表达。
- 规范自带的「静默长命令」处方与 L2 完全一致：`docs/protocol/terminals.mdx:250-261` 的 "Building a Timeout" 要求 terminal + 计时器 race `terminal/wait_for_exit`，到期 `terminal/kill`，再 `terminal/output`，并**把输出放进给模型的响应**。也就是说规范推荐「把超时转成模型可见结果」，而不是做一条进度通道。
- 规范瑕疵（备查）：`docs/protocol/prompt-turn.mdx:296` 让客户端把未完成的 tool call 标为 `cancelled`，但 `ToolCallStatus` 没有该取值（`schema.json:3262-3285`），**不要自造这个状态**。
- `_meta` 的用法照规范示例走命名空间（`extensibility.mdx:25-28` 的 `"zed.dev/debugMode"`）：我们用 `_meta: { "amio/toolProgress": { … } }`。若还需要独立消息，第二条合法路径是 `_` 前缀的自定义方法/通知，并在 `_meta` capabilities 里声明（`extensibility.mdx:41-109,111-134`）。
- 顺带一条容易踩的规范义务：ACP 草稿 `docs/protocol/draft/cancellation.mdx:28-38` 规定**内部超时算内部取消，必须返回 `-32800 Cancelled` 错误响应**。本设计的 L2 是 agent 内部对单个工具调用的处置，不涉及取消某个 ACP 请求；但如果将来把「中止某次工具调用」暴露成 ACP 能力，就要满足这条。
- 客户端的 elapsed 不需要协议字段：ACP 客户端收到 `in_progress` 的 `tool_call_update` 就能自己起本地计时；它们**无法本地推导的是「执行方是否还活着」** —— 这才是心跳真正要传的信息。这条正好支持我们 L1 只发心跳、不发明 progress 字段的决定。

## 6. 参考：其他 agent / 客户端的做法

**本地已验证（DSH，`E:\Projects\deepseek-harness`）**——与本设计最接近的成熟实现：

- 工具调用**有界等待**后返回给模型，工作继续在后台跑：`packages/terminal/tool-terminal/src/render.ts:120-131` 渲染 `(no new output)\n[wait: timeout]\n[session: running]`，并有系统提示明确「An inferred_idle or timeout result does not prove the foreground command exited」（`src/index.ts:159`）。
- 后台 job 与模型轮询：`packages/jobs/tool-jobs/README.md:156` `job_output` 返回输出或 `(no new output)` + `[status: …]`；`README.md:127` 的模型指引明确「不要 busy-poll 或 sleep，完成后会有 in-session 通知」。
- 前缀缓存友好：通知是追加式的，「newly visible content follows the reusable request prefix and does not invalidate existing KV Cache entries」（`README.md:162-164`）——这也是本设计选择「把静默事实挂在 tool result 上」而不是重写上下文的原因之一。

**ACP 规范（已验证，摘要见 §5.4）**——三点直接支持本设计：

- 规范**没有**工具进度通道，只能走 `_meta`；把静默信息做成进度字段是规范外行为。
- 规范**有**把超时转成模型可见结果的处方（`terminals.mdx:250-261` 的 "Building a Timeout"：race → kill → 取输出 → 放进模型响应），与本设计 L2 同构。
- 取消粒度是 turn 级，per-call 取消在稳定版不可表达（unstable `$/cancel_request` 才有），所以 L2 的 per-call 中止应留在 agent 内部实现，不要试图在 ACP 面暴露。

**Claude Code（已验证；注意这是 2026-03-31 从 npm `.map` 泄露出来的 `src/`，无 `package.json`/CHANGELOG/测试，版本无法核对）**——它把「心跳给人、超时给模型」这条分工做得最彻底：

- **进度永不进模型上下文**：`onProgress`/`bash_progress` 只服务 UI，`normalizeMessagesForAPI` 在发请求前把 `type === 'progress'` 全部过滤掉（`messages.ts:2056-2075`）。也就是说，一个安静跑 9 分钟的 `git log -S` 在模型眼里和卡死没有区别 —— 恰好是我们截图里的情形。
- **默认「超时即后台化」，不杀也不报错**：`shouldAutoBackground`（仅 `sleep` 例外）→ 走后台回调而非 kill（`ShellCommand.ts:135-141`、`BashTool.tsx:880,307-315`）；模型拿到 `Command running in background with ID: …`，「Command timed out after 2m」只在关闭后台化时才可能出现。
- **唯一的「静默 → 模型」机制是可操作性门控的 stall watchdog**（45s 无增长 + 尾部像交互式提示 + 给出处置建议，且只对后台化任务布防，见 §4.2.2）——它**刻意不在「只是慢」时报**。
- **没有任何周期性「still running」提醒**（此条是 2026-03-31 泄露快照的结论）；所有 `heartbeat`/`keepalive` 都是传输/租约存活（WS `keep_alive`、SSE keepalive、worker heartbeat），与对话无关。官方文档描述的新版本另加了两条**模型可见**的机制：主对话 MCP 调用超过 2 分钟自动后台化并把 task ID 立即交给模型（`CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`）；子代理停滞 600s（每次 progress 事件重置）则中止并**把停滞上报给父模型**（`CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS`）。MCP 的 idle window（5/30 分钟）只重置 idle 看门狗，**不允许延长 wall clock**（见 §4.2.3）。
- 通知的人类/模型区分用 `isMeta: true`（`textInputTypes.ts:329-335`），投递点在下一轮 loop 顶部（`query.ts:1570-1590`）。
- 它**明确不做的四件事**，正好是本设计要补或要避开的：不给模型流进度、不做周期性静默提醒、不把超时当回合级错误、不在工具调用中途注入任何东西。

对我们的取舍结论：**L1 无条件做（给人看）、L2 必须可操作性门控（给模型看，且宁可后台化也不要误杀）、不做任何「在线注入模型」的尝试** —— 三家做法（Claude Code、ACP 规范、DSH）在这三点上是一致的。

**Gemini CLI（已验证，源码 + 已合并 PR #13531）**——把「静默」做成了独立于总时长的第一等机制：

- shell 工具有 `shellToolInactivityTimeout`，**默认 300s，每个输出事件重置**；到期取消命令，并把 `Command was automatically cancelled because it exceeded the timeout of N minutes without output.` + 取消前部分输出作为模型结果（§4.2.3 有完整引用）。**模型与 UI 拿到的是同一段文本**，是本节唯一「静默文案直接进模型」的实现。
- 除此之外，进度仍然只走 UI：`ShellExecutionService` 只发 data/binary/exit 事件，没有定时心跳；实时输出经 `updateOutput` 给 CLI，并以 `OUTPUT_UPDATE_INTERVAL_MS = 1000` 节流；模型只在 `execute()` resolve 时拿到 `ToolResult.llmContent`。工具类型把两条通道分开写明：`llmContent` = 进模型历史，`returnDisplay` = 给人看的 Markdown。
- 后台完成通知走**模型专用注入**：`injectionService.addInjection(text, 'background_completion')`。
- 已知缺口：交互式提示不产生输出 → inactivity 计时器永不重置 → 模型盲等满 5 分钟（issue #24707）。这正是我们要用「提示形态识别」补上的部分。

**Codex CLI（已验证，`E:\Projects\codex\codex-rs`）**——根本不给「干等」留位置，但代价是它不做静默监测：

- 交互式 `exec_command`：**没有硬超时**，只有 `yield_time_ms`（默认 10000ms，钳制 250–30000ms，Windows 下限 10000）；「Runs a command in a PTY, returning output **or a session ID** for ongoing interaction」。
- `write_stdin`：`session_id` + `chars`（空即轮询）+ `yield_time_ms`（空轮询钳制 5000ms–300000ms）。
- 模型可见文本：响应头 `Process running with session ID N` / `Wall time: N seconds`；输出 schema 含 `session_id`（仍在跑时）/ `exit_code`（本次结束才有）/ `wall_time_seconds`。
- 单次模式的 `timeout_ms`（默认 10000）到期把 exit code 置为 **124**，返回 `command timed out after N milliseconds\n<partial aggregated output>`。
- 会话跨轮次与 interrupt 存活（最多 64 live + LRU），单次模式不存活；`ExecCommandOutputDelta` 只走 UI。
- **它明确不做的**：静默期间不给模型任何周期性心跳或「no output for N」提示（模型此时并未在采样）；yield 纯按墙钟、不按静默；交互式 yield 路径连 "timed out" 字样都没有；中途注入的 `CustomToolCallOutput` 也必须等下一次采样、因此只能配合 `yield_control()` 结束当前调用。整个 exec 层没有 heartbeat/keepalive 原语。

**MCP `notifications/progress`（标准，值得借为心跳原语）**：带 `progressToken`、单调递增的 `progress`、可选 `total` 与 `message`，且明确「Receivers … MAY choose not to send any progress notifications」。ACP 没有对应能力（§5.4），所以 ACP 侧只能走 `_meta`；而 Claude Code 对它的用法正是本设计的分工样板：**progress 重置 idle 看门狗，wall clock 依然独立**。

**OpenHands / SWE-agent / Devin / Amp / Cursor（部分已验证）**：

- **OpenHands**——「以进度形状表达的契约，而不是心跳」最干净的样本：软超时 30s → 暂停并返回**带部分输出**的 observation；`exit_code == -1` 表示仍在运行，于是 `to_llm_content` **刻意不加** `[Command finished with exit code N]`（只有 `exit_code != -1` 才加），并且把「轮询」做成一等能力（`is_input=True` + 空命令取更多日志，还可以送 `C-c`/`C-z`/`C-d`）。前台 `timeout` 超过运行时 idle 超时 90%（`MAX_FOREGROUND_TIMEOUT_RATIO`）时，拒绝文案**本身就是 observation**（模型可见的拒绝，不是抛异常）。唯一 UI-only 的是 `visualize` 渲染的 "Process still running (soft timeout)"。已知文档/代码不一致：工具描述写 10s，实际常量 30s。
- **SWE-agent（反例）**：`execution_timeout = 30` → Ctrl+C 并给模型 `command_cancelled_timeout_template`，但**接口层就没做完** —— `BashAction.timeout: float | None = None  # None means no timeout` 还挂着 `# todo: implement non-output-timeout`，`BashObservation.failure_reason` 有文档却从未被 `LocalRuntime` 填充。结果是模型拿到的**唯一**停滞信号就是那句模板文案，**部分输出被丢弃**，连续 3 次超时结束 run。它和 SWE-ReX 都没有任何心跳/进度机制。
- **Devin（官方 changelog，v2026.5.26-0 等）**：超时后命令**继续在后台跑**，并「report how long Devin waited before returning」；取消/超时**先 SIGTERM 进程组、5 秒宽限后再 SIGKILL**；`sudo` 密码提示这类阻塞会 fast-fail 并给解释。进度**只给 UI**（Ctrl+B 后台 shell 托盘、命令卡片在回合结束后继续流式输出），模型只拿结果 + 等了多久。它印证了行业默认仍是「转后台 + 在 UI 里让用户知情」，**没有**中途给模型的心跳。
- **Amp**：仍然**没有**任何一手资料说明它有工具超时/停滞处理/合成停滞消息/心跳（官方 Tools、CLI、Execute-mode、Settings、Chronicle、News 页均无）；最近似的官方事实都只是相邻能力（`amp.notifications.enabled` 在「完成或被阻塞等待输入」时响铃；长任务用 orb/远端执行移出前台；newsletter 的 schedule 与 steer-don't-queue）。它给的是**原语而非策略**：插件 `tool.call`/`tool.result`、`ctx.ui.notify`（UI）、`ctx.thread.append` / `agent.end → {action:'continue'}`（模型可见）——两半都能由插件实现，但那是能力，不是内建行为的证据。
- **Cursor**：**UNKNOWN，属检索受限而不是「验证了不存在」** —— 本环境所有官方 Cursor URL 抓取都失败（网络错误而非 404），GitHub API 后段 403；论坛里「shell 工具卡住」的帖子是用户言论且未抓取，只能算二手未证实。

调研 caveat（供复核）：ACP 检出为 schema **0.11.5**（2026-04-09，无 `.git` 无法核对 commit）；Claude Code 文档带版本号且更新频繁，阈值按「读取时有效」看待；OpenHands `main` 已不含 Python agent（迁到 `OpenHands/software-agent-sdk`），旧路径只在相关 PR 里真实存在；OpenHands/SWE-agent 的引用是符号名（`NO_CHANGE_TIMEOUT_SECONDS`、`command_cancelled_timeout_template`、`MAX_FOREGROUND_TIMEOUT_RATIO` …）而非行号，因为 raw.githubusercontent.com 不提供行号；Codex [issue #22541](https://github.com/openai/codex/issues/22541)（初次 `exec_command` 被压到 ~30s）与源码默认值冲突，属用户报告未证实。

## 7. 上游关系与合并冲突

上游**没有**实现本功能，只有脚手架：

- 事件已定义：`packages/schema/src/session-event.ts:331`（注释即「Replayable bounded running-tool state. Tools should checkpoint semantic transitions or at a bounded cadence」）。
- 消费者已就绪：`packages/core/src/session/projector.ts:387`、`message-updater.ts:288`、`packages/tui/src/context/data.tsx:298`、client/OpenAPI 生成类型、单测 `packages/core/test/session-tool-progress.test.ts`。
- **无生产端**：全树 grep `Tool.Progress` 只有上述消费端与测试；`packages/core/src/tool/bash.ts:71` 的 TODO、被测试钉住的字面量（`packages/core/test/tool-bash.test.ts:429`）、以及 `runner/llm.ts:74` 未勾选的清单项（"Add scoped runtime context, progress updates, …"）三处互相印证。
- 上游的「有输出才更新」：V1 `tool/shell.ts:487-530` 每 chunk `ctx.metadata(...)`；ACP `src/acp/event.ts:341-377` 事件驱动地发 `tool_call_update`（含 `shellOutputSnapshot`），**没有定时器**。
- 上游唯一的活性检测是 MCP 专用的 `src/tool/code-mode.ts:154-158`（`resetTimeoutOnProgress`），与消费者无关。

对 fork 的影响：

- 我们的 L1 生产端正好落在上游留空的位置，形状按上游既定语义实现，具备回贡可能。
- 冲突面（上游 1132 个 commit 未合并）：`core/src/tool/bash.ts`（TODO 区域）、`core/test/tool-bash.test.ts:429`（钉住字面量）、`core/src/session/runner/llm.ts`（清单 + fiber 安装点）、`packages/opencode/src/session/{tools,processor}.ts`（V1 热点文件，fork 已大幅分叉）、`packages/opencode/src/acp/event.ts`（fork 已重写，228 行 diff）。
- 降低冲突的约束：心跳/阈值/文案集中在一个新模块与一处常量表；V1 的改动尽量只落在 `session/tools.ts` 包装与新增 processor 方法上。

## 8. 测试计划

- V1（`packages/opencode`，须从包目录运行）：假工具静默挂住 → 断言 part metadata 的 progress 周期更新、`health` 分级、静默上限触发后**该 call**被结算为模型可见结果、且同一轮其他工具/整轮未被中断。
- V2（`packages/core`）：基于现有 `session-tool-progress.test.ts` 扩展 runner 级测试（TestClock 推进），断言 `Tool.Progress` 的节奏与有界性、静默结算的事件序列与持久化顺序。
- 协议层：断言 `metadata.progress → tool_call_update.progressMessage/health` 的映射（Cowork 侧 `test/test_acp_session_load.py` 已有心跳用例）；由于不再有兜底路径，旧用例应改为断言「Cowork 自身不再生成 progressMessage」，而不是保留双源测试。
- 回滚开关测试：`tool_progress` 关闭时行为与今天一致（无 progress 元数据、无静默结算）。

## 9. 分期与回滚

1. **P0 心跳下沉**：V1 活动时钟 + 心跳 + 三档 `health`（含 `possibly_stalled` 的交叉判断）+ Cowork 翻译器读取 + **Cowork 删除生成逻辑**（单源，无双发窗口）。此阶段不改等待语义。
2. **P1 静默上限**：shell 类工具**默认开启、默认 300s**（对齐 Gemini 的 `shellToolInactivityTimeout`），其他工具默认关闭；灰度观察误杀率，并结合 §4.2.2 的提示形态门控升级文案。
3. **P2 后台化**：与 core 的 background job 前置依赖一起排期。
4. 全程可用配置/env 关闭；**Cowork 侧不留任何生成逻辑也不再留兜底** —— 拿不到 amio 的进度就不显示进度，只记录日志/指标，绝不静默降级为本地生成。

## 10. 开放问题

1. 静默上限该由 loop 配置决定，还是允许模型用参数（如 `silenceMs`）覆盖？倾向：loop 定默认与下限（shell 类默认 300s、`<=0` 关闭），模型可在**下限之上**调大以表达「这个命令确实会安静很久」，但不能把兜底整个关掉。
2. 「尾部像交互式提示」的识别（§4.2.2）放在 P0 还是 P1？它只影响文案质量（Gemini 的教训是纯 inactivity 会让等输入的进程盲等满 5 分钟），但对 P1 的误杀率影响最大，倾向随 P1 一起做。
3. 静默上限到期时，**部分输出从哪来**？V1 shell 已有 sink + `ctx.metadata`（可直接取尾部），V2 bash 目前 `combineOutput` 只在退出时返回（`core/src/tool/bash.ts:179-197`），需要先补流式取数才能把「取消前输出」带给模型。
4. `task`/子代理这类天然长时间静默的工具是否需要单独的、更长的阈值与文案（当前 Cowork 也把它们算长工具）？
5. P0 的 progress 放 part metadata（临时、随 part 走）还是直接上 V2 的 `Tool.Progress` 持久化（可重放、TUI 可见，但引入事件量与投影成本）？倾向 V1 用 metadata、V2 用事件。
6. 是否需要把 `possibly_stalled`（运行流已结束但工具未完成）升级为自动终止？目前 Cowork 只提示，建议保持提示 + 交给 L2 的静默上限处理。
