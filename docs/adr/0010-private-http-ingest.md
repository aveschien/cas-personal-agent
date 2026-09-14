# 本地回环 HTTP ingest 作为 Grok 入口，飞书长连接仍保留

ADR-0004 决定飞书消息走 `lark-cli event consume` 长连接，不部署 webhook。该约束对飞书入口仍然成立。本 ADR 只增加第二条、与飞书并列的私有注入路径：Grok Bot 经 `POST /v1/ingest` 把 ChannelEvent 送进同一条 `agent.ingest` 流水线。这不是飞书 webhook，也不替代长连接。

HTTP ingest **不经过 Supervisor**。Supervisor 的职责是飞书 Channel → ingest → `lark-cli im +messages-reply`。Grok 没有可用的飞书 `message_id`，若走 Supervisor 会误发飞书回复或因无效 ID 失败。因此 live service 在 Supervisor 之外直接调用 `agent.ingest`，把 JSON acknowledgement 返回给 HTTP 调用方。

## 考虑过的替代

- 把 Grok 流量伪装成飞书 `im.message.receive_v1` 再喂给现有 Channel：会迫使回复走 `lark-cli im +messages-reply`，而 Grok 没有可用的飞书 `message_id`。
- 用 Express / 额外 RPC 框架：当前运行时只有 Node `http` 与受管子进程，新依赖面大于收益。
- 绑定 `0.0.0.0` 并靠隧道暴露：扩大攻击面。默认只绑 `127.0.0.1`，host/port 用环境变量显式覆盖；非 loopback host 会告警，但飞书入口仍继续。

## 后果

- 飞书长连接 ingress 与 `lark-cli` 回复路径保持不变，作为备份入口继续运行。HTTP ingest 绑定失败（端口占用等）只关掉这条注入路径并记录错误，**不得**让 Supervisor / 飞书入口退出。
- HTTP ingest 仅在设置了 `CAS_INGEST_TOKEN` 时启动；鉴权为 `Authorization: Bearer <CAS_INGEST_TOKEN>`，缺省或错误令牌返回 401。
- 默认监听 `127.0.0.1:8787`。`CAS_INGEST_HOST` / `CAS_INGEST_PORT` 可改；不要把未加保护的端口绑到公网。
- `events.source` 从只写 `feishu` 放宽为 `feishu | grok`。Grok 请求体对齐 ChannelEvent（`sourceMessageId`、`receivedAt`、`userId`、`rawText`、`rawPayload`），并写入 `rawPayload.channel = "grok"`。`userId` 仍是飞书 `open_id`，走现有 `CAS_ALLOWED_USER_IDS`。
- Event store 对 `source_message_id` 全局 UNIQUE。HTTP ingest 会把未加前缀的 ID 规范为 `grok:<id>`（已是 `grok:` / `grok-` 开头的保持原样），避免与飞书 `om_*` 等 ID 静默碰撞。
- 飞书 Supervisor/batcher 与 HTTP ingest 共用一个串行队列，同一时刻只跑一个 Pi 回合。HTTP 在队列中等待，默认最多 120 秒（`CAS_INGEST_QUEUE_WAIT_MS`）；超时返回 503 `ingest_busy`，不中断正在进行的飞书回合。
- **回复策略**：Grok 来源只把 JSON acknowledgement 返回给 HTTP 调用方，不发飞书主动私聊，也不要求飞书 `message_id`。飞书来源仍经 Supervisor + `lark-cli` 回复原消息。
- HTTP ingest 不经过飞书消息聚合窗口；每条请求排队后 `agent.ingest` 并同步返回 JSON。
