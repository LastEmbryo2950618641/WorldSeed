# 叙事目标分类（伏笔 / 高潮 / 尺度）设计

> **状态：** 已评审可实施（2026-09-02）  
> **范围：** 在既有「推演目标」上增加叙事分类与尺度，支撑几百万字长篇的伏笔回收与短/中/长高潮进度；**不**新建工作区顶级目录「动态区」。  
> **关联：** [创作台推演目标设计](./2026-08-27-creation-desk-deduction-goals-design.md) · [章节意图与弧线规划](./2026-08-31-chapter-intent-and-arc-planning-design.md)  
> **评估：** 多 Agent 代码梳理 + 架构评审（见 §8）

---

## 1. 问题

梗概讨论时，AI 缺少结构化戏核清单（角色新/旧、冲突、伏笔埋/收、高潮推进）。长篇中「伏笔 / 高潮」有跨章进度，适合落在推演目标上；但现状目标只有自由文本，无法按类型/尺度过滤，百万字项目会把全部 active 目标灌进讨论与推演上下文。

---

## 2. 分层职责（单句）

| 层 | 职责 |
| --- | --- |
| **设定集 / 沿革** | 世界是什么（权威事实与历史） |
| **暂存区** | 未确认草稿；不作为伏笔/高潮权威账本 |
| **推演目标（本设计扩展）** | 跨章叙事承诺与按章进度（伏笔/高潮权威） |
| **弧线规划.md** | 叙事地图，可引用 goalId，**不**拥有回收状态 |
| **因果焦点 / 边界节奏** | 本章写法旋钮；**不等于**「收伏笔」 |
| **梗概文件** | 本章发生什么 |

**禁止：** 新建第七顶级目录作为 v1 权威存储。

---

## 3. 方案选择

| 候选 | 结论 |
| --- | --- |
| 仅扩暂存区 | 否：有驱逐，长线伏笔会丢 |
| 新建动态区根目录 | v1 否：成本高；若需要作者文件视图，v2 再做库的镜像导出 |
| 扩推演目标 + 相关性过滤 | **采纳** |
| 用图 frontier 管伏笔 | 否：作者编剧表 ≠ 世界模拟 |

---

## 4. v1 数据模型

在 `DeductionGoal` 上增加（字段名避开与 `GoalProposalKind` 的 `kind` 冲突）：

```ts
narrativeKind: "general" | "foreshadow" | "climax"  // 默认 general；暂不含 thread
scale: "short" | "medium" | "long"                  // 默认 short
plantChapterSequence?: number                       // 建议埋设/起势章
payoffChapterSequence?: number                      // 建议回收/爆发章
```

| scale | 含义（长篇约定） |
| --- | --- |
| `short` | 本章或近几章小高潮 / 局部兑现 |
| `medium` | 一卷或一弧高潮 |
| `long` | 跨卷或全书主线高潮 / 长伏笔 |

**进度枚举不变：** 仍用 `planned | achieved | partial | missed`；「埋 → 推 → 收 / 蓄 → 峰 → 褪」写在各章 `summary` + status，不新增第二套状态机。按 `narrativeKind` 的**读法与 UI 文案**见 [按类型区分的情况/进度语义](./2026-09-03-goal-progress-semantics-by-kind-design.md)。

**校验：** 若 plant 与 payoff 均存在，则 `plant ≤ payoff`。

**提案载荷：** `create` / `update_content` 增加可选 `narrativeKind` / `scale` / plant / payoff（Zod 字段名用 `narrativeKind`，**不要**再用顶层 `kind` 表示叙事类型）。

---

## 5. 相关性过滤（长篇必做）

```ts
function isGoalRelevantToChapter(goal, chapterSequence): boolean
```

规则（active 目标）：

1. 无 plant/payoff → 视为相关（兼容旧数据与短目标）；
2. 二者皆有 → `plant ≤ N ≤ payoff`；
3. 仅 plant → `N ≥ plant`；
4. 仅 payoff → `N ≤ payoff`。

用于：

- 创作台「本章」视图与 badge 的 unfilled 计数；
- discuss / turn 注入的 `activeGoals`（另可硬顶 `K`，例如 24，按距当前章远近排序）。

Overview 仍可列出全部 active。

---

## 6. 梗概讨论清单（提示词，非新表单）

在 `synopsis-discuss` / `plot-synopsis-guide` 要求每轮收窄决策时自检：

1. 角色：新建还是沿用已有（沿用须点名并读档案；新建须 **性格 + 背景** 齐全；多角色行为不可互换）；
2. 本章冲突/对立面是什么；
3. 伏笔：埋 / 收 / 暂不动；若埋或收，经 `goalProposals` 登记或更新 `foreshadow`；
4. 本章推进哪条高潮（`climax` + `scale`）；远期高潮用 `long` + payoff 章窗；
5. **禁止**把伏笔账写进设定集；**禁止**用因果焦点代替目标登记；**禁止**多角色同一性格模板。

可点击选项仍走 `choices`；目标变更仍须用户采纳提案。

人物设定：`设定集/人物/`（及暂存人物）必须含「性格」「背景」；正式推演 `draft` 须按已读性格行事；`settings_extraction` 人物提案缺两节则不合格。

### 6.1 维护职责（主次）

| 路径 | 角色 |
| --- | --- |
| **主路径** | 梗概讨论 Agent 在戏核决策时**主动**输出 `goalProposals`（创建/更新分类与章窗、拟定本章 progress）；用户在 UI **采纳/忽略** |
| **次路径** | 用户可手动添加或改文案/分类（纠错、补漏），**不是**日常登记手段 |

Agent **不得**静默写库；「自动」= 讨论中自动提案，而非绕过确认。

---

## 7. v1 验收标准

1. Agent 可经 `goalProposals` 创建/更新带 `narrativeKind` / `scale` 的目标；用户可手动补录；旧目标迁移为 `general` / `short`。主路径为 Agent 提案 + 用户采纳。
2. foreshadow/climax 可设可选 plant/payoff 章序。
3. 进度 API/状态词汇不变。
4. discuss 提示含戏核清单；登记经 `goalProposals`（主）或手动（次）；提示词要求戏核决策时主动提案。
5. 本章视图与注入使用相关性过滤，不全量倾倒。
6. 无新工作区根目录；暂存不是伏笔权威。
7. 规格写明：因果焦点 ≠ 收伏笔；弧线规划不拥有 payoff 状态；手动添加非日常主入口。

---

## 8. 多 Agent 评估摘要

- **可行性：** 在现有 goals 表加列 + 提案字段扩展即可；进度与 beginTurn 锁路径可复用。
- **架构评审：** 方向正确；须避免与 proposal `kind` 撞名；v1 必须做注入过滤；`thread` 与完整 plant→payoff 状态机可延后；`scale` 因长篇短/中/长需求保留为轻量枚举（非第二状态机）。
- **暂缓（v2）：** 暂存区伏笔 md 文件、弧线规划 UI 投影看板、`thread` kind、清单表单硬门禁、自动 NLP 判定是否已收伏笔、动态区文件镜像。

---

## 9. 实施触点（v1）

- `packages/contracts`：`deduction-goals.ts`、`backend-payloads.ts` + 相关性 helper
- `packages/prompt-contracts`：artifacts + synopsis-discuss / plot-synopsis-guide
- `apps/backend`：migration 039、database-types、repository、service、discuss 注入过滤
- `apps/desktop`：goals helpers、popover 徽章/筛选、create/update 传参
- 测试：deduction-goals、creation-desk-goals、prompt-contracts

---

## 10. 非目标（v1）

- 不自动从因果焦点创建/关闭目标  
- 不把高潮进度写入设定沿革  
- 不机械阻断「未填清单则禁止开始推演」  
