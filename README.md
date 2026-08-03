# Worldseed

Worldseed 是一个由 AI 完全自治治理的动态世界图实验项目。

核心思想：

- 万事万物都是节点；
- 代码不预设人物、地点、势力、时间、状态或边类型；
- AI拥有节点和连接的新增、编辑、合并、拆分、迁移和归档权限，不物理删除旧结构；
- AI每次重要修改都说明原因、依据原则自审，并在修改后复核；
- 候选正文和图修订先进入同一 `pending` 作用域，完整结算后才共同提交；正式正文单独以连续小说形式保存，图通过原文引用返回准确内容；
- 正文按不可变原文单元生成结算映射，正文中实际出现的全部内容都持久化，同一内容再次出现时优先复用已有局部图；
- 每次图修改都保留不可变前后修订，当前状态变化连接前置修订、生效时间和新的当前入口；
- 任意持久记录都有统一检索投影，任意载荷都能通过精确键和 AI生成的语义文本重新召回；
- 持久化图独立于模型上下文，上下文压缩不能造成世界失忆或状态回退；
- 每轮推演只使用实际读取的旧图和本轮新内容，正式场景必须具有连续的时间与地点锚点；
- AI在每轮变化后强制结算演化前沿，并用可调自主度和每轮总调用、总 token、总耗时预算有限推进用户视野外的局部世界；
- 自主行动只使用行动主体实际可获得的信息，联合演化负责处理局部碰撞和共同世界约束；
- 正文草稿前扫描当前场景可达的自治局部，主推演整体受调用、token、耗时和循环次数上限约束；
- AI按版本化 Prompt Contract 分阶段完成依赖审计、图治理、自审、正文结算、前沿结算和提交复核；
- 基础规则对用户可见但不可修改；用户规则以 Markdown 在明确适用范围内优先于平台默认创作建议，范围外或无法判断时回退默认规则；设定集与参考资料通过 Skill manifest、索引和按需片段选择性注入；
- 正文只投影少量有依据的自主变化，并通过近期来源去重让不同局部共同形成世界活力感；
- 新人物、新势力、新事件或其他新内容不按类型和章节配额触发，而由已读取世界无法被现有局部承担的“出现压力”统一决定；
- 世界活力不要求后台事实俱备，长期未加载区域在重新进入前执行惰性追赶；
- AI优先在已有结构上生长，避免重复和同义结构；
- 节点任一方向的直接邻接达到上限时，AI自主提炼更高层含义并递归重构，保证连接从两端都可重新发现；
- 查询先召回入口再围绕锚点局部展开，地图、关系网、历史、普查和回忆都是临时图投影；
- 固定长篇测试同时验收历史召回、状态连续、表现控制、矛盾输入处理和读者可感知的世界活力。
- 提供 IDE 式桌面工作台：左侧管理 Markdown 工作目录，中央进行编辑与正文推演，右侧展示流程、底层图和自洽演化。
- 每次正式推演由 AI生成连续章节序号和章节名，以 `第一章 xxxx.md` 保存到固定的 `章节正文` 目录，标题同时属于正文并参与图结算。
- 第一阶段使用 DeepSeek API 作为统一模型基线，采用 JSON Mode，不把运行时绑定到 Claude Code 或某一种 Tool Calling 格式。

完整底层设计见 [docs/system-design.md](docs/system-design.md)，项目技术栈、Monorepo 和 Electron 进程边界见 [docs/project-code-architecture.md](docs/project-code-architecture.md)，后端模块、端口、存储和执行管线见 [docs/backend-architecture.md](docs/backend-architecture.md)，后端复用、隔离和依赖约束见 [docs/backend-coding-principles.md](docs/backend-coding-principles.md)，单轮上下文、选择性读取和 KV 缓存复用见 [docs/context-and-kv-cache.md](docs/context-and-kv-cache.md)，AI 阶段输入输出与回流契约见 [docs/ai-phase-contracts.md](docs/ai-phase-contracts.md)，世界内容何时复用、扩展、揭示、创建、延后或拒绝见 [docs/world-emergence-rules.md](docs/world-emergence-rules.md)，规则与资料层级见 [docs/rule-and-source-layers.md](docs/rule-and-source-layers.md)，IDE 工作台见 [docs/ui-design.md](docs/ui-design.md)。

编码前冻结基线见 [docs/v1-freeze.md](docs/v1-freeze.md)，其中集中定义 V1 最小闭环、接口契约、SQLite 迁移、DeepSeek 代理与缓存配置、默认参数以及基础 Prompt 资源。
