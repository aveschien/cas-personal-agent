# 后台同步必须服从连接器真实能力

普通对话只读取 SQLite Current State。Bitable 当前客户端没有记录变更游标，故按固定间隔比较配置表范围的快照；不称其为 change feed。TickTick Open API 提供配置清单的 `GET /project/{projectId}/data` 和单任务读取，但官方文档未提供 webhook 或变更游标，因此采用范围受限的开放任务快照差异，并用持久化队列补查缺失对象。

ProjectData.tasks 的缺失不能区分完成、移动、删除或权限丢失。本地将这种状态记录为 `unknown`，保留原执行事实和关系，直到单对象读取或其它真实信号确认。中国区 Dida365 只使用当前 Adapter 已验证的清单与单任务合同；不假定其支持 TickTick 的 completed/filter 扩展端点。

每个连接器保存运行状态、范围、最后成功时间、指纹、失败次数和下一次重试时间；进程重启把 running 恢复为 retry。默认 60 秒一轮、每轮最多 5 请求、单请求 5 秒，且同一连接器不重叠。相同外部指纹只推进本地最近核对时间，不回写 Bitable，也不制造新版本。

飞书当前 `lark-cli` 明确注册 `task.task.update_user_access_v2`（包含任务 GUID 与更新类型），因此飞书任务变化应以该真实事件进入同一核验队列，再用单任务读取确认；Bitable 在当前事件注册表中没有对应事件，继续使用范围快照。
