import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createReminderStore } from "../src/reminder-store.js";
import { createReminderWorker } from "../src/reminder-worker.js";
import { createCurrentStateStore } from "../src/current-state-store.js";

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

test("a fired checkpoint rescheduled under the same key fires once at the new version", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cas-reminder-reschedule-"));
  const databasePath = join(directory, "events.sqlite");
  const store = createReminderStore(databasePath);
  const deliveries: string[] = [];
  const worker = createReminderWorker({ databasePath, notifier: { notify: async (delivery) => { deliveries.push(delivery.idempotencyKey); } } });
  try {
    await store.schedule({ key: "same-checkpoint", itemKey: "item", title: "旧检查点", fireAt: "2026-09-07T01:00:00.000Z", kind: "checkpoint", sourceEventId: "old" }, "rec-item");
    await worker.runOnce("2026-09-07T01:00:00.000Z");
    assert.equal(store.get("same-checkpoint")?.status, "fired");
    await store.schedule({ key: "same-checkpoint", itemKey: "item", title: "新检查点", fireAt: "2026-09-08T01:00:00.000Z", kind: "checkpoint", sourceEventId: "new" }, "rec-item");
    assert.equal(store.get("same-checkpoint")?.status, "pending");
    assert.equal(await worker.runOnce("2026-09-07T02:00:00.000Z"), false);
    assert.equal(await worker.runOnce("2026-09-08T01:00:00.000Z"), true);
    assert.equal(deliveries.length, 2);
    assert.notEqual(deliveries[0], deliveries[1]);
  } finally {
    worker.close(); store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("completion cancellation invalidates an already queued old delivery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cas-reminder-cancel-"));
  const databasePath = join(directory, "events.sqlite");
  const store = createReminderStore(databasePath);
  let attempts = 0;
  const worker = createReminderWorker({ databasePath, retryDelayMs: 1, notifier: { notify: async () => { attempts += 1; throw new Error("offline"); } } });
  try {
    await store.schedule({ key: "cancel-me", itemKey: "item", title: "不应再催", fireAt: "2026-09-07T01:00:00.000Z", kind: "deadline", sourceEventId: "old" }, "rec-item");
    await worker.runOnce("2026-09-07T01:00:00.000Z");
    store.cancelForItem("rec-item", "item completed", "2026-09-07T01:00:00.001Z");
    assert.equal(store.get("cancel-me")?.status, "cancelled");
    assert.equal(await worker.runOnce("2026-09-07T01:00:00.002Z"), false);
    assert.equal(attempts, 1);
  } finally {
    worker.close(); store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a deadline waits for an unknown external fact and sends after targeted verification", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cas-reminder-verify-"));
  const databasePath = join(directory, "events.sqlite");
  const current = createCurrentStateStore(databasePath);
  const store = createReminderStore(databasePath);
  let deliveries = 0;
  const verification: string[] = [];
  try {
    current.apply({ sourceKind: "user_intent", sourceEventId: "deadline-intent", occurredAt: "2026-09-07T00:00:00.000Z", operations: [
      { kind: "upsert_item", itemKey: "deadline-item", title: "外部截止", type: "task", status: "actionable" },
      { kind: "plan_action", actionKey: "deadline-action", itemKey: "deadline-item", title: "外部截止", actionType: "personal_action", factOwner: "ticktick", deadlineAt: "2026-09-07T01:00:00.000Z" },
    ] });
    current.bindRecord("item", "deadline-item", "rec-deadline-item", "2026-09-07T00:01:00.000Z");
    current.recordActionExecution({ actionKey: "deadline-action", sourceEventId: "deadline-intent", occurredAt: "2026-09-07T00:02:00.000Z", externalObjectId: "task-1", status: "confirmed" });
    await store.schedule({ key: "deadline-action-deadline", itemKey: "deadline-item", title: "外部截止", fireAt: "2026-09-07T01:00:00.000Z", kind: "deadline", sourceEventId: "deadline-intent" }, "rec-deadline-item");
    const worker = createReminderWorker({ databasePath, retryDelayMs: 1, notifier: { notify: async () => { deliveries += 1; } }, onVerificationNeeded: (action) => verification.push(action.actionKey) });
    try {
      await worker.runOnce("2026-09-07T01:00:00.000Z");
      assert.equal(deliveries, 0);
      assert.deepEqual(verification, ["deadline-action"]);
      assert.equal(store.get("deadline-action-deadline")?.status, "pending");
      current.recordExternalActionState({ actionKey: "deadline-action", observedAt: "2026-09-07T01:00:00.001Z", fingerprint: "verified-open", status: "open" });
      await worker.runOnce("2026-09-07T01:00:00.002Z");
      assert.equal(deliveries, 1);
      current.recordExternalActionState({
        actionKey: "deadline-action", observedAt: "2026-09-07T01:00:00.003Z",
        fingerprint: "mobile-reschedule", status: "open", deadlineAt: "2026-09-08T01:00:00.000Z",
      });
      assert.equal(store.get("deadline-action-deadline")?.status, "pending");
      assert.equal(store.get("deadline-action-deadline")?.fireAt, "2026-09-08T01:00:00.000Z");
      assert.equal(await worker.runOnce("2026-09-07T02:00:00.000Z"), false);
      assert.equal(await worker.runOnce("2026-09-08T01:00:00.000Z"), true);
      assert.equal(deliveries, 2);
    } finally { worker.close(); }
  } finally {
    store.close(); current.close();
    await rm(directory, { recursive: true, force: true });
  }
});
