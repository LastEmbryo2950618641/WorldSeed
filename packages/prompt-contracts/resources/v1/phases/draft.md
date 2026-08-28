# draft

使用本轮实际读取资料、已批准出现计划、用户意图和表现规则形成内部草稿或查询回答草稿。正文可以包含本轮首次创作的新事物；旧资料缺失时缩小范围或保留不确定性，但仍然要完成正文。

- 遵守本轮阶段指令末尾的 **「推演发散程度」**：严格模式下不得发明未在已读设定/证据中出现的新设定；默认与自由模式允许按策略建立新设定性内容，并由后续设定抽取经用户确认后写入。
- 不使用未返回的旧事实，不以草稿内容反向证明过去存在。首次出现的新事物不是旧事实，可以在本轮明确建立后写入正文并进入图治理（仍受上方发散程度约束）。
- 正式场景保持时间、地点、移动和观察范围连续。
- 已读取图中的当前状态和修订链优先于其他资料；不同所有者的当前证据冲突时，使用 `committedSequence` 识别更晚提交的世界状态，同时服从已读故事内时间锚点，不得把较旧计划误写成当前状态。没有任何来源覆盖的新事物可以根据本轮上下文合理补全，但不得伪造为旧事实。
- 从旧章节或其他不可变来源继续时，只有 `sourcePosition.isEnd=true` 的原文证据可被当作该来源的物理末端。语义命中的开篇或中段不能冒充结尾；末端缺失时先请求来源边界，再结合当前图状态与故事时空决定续写入口。
- 机位、景别、描写视角和笔风只影响表现，不改写事实。
- 世界可以主动显现少量已到达当前场景的自治变化，但不能泄露主体未知信息。
- 标记任何计划外新内容，审计前不得发布；计划外内容需要审计建议，不是拒绝撰写正文的理由。
- 不得输出“等待读取资料”“尚未开始撰写正文”“无法撰写”“不能撰写”或“待补充资料”之类的等待、拒绝或空壳占位文本。即使没有命中旧资料，也必须输出正式的、范围可控的正文，并把不确定性留在正文或审查建议中。
- 在 `contentMarkdown` 返回完整草稿；不要伪造 `contentRef`，该引用由应用层持久化后生成。
- 查询工作流若提供 `revisionFeedback`，说明上一版回答未通过只读回答复核。必须逐项修正其中的 `outcome`、`artifact`、`reason` 与 `selfReview` 所指出的问题，重新核对本轮 `readEvidence`，不得原样返回被否决的旧答案。

Draft artifact 的字段必须全部位于顶层结果的 `artifact` 对象内，不能与 `outcome`、`requestedReads`、`citedReadIds`、`reason` 或 `selfReview` 并列。完整形状如下：

```json
{
  "outcome": "continue",
  "artifact": {
    "contentMarkdown": "正文草稿",
    "adoptedDecisionIndexes": [],
    "currentTimeAnchorRefs": [],
    "currentLocationAnchorRefs": [],
    "detectedUnplannedContent": []
  },
  "requestedReads": [],
  "citedReadIds": [],
  "unresolvedDependencies": [],
  "reason": "草稿已根据本轮实际读取资料形成",
  "selfReview": "已检查时间、地点和计划外内容"
}
```

尤其不要输出如下错误形状：`{"artifact":{"contentMarkdown":"..."},"adoptedDecisionIndexes":[],"currentTimeAnchorRefs":[],"currentLocationAnchorRefs":[],"detectedUnplannedContent":[]}`。这四个字段必须移动到 `artifact` 内，而不是放在结果顶层。
