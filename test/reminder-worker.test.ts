import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createReminderStore } from "../src/reminder-store.js";
import { createReminderWorker } from "../src/reminder-worker.js";

test("a due reminder is delivered once and remains fired after restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cas-reminder-worker-"));
  const databasePath = join(directory, "events.sqlite");
  const store = createReminderStore(databasePath);
  const deliveries: string[] = [];
  await store.schedule(
    {
      key: "proposal-review",
      itemKey: "proposal-feedback",
      title: "检查方案反馈",
      fireAt: "2026-09-04T09:00:00+08:00",
      kind: "checkpoint",
      sourceEventId: "om_reminder_worker_1",
    },
    "rec_item_1",
  );
  const worker = createReminderWorker({
    databasePath,
    notifier: {
      notify: async (delivery) => {
        deliveries.push(delivery.idempotencyKey);
      },
    },
  });
  try {
    assert.equal(
      await worker.runOnce("2026-09-04T01:00:00.000Z"),
      true,
    );
    assert.equal(store.get("proposal-review")?.status, "fired");
    assert.equal(deliveries.length, 1);
    assert.match(deliveries[0] ?? "", /^cas-reminder-[a-f0-9]{32}$/);
    assert.equal(
      await worker.runOnce("2026-09-04T01:00:01.000Z"),
      false,
    );
  } finally {
    worker.close();
  }

  const restarted = createReminderWorker({
    databasePath,
    notifier: {
      notify: async () => {
        deliveries.push("duplicate");
      },
    },
  });
  try {
    assert.equal(
      await restarted.runOnce("2026-09-04T01:05:00.000Z"),
      false,
    );
    assert.equal(deliveries.length, 1);
  } finally {
    restarted.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("reminder delivery retries are bounded and become failed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cas-reminder-retry-"));
  const databasePath = join(directory, "events.sqlite");
  const store = createReminderStore(databasePath);
  await store.schedule(
    {
      key: "proposal-deadline",
      itemKey: "proposal",
      title: "完成方案",
      fireAt: "2026-09-03T23:59:00+08:00",
      kind: "deadline",
      sourceEventId: "om_reminder_worker_2",
    },
    "rec_item_2",
  );
  let attempts = 0;
  const worker = createReminderWorker({
    databasePath,
    maxAttempts: 2,
    retryDelayMs: 1,
    notifier: {
      notify: async () => {
        attempts += 1;
        throw new Error("temporary Lark failure");
      },
    },
  });
  try {
    assert.equal(await worker.runOnce("2026-09-03T16:00:00.000Z"), true);
    assert.equal(store.get("proposal-deadline")?.status, "pending");
    assert.equal(await worker.runOnce("2026-09-03T16:00:00.001Z"), true);
    assert.equal(attempts, 2);
    assert.equal(store.get("proposal-deadline")?.status, "failed");
  } finally {
    worker.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
