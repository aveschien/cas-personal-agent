# 飞书消息经 lark-cli 事件总线长连接接收，不部署 webhook

PRD v0.1 假设飞书消息走 webhook，因此要求公网入站端点、签名与 challenge 校验。官方 lark-cli 提供 `event consume <EventKey>` 命令：本地事件总线 daemon 与飞书保持长连接，事件以 NDJSON 流到 stdout，并有明确的子进程契约（stderr ready marker、stdin EOF 即退出、SIGTERM 优雅退出、`message_id` 作为幂等键）。决定：Supervisor 以受管子进程运行 `lark-cli event consume im.message.receive_v1 --as bot`，回复经 `lark-cli im +messages-reply` 发送；不开放任何入站 HTTP 端口，不做签名校验。

## 考虑过的替代

- `@larksuiteoapi/node-sdk` 的 WSClient 长连接：同样免公网，但会引入第二套飞书认证与 SDK；lark-cli 已经是 Bitable 和任务的唯一通道，统一到它上面依赖面最小。
- webhook 经 cloudflared 隧道：VPS 上隧道已存在，可行，但多一个人工配置面（ingress）和一类故障（隧道断）。

## 后果

- 飞书开放平台上应用需开启 Bot 能力并订阅 `im.message.receive_v1`，事件订阅方式选“长连接”。
- 子进程要按 lark-cli 契约管理：不能 `kill -9`（会泄漏服务端订阅），无界运行必须给 stdin 一个不 EOF 的源。
- 微信 Bot 接入时 Channel 接口不变，只是换一个子进程或 SDK 作为事件源。
