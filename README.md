# CAS Personal Agent

单用户、私有部署的个人工作管理 Agent。开发入口提供确定性 NDJSON 闭环；真实入口通过受管的 `lark-cli` Event Channel 接收飞书私聊，由持久化 Pi SDK 会话解释消息，并用 `lark-cli` 回复。所有原始 Event 会先写入 SQLite。

## 本地运行

要求 Node.js 24.14 或更高的 24.x 版本。

```bash
npm install
npm run build
CAS_DATABASE_PATH=./var/cas-agent.sqlite \
CAS_ALLOWED_USER_IDS=dev-user \
npm start
```

进程从 stdin 读取一行一个 JSON 命令，并向 stdout 写回一行 JSON。健康检查：

```json
{"type":"health"}
```

开发模式 Channel Event 示例：

```json
{"type":"event","event":{"sourceMessageId":"message-1","receivedAt":"2026-09-02T17:30:00.000Z","userId":"dev-user","rawText":"把报价页改完","rawPayload":{"event_id":"delivery-1"}}}
```

开发入口使用确定性占位 Interpreter 和无写入 State Adapter，因此不需要飞书、Pi、Bitable 或 Hindsight 凭证。

## 真实飞书 + Pi 运行

先确认 bot 身份和 Pi OAuth 可用：

```bash
lark-cli auth status --json --verify
pi auth check --provider openai-codex --json
```

复制 `.env.example` 为 `.env`，把 `CAS_ALLOWED_USER_IDS` 改成获准使用 Bot 的飞书 `open_id`，然后启动：

```bash
set -a
. ./.env
set +a
npm run build
npm run start:live
```

进程会等待 `lark-cli` 的精确 ready 标记，并在收到 SIGTERM/SIGINT 后优雅关闭事件流、Pi 会话和 SQLite。systemd 模板位于 `deploy/cas-personal-agent.service`。

只验证真实 Pi SDK、受控工具和多轮上下文，不连接飞书：

```bash
npm run verify:pi
```

## 验证

```bash
npm run typecheck
npm test
```
