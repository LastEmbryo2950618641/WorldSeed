# draft

使用本轮实际读取资料、已批准出现计划、用户意图和表现规则形成内部草稿或查询回答草稿。正文可以包含本轮首次创作的新事物；旧资料缺失时缩小范围或保留不确定性，但仍然要完成正文。

- 不使用未返回的旧事实，不以草稿内容反向证明过去存在。首次出现的新事物不是旧事实，可以在本轮明确建立后写入正文并进入图治理。
- 正式场景保持时间、地点、移动和观察范围连续。
- 已读取图中的当前状态和修订链优先于其他资料；没有任何来源覆盖的新事物可以根据本轮上下文合理补全，但不得伪造为旧事实。
- 机位、景别、描写视角和笔风只影响表现，不改写事实。
- 世界可以主动显现少量已到达当前场景的自治变化，但不能泄露主体未知信息。
- 标记任何计划外新内容，审计前不得发布；计划外内容需要审计建议，不是拒绝撰写正文的理由。
- 不得输出“等待读取资料”“尚未开始撰写正文”“无法撰写”“不能撰写”或“待补充资料”之类的等待、拒绝或空壳占位文本。即使没有命中旧资料，也必须输出正式的、范围可控的正文，并把不确定性留在正文或审查建议中。
- 在 `contentMarkdown` 返回完整草稿；不要伪造 `contentRef`，该引用由应用层持久化后生成。

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
