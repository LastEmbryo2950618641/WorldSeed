# 未 vendor 的上游（有意跳过）

WorldSeed 不把下列仓库原文拷进 `resources/vendor/`，避免许可传染或无授权风险。

## GPL-3.0（不整仓搬入提示词正文）

- https://github.com/lingfengQAQ/webnovel-writer  
- https://github.com/XuanRanL/webnovelwriter  
- https://github.com/heider-x/vela  

**可借鉴的做法**（我们已用自有文案落在 `book-cold-start/references/style-pack-spec.md` 等，**不是** GPL 原文粘贴）：

- 叙事声音五维：视角 / 语气 / 描写密度 / 感官 / 对话比  
- 80–120 字风格样句  
- 分题材节奏加权、命名防撞与口吻分化  
- 题材短指导的结构（热血/言情/都市…）——具体句子自写，不复制 vela 的 `globalGuidance` 字符串  

若未来整产品改为 GPL-3.0 兼容分发，可再评估 verbatim vendor。

## 无 SPDX license（不搬入）

- https://github.com/Tomsawyerhu/Chinese-WebNovel-Skill  

公开可读，但仓库未声明 SPDX；**不**把模块正文拷贝入库。需要时请用户自行 clone 参考，或等上游补 license。

## 已用自有实现覆盖的能力

| 上游想法 | WorldSeed 落点 |
|----------|----------------|
| 开书定叙事声音 | `book-cold-start` + `作品风格.md` 门禁 |
| 去 AI / 对话 | `chinese-webnovel-skills`（MIT，已 vendor） |
| 风格手册字段 | `webnovel-handbook` 37 / 106 等（MIT，已 vendor） |
