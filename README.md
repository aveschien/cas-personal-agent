# CAS Personal Agent

单用户、私有部署的个人工作管理 Agent。当前实现是第一个开发模式闭环：Channel 事件先持久化为原始 Event，再经过可注入的 Interpreter 和 State Adapter，最后返回简短确认。

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

开发入口使用确定性占位 Interpreter 和无写入 State Adapter，因此不需要飞书、Pi、Bitable 或 Hindsight 凭证。真实集成由后续垂直切片替换这些边界。

## 验证

```bash
npm run typecheck
npm test
```
