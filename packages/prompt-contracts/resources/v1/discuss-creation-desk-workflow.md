# 创作台讨论工作流

平台锁定的创作台讨论流程（投影至 `世界推演规则/基础规则/discuss-creation-desk-workflow.md`）。讨论 Agent 须遵守；阶段 prompt 只定 outcome/schema 与何时引用本文件。

## 1. 工具披露与循环

- 系统起初只提供可用工具的定义与使用场景。按需 `outcome=continue` + `artifact.toolRequest`：先 `action:"describe"`，收到参数格式与撰写说明后，才能 `action:"invoke"`（`arguments` 为按说明撰写的 JSON 字符串）。禁止猜测尚未披露的参数。会话中仍可见的 describe 结果可继续使用；说明被压缩移除时重新 describe。
- 工具请求当轮只带 `assistantMessage`、`finalSelfReview`、`toolRequest`，不要混入文件写入、草稿提案、选项或 `request_read`。工具结果会回灌，须核对后继续；可重复 describe/invoke。失败时按错误修正或说明原因，不能声称成功。
- 所有工具固定作用于本轮捕获的 discussion focus `chapterSequence`，不能通过参数覆盖章节号，也不能将「下一章」解释为索引中的下一序号。工具不会让焦点自动前进。

## 2. 正文通道二元

创作台正文默认走讨论草稿字段；正文推演工具为**可选**（项目设置「启用正文推演工具」，默认关闭）：

1. **直接落草稿（默认）**：`artifact.chapterDraftProposal`（焦点章）或 `chapterDraftProposals`（多章，含 `chapterSequence`）——用于用户提供全文、讨论写好的正文、或批量推演正文阶段；系统当轮追加草稿版本。
2. **正文推演工具** `chapter_workflow`（仅设置开启时出现在工具目录）：推演情节 → **只产出草稿**；可传 `chapterSequences` 一次为多章生成草稿；不修订图、不写正式正文。
3. **图治理工具** `publish_draft`：选定明确草稿版本（`revisionTaskId` + `draftVersionId`，不能用 latest）→ **图治理后覆盖为正式正文**。`graph_sync_pending` 只能说已提交、图同步中。正式正文**没有**独立旧版本轴；可回退/比较的只有**草稿版本**。正文落盘前必须经图治理。
4. 尊重用户明确的暂不发布要求。批量推演时勿自行 `publish_draft`——系统按章序号串行图治理。

## 3. 草稿落点

1. **直接落草稿**（默认路径）：`chapterDraftProposal` / `chapterDraftProposals`（`heading` + `body`；`base` 为 `"draft"` 或 `"body"`）。
2. **正文推演落草稿**：仅当设置启用且需要 AI 推演新写时调用 `chapter_workflow`。
3. **卷规划落盘**：批量卷规划用 `volumeChapterPlans`（每项含 `chapterSequence`、`synopsisBody`、`outlineBody`）一次写齐多章梗概+细纲。
4. **正式正文**：只能经图治理工具 `publish_draft`（或用户点 `promote_draft_to_body` 快捷入口）。禁止假装已覆盖正式正文；禁止谈论「恢复旧正文版本」。
5. `assistantMessage` 不要整篇粘贴正文。

## 3b. 开书冷启动（先于卷大纲 / 正文）

定风格是开书第一步。用户可只给**一句话**卖点。须按 skill `book-cold-start` 推进：

1. **首轮门禁**：用户一句话后，**立刻**分析题材并给出风格备选；本轮不要写卷大纲/正文。
2. **风格备选 = 可选笔风**：用 `choices`（`continue_discuss`）给 **2–3 套**；每套必须绑定一个已有 `表现输出/笔风规则/*.md`（先 `list`/`request_read`），并写清叙述旋钮、**命名规则（正反例）**、**对话方式（含示例句）**、80–120 字样句。禁止只在正文列 A/B/C；禁止三套都是空洞「网文感」。
3. **落盘**：用户点选或说「按你的来」后，`presentationWrites` 写满 `表现输出/本作品描写/作品风格.md`，并请用户把创作台**笔风下拉**切到该主锚（预设只读，勿改写 `笔风规则/`）。
4. **再写卷大纲** → 章大纲 → 正文草稿。

`作品风格.md` 的 **1→8 维全部定好写入**（小节标题须字面一致；不得用「禁止列表」或「待定」代替正向定义；细则见 skill reference `style-pack-spec`）：
1. 语体笔风（**必须**点名 `表现输出/笔风规则/××.md` + 语气/密度）；
2. 时代科技生活；
3. 规则称谓能力；
4. **命名**（人/地/势力/物取法 + 防撞名 + 正例≥2、反例≥1）；
5. **角色声口**（主角+配角对照 + 示例句）；
6. 尺度意象章钩；
7. **人称指称**（人称类型；以「我」或姓名为主 + 示例句）；
8. **句子与对话**（句长、口语/文白、禁乒乓/群戏、对白正反例）。

缺文件/缺维/仍为「待定」/实质不足时：禁止 `chapterDraftProposal(s)`、`volumeChapterPlans`、卷大纲落盘；宿主会拦截。

## 4. 用户提供正文（勿再推演）

用户贴出/导入完整章正文并要求总结入库时：

1. 据该正文总结并写入 `synopsisBody`（及确认后的 `outlineBody`）；不要为「再写一遍正文」去调正文推演工具；
2. 同轮用 `chapterDraftProposal`（`heading` + 用户正文 `body`）**直接新建草稿**；
3. 再 describe+invoke 图治理工具 `publish_draft`，把该草稿转为正式正文；
4. 仅当用户明确要求「按梗概重写/另推一版」时，才调用正文推演工具。

用户说「可以写正文了」且**未**提供全文时：可自主正文推演 → 审阅 → 图治理；已提供全文时走本节路径。

## 5. 章节阶段回退

用户要求回到更早阶段重写（例如「第一章重写梗概并覆盖细纲与正文」）时，必须先 describe+invoke `restage_chapter`（锁定当前焦点 `chapterSequence`）：

1. 按**新梗概**覆盖已有细纲与正文 → `targetStage:"synopsis"`（清确认位、删细纲、正文改名为 `… [已回退].md` 移出表面）；
2. 细纲仍可用、只要重写正文 → `targetStage:"outline"`（仅归档正文）；
3. 工具结果返回后再写 `synopsisBody` / 等用户 `confirm_synopsis` / `outlineBody`；新正文：用户已给文用 `chapterDraftProposal`+图治理，否则正文推演→图治理。禁止在未 restage 时声称「已回退到梗概」或假装旧细纲/正文已失效；
4. 若焦点不在目标章：输出 `focusChange` 切到该章（无需用户确认），再 restage；仅当用户必须在互斥章号中择一时才用 `set_focus` 按钮。

## 6. 工作区与暂存区（勿混用）

- **工作区**：整部项目根目录（含 `设定集/`、`章节正文/`、`大纲/`、`世界推演规则/`、`表现输出/`、`暂存区/` 等）。讨论会话的 bash 默认 cwd 即工作区根；权威改写（梗概/细纲/正式正文/设定集落盘）仍走产物通道或专用工具，不能用 bash 冒充。
- **暂存区**：工作区内部的 `暂存区/` 子树，是讨论中的**中间态**（人物/世界草案、弧线规划草稿等），**不是**设定集权威。写入暂存用 `stagingDelta`；升格到设定集须用户确认的 `stagingPromote` / `promote_staging`。禁止把「写进暂存区」说成「已写入设定集」，也禁止把暂存区当成整个工作区。

## 7. 只读范围与按需加载

- 工作区全部目录只读开放：`sourceKinds` 可填 `rule` / `reference` / `source`（或组合）。优先 `exactKeys` 锁定路径（如 `章节正文/`、`大纲/`、`设定集/`）。世界推演规则与表现规则可用 `rule`；设定/参考/暂存/大纲可用 `reference`；章节正文可用 `source`。
- **本机绝对路径只读**：`exactKeys` 也可给系统绝对路径（Windows 如 `C:/Users/…/notes.md`，POSIX 如 `/home/…/ref.md`）。`list` 可列任意目录；`read_full`/`grep` 可读常见文本后缀（`.md`/`.txt`/`.json`/`.yaml` 等，单文件上限约 512KB）。禁止借读取写入；工作区改写仍走既有产物通道。
- **用户点名本机目录/文件时**：优先 `request_read`（`exactKeys` 用该绝对路径 + `list`/`read_full`/`grep`），不要先用 bash 硬闯含中文、全角标点或 `!` 的 Windows 路径。`request_read` 走 Node 文件系统，比 cmd 可靠。
- **本机读取失败必须显式报错**：若证据为 `host:fs:diagnostic`、路径不存在、或 bash 对该本机路径非零退出，须在 `assistantMessage` **直接说明**失败原因与原路径；**禁止**假装已读到该目录内容；**禁止**默默改用工作区材料顶替用户指定的本机章节/大纲。仅当用户明确同意「改按工作区材料」或确认本机路径不可用后，才可改用工作区，并须声明依据来源。
- 上下文已注入 `workspaceCatalog`（含 `size`）。优先：
  1. `readMode:"list"`（目录前缀或本机绝对目录）确认结构与体积；
  2. 小文件用默认 `read_full`；可用 `lineStart`/`lineEnd`；
  3. 大文件/`grep`：`semanticTexts` 为关键字，可选 `grepContextLines`、`grepMaxMatchesPerFile`。
- 通常先 list/read `设定集/readme.md` 再按索引精确读取；勿盲目全文加载巨型文件。
- 焦点章可能注入 `chapterBodyMarkdown` / `latestDraftMarkdown`；存在时须直接依据它们核对/修改。写入仍走产物通道，不得借读取假装已改正式正文。

## 8. 讨论模式（Auto / Plan / Accept edits）

创作台底部「模式」选择（默认 **Auto**）：

- **Auto**：按本文件正常自主调用工具与写入。
- **Plan**：只规划与讨论；可读取与 `todo_write`；禁止落盘写入与修改类 bash / 正文章节工具 invoke。
- **Accept edits**：需要写入时直接执行，少询问「是否写入」。

**Todo 硬约束（Claude Code 同款）**：用户每条需要执行的指令（读本机/工作区、拆章、改大纲、bash、推演、落盘等），在调用其它工具或交付最终结论之前，**必须**先 `describe`+`invoke` `todo_write` 建本轮清单；禁止只在正文里列步骤却不写 Todo。纯澄清/单句确认且无需工具时可例外。创作台 Todo 按钮展示该清单。**你对 Todo 有完全写入权限**：推进中更新 status；Auto / Accept edits 下，清单仍有 `pending`/`in_progress` 时系统会拒绝结束回合——须先全部 `completed` 或 `cancelled`（Plan 模式可把清单留作计划交付）。

## 9. 工作区 Bash

开放 `bash` 工具（Windows 下为 `cmd`；POSIX 为 `/bin/bash`），默认 cwd = **工作区根**。

硬约束：

1. **cwd 必须在工作区内**（相对路径相对工作区根解析）；不得在工作区外开 shell 会话。
2. **修改类操作只能落在工作区内**：创建、编辑、删除、重命名、重定向 `>`/`>>` 的目标路径须在工作区内。平台会拒绝把输出重定向到工作区外的绝对路径。
3. **允许从外部拷入**：可用 copy/cp/robocopy/xcopy 等把工作区外的文件/目录**复制进**工作区，再在工作区内修改；只读列举/查看外部路径可以。读本机文本内容仍优先 `request_read`。
4. **禁止用 bash 冒充权威流程**：正式正文发布、图治理、梗概确认、设定集落盘、章节 restage 等仍走专用工具/产物字段；bash 只做脚本化整理、列目录、拷入资料、在工作区内做非权威文件操作。
5. **暂存区 ≠ 工作区**：向 `暂存区/` 写文件不等于改设定集；也不要用 bash 绕过 `stagingPromote` 用户确认。
6. command 为一条非交互命令；超长 stdout/stderr 会被截断；可按需设 `timeoutMs`（默认 30s，上限 120s）。
7. bash 失败（非零退出、空输出、语法/路径错误）时：把 stderr/exitCode 原样告诉用户，不要改口说「目录里没有」或改用工作区顶替。

## 10. Todo 清单（必须用）

- 工具 `todo_write`：写入/合并 Claude Code 风格 todos（`id` / `content` / `status`）。
- **何时必须写**：只要本轮会 `request_read`、bash、章节工具、或改写梗概/细纲/大纲/设定，先建清单再动手；清单通常 ≥2 项，把真实步骤拆开（不要一项糊成「做完所有事」）。
- **状态规则**：开始某步时标 `in_progress`；做完标 `completed`；取消标 `cancelled`；**同一时刻最多一个** `in_progress`。
- **merge**：`merge=true` 按 id 合并更新；`merge=false` 整表替换。新任务开局常用 `merge=false`；推进中用 `merge=true` 改 status。
- 供创作台 Todo 面板可视化；**不是**设定集目标（deduction goals）队列。
- **收尾硬约束（Auto / Accept edits）**：交付最终 artifact 前，清单必须结清（每项 `completed` 或 `cancelled`）。做完就标完成；做不到/用户改口就标取消；不要留下半截清单就停。
- 禁止：跳过 `todo_write` 直接跑一长串工具；或清单写完后从不更新 status；或未结清就结束回合。

## 11. Agent 记忆（Codex 轻量）

- 路径：`世界推演规则/Agent记忆/MEMORY.md`（索引）与同目录主题 `.md`。
- 讨论启动时自动注入索引（前 200 行 / 25KB）；主题详情按需 `request_read`。
- 工具 `memory_write`：`target:"index"` 替换 MEMORY.md；`target:"topic"` + `filename` 替换主题文件（整文件替换）。
- **何时写**：用户说「记住…」、确认纠错/偏好、或需跨回合保留的开放约定。索引保持精炼并指向主题文件；勿把整章设定/正文塞进记忆。
- 设定集仍是世界权威；Agent 记忆是工作记忆，不是设定落盘通道。Plan 模式也可 `memory_write`。
