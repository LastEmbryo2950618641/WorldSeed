# Worldseed：设计与实施状态

## 1. 文档职责

本文是 Worldseed 当前功能状态的唯一权威清单，用于区分：

- 已经冻结的目标设计；
- 仅存在于 UI 原型或实施计划中的能力；
- 已进入代码但尚未形成完整闭环的基础设施；
- 已通过自动化和真实流程验收的功能。

其他设计文档中的“必须”“应当”和流程图均描述目标规范，不自动表示代码已经实现。历史实施计划只记录当时的判断，不覆盖本文。代码、测试和本文不一致时，必须先把差异登记到本文，不能以局部测试通过宣称完整需求完成。

状态只使用以下值：

| 状态 | 含义 |
| --- | --- |
| `design_complete_implemented` | 设计已冻结，代码已接入正式路径，但尚未完成全部验收 |
| `design_complete_not_implemented` | 设计已冻结，代码没有实现，或只有不足以形成闭环的局部基础设施 |
| `design_incomplete` | 目标、协议、边界或验收条件仍有缺口，不能开始正式实现 |
| `prototype_only` | 只有静态界面、模拟数据或不可用于真实业务的演示路径 |
| `verified` | 设计、正式代码路径、自动化测试和要求的真实流程验收均已通过 |

“部分实现”不单独作为完成状态。只要关键闭环尚未成立，该能力仍记为 `design_complete_not_implemented`，并在“当前证据”中说明已经存在的可复用基础。

## 2. 2026-08-10 设计实施矩阵

本节只跟踪 2026-08-10 新增或修改的设计。实施时必须保留“正常基线”，只修改新设计直接涉及的边界。

| 当天设计变化 | 必须保留的正常基线 | 当前缺口 | 最小修改范围 | 完成证据 |
| --- | --- | --- | --- | --- |
| 项目级永久 ID 与独立前缀计数器 | 项目、任务、阶段运行等内部 UUID 和现有数据库关系继续有效 | `source`、`evidence`、`revision` 及图治理本地引用已接入项目级原子分配器；真实历史恢复后各前缀计数保持独立且不回退 | 不再扩展内部任务 ID；只补真实运行验收 | 独立前缀、重启续号、历史恢复不回退及 `local:*` 一次物化自动化已通过；Electron/DeepSeek 产物使用 `node_21` 至 `node_40`，当前计数器继续位于 `node=40`、`link=74`、`revision=114`、`source=2`、`evidence=23` |
| 真实执行的通用图治理验证探针 | 普通 exact、semantic、source 和邻域检索继续复用 | 探针计划、真实读取、只读 overlay、逐探针游标和恢复已接入；真实 DeepSeek 首章治理执行了两条通用探针 | 不新增人物、势力、地点等专用查询；只补真实运行观测 | 中断恢复、按 `probeIndex` 审核和真实返回映射自动化已通过；真实探针分别返回局部 Proposal/Source 证据及章节关键台词原文 |
| 单一追加式 `ModelContextChain` | 原有阶段顺序、模型调用和阶段 Schema 不变 | 活动链、系统规则一次写入、增量追加、跨轮复用和正式章节引用已接入；真实供应商五阶段精确消息前缀连续增长 | 不改业务阶段，只验证真实公共前缀与缓存指标 | 跨轮同链自动化已通过；真实压缩后查询的精确消息前缀为 0/6/11/16/21 条，公共前缀比例从 0% 增至 87.56%，供应商累计 KV 命中率为 9.50% |
| 动态提示词按轮和阶段追加 | 用户规则、两个 readme、选择性资料和表现规则现有读取逻辑不变 | 目录、规则、索引、Evidence、用户输入和表现约束已由统一追加器进入链尾；大型目录真实选择性读取未验收 | 保持现有资料检索，只补顺序和真实规模验收 | 动态内容不会重建系统前缀；增量追加单元测试已通过 |
| 上下文与事实库分离及新旧状态继承 | 图、修订、Source 和章节 Markdown 仍是事实来源 | 可见 Evidence 跨轮继承、精确 Source 回退及移出后按事实库召回已接入；真实压缩后查询在不读章节目录的条件下从 Source 返回原文事实 | 不保存额外压缩摘要或章节清单 | 最新投影继承、Source 窗口扩展和章节原文回退自动化已通过；真实查询准确返回雾港站、停运、末班车和候车室信息，并保留“林序未被原文证实”的不确定性 |
| 97%/50% 两阶段机械压缩 | 原始章节、Source、图、阶段记录和历史对象不删除 | `ContextWindowManager` 已在发送前按模型容量执行两阶段移出并保护当前轮；真实 60k Profile 已触发第一阶段机械压缩 | 不增加 AI 压缩阶段，只观察真实 Token 计数和暂停边界 | 自动化覆盖两阶段和保护项；真实运行把 72 条消息中的 70 条旧非正文移出，可见链降至 7,778 Token，压缩代次由 0 增至 1 |
| 模型 Profile 是上下文容量唯一来源 | 现有模型 Profile 切换和项目设置保存继续工作 | 项目设置只保留压缩比例，容量来自当前模型 Profile；Electron 将 Flash 容量由 1M 改为 60k 后，运行指标和压缩阈值立即使用 60k/58.2k | 不恢复项目级重复容量字段 | 默认 1M、适配器与窗口管理器使用所选模型容量的类型和自动化检查已通过；真实验收后已恢复 1M |
| 错误保留、用户可控恢复和额度重置 | 现有自动修复上限、任务列表和阶段日志继续使用 | 稳定检查点、继续、重试、暂停、持久额度窗口和单项重置已接入；运行中长请求与重启仍需 Electron 验收 | 保持成功路径不变，只补真实交互验收 | 超限暂停、实际重置 generation、从中断阶段恢复和重启发现自动化已通过 |
| 章节 Finalization | 正文、图作用域和 Markdown 的现有提交逻辑继续复用 | `prepared` 至 `completed` 的幂等状态机和正式章节唯一消息已接入；尚缺 Electron 真实故障注入 | 不重复调用模型、提交图或发布章节 | 作用域提交失败、章节发布失败和登记后中断恢复自动化已通过 |
| 完整历史上下文快照与世界线恢复 | 用户工作区和正式 Git 不受内部历史模块影响 | 正式保存、恢复、隔离 Git 和 UI 已接入；包含检查点的恢复会克隆成新暂停任务，原任务和原未来不变；真实 Electron 已完成 A/B 世界线与压缩前链恢复 | 独立 HistoryService 和隔离存储，不进入 AI 阶段循环 | 自动化覆盖完整投影和检查点；真实恢复后活动链回到原 72 条、52,142 Token、0 条隐藏消息，压缩后的查询尾部没有串入保存点 |
| 监控日志和 UI | 已有 Electron 布局、模型配置和正常推演交互不改版 | 后端实时指标、KV、压缩代次、持久重置命令、真实历史列表和检查点弹窗已接通；Electron 已实际显示额度暂停、重置、恢复、上下文容量和压缩代次 | 不新增第二套监控，只验证现有右栏实时数据 | UI 契约和 Facade 自动化已通过；真实运行观察到 `context_tokens=8,869`、`context_limit=60,000`、`compression_generation=1` 和 KV 命中率更新 |

### 2.1 2026-08-11 Electron / DeepSeek Flash 真实验收

- 使用真实 Electron、持久模型配置和 `deepseek-v4-flash` 从一句话启动首章；先将模型调用上限设为 1，任务在 `interpret` 完成后于 `rule_assembly` 进入 `awaiting_user_decision`。
- 通过右侧实时监控执行“重置模型调用”，当前窗口由 `1 / 1` 变为 `0 / 400`，累计调用仍为 1；点击“继续执行”后从 `rule_assembly` 恢复，`interpret` 没有重复执行。
- 全轮最终完成 14 次真实模型调用，累计输入 432,614 Token、输出 46,408 Token、KV 命中率 11.86%，活动上下文 52.1k / 970k，压缩代次为 0。
- 正式发布 `章节正文/第一章 雨夜雾港站.md`，世界图提交为 20 个节点、37 条连接，章节、图作用域和正式上下文消息均完成 Finalization。
- 真实图产物暴露 `ownerRef` 指向本轮 `local:*` 身份时无法绑定 pending revision 的缺陷；已改为优先绑定本轮同类实体的最新修订，再回退到已提交历史，并加入回归测试。
- 暂停任务恢复完成后没有自动历史保存；已将首次执行和恢复执行收敛到同一自动保存入口，并加入 Facade 端到端回归测试。
- 在 Electron 历史面板中完成两个手动状态的 A/B 加载、从旧保存点创建“世界线 2”、切回主世界线并恢复较新状态；整个过程没有重启，`设定集/readme.md` 的差异、章节和 20/37 图投影随保存点恢复。
- 将 Flash Profile 的最大上下文临时改为 60,000，用恢复后的 52,142 Token 活动链执行真实只读查询；发送前按 97%/50% 规则移出 70 条旧非正文，可见链降至 7,778 Token，监控显示压缩代次 1。
- 查询禁止读取章节目录，仍通过 Source 原文单元准确返回雾港站、列车停运、末班九点四十、次日六点十五及候车室过夜等事实，并拒绝把用户给出的“林序”当成已证实身份。
- 真实五阶段请求严格保留追加前缀：精确消息前缀为 0/6/11/16/21，公共前缀比例升至 87.56%；累计 5 次调用、111,797 输入 Token、14,943 输出 Token，供应商 KV 命中率 9.50%。
- 恢复压缩前手动保存点后，活动链回到 72 条、52,142 Token、0 条隐藏消息，图与章节不变；`node`、`link`、`revision`、`source`、`evidence` 独立计数器没有随历史回退。
- 完整重启 Electron 后重新打开验收项目，`history.list` 返回当前投影的 20 个图锚点，Renderer 随后自动调用 `graph.neighborhood`；历史面板仍选中“压缩验收前 · 08/11”，模型 Profile 仍为 1,000,000 上下文，右栏恢复为 20 个节点、37 条连接，日志无错误。
- 8 月 10 日批次的真实执行闭环已经验收。Pro Profile 凭据和 Sigma 窄栏布局属于独立后续事项；Sigma 画布继续保持 `prototype_only`，不作为本批上下文、恢复和治理能力的完成证据。

### 2.2 2026-08-11 单链角色与 KV 复验

- 旧活动链中遗留的阶段 `system` 消息现在只在模型发送边界规范化为 `user`；数据库历史不改写、不创建第二条链，首条锁定规则仍是唯一 `system`。
- 使用真实 Electron 和 `deepseek-v4-flash` 完成第四章《临口往返》，任务 `57bd22c0-59c9-4b01-a1b4-f358a31dd69d` 全部阶段、10 次语义探针审核、Finalization 和自动历史均完成。
- 26 次真实调用的消息角色违规为 0；25 次连续请求全部满足上一请求是下一请求的完整字节前缀。
- 角色规范化后的第一次调用是预期冷启动；后续有效 KV 命中平均 99.87%，最近三次平均 99.98%，供应商整轮命中率 95.41%。
- 只读审计结果为 11 项通过、0 项失败；后台世界自动调度仍未实现，因此完整全链路验收仍保留 1 项 `not_implemented`。

### 2.3 2026-08-14 分步图治理与恢复验收

- 第 23 章任务 `c8967c3a-d96d-4c49-bfc4-9d306a8b049d` 完成分步图治理、容量局部重构、时空结算、查询设计、真实探针、审核、Finalization 和自动历史保存；只读审计为 15 项通过、0 项失败。
- 图容量重构把旧提案 `proposal:p10` 替换为 `proposal:p10b`，下游时空与查询阶段只引用最终提案；提交后全图最高直接入度和出度均为 12，没有超过项目上限。
- 19 个 Source 结算全部具有非空图返回路径，10 个 `world_effect` 全部绑定有效场景；提交产物不存在 `local:*` 身份或引用。
- 后台自动演化任务 `55fe6ee1-4f35-44fa-b6ce-9821f44f25f6` 从旧无效时空产物恢复：旧时空及下游运行被 `superseded`，结构阶段没有重跑，最终提交 6 个图修订和 1 个有效探针，不发布章节正文。
- 同轮当前可见 Evidence 单调保留；图 owner 的读取时 `revisionId` 与当前 head 一致时直接复用，变化时才刷新。第 23 章真实请求保持单链字节级前缀，供应商 KV 命中率为 98.27%。
- 验收器已同步到分步阶段：`graph_capacity_rewrite` 是仅在超限时出现的条件阶段；完整治理必须包含 structure、spacetime、retrieval 和 review，旧单体 `graph_governance`/`semantic_review` 不再算新任务完成证据。
- 图探针验收只统计关联有效 `completed` 阶段的执行记录，并要求最新治理审核按 `probeIndex` 精确覆盖；第 23 章和后台演化任务均为 1 对 1 通过。审核提示尾部已明确真实执行字段，自动化通过，真实模型措辞需在下一轮继续观察。
- 本次证明单轮正文与后台演化的治理、恢复和提交闭环。几十章压缩后的长期图召回质量、跨时间流与复杂世界线切换仍需独立验收，不能由本次结果外推为全部产品需求已验证。

### 2.4 2026-08-14 第 24 章决策覆盖修复与真实验收

- 任务 `57107375-6c92-4712-a048-b4ae0969cc9b` 在首次提交时暴露真实契约缺口：候选图修改未被 AI 决定记录完整覆盖，错误直到 Finalization 前才出现。
- `graphStructurePlanArtifactSchema` 现要求决定记录覆盖每一项候选修改且不得引用未知候选；缺失时在结构规划阶段立即 Schema repair。对应回归测试、79 项相关测试、类型检查和构建均通过。
- 同一 Task 自动回退到 `graph_structure_plan`，没有重新生成正文或创建替代任务。重跑后 9 项候选由 3 条决定记录完整覆盖，18 个 Source、3 个场景、5 个图修订、5 个检索投影和 1 个 AI 自定义探针完成提交。
- 项目只读审计为 15/15 通过；活动上下文仍是单一追加链，完整消息 4,080 条，当前可见 105 条，系统规则只有 1 条。有效相邻前缀平均命中率为 99.32%，最近三次为 99.97%；供应商按整轮输入统计的命中率为 92.64%，主要包含冷启动、恢复和新增 Evidence，不能与相邻可复用前缀指标混为一谈。
- 人工正文检查发现第 24 章相对时间措辞沿用了第 21 章的“昨天”。这不否定图持久化和召回闭环，但证明“图正确提交”尚不能升级为“正文长期语义完全自洽”。正文审核仍按产品原则只给建议、不拒绝提交。

## 3. 当前总览

截至 2026-08-14，正文单轮、分步图治理、容量治理、Source 返回、后台演化恢复和提交闭环已经分别获得真实证据，但跨越长期压缩召回、复杂世界线切换、多时间流和持续后台影响的完整产品闭环仍未达到 `verified`。不能用单轮成功替代长期产品验收。

| 能力 | 权威设计 | 状态 | 当前证据 | 下一代码批次 |
| --- | --- | --- | --- | --- |
| 一句话生成任意世界、资料不足时合理补全 | [system-design.md](system-design.md)、[world-emergence-rules.md](world-emergence-rules.md) | `design_complete_implemented` | 主阶段和出现规划已存在；尚未通过长期通用题材验收 | 建立长期固定场景集并完成真实十章一致性验收 |
| 用户矛盾输入作为意图或提案，不自动成为事实且不拒绝创作 | [system-design.md](system-design.md)、[ai-phase-contracts.md](ai-phase-contracts.md) | `design_complete_implemented` | 输入理解、依赖审计和 pending 作用域已有正式路径；矛盾输入的长期状态结果尚未系统验收 | 增加“与当前图冲突但继续推演”的端到端测试 |
| 机位、景别、描写视角、笔风和字数作为每轮尾部表现约束 | [ui-design.md](ui-design.md)、[rule-and-source-layers.md](rule-and-source-layers.md)、[dynamic-context-architecture.md](dynamic-context-architecture.md) | `design_complete_implemented` | UI 与阶段输入已有相关字段；尚未证明所有阶段只把它们当表现控制且正式正文稳定遵守 | 增加 Prompt 尾部顺序、字数范围和不污染世界图测试 |
| 万事万物皆节点、AI 自主定义语义与局部结构 | [system-design.md](system-design.md) | `design_complete_implemented` | 通用节点、连接、修订和治理 artifact 已存在；真实长期图质量未验证 | 增加结构复用、历史返回和图简洁度验收 |
| 正文全部事物回写、完整原文与精确话语返回 | [system-design.md](system-design.md)、[ai-phase-contracts.md](ai-phase-contracts.md) | `design_complete_implemented` | `source_units`、结算记录和章节发布已有基础；不能证明正文全部内容均获得可返回表达 | 加入逐原文单元结算完整性和精确召回测试 |
| 当前状态、历史演化与归档返回 | [system-design.md](system-design.md)、[spacetime-anchor-design.md](spacetime-anchor-design.md) | `design_complete_implemented` | 不可变图修订和归档原则已进入协议；长期状态投影尚未验收 | 验证旧事实、最新状态、归档出口和原文共同返回 |
| 图结构只归档不物理删除，重构后旧含义仍可返回 | [system-design.md](system-design.md)、[backend-architecture.md](backend-architecture.md) | `design_complete_not_implemented` | 不可变修订可复用，但当前仍有 `retired` 基础设施，尚未证明所有语义归档都建立普通图出口 | 收敛归档提交协议并验证当前入口与历史入口同时可达 |
| 选择性图与资料检索 | [dynamic-context-architecture.md](dynamic-context-architecture.md)、[rule-and-source-layers.md](rule-and-source-layers.md) | `design_complete_implemented` | exact、FTS、语义和邻域读取已有正式代码；召回质量、耗时和预算仍未达到产品验收 | 建立可重复召回基准并测量命中率、Token 和延迟 |
| AI 自主查询规则与图重构后的真实验证探针 | [system-design.md](system-design.md)、[ai-phase-contracts.md](ai-phase-contracts.md)、[backend-architecture.md](backend-architecture.md) | `design_complete_implemented` | 探针定义权已完全归 AI；模型漏提时同阶段 Schema repair 要求补提，应用只执行、冻结和回传，逐探针游标及按 `probeIndex` 审核均已接入；第 23 章和后台演化均产生应用层真实执行及审核评估 | 继续验证压缩后当前/历史/原文多种探针的长期召回质量 |
| 通用时空锚点、多时间流与动态空间 | [spacetime-anchor-design.md](spacetime-anchor-design.md) | `design_complete_implemented` | 契约和部分机械门禁已进入编排；尚无跨世界流速和动态空间端到端验收 | 增加多参照同步、未知对应和跨空间移动测试 |
| 世界自洽演化、局部主体信息边界与演化前沿 | [world-emergence-rules.md](world-emergence-rules.md)、[system-design.md](system-design.md) | `design_complete_implemented` | 自动触发来源、前沿选择、正式演化任务、分步图治理和恢复已接入；验收项目存在 22 个自动任务，其中 18 个完成，最新恢复任务提交 6 个图修订 | 验证后台变化在较晚正文中被选择性召回并产生自然影响 |
| 图直接入度/出度上限、预警和 AI 递归抽象治理 | [system-design.md](system-design.md)、[v1-freeze.md](v1-freeze.md)、[graph-governance-staged-design.md](graph-governance-staged-design.md) | `verified` | 代码机械检测双向容量，AI 只重构违规局部并重新检测；第 23 章真实重构后全图最高入度/出度均为 12，无超限，最终提案引用和提交结果一致 | 保持回归与性能观测，不扩展固定领域规则 |
| 单一追加式模型上下文与 KV 前缀复用 | [context-and-kv-cache.md](context-and-kv-cache.md)、[2026-08-10-model-context-chain.md](superpowers/plans/2026-08-10-model-context-chain.md) | `design_complete_implemented` | SQLite 活动链、基础规则一次写入、增量追加、跨轮同链和正式章节引用已进入正式路径；尚未完成真实 KV 趋势验收 | 用 Flash/Pro 验证跨阶段公共前缀和 KV 命中趋势 |
| 两阶段机械上下文压缩 | [context-and-kv-cache.md](context-and-kv-cache.md) | `design_complete_implemented` | 旧 AI 压缩阶段已移除；发送前 97%/50% 机械移出已接入并有保护项测试 | 在真实模型接近阈值时验证可见链、暂停和历史恢复 |
| 模型上下文容量唯一来源 | [context-and-kv-cache.md](context-and-kv-cache.md)、[model-protocol-boundary.md](model-protocol-boundary.md) | `design_complete_implemented` | 模型 Profile 保存唯一容量，项目设置只保存压缩比例；默认 1M | 完成 Electron Profile 切换验收 |
| 项目级按前缀永久 ID 计数器 | [model-protocol-boundary.md](model-protocol-boundary.md)、[2026-08-10-model-context-chain.md](superpowers/plans/2026-08-10-model-context-chain.md) | `design_complete_implemented` | 项目 SQLite 原子计数器已接入 Source、Evidence、Revision 和图本地引用物化，历史恢复不回退 | 完成真实多世界线 ID 连续性观察 |
| 任务检查点、异常保留与用户控制恢复 | [turn-interruption-recovery.md](turn-interruption-recovery.md) | `design_complete_implemented` | 持久阶段检查点、继续/重试、暂停、取消、重启发现和 Finalization 恢复已接入；长请求用户操作待 Electron 验收 | 完成实际运行中暂停、重启和恢复交互 |
| 调用、Token、耗时、检索、循环和图容量参数化 | [v1-freeze.md](v1-freeze.md)、[turn-interruption-recovery.md](turn-interruption-recovery.md) | `design_complete_implemented` | 配置来源和额度窗口已收口，阻塞指标会暂停并保留当前累计成本 | 用真实模型覆盖耗尽、重置和继续 |
| 额度实时监控、单项/全部重置 | [turn-interruption-recovery.md](turn-interruption-recovery.md)、[ui-design.md](ui-design.md) | `design_complete_implemented` | 后端按任务返回实时指标，单项/全部重置写入新额度窗口并增加 generation；UI 已接真实命令 | 完成 Electron 实时更新和按钮交互验收 |
| 正式章节 Finalization | [turn-interruption-recovery.md](turn-interruption-recovery.md)、[context-and-kv-cache.md](context-and-kv-cache.md) | `design_complete_implemented` | 幂等状态机、正式章节唯一消息及三个关键中断点恢复测试已完成 | 完成 Electron 真实发布故障验收 |
| 推演历史、手动/自动保存、返回上一轮和世界线 | [world-history-versioning.md](world-history-versioning.md) | `design_complete_implemented` | 正式路径已使用隔离 `isomorphic-git`、历史表、完整快照、活动投影切换和真实 `HistoryPanel`；自动保存失败不改变正文任务完成状态；A/B 世界线模型链隔离测试通过 | 完成 Electron 实际点击、运行中手动保存和重启恢复验收后再评估 `verified` |
| 历史保留上限和独立可恢复快照 | [world-history-versioning.md](world-history-versioning.md) | `design_complete_implemented` | 有限上限会预览并确认，随后重写最早保留 Git 基线、迁移游标与父引用、删除超额 SQLite 入口并记录延迟 GC 事件；自动化验证新基线无旧父提交 | 补跨多世界线空分支清理、进程中断恢复和大历史量性能验收 |
| 工作区固定目录、Markdown 限制、上传文件与目录 | [ui-design.md](ui-design.md)、[backend-architecture.md](backend-architecture.md) | `design_complete_not_implemented` | 文件读取和目录清单已有基础；新建、上传及目录全 Markdown 校验没有完整接线 | 完成 Electron IPC、Facade 和原子文件任务 |
| 用户 Markdown 工作区与数据库、索引、对象库和内部 Git 物理隔离 | [backend-architecture.md](backend-architecture.md)、[world-history-versioning.md](world-history-versioning.md) | `design_complete_implemented` | SQLite、对象、索引和 bare `isomorphic-git` 均位于应用内部目录；用户工作区无 `.git`，适配器不读取系统 Git 配置，隔离测试已通过 | 继续在 Electron 打包环境验证路径与权限边界 |
| 世界图专业布局、节点避碰与边交叉控制 | [ui-design.md](ui-design.md) | `prototype_only` | 已使用 Sigma 展示图；当前布局没有满足避碰和边交叉验收 | 引入布局计算、稳定坐标和视觉回归测试 |
| DeepSeek 模型配置、模型列表、思考与 JSON 开关 | [model-protocol-boundary.md](model-protocol-boundary.md)、[ui-design.md](ui-design.md) | `design_complete_implemented` | 配置持久化、模型调用及 reasoning/JSON 控制已有代码和测试；真实供应商边界仍需持续回归 | 增加 Profile 切换、空 content、结构修复和状态码集成测试 |
| 用户规则、设定集/参考文件 `readme.md` 索引和表现输出 | [rule-and-source-layers.md](rule-and-source-layers.md)、[dynamic-context-architecture.md](dynamic-context-architecture.md) | `design_complete_implemented` | 目录和动态读取流程已有代码基础；尚未完成大型目录选择性读取验收 | 测试索引引导、来源追踪、表现规则尾部强调和不读章节目录 |
| 连续章节编号与 AI 章节名 | [system-design.md](system-design.md)、[ui-design.md](ui-design.md) | `design_complete_not_implemented` | 当前章节序号仍由章节目录文件数量推算，不能支持历史恢复、并发和分支 | 使用世界线章节头或永久序列协议生成编号 |
| 后端低耦合、基础工具复用和业务隔离 | [backend-coding-principles.md](backend-coding-principles.md)、[backend-architecture.md](backend-architecture.md) | `design_complete_not_implemented` | 端口和仓储边界存在，但 `TurnOrchestrator` 仍集中承担大量职责 | 按上下文、探针、恢复、Finalization 拆分独立应用服务 |

## 4. 设计完整性结论

### 4.1 已经齐全，可以进入代码实施

以下设计的目标、边界、失败语义和验收条件已经足够明确：

- AI 自治动态图、全部事物持久表达、原文返回和选择性检索；
- 时空锚点、多时间流、动态空间和当前状态连续性；
- 单一追加式上下文、两阶段机械压缩和 KV 前缀稳定；
- 项目级永久 ID、章节 Finalization 和任务检查点；
- 推演历史、世界线、手动/自动保存、恢复暂停和保留上限；
- 世界演化原则、演化前沿和局部主体信息边界；
- 工作区、模型配置、运行监控和 UI 布局。

这些能力目前的主要问题是代码没有完成，不应继续通过增加原则性文档掩盖实施缺口。

### 4.2 本轮补齐的协议缺口

图治理验证此前只有“AI 返回 `verificationProbes`”的结果结构，没有规定谁真实执行查询，存在 AI 自己声明已经验证的漏洞。本轮已冻结并开始实施为：

1. AI 只提出通用查询计划；
2. 应用层通过现有检索端口真实执行；
3. 执行结果以不可伪造的系统记录返回 AI；
4. AI 只对真实结果给出语义判断；
5. 语义失败只形成审核建议并继续提交；执行中断才进入任务检查点恢复，且不丢弃探针记录。

协议缺口已经冻结，基础执行链已开始实施；但 overlay、故障恢复和真实模型验收仍是代码缺口。后续若发现设计与真实实现冲突，必须先更新本文状态，再决定修改设计还是代码。

## 5. 验收纪律

- 单元测试通过只证明对应单元，不自动把能力标记为 `verified`。
- UI 能点击、能展示模拟数据，只能标记为 `prototype_only`。
- 数据表、Schema 或端口存在，但没有接入正式执行路径，仍是 `design_complete_not_implemented`。
- 只有 Fake 模型通过，不能证明 DeepSeek 真实流程通过。
- 一轮推演完成，不能证明长期历史召回、图有效性、压缩、恢复和世界线隔离通过。
- 任一状态升级都必须记录自动化测试、真实流程、持久化结果和用户可见结果四类证据；不适用的证据必须说明原因。
