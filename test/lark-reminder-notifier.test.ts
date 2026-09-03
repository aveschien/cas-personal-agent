import assert from "node:assert/strict";
import test from "node:test";

import { createLarkReminderNotifier } from "../src/lark-reminder-notifier.js";

test("reminders are sent as Feishu Markdown with a stable idempotency key", async () => {
  const calls: { command: string; args: readonly string[] }[] = [];
  const notifier = createLarkReminderNotifier({
    userId: "ou_owner",
    runner: {
      run: async (command, args) => {
        calls.push({ command, args });
        return { exitCode: 0, stdout: "{}", stderr: "" };
      },
    },
  });
  await notifier.notify({
    reminderKey: "proposal-review",
    idempotencyKey: "cas-reminder-123",
    itemRecordId: "rec_item",
    fireAt: "2026-09-04T09:00:00+08:00",
    kind: "checkpoint",
    title: "检查方案反馈",
    sourceEventId: "om_source",
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    command: "lark-cli",
    args: [
      "im",
      "+messages-send",
      "--user-id",
      "ou_owner",
      "--markdown",
      "**检查点已到：检查方案反馈**\n\n请确认当前状态和下一步。",
      "--idempotency-key",
      "cas-reminder-123",
      "--as",
      "bot",
    ],
  });
});
