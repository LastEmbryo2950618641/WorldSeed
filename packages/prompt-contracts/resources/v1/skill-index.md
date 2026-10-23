# 平台 Skill 索引（按需加载）

完整 skill 正文**不**常驻系统规则。需要时用工具 `load_skill`（先 describe 再 invoke），或由宿主按阶段默认挂载。
arguments 示例：`{"skillId":"webnovel-dialogue","includeReferences":false}`。

| id | 名称 | 策略 | 何时用 |
|----|------|------|--------|
| `webnovel-deslop` | 去 AI 味（deslop） | default(draft,synopsis_discuss) | 改工整/排比/翻译腔/空洞抒情；写正文或润色时用。 |
| `webnovel-dialogue` | 对话与台词 | default(draft,synopsis_discuss) | 口语化、潜台词、角色声音、禁对白乒乓；写对白或改书面腔时用。 |
| `webnovel-human` | 人味 / 失控感 | onDemand | 表面去味后仍像说明书时用：非理性、留白、私货。 |
| `webnovel-emotion` | 情绪演出 | onDemand | 喊情绪不演、缺身体反应时用；查情绪→外显对照。 |
| `book-cold-start` | 开书冷启动 | default(synopsis_discuss) | 一句话→绑笔风的风格备选（命名/对话硬字段）→8维落盘→卷大纲；未完成禁正文。 |
| `style-bible` | 项目风格手册与声口 | onDemand | 旁白距离、角色声音矩阵、称呼与禁改平。 |
| `naming-consistency` | 命名称谓一致性 | onDemand | 防撞名、称呼术语前后一致。 |
| `dialogue-subtext` | 对话潜台词与战术话轮 | onDemand | 议程/潜台词/群戏分层；改同声对白。 |
| `style-profile` | 文风剖析协议 | onDemand | 从对标书抽文风手册。 |
| `genre-style-presets` | 题材笔风短预设 | onDemand | 奇幻/言情/悬疑短条，补笔风备选。 |
| `discuss-workflow` | 创作台讨论工作流 | default(synopsis_discuss) | 创作台 outcome/工具/门禁流程；讨论回合默认挂载。 |
| `plot-synopsis` | 梗概与细纲指南 | default(synopsis_discuss) | 写/改梗概或细纲时用。 |
| `settings-revision` | 设定修订指南 | default(synopsis_discuss) | 改设定集、对齐冲突设定时用。 |

## 描写场面卡（工作区）

Auto 模式只注入 `表现输出/描写规则/自动.md` + 感官/去AI味基线；其他场面卡用 `request_read`（`sourceKinds:["rule"]`）或锁定下拉按需加载。
