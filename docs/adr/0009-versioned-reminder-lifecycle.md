# Reminder 幂等绑定有效安排版本

Reminder 的稳定 key 标识业务关系，但一次通知的幂等键必须同时包含递增版本。fireAt、类型、内容或来源版本变化时，旧 delivery outbox 立即失效，Reminder 回到 pending，并只在新时间投递一次；重复重放相同版本不增加版本。

事项完成、放弃或归档以及外部 Action 完成会在本地状态事务中取消关联 Reminder，并使已排队旧投递变为 dead。Worker 在通知前再次核对 Reminder 状态/版本、Current State 事项状态和外部状态；外部事实为 unknown 时不发送，而是沿用有界重试等待后台或定向核验。deadline、checkpoint 与 scheduled_event 仍是不同 kind，不推断新时间或提前量。
