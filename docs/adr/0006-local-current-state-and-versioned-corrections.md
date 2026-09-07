# SQLite Current State 是统一本地读模型

项目、事项与行动挂载在 SQLite 中保存可直接查询、可重启恢复的 Current State，同时保留 Bitable、滴答和飞书任务各自的 Fact Owner。Bitable 仍是项目与事项的可编辑展示面；SQLite 副本不把“本地已记录请求”冒充成“外部执行已确认”。

聊天指令、外部人工纠正与执行结果通过同一版本化应用边界进入。每个实体保存稳定 key、外部 record ID、来源、发生时间、递增 revision 和本地/待投影/已确认状态；变更历史追加保存。upsert 采用补丁语义：省略字段保持当前值，显式 `null` 才清空；离开 waiting 时只清理等待专属字段。

幂等键阻止同一操作重复生效；带旧 `base_revision` 或早于当前有效来源时间的输入会记录为拒绝版本而不修改 Current State。这样，人工完成后用户明确重新开始可以产生新版本，而随后重放的旧 waiting 操作不能倒退状态。复杂字段级自动合并不在本轮范围内，真实冲突留给最小澄清或定向核对。

现有 Bitable Project、Item、Action Link 在启动迁移时按稳定 key 和 record ID 幂等导入，不修改远端记录。schema migration 只新增表，保留 Event、Pi session、outbox 和 reminder。
