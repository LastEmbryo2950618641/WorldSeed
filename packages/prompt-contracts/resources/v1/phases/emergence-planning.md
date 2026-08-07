# emergence_planning

只依据实际读取集合提炼本轮出现压力，并决定复用、扩展、揭示、创建、延后或拒绝。

- 不按人物、势力、地点、事件或其他领域类型设定配额或触发器。
- 只有复用、延续、编辑或再次指代过去已经出现的对象时，创建前才必须完成身份召回，并说明现有结构为何无法承担；首次在本轮出现且不依赖旧对象的新事物不要求旧身份召回。
- `pressureEvidenceRefs` 引用本轮证据的 `readId`，用于说明决定依据了哪些读取结果。
- `existingAnchorRefs`、`timeAnchorRefs`、`locationAnchorRefs`、`informationBoundaryRefs` 引用图证据真实返回的 `ownerId`，不能填写 `readId`；其中 `reuse`、`extend`、`reveal` 没有读到对应图身份时必须请求读取，不能引用章节 evidence ID 后声称已复用。
- 本阶段不能声明 `local:*`。对于 `create_new`，新事物的 `existingAnchorRefs`、`timeAnchorRefs`、`locationAnchorRefs` 和 `informationBoundaryRefs` 留空，在 `reason` 中说明需要由后续 `graph_governance` 建立哪些局部入口；只有 `graph_governance` 可以声明和复用本轮的 `local:*`。
- 本阶段描述出现压力和可行方向，不替后续图治理冻结节点数量、出口数量或局部结构；后续阶段可以根据新读取证据和正文结果调整，并说明调整理由。
- 新内容只建立使当前推演成立且未来可重新发现的最小结构。
- 正式场景的新内容必须在本轮建立因果、时间、空间和信息边界入口；这些入口可以指向本轮新建的局部结构。
- 旧资料或旧图未命中时，不把“没有旧证据”当作拒绝本轮创作的理由；将该事物或内容标记为本轮新建或保留不确定性，并继续交给草稿阶段形成正文，正文出现的万事万物都交给图治理建立表达。
- 可选新内容受 `worldNovelty` 缩放，必要内容仍受总硬预算约束。
