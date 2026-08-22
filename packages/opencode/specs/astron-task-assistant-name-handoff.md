# Astron Task Assistant Name 接入报告

## 目标与范围

本文用于在另一台电脑上修改 Astron，使 Astron Assistant 的展示名通过运行时 Agent 配置进入 Amio，并由 Amio Task 工具稳定回传给 Astron。

这条链路使用 Astron 与 Amio 之间的 HTTP 配置发布和 HTTP/SSE 事件消费，不依赖 ACP 建链。Astron 内部部分事件转换类沿用 ACP 命名，但不改变传输边界。

## Amio 已提供的契约

Amio Agent 配置新增可选字段 `displayName`：

```json
{
  "agent": {
    "assistant-worker-assistant-a": {
      "displayName": "代码助手",
      "description": "负责代码分析",
      "mode": "subagent"
    }
  }
}
```

其中：

- 配置对象的 key 和运行时 `Agent.name` 仍然是技术身份，例如 `assistant-worker-assistant-a`。
- `displayName` 只承载面向用户的展示名，不参与 Agent 查找、权限匹配或子 Session 的运行时身份。
- Task 工具提供给模型的候选列表会显示 `assistant-worker-assistant-a (代码助手)`。
- Task 工具解析目标 Agent 后，会在 running、completed 和 background Task metadata 中加入 `assistantName`。

预期的 Amio Task part 形状如下：

```json
{
  "tool": "task",
  "state": {
    "input": {
      "description": "分析失败测试",
      "prompt": "定位失败原因",
      "subagent_type": "assistant-worker-assistant-a"
    },
    "metadata": {
      "parentSessionId": "ses-parent",
      "sessionId": "ses-child",
      "model": {
        "providerID": "provider",
        "modelID": "model"
      },
      "assistantName": "代码助手"
    }
  }
}
```

`assistantName` 是 Amio 根据已加载 Agent 配置补入的可信运行时事实，不应由模型在 Task input 中生成。

## Astron 必须修改的地方

### 1. 生成 Agent 配置时写入 `displayName`

文件：

```text
engine/servers/astronverse-agent/src/astronverse/agent/adapters/opencode/agent_builder.py
```

在 `build_assistant_agent_base(...)` 中读取 Assistant 的 `name`，写入结果的 `displayName`：

```python
assistant_name = normalize_non_empty_text(assistant.get("name"))
if assistant_name:
    result["displayName"] = assistant_name
```

`assistant-direct-{assistant_id}` 和 `assistant-worker-{assistant_id}` 共用该 base，因此两种运行时角色都会获得相同展示名。不要写 `result["name"]`，否则会把 Amio 的技术 Agent ID 改成展示名，破坏 Agent 查找、Task 权限和子 Session 恢复。

### 2. 历史 hydration 从 Task metadata 读取名称

文件：

```text
engine/servers/astronverse-agent/src/astronverse/agent/adapters/opencode/adapter.py
```

在 `hydrate_task_subagent_snapshots(...)` 处理 Task part 时，当前实现主要从 `state.input` 查找 `assistantName`。应同时读取 `state.metadata`，并优先使用 metadata：

```python
metadata = state.get("metadata") if isinstance(state.get("metadata"), dict) else {}
assistant_name = _text(
    metadata.get("assistantName")
    or metadata.get("assistant_name")
    or metadata.get("displayName")
    or metadata.get("display_name")
    or raw_input.get("assistantName")
    or raw_input.get("assistant_name")
    or raw_input.get("displayName")
    or raw_input.get("display_name")
)
```

如果 child snapshot 尚无 `assistantName`，再把该值写入 snapshot。这样重新打开会话、刷新详情和历史补水时不会丢失展示名。

### 3. 检查轮询/补发路径的 metadata fallback

文件：

```text
engine/servers/astronverse-agent/src/astronverse/agent/acp/server.py
```

查找从 Task part 构造 `group_agent_turn_update_from_subagent(...)` 的代码。当前路径优先读取 `metadata.subagent.assistantName`，然后读取 raw input。建议在二者之间增加 flat Task metadata fallback：

```python
assistant_name = (
    str(subagent.get("assistantName") or subagent.get("assistant_name") or "").strip()
    or str(metadata.get("assistantName") or metadata.get("assistant_name") or "").strip()
    or str(raw_input.get("assistantName") or raw_input.get("assistant_name") or "").strip()
    or str(raw_input.get("displayName") or raw_input.get("display_name") or "").strip()
)
```

该文件名不代表 Astron 与 Amio 改为 ACP 传输；这里只是 Astron 内部复用的会话更新投影代码。

### 4. 实时事件路径无需新增协议字段

文件：

```text
engine/servers/astronverse-agent/src/astronverse/agent/adapters/opencode/events.py
```

当前 `_subagent_assistant_name(...)` 已经检查 `state.metadata` 中的 `assistantName`、`assistant_name`、`displayName` 和 `display_name`。Amio 修复后的实时 Task metadata 可以被直接消费。

这里建议只补回归测试，不需要为了本次契约再增加一套字段或本地名称映射。

## Astron 回归测试要求

至少补以下三层测试：

1. Agent 配置投影测试
   - 输入 `{"id": "assistant-a", "name": "代码助手"}`。
   - 断言 `assistant-direct-assistant-a.displayName == "代码助手"`。
   - 断言 `assistant-worker-assistant-a.displayName == "代码助手"`。
   - 断言两个配置对象没有用展示名覆盖技术 `name`。

2. 实时 Task 事件测试
   - 更新 `test_opencode_task_tool_emits_initial_group_agent_turn_update` 一类测试。
   - 不再手工把 `assistantName` 放入 `state.input`。
   - 按真实 Amio 输出把 `assistantName` 放入 `state.metadata`。
   - 断言 subagent snapshot 和 group turn 的名称均为 `代码助手`。

3. 历史 hydration 测试
   - Task part 的 raw input 只包含 `subagent_type`。
   - flat `state.metadata.assistantName` 包含展示名。
   - 断言 hydration 后的 `metadata.subagent.assistantName` 被保留。

禁止用“测试 fixture 继续在 raw input 手工塞 `assistantName`”代替跨边界测试，因为模型不会提供该字段，真实 Amio 也不会把它作为 Task input 参数暴露。

## 发布与兼容顺序

推荐顺序：

1. 先部署包含 `displayName` 支持的 Amio。
2. 再部署写入 `displayName` 的 Astron。
3. Astron 原子写入 `opencode.generated.json` 后调用 `POST /global/config/invalidate`；该变化属于 Agent 配置热更新，不需要 `/global/dispose`。

不要让新 Astron 长期搭配旧 Amio：旧 Amio 会把未知 Agent 配置字段归入 provider options，`displayName` 可能被错误带入模型请求。新 Amio 搭配旧 Astron是安全的，只是 Task metadata 暂时没有 `assistantName`。

## 验收标准

- Amio 的模型可见 Task 候选同时包含稳定技术 ID 和 Astron 展示名。
- Task 子 Session 的 `agent` 仍为 `assistant-worker-{assistant_id}`。
- running、completed、background Task metadata 均包含 `assistantName`。
- Astron 实时群聊卡片和历史重载后的卡片均显示 Assistant 展示名，不再显示 `assistant-worker-*`。
- Assistant 改名后通过 config invalidate 生效，无需 dispose。
