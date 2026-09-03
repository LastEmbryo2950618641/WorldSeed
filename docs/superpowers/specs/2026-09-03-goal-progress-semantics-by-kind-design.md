# 按叙事类型区分的目标「情况 / 进度」语义

> **状态：** 已评审可实施（2026-09-03）  
> **范围：** 在既有 `planned|partial|achieved|missed` 上，按 `narrativeKind` 定义「情况 / 进度」读法与 UI/提示词文案；**不**新增第二套状态机或 `phase` 字段。  
> **关联：** [叙事目标分类设计](./2026-09-02-narrative-goal-taxonomy-design.md) · [创作台推演目标设计](./2026-08-27-creation-desk-deduction-goals-design.md)  
> **评估：** 叙事 / UX / 架构三路并行评审后冻结。

---

## 1. 问题

作者需要三类推演目标使用不同的「情况」与「进度」语言：

| 类型 | 作者直觉 |
| --- | --- |
| **目标** `general` | 完成情况 + 完成进度 |
| **伏笔** `foreshadow` | 收束情况 + 收束进度（铺垫靠近，非突然完成） |
| **高潮** `climax` | 推进情况 + 弧线进度（升温 → 爆发 → 褪去） |

若 UI 一律写「完成情况 / 已达成」，会误导伏笔与高潮的用法，也会诱使 Agent 过早标 `achieved`。

---

## 2. 冻结原则

1. **后端枚举不变：** `planned | partial | achieved | missed | superseded`。
2. **情况** = 本章事件描述 → `progress.summary`（自然语言）。
3. **进度** = 相对整条叙事承诺的位置 → `progress.status`（枚举）。
4. **生命周期阶段**（埋/推/收、蓄/峰/褪）写在 summary 与提示词约定中，**不进库**。
5. **plant / payoff / scale / lock / 复盘路径不动。**

---

## 3. 语义标准

### 3.1 通用

| 概念 | 定义 | 存储 |
| --- | --- | --- |
| 情况 | 本章做了什么（事件级） | `summary` |
| 进度 | 相对终态/收束点/峰值走到哪（承诺级） | `status` |

### 3.2 枚举 × 类型映射

| `status` | general | foreshadow | climax |
| --- | --- | --- | --- |
| `planned` | 本章拟推进 | 拟埋 / 拟推 / 拟收 | 拟蓄 / 拟升 / 拟峰 / 拟褪 |
| `partial` | 部分兑现 | 有推进、**未收** | 铺垫升温，或峰值后**仍在褪去** |
| `achieved` | 本章意图达成 | **仅**回收完成的那一章 | **仅**峰值兑现的那一章 |
| `missed` | 该推进却落空 | 该埋/该收却落空或错过窗口 | 该升/该峰却落空（**≠ 褪去**） |

### 3.3 高潮褪去（已确认）

```text
峰值章 → status = achieved
其后褪去/余波章 → status = partial（summary 标明褪去/泄压）
整条高潮弧结束 → goal.lifecycle = completed
```

禁止：把褪去并入峰值章的 `achieved`；禁止用 `missed` 表示褪去。

### 3.4 伏笔靠近

多章 `partial` + summary = 慢慢靠近 payoff；真正收束点才 `achieved`。

---

## 4. UI 文案（表单态 vs 结果态）

**表单态**（三类共用，不按类型改名）：未填写 / 已填写 / 已锁定。

**结果态 / 复盘态**（按 `narrativeKind`）：

| 位置 | general | foreshadow | climax |
| --- | --- | --- | --- |
| 展开区标题 | 第 N 章完成情况 | 第 N 章收束情况 | 第 N 章推进情况 |
| `review` | 待复盘 | 待核对收束 | 待复盘推进 |
| `achieved` | 已达成 | 已收束 | 已爆发 |
| `partial` | 部分达成 | 有推进、未收 | 在升温 |
| `missed` | 未达成 | 未收/错过窗口 | 未爆发 |
| 空进度提示 | 尚未填写本章预期 | 尚未填写本章收束预期 | 尚未填写本章推进预期 |

折叠态最少信息：类型(+尺度) · 状态 chip · 本章一句 ·（伏笔/高潮）章窗。

进度可视化：文字 chip + 可选轻量阶段条（由 plant/payoff + status **推导展示**）；**不用百分比作权威**。

---

## 5. Agent / 提示词约定

撰写 `set_chapter_progress` 的 summary 时：

- general：写「完成情况」；勿过早建议 `achieved`。
- foreshadow：标明埋/强化/临近/收束；未回收用推进语气；仅收束章建议 `achieved`。
- climax：标明蓄势/升温/峰值/褪去；峰值章才 `achieved`；褪去章用 `partial`。

---

## 6. 方案选择

| 候选 | 结论 |
| --- | --- |
| 仅 UI/提示词映射 | **采纳（本规格）** |
| 新增 `phase` 字段 | 延后；与 status 双真相 |
| 三类独立状态机 | 否 |

---

## 7. 实施触点

- `packages/contracts`：共享文案 helper（section title、status/chip 标签）
- `apps/desktop`：`creation-desk-goals`、popover、章后复盘按钮文案
- `packages/prompt-contracts`：`synopsis-discuss` / `plot-synopsis-guide`
- 测试：desktop helpers；可选 contracts 单测
- 交叉引用：更新 taxonomy 规格 §4「进度语义不变」为「枚举不变、读法按 kind 映射」

---

## 8. 非目标

- 不新增 DB 列 / migration  
- 不自动 NLP 判定是否已收伏笔或已褪去  
- 不把因果焦点当作收束权威  
- 不改 beginTurn lock 语义  

---

## 9. 验收

1. 三类目标展开区标题与 chip 文案按 kind 正确切换。  
2. 复盘按钮文案按 kind 映射。  
3. 提示词含三类 progress 写法与「褪去 ≠ achieved / missed」。  
4. 无新 status 枚举、无 `phase` 字段。  
