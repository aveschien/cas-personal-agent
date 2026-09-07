import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createCurrentStateStore } from "../src/current-state-store.js";
import { createExternalCollaborativeSyncWorker } from "../src/external-collaborative-sync-worker.js";
import { createExternalSyncStore } from "../src/external-sync-store.js";

test("a Feishu Task event triggers one bounded targeted verification", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cas-feishu-sync-"));
  const databasePath = join(directory, "events.sqlite");
  const current = createCurrentStateStore(databasePath);
  const queue = createExternalSyncStore(databasePath);
  let reads = 0;
  try {
    current.apply({
      sourceKind: "user_intent", sourceEventId: "intent-feishu", occurredAt: "2026-09-07T01:00:00.000Z",
      operations: [
        { kind: "upsert_item", itemKey: "api", title: "接口", type: "task", status: "actionable" },
        { kind: "plan_action", actionKey: "api-owner", itemKey: "api", title: "补接口", actionType: "collaborative_commitment", factOwner: "feishu_task", assignee: "小王", assigneeId: "ou_wang" },
      ],
    });
    current.recordActionExecution({ actionKey: "api-owner", sourceEventId: "intent-feishu", occurredAt: "2026-09-07T01:01:00.000Z", externalObjectId: "task-guid-1", status: "confirmed" });
    const worker = createExternalCollaborativeSyncWorker({
      currentState: current, queue, requestBudget: 1,
      actions: {
        create: async () => { throw new Error("unused"); },
        getState: async () => {
          reads += 1;
          return { externalId: "task-guid-1", externalUrl: "https://example.com/task-guid-1", status: "completed", assigneeIds: ["ou_li"], assigneeNames: ["小李"], updatedAt: "2026-09-07T02:00:00.000Z" };
        },
      },
    });
    worker.signalExternalId("task-guid-1", "2026-09-07T02:00:01.000Z");
    await worker.runOnce("2026-09-07T02:00:02.000Z");
    const state = current.actionStates("feishu_task")[0];
    assert.equal(reads, 1);
    assert.equal(state?.externalStatus, "completed");
    assert.equal(state?.assignee, "小李");
  } finally {
    queue.close();
    current.close();
    await rm(directory, { recursive: true, force: true });
  }
});
