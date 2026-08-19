# graph_governance_review

审核组合后的候选图，但不要重复输出完整图结构。

- 检查正文中出现的事务是否都被表达，当前状态与历史演化是否同时可返回。
- 对每个 `edit_node` 比较已读当前修订与候选 `next`：候选必须是自包含的最新当前投影，仍然有效的稳定身份、描述和查询入口不能因为本轮只更新了局部状态而无理由消失。旧内容已失效时允许不继承，但必须由修改原因或演化依据支持。
- 检查时间和空间连续性、跨参照对应、精确原文返回、选择性发现、容量与图的简洁性。
- 逐项核对时空锚点的实际用途：允许奇异事物承担锚点，但它必须按当前图含义或局部可达路径真正恢复时间顺序、时间位置或空间位置；仅因节点可读、相关或在场景中出现而充当锚点，应归为 `spacetime` 修订建议。
- 使用 `temporalClaimAssessments` 逐项恰好覆盖依赖审计中的时间断言。结合原文片段、时空结算和实际 Evidence 判断证据是否充分、正文表达是否一致，并用自由文本说明当前叙述语境；不得用固定叙事类型枚举代替理解。
- 时间断言可以返回 `pass`、`uncertain` 或 `conflict`。`responsibility` 只表示问题应由哪个既有阶段修复，不是时间语义分类；`advice` 只向用户说明后续修改方向，不能拒绝正文或图提交。
- 不得因为正文引入了旧资料中不存在的新事务而拒绝；只检查它是否与已知演化和当前状态矛盾。
- 问题必须归属 `structure`、`capacity`、`spacetime` 或 `retrieval`，让执行器只回退对应的小阶段。
- 尚无 `verificationProbeExecutions` 时，必须返回 `outcome=request_read`，由 AI 在 `requestedReads[].verificationProbe` 中定义至少一个通用验证目的、覆盖范围和查询；应用只负责真实执行，不替 AI 发明探针。已有执行记录时，逐项结合其中的 `returnedReadRefs`、`returnedGraphRefs`、`returnedProposalRefs`、`resultDigest` 以及同一请求中的 `readEvidence` 返回 `verificationProbeAssessments`；字段已提供时不得声称“未提供探针执行结果”，也不得虚构额外探针。
- `retrievalGaps` 中的 `system:retrieval-gap` 只表示对应读取或探针本轮没有执行成功；不得为该缺口生成 `verificationProbeAssessment`，更不得给出 `pass`。Token、时间、模型调用或实际读取错误仍由任务恢复协议处理；选择性读取轮次达到上限时，应用会保留缺口并继续后续审核与提交。
- 没有阻断性问题时返回 `pass`。建议不具有拒绝正文提交的权限，结构契约通过后流程继续。
