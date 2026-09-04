# 细纲局部编辑（searchReplace）设计

> **状态：** 已实施（2026-09-03）  
> **包名：** `outline-patch-fail-loud-auto-apply`  
> **范围：** 创作台讨论 Agent 对 `[剧情细纲].md` 支持 JSON `bodyEdits` 精确替换；补齐细纲手改守卫；失败进对话面。  
> **关联：** [章细纲生命周期](./2026-09-02-chapter-outline-lifecycle-design.md) · Codex 对照评审（概念借鉴，不移植方言） · [实施计划](../plans/2026-09-03-outline-body-edits.md)  
> **非目标：** Codex `apply_patch`/V4A、shell/sed、梗概改 patch、正文讨论期局部写、diff 审批 UI、失败后静默全量兜底。

---

## 1. 问题

细纲为多节施工图，Agent 每轮吐完整 `outlineBody` 成本高，且易冲掉作者在 Monaco 中的局部手改。梗概仍是短决策稿（约 120–600 字），整篇覆盖仍合理。

多 agent 结论：

- **借** Codex：专用写通道、局部变更、失败可纠、禁 shell 编辑；
- **不借**：V4A 文法、过宽模糊匹配、任意 sed。

---

## 2. 决策记录

| 议题 | 选择 |
| --- | --- |
| 编辑形态 | JSON `bodyEdits.ops[]`：`oldText` / `newText`（默认唯一命中） |
| 首包制品 | **仅细纲**；梗概继续 `synopsisBody` 全量 |
| 首写细纲 | 仍优先全量 `outlineBody`（confirm 后第一版） |
| 同轮互斥 | `outlineBody` 与 `bodyEdits(target=outline)` **不可同回并存** |
| 匹配策略 | **字面精确**（可统一 `\r\n`→`\n` 后再计次）；禁止模糊/正则 |
| 失败策略 | **整单回滚**；失败原因写入 `assistantMessage`（或前缀）；**禁止**失败后改全量覆盖 |
| 落盘 | 继续自动写盘（与今日梗概/细纲一致）；无审批框 |
| 手改守卫 | 新增 `lastOutlineAgentDigest`；漂移则跳过写入并**明示用户** |
| 门禁 | `bodyEdits` 写细纲仍要求 `synopsisConfirmed`（或本轮 confirm） |

---

## 3. Artifact 契约

```ts
bodyEdits?: {
  target: "outline"           // v1 仅允许 outline
  baseDigest?: string         // 可选；若提供则必须等于当前细纲文件 digest
  ops: Array<{
    oldText: string           // min 1；在目标正文中须唯一出现
    newText: string           // 可为 ""（删除片段）
  }>                          // 1..20，顺序应用
}
```

校验（Zod + 服务端）：

- 有 `bodyEdits` 时不得同回带 `outlineBody`；
- `target !== "outline"` → schema 拒绝（v1）；
- 应用前：未确认梗概 → 丢弃 edits（与今日挡 `outlineBody` 同语义），并在回复中说明；
- `baseDigest` 不匹配 → 整单失败；
- 任一条 `oldText` 出现次数 ≠ 1 → 整单失败。

全量逃生：大改 / 结构重排 / patch 连续失败后，模型改吐 `outlineBody`（用户或 repair 引导）。

---

## 4. 服务端应用流程

```
读 outlinePath 当前全文
→ 可选校验 baseDigest
→ 校验 userEditedOutlineSinceAgent（lastOutlineAgentDigest）
→ 若手改漂移：不写盘，assistantMessage 明示
→ 否则 applySearchReplace(content, ops) 原子结果
→ 失败：不写盘，把失败原因并入 assistantMessage
→ 成功：saveSynopsisMarkdown(outlinePath, next)；更新 lastOutlineAgentDigest
```

`applySearchReplace` 纯函数（可单测）：

1. 归一换行副本仅用于匹配计数与定位；  
2. 写回使用原文件换行风格或统一 `\n`（实现选统一 `\n`，与现有 Markdown 写入一致）；  
3. 顺序替换；任一步失败返回 `{ ok: false, reason }`。

---

## 5. 会话与 DB

`synopsis_conversation_sessions` 新增：

- `last_outline_agent_digest TEXT`（可空）

迁移：`041_outline_agent_digest`。

合约 `SynopsisConversationSession` 增加可选 `lastOutlineAgentDigest`。

模型上下文注入（discuss 用户消息旁或 appendix）：

- 当前细纲是否存在、`outlineDigest`、`userEditedOutlineSinceAgent`；
- 已确认则可提示「局部改用 bodyEdits」。

---

## 6. 提示词

- `plot-synopsis-guide.md` / `synopsis-discuss.md`：细纲更新优先 `bodyEdits`；首写或大改用 `outlineBody`；禁止同回并存；`oldText` 须从当前细纲逐字复制。  
- 失败 repair hint：对照最新细纲重抄 `oldText`，或改吐全量 `outlineBody`。

---

## 7. UX

- 成功：助手一句「已局部更新细纲（N 处）」。  
- 失败 / 手改冲突：助手可见说明；底部仍可继续讨论。  
- **不**新增审批按钮。

---

## 8. 验收

1. confirm 后首写：全量 `outlineBody` 仍可用。  
2. 再改一场：仅 `bodyEdits`，文件其余节不变。  
3. `oldText` 不唯一或缺失：不写盘，消息含失败原因。  
4. 用户改细纲后 Agent 再 patch：跳过并明示。  
5. 未 confirm：`bodyEdits` 不写细纲。  
6. 同回 `outlineBody`+`bodyEdits`：schema/服务端拒绝。  
7. 单测覆盖 `applySearchReplace` 与门禁。

---

## 9. 后续（非本包）

- `target: synopsis | chapter`；revision_assist 共用原语；  
- section heading ops；结构化 hunk（仍非 shell）；  
- 手改冲突选项按钮（「以我手改为准 / 覆盖手改」）。
