# CAS Personal Agent

单用户、私有部署的个人工作管理 Agent。开发入口提供确定性 NDJSON 闭环；真实入口通过受管的 `lark-cli` Event Channel 接收飞书私聊，由持久化 Pi SDK 会话解释消息，并用 `lark-cli` 回复。所有原始 Event 会先写入 SQLite，再通过类型化语义操作投影到飞书多维表格。

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

复制 `.env.example` 为 `.env`，配置获准使用 Bot 的飞书 `open_id` 和三个多维表格 ID，然后启动：

```bash
set -a
. ./.env
set +a
npm run build
npm run start:live
```

进程会等待 `lark-cli` 的精确 ready 标记，并在收到 SIGTERM/SIGINT 后优雅关闭事件流、Pi 会话和 SQLite。systemd 模板位于 `deploy/cas-personal-agent.service`。

当前开发 Base 是 [CAS Personal Agent](https://scnnyorf7h0o.feishu.cn/base/ALm5bispqak1uVsw4uwcJbYxnhe)，包含“项目”“事项”“行动同步”三张表。固定时间安排写成 Bitable 自有的日程事项；截止时间和检查点分别保留为行动截止与事项复查时间。个人行动目前仅以干跑计划写入“行动同步”，不会真实创建滴答或飞书任务。

只验证真实 Pi SDK、受控工具和多轮上下文，不连接飞书：

```bash
npm run verify:pi
```

验证真实 Base 的幂等投影和关联字段：

```bash
set -a
. ./.env
set +a
npm run verify:bitable
```

验证真实 Pi 对混合输入的语义拆分、可逆默认和最小澄清：

```bash
set -a
. ./.env
set +a
npm run verify:mixed
```

## Hindsight 长期记忆

生产配置默认启用记忆。每回合在 Pi 之前执行最多 5 条、800 token、2 秒超时的轻量 recall；失败会静默降级。Pi 只能提出明确纠正、长期偏好/边界、重要决定或项目变化、行动结果和 Handoff 等高价值候选。候选与 Event 完成在同一个 SQLite 事务中进入 outbox，随后用稳定的 Hindsight `operation_id` 异步 retain，最多尝试 5 次。原始消息仍只完整保存在 SQLite。

VPS 使用现有 PostgreSQL 16，不启用 pg0。一次性准备步骤：

```bash
uv tool install hindsight-api-slim==0.9.2
sudo -u postgres createuser --pwprompt hindsight
sudo -u postgres createdb --owner hindsight hindsight
sudo -u postgres psql --dbname hindsight --command 'CREATE EXTENSION IF NOT EXISTS vector;'
mkdir -p ./var/hindsight-codex
cp .env.hindsight.example .env.hindsight
chmod 600 .env.hindsight
```

在 `.env.hindsight` 中填写独立数据库密码、Cloudflare account ID 和最小权限 token；不要把真实凭据提交到 Git。Hindsight 使用独立的 Codex OAuth 目录，按当前 Codex CLI 完成一次设备授权：

```bash
CODEX_HOME="$PWD/var/hindsight-codex" codex login --device-auth
```

授权完成后安装并启动服务：

```bash
sudo install -m 0644 deploy/hindsight-api.service /etc/systemd/system/hindsight-api.service
sudo systemctl daemon-reload
sudo systemctl enable --now hindsight-api.service
sudo systemctl status hindsight-api.service
```

该服务只绑定 `127.0.0.1:8888`，MCP 关闭，API 进程数固定为 1，并使用 Hindsight 默认的内置后台 worker；这个单实例原型不需要另起 `hindsight-worker` 服务。

验证真实 Pi 的高价值候选筛选，不连接 Hindsight：

```bash
npm run verify:memory-candidate
```

Hindsight ready 后，在隔离的 smoke bank 中执行一次真实异步 retain 与跨客户端 recall：

```bash
set -a
. ./.env
set +a
npm run verify:memory
```

## 验证

```bash
npm run typecheck
npm test
```
