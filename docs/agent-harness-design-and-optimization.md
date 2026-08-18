# Agent Harness 设计与优化总结

## 概述

本文总结 Astron Cowork 场景下 Agent Harness 的设计与优化。Agent Harness 位于 Cowork 与底层模型、工具和文件系统之间，负责把一次模型调用组织成可运行、可控制、可扩展、可恢复、可观测的 Agent 任务。

它解决的重点不是模型本身如何生成内容，而是 Agent 如何作为产品运行：运行时如何启动，Prompt 如何跟踪，Session 如何绑定 Workspace，工具和技能如何调度，子 Agent 如何受到权限约束，长上下文如何恢复，以及内部状态如何准确传递给 Cowork。

围绕这些目标，Agent Harness 的设计和改造可以归纳为以下 17 个方面。

## 1. 运行载体 Harness 化

建立独立的 `amio-agent` Sidecar，使 Agent 能力可以作为后台服务被 Cowork 启动和托管，而不再依附完整的终端或 Web 产品形态。

主要能力包括：

- 新增独立的 `amio-agent` CLI 入口和构建目标。
- 只注册 `serve` 命令，不加载交互式产品命令。
- 关闭 TUI、Web UI 命令和 Web UI 路由。
- Web UI 相关代码仅在启用时动态加载。
- 支持独立二进制命名、稳定版本号和跨平台构建。
- 保留标准 OpenCode 的入口和默认行为，Sidecar 改造只作用于 `amio-agent`。

这一步完成了 Agent 的运行边界封装：Cowork 只需要管理一个独立进程及其 HTTP、ACP 接口，不需要集成完整开发工具。

## 2. Prompt 执行生命周期 Harness 化

将每次 Prompt 建模为具有唯一身份和明确终态的执行单元，避免宿主通过 `session.idle` 或最后一条消息猜测任务是否结束。

Harness 提供三类 Prompt 终态事件：

- `prompt.completed`
- `prompt.failed`
- `prompt.cancelled`

事件可以携带 `requestID`、`promptID`、用户与助手消息 ID、Stop Reason、Finish Reason、Token Usage、Cost 和标准化错误信息。Cowork 因此可以把外部请求、内部执行和最终消息精确关联，并明确区分正常完成、模型失败和用户取消。

对于部分 Provider 返回的 `finish="unknown"`，Harness 不会在没有有效结果时直接结束任务，而是继续执行循环，直到获得明确终态。这避免了模型空响应或异常结束状态导致的静默退出。

## 3. Session 与 Workspace Harness 化

Agent 的配置、工具、技能、权限和文件操作都依赖当前 Workspace。Harness 对 Session 与运行目录的关系进行了显式管理，保证请求在正确环境中执行。

- Session 持久化工作目录和可选的 Workspace Identity。
- HTTP 请求可以显式提供 Directory 或 Workspace Hint。
- 显式路由信息优先于 Session 中保存的旧目录。
- 运行时根据最终 Location 装配对应的目录级服务。
- Agent、Provider、Tool Registry、Skill Registry 和文件系统共享同一 Workspace 语义。

这样可以避免多个 Assistant、Session 或 Workspace 共用 Sidecar 时发生环境串用，也不再依赖进程启动时的当前目录决定 Agent 的实际工作区。

## 4. Agent 配置热更新 Harness 化

Harness 新增 `/config/reload`，使 Cowork 可以在不重启 Sidecar 的情况下更新运行配置。

Reload 覆盖：

- 生成后的运行时配置。
- Agent 定义。
- Skill Path。
- Skill Discovery Cache。
- 已加载的 Skill Cache。

因此，Assistant、插件和技能发生变化后，不需要销毁整个运行时。Harness 从只能读取启动时静态配置的进程，演进为可以动态更新能力集合的 Agent 容器。

## 5. Tool 调度 Harness 化

工具不再被视为一次性注入模型请求的静态参数，而是由 Harness 管理的动态能力。

- Built-in Tool 默认保持常驻。
- Plugin Tool 和 Config Tool 默认进入 Deferred Registry。
- 工具可以通过 `deferLoading: false` 显式设置为常驻。
- 新增模型可调用的 `tool_search`。
- `tool_search` 按工具 ID、描述和业务意图搜索能力。
- 命中的工具只在后续模型步骤进入活跃工具集合。
- 支持使用 `select:<tool_id>` 精确激活工具。
- 搜索采用相关性评分，支持中文、英文和中英文混合意图。

这种机制将工具规模与初始模型请求解耦。即使持续增加业务工具，每次 Prompt 也只需要携带当前任务真正需要的 Tool Schema。

## 6. Skill 调度 Harness 化

Skill 从完整内容的静态注入，改造成轻量索引与按需加载相结合的能力系统。

- 初始系统上下文只提供 Skill 名称和一句话描述。
- 不在初始 Prompt 中暴露完整 Skill 内容和本地路径。
- 新增 `skill_search`，根据任务意图查找当前可用技能。
- 完整 Skill 内容继续通过 `skill` 工具加载。
- Skill 描述优先采用面向模型的 Short Description。
- Skill Path 变化后可以通过 Reload 刷新，无需重启。

这样既控制了系统 Prompt 长度，也避免模型根据历史记忆猜测已经删除、更名或尚未加载的 Skill。

## 7. Plugin 执行 Harness 化

为了让外部插件和自定义工具能够随 Sidecar 独立交付，Harness 增加了 Bundled Plugin Runtime。

外部插件入口由 Bun 在运行时进行 Bundle，并通过 Harness 提供的 Plugin API Shim 解析 `@opencode-ai/plugin`。配置目录中的自定义 `tools/*.ts` 使用同一套加载机制，因此即使用户目录中没有 `node_modules`，插件和工具仍然可以正常加载。

运行时不再为配置目录安装依赖，也不再写入依赖专用的 `package.json`、Lockfile、`.gitignore` 和 `node_modules`。插件执行依赖由 Harness 自身负责，避免任务启动受用户开发环境和外部网络影响。

## 8. Subagent 调度 Harness 化

Task 创建的子 Agent 作为独立 Child Session 运行，但仍处于父任务的 Workspace 和权限治理范围内。

- 子 Agent 继承父 Agent 的 `external_directory` 规则。
- 父 Session 的 Deny 规则继续作为子 Agent 的权限上限。
- 子 Agent 自身的工具限制仍然保留。
- 默认限制不适合子 Agent 使用的 `todowrite` 和嵌套 `task` 等能力。

子 Agent 因此既可以继续处理父任务所在的外部工作区，又不能突破父 Agent 已设定的安全边界。任务拆分能力与权限控制被统一到同一套 Harness 规则中。

## 9. 上下文管理 Harness 化

Harness 对长会话增加了上下文预算、主动压缩和溢出恢复能力。

- 新增 `compaction.threshold_tokens`，支持配置主动压缩阈值。
- `compaction.auto: false` 可以完整关闭自动压缩。
- Provider 请求前执行 Context Window Preflight。
- 达到阈值时先生成摘要，再继续模型请求。
- 可恢复的 `ContextOverflowError` 被转换为内部压缩信号。
- 压缩完成后重新加载历史并继续执行。
- 压缩摘要使用 `toolChoice: "none"`，避免被工具调用中断。
- Base64 媒体内容使用有界元数据参与 Token 估算。

上下文由此成为 Harness 主动管理的运行资源，而不是等到模型返回溢出错误后直接终止任务。

## 10. Compaction 状态 Harness 化

除了执行压缩，Harness 还将压缩过程建模为宿主可以正确展示的状态。

- 提供压缩开始和完成事件。
- 事件携带压缩原因和摘要消息身份。
- 使用 `afterMessageID` 指定压缩状态在对话中的位置。
- 状态锚点根据原始 Transcript 计算。
- 压缩摘要保留在模型历史中，但不投影为普通 Assistant 回复。
- Cowork 可以只展示“正在压缩上下文”等状态。

这样既保留模型继续执行所需的摘要，又避免内部压缩内容污染用户可见的聊天记录。

## 11. Permission Harness 化

权限请求从简单的允许或拒绝，扩展为宿主可以直接渲染的结构化协议。

Permission Request 的 `display` 元数据可以携带：

- `uiKind`
- `title`
- `rawInput`
- `locations`
- `previewCard`
- `formSchema`
- `toolCallId`

这些信息会保存在 Pending Permission、Permission Event 和查询结果中，并继续投影到 ACP。Cowork 不再需要根据工具名称和参数猜测授权界面，而是可以直接获得标题、资源位置、编辑预览或表单等展示信息。

## 12. Tool 事件 Harness 化

Harness 建立了工具调用与消息、Part 和 Tool Call 之间的稳定身份关系。

ACP 工具事件增加 `messageId`、`partId` 和 `toolCallId`，Pending、Running、Completed、Failed 和增量更新都可以归属到准确的助手消息。即使存在多个工具、Tool-first 输出、Session Reload 或并发更新，Cowork 也不需要再按“最后一条 Assistant 消息”推断工具卡片位置。

Write 工具生成输入时，还会通过瞬态 `message.part.delta` 发送增量 JSON。Cowork 可以在工具真正执行和持久化之前，实时展示正在生成的写入内容。

## 13. Usage 与上下文用量 Harness 化

Harness 将单次 Prompt 消耗和当前上下文占用统一投影给宿主。

- Prompt 终态事件携带 Token Usage 和 Cost。
- ACP `usage_update` 使用最新 Assistant Message 的总上下文 Token。
- 优先采用 Provider 返回的 `tokens.total`。
- 缺失时汇总 Input、Output、Reasoning 和 Cache Token。
- 使用当前上下文窗口口径，而不是只统计本轮新增输入。

Cowork 因此可以展示单次任务成本、当前会话上下文占用，并判断是否正在接近压缩阈值。

## 14. 首轮预热 Harness 化

Harness 将运行环境准备与用户任务执行拆分为两个阶段。新增 Location Prewarm 接口，在不创建 Session、不发送 Prompt、不调用模型的情况下，提前初始化 Workspace 级运行环境。

Prewarm 可以：

- 初始化 Location-scoped Services。
- 加载 Workspace 配置。
- 准备 Tool Registry。
- 接收 Provider、Model 和 Agent 信息。
- 提前物化与当前模型相关的工具定义。

这样可以将部分目录服务和工具初始化移出用户首轮请求路径，使真正的 Prompt 更快进入模型执行阶段。

## 15. 离线运行 Harness 化

Harness 减少了启动和执行路径中的隐式网络依赖，使运行结果更加确定。

- 构建期保留模型目录快照。
- `amio-agent` 运行时禁止自动刷新 `models.dev`。
- 插件和自定义工具加载不执行依赖安装。
- Reference 不再自动 Clone、Fetch 或 Refresh GitHub 仓库。
- 已存在的本地 Reference Cache 仍然可以使用。
- 配置初始化不再等待后台依赖安装。

Sidecar 因此不会因为 VPN 波动、模型目录服务不可达、GitHub 访问失败或用户目录缺少依赖而阻塞启动。

## 16. 工具执行保护 Harness 化

Harness 为可能放大资源消耗或阻塞任务的工具增加了明确边界。

Write 工具在 Sidecar 中默认跳过 Formatter 和 LSP Diagnostics，减少与任务结果无关的后台处理；标准 OpenCode 的默认行为不受影响。

PDF Read 增加了更严格的资源控制：

- 支持指定页码范围。
- 超过 10 页的 PDF 要求显式选择范围。
- 单次最多读取 20 页。
- 完整内联读取限制为 20 MiB。
- 分页提取允许处理不超过 100 MiB 的源文件。
- 校验 PDF Header、页码范围和提取结果大小。

工具不仅需要能够执行，还必须在可控的时间、内存和上下文范围内执行。这些限制构成了 Harness 的资源保护边界。

## 17. 可观测性 Harness 化

Harness 建立了从 Prompt 准备到首段用户可见正文的分阶段诊断能力。

主要观测信息包括：

- 原始和准备后的消息数量。
- Content Part 数量与估算字符量。
- 最大单条消息大小。
- 消息角色和类型分布。
- 当前活跃工具数量。
- Provider 请求开始时间。
- 第一个 AI SDK Stream Event。
- 第一个标准化 LLM Event。
- 第一个 Reasoning Delta。
- 第一个 Content Delta 和 Text Delta。

这些时间点可以把“首响应很慢”拆分为 Workspace 初始化、工具注册、Prompt 准备、Provider 首包、模型推理和下游事件转发等阶段。可观测性因此不是附加日志，而是预热、上下文控制和性能优化能够形成闭环的基础。

## 总结

以上 17 个方面共同构成了 Agent Harness 的完整运行能力。独立 Sidecar 提供部署边界，Prompt 生命周期提供任务边界，Session 与 Workspace 提供环境边界，Tool、Skill 和 Plugin Runtime 提供动态能力边界，Subagent 与 Permission 提供权限边界，上下文治理和工具保护提供资源边界，ACP 事件与可观测性则提供宿主控制和诊断边界。

这些能力并不是互相独立的功能堆叠，而是围绕一次 Agent 任务形成的完整链路：运行环境被正确装配，Prompt 进入可追踪生命周期，所需能力按任务动态加载，执行过程受到权限和上下文约束，工具与状态准确投影给 Cowork，最终进入完成、失败或取消的明确终态。

最终形成的 Agent Harness，使 Agent 从“能够调用模型和工具”演进为“能够在产品环境中被可靠托管、持续扩展并稳定运行”的完整系统。
