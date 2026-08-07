# Worldseed 后端编码原则

## 1. 文档目的

本文件是后端开始编写业务代码前的强制规范。

目标不是把所有代码抽象成一套复杂框架，而是保持以下边界：

- 底层通用工具和机械能力可以复用；
- 上层业务用例相互隔离，不能因为一个业务模块的修改而隐式影响其他模块；
- 业务模块只能依赖稳定的端口和契约，不能依赖其他模块的内部实现；
- AI 的世界语义决定仍属于 AI，代码只提供执行、存储、检索、调度和校验结构的能力。

本规范不引入当前未决定的原子提交设计，也不把人物、势力、地点、事件等领域类型写入代码结构。

## 2. 总体依赖方向

后端代码必须遵守以下单向依赖：

```text
transport ───────> contracts
    │
    └────────────> application ─────> core

infrastructure ──> application ports
bootstrap ───────> transport + infrastructure + application
```

具体含义：

- `core` 不依赖 Electron、SQLite、DeepSeek、文件系统或任何上层业务模块；
- `application` 只依赖 `core` 和自己声明的端口；
- `infrastructure` 实现端口，但不能把数据库、模型 SDK 或文件系统细节泄漏到应用层；
- `transport` 只负责协议转换、输入输出校验和事件传输；
- `bootstrap` 是唯一负责组装具体实现的地方；
- 业务模块之间禁止形成环形依赖。

依赖方向是强约束。任何“为了方便直接导入”的跨层依赖都必须拒绝。

## 3. 模块边界

### 3.1 Core

`core` 只保存与具体业务无关的稳定机械能力，例如：

- 节点、连接、局部图和邻接读取的通用结构；
- 修订、作用域、可见性和来源引用；
- 规范序列化、摘要、精确键和容量计算；
- 预算、时间点、路径和分页等通用值对象；
- 通用错误、结果和不可变数据结构。

`core` 禁止出现：

- `Character`、`Faction`、`Location`、`Marriage` 等领域专用类；
- `TurnService`、`ChapterService` 等应用用例；
- SQL、文件路径、IPC、Electron、DeepSeek 调用；
- 根据小说语义判断节点身份、关系或真实性的逻辑。

### 3.2 Application

`application` 以用户可执行的能力划分模块：

```text
application/
├── projects/
├── workspace/
├── turns/
├── queries/
├── chapters/
├── evolution/
└── operations/
```

每个模块只拥有自己的：

- Command、Query 和 Result；
- 用例处理器；
- 所需端口；
- 应用层错误；
- 本模块的阶段状态转换。

例如，`chapters` 只负责章节版本、标题、发布投影和修订生命周期，不理解正文中出现的是人物还是势力；`turns` 负责推演阶段编排，但不直接操作 SQLite。

### 3.3 Infrastructure

`infrastructure` 按外部技术实现端口：

```text
infrastructure/
├── sqlite/
├── filesystem/
├── fts/
├── vector/
├── models/
└── telemetry/
```

基础设施代码可以知道 SQLite、文件系统和 DeepSeek，但不能决定世界语义，也不能绕过应用用例直接修改其他模块状态。

### 3.4 Transport

`transport` 只做：

- IPC 或 HTTP 输入转换；
- DTO 的 Zod 校验；
- 调用应用层用例；
- 应用错误到协议错误的映射；
- 任务事件的序列化。

`transport` 不得包含推演流程、检索策略、图修改判断或 Markdown 业务规则。

## 4. 通用工具复用原则

### 4.1 复用的是机械语义，不是业务名称

可以复用：

- `canonicalSerialize(value)`；
- `digest(value)`；
- `paginate(items, cursor)`；
- `BudgetCounter`；
- `ScopeRef`；
- `GraphSlice`；
- `WorkspacePath`；
- `Result` 和错误映射。

不能因为两个业务模块都处理“人物”或“章节”就抽出领域基类。代码不预设世界中的领域类型。

### 4.2 工具类必须满足的条件

新增底层工具前必须满足：

1. 解决稳定、明确、可描述的机械问题；
2. 输入和输出可以独立说明；
3. 不依赖某个具体业务模块的内部状态；
4. 不隐式读取全局变量、数据库或当前任务；
5. 可以用纯函数或无状态对象表达时，优先采用纯函数；
6. 至少存在两个真实使用场景，或已确认是跨模块基础协议。

只有一个业务模块使用的代码，先留在该模块内部，不要为了“看起来复用”提前抽象。

### 4.3 禁止万能工具箱

禁止创建不断堆积函数的：

```text
utils.ts
helpers.ts
common.ts
service.ts
```

如果工具职责不同，必须按稳定能力拆分，例如：

```text
core/serialization/canonical-serialize.ts
core/identity/digest.ts
core/budgets/token-budget.ts
infrastructure/filesystem/workspace-path.ts
```

工具名称必须描述机械能力，不能使用 `doEverything`、`processData`、`handleWorld` 等无边界名称。

### 4.4 共享状态禁止隐式存在

禁止通过模块级可变变量、单例服务容器或隐式缓存共享业务状态。

必须显式传入：

- `projectId`；
- `taskId`；
- `scopeId`；
- `RuleSnapshot`；
- `BudgetSnapshot`；
- 当前读取集合；
- 所需的端口实例。

缓存必须具有明确的所有者、作用域、失效方式和测试替身，不能把缓存当作事实来源。

## 5. 业务模块隔离原则

### 5.1 只依赖公开 API

模块外部只能导入模块的 `index.ts` 或明确的 public API，禁止导入内部文件：

```ts
// 允许
import { StartTurnHandler } from "../turns";

// 禁止
import { buildInternalPrompt } from "../turns/internal/prompt-builder";
```

每个模块内部可以自由重构，只要公开契约不变。

### 5.2 模块之间通过端口协作

业务模块禁止：

- 直接调用其他模块的 Repository；
- 直接读取其他模块的 SQLite 表；
- 直接读写其他模块的内部文件；
- 直接修改其他模块的 Zustand 或任务状态；
- 通过字符串路径或未声明事件偷偷传递数据。

跨模块协作只能使用：

- 应用层声明的端口；
- `packages/contracts` 中的稳定 DTO；
- 已注册的版本化应用事件。

例如，推演模块需要保存章节时调用 `ChapterWriterPort`，而不是导入章节模块的 SQLite Repository。

### 5.3 编排器不实现业务语义

`TurnOrchestrator`、`QueryOrchestrator` 和 `EvolutionScheduler` 只负责：

- 阶段顺序；
- 阶段输入输出传递；
- 暂停、恢复、重试和预算；
- 事件发布；
- 阶段失败后的回流。

它们不能判断“这个节点是不是人物”“用户说法是否真实”或“AI提出的关系是否合理”。这些决定通过 Prompt Contract 交给 AI，代码只验证结构和读取边界。

### 5.4 事件用于通知，不用于隐藏调用链

事件可以通知：

- 任务进度变化；
- 文件索引完成；
- 图修订已暂存；
- 章节发布完成。

事件不能被用来绕过端口偷偷执行核心业务。需要得到返回结果的调用使用显式端口；只需要广播事实的场景才使用事件。

事件名称、版本和载荷必须进入 `contracts`，事件处理失败不能静默吞掉。

## 6. 数据与持久化隔离

### 6.1 Repository 不等于业务服务

Repository 只负责持久化数据的读写和机械查询，不负责：

- 判断节点是否同一实体；
- 判断图修改是否合理；
- 决定是否提交 AI 结果；
- 将查询结果解释为世界事实。

这些行为属于应用阶段编排和 AI 决定记录。

### 6.2 数据库表按基础设施职责归属

应用层不能直接依赖表名。表结构变更只能影响对应基础设施适配器和迁移，不能要求所有业务模块改写 SQL。

跨模块查询如果确有需要，必须新增一个面向用例的端口，而不是让一个模块直接读取另一个模块的表。

### 6.3 用户目录和内部存储分离

用户工作目录只保存目录和 `.md` 文件。数据库、索引、任务状态、pending 内容、不可变历史和缓存进入独立的应用内部目录。

任何模块都不能把内部数据库路径、内部对象存储路径或任务文件路径暴露成用户 Markdown 工作目录中的事实文件。

## 7. AI 与供应商隔离

AI 调用必须经过：

```text
application AIModelPort
        ↓
infrastructure DeepSeekAdapter
        ↓
DeepSeek API
```

应用层只知道 `AIModelPort` 和 `AIPhaseResult`，不能导入 `openai` SDK 或 DeepSeek 类型。

DeepSeek 适配器只负责：

- API 认证和请求发送；
- JSON 文本提取与供应商响应转换；
- 流式输出和 token 统计；
- 超时、重试和供应商错误转换。

它不能修改节点、连接、状态、章节或规则的业务含义。

更换模型供应商时，只允许影响 `infrastructure/models` 和对应配置，不得迫使 `turns`、`queries` 或 `evolution` 修改业务流程。

## 8. 契约与版本原则

以下内容必须版本化：

- IPC DTO；
- AI 阶段 JSON Schema；
- Prompt Contract；
- 任务事件；
- `RuleSnapshot`；
- 项目配置快照；
- 持久化迁移。

任务开始后固定本轮使用的契约版本。任务恢复不能静默使用新 schema 或新 Prompt。

兼容性规则：

- 新增可选字段优先保持向后兼容；
- 删除或改变字段含义必须升级版本；
- 外部 DTO 不直接复用数据库行类型；
- 数据库迁移不能反向污染业务模型。

## 9. 配置与参数原则

运行参数必须分为三类：

1. **应用配置**：模型地址、默认模型、日志级别等；
2. **项目配置**：出度上限、合并预警阈值、图布局、检索和预算参数；
3. **任务快照**：本轮实际使用的配置，任务开始后不可被后台静默改变。

配置读取通过端口完成，业务代码接收不可变快照，不直接读取环境变量或 UI 状态。

图出度上限、合并预警阈值和布局参数属于项目配置；布局参数只影响展示，不得修改图数据。AI 可以依据这些参数做图治理决定，但代码不替 AI 判断语义合并内容。

## 10. 错误与失败隔离

错误按边界分类：

```text
core error
application error
infrastructure error
transport error
```

规则：

- 底层错误不能携带数据库或供应商私有类型穿透到 UI；
- 应用层必须把可恢复、需补充读取、需修订、不可恢复区分开；
- 失败不能通过返回 `null` 静默隐藏；
- 重试必须由拥有任务状态的应用层决定，不能由 Repository 或 UI 隐式重试；
- 一个业务模块的失败不能直接污染其他模块的 committed 状态。

## 11. 测试与架构守门

每个模块必须具有自己的测试边界：

- `core`：纯函数和不变量测试；
- `application`：使用 fake ports 的用例测试；
- `infrastructure`：SQLite、文件系统和 DeepSeek 适配器集成测试；
- `transport`：DTO、错误映射和事件协议测试；
- `contracts`：schema 兼容性测试。

必须增加架构测试，至少检查：

- `core` 不导入 `application`、`infrastructure` 或 Electron；
- `application` 不导入数据库驱动、文件系统和模型 SDK；
- 业务模块不导入其他业务模块的内部路径；
- contracts 不依赖业务实现；
- 不存在循环依赖；
- 用户目录适配器不写入非 Markdown 文件。

业务模块替换为 fake port 后，如果仍然必须启动 SQLite、Electron 或 DeepSeek，说明边界泄漏，代码不能合并。

## 12. 代码评审清单

每次后端修改至少回答：

1. 修改属于哪个模块，公开边界是什么？
2. 是否新增了跨模块 import？为什么不能通过端口解决？
3. 新代码是稳定机械能力还是业务语义？机械能力是否应放入 `core`？
4. 是否把一个业务模块的内部类型泄漏到另一个模块？
5. 是否引入了全局可变状态、隐式缓存或隐藏文件读写？
6. 是否可以用 fake port 独立测试上层用例？
7. 是否改变了外部契约、Prompt Contract 或任务快照版本？
8. 是否影响其他模块的数据库表、事件或文件路径？
9. 是否有针对本次边界的架构测试？
10. 如果改动模型供应商、图布局或存储实现，应用层是否无需修改？

## 13. Definition of Done

后端功能只有同时满足以下条件才能进入实现完成状态：

- 代码位于正确的层和模块；
- 对外依赖经过端口或版本化契约；
- 底层机械能力没有重复实现；
- 没有新增隐式共享状态；
- 业务模块可以独立测试；
- 相关架构测试和模块测试通过；
- 失败、恢复和边界行为已经定义；
- 文档中的依赖方向和源码保持一致。

本原则的核心是：**底层能力复用，上层用例隔离，跨模块只通过契约协作，任何实现细节不得成为其他业务的隐式前提。**
