# Vendor 笔风 / 文风资料

第三方提示词与写法参考。**许可不允许的不入库**；已入库的保持原文（仅必要时摘 YAML frontmatter）。

| 来源 | SPDX | 本仓状态 | 用途 |
|------|------|----------|------|
| [tance-mang/chinese-webnovel-skills](https://github.com/tance-mang/chinese-webnovel-skills) | MIT | `chinese-webnovel-skills/` | 去 AI / 对话 / 人味 / 情绪 |
| [miserylee/webnovel-handbook](https://github.com/miserylee/webnovel-handbook) | MIT | `webnovel-handbook/` | 风格手册、命名、叙事声音、对话潜台词 |
| [zenstory-ai/oh-story-claudecode](https://github.com/zenstory-ai/oh-story-claudecode) | MIT | `oh-story-claudecode/` | 文风剖析协议、对话操作手册 |
| [voocel/ainovel-cli](https://github.com/voocel/ainovel-cli) | Apache-2.0 | `ainovel-cli/` | 题材 style 短预设 + anti-ai-tone |
| [lingfengQAQ/webnovel-writer](https://github.com/lingfengQAQ/webnovel-writer) 等 | **GPL-3.0** | **未搬入** | 见 `NOT-VENDORED.md` |
| [heider-x/vela](https://github.com/heider-x/vela) | **GPL-3.0** | **未搬入** | 见 `NOT-VENDORED.md` |
| [Tomsawyerhu/Chinese-WebNovel-Skill](https://github.com/Tomsawyerhu/Chinese-WebNovel-Skill) | **无 SPDX** | **未搬入** | 见 `NOT-VENDORED.md` |

平台 skill 通过 `skill-registry` / `load_skill` 按需挂载；开书冷启动细则见 `resources/skills/book-cold-start/`。
