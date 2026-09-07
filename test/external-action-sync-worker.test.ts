import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createCurrentStateStore } from "../src/current-state-store.js";
import { createExternalActionSyncWorker } from "../src/external-action-sync-worker.js";
import { createExternalSyncStore } from "../src/external-sync-store.js";

test("configured TickTick snapshot updates changes and verifies missing open tasks without guessing completion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cas-external-sync-"));
  const databasePath = join(directory, "events.sqlite");
  const current = createCurrentStateStore(databasePath);
  let queue = createExternalSyncStore(databasePath);
  const writes: Record<string, unknown>[] = [];
  let targetedFails = true;
  try {
    current.apply({
      sourceKind: "user_intent",
      sourceEventId: "intent-actions",
      occurredAt: "2026-09-07T01:00:00.000Z",
      operations: [
        { kind: "upsert_item", itemKey: "one", title: "一", type: "task", status: "actionable" },
        { kind: "upsert_item", itemKey: "two", title: "二", type: "task", status: "actionable" },
        { kind: "plan_action", actionKey: "present", itemKey: "one", title: "旧标题", actionType: "personal_action", factOwner: "ticktick" },
        { kind: "plan_action", actionKey: "missing", itemKey: "two", title: "待确认", actionType: "personal_action", factOwner: "ticktick" },
      ],
    });
    current.bindRecord("action_link", "present", "rec-present", "2026-09-07T01:01:00.000Z");
    current.bindRecord("action_link", "missing", "rec-missing", "2026-09-07T01:01:00.000Z");
    current.recordActionExecution({ actionKey: "present", sourceEventId: "intent-actions", occurredAt: "2026-09-07T01:02:00.000Z", externalObjectId: "task-present", status: "confirmed" });
    current.recordActionExecution({ actionKey: "missing", sourceEventId: "intent-actions", occurredAt: "2026-09-07T01:02:00.000Z", externalObjectId: "task-missing", status: "confirmed" });

    const worker = createExternalActionSyncWorker({
      currentState: current,
      queue,
      projectId: "configured-list",
      requestBudget: 2,
      personal: {
        create: async () => { throw new Error("unused"); },
        listProjectSnapshot: async () => [{
          externalId: "task-present", projectId: "configured-list", status: "open",
          title: "手机端改期", deadlineAt: "2026-09-10T09:00:00.000Z", updatedAt: "2026-09-07T02:00:00.000Z",
        }],
        getState: async () => {
          if (targetedFails) throw new Error("temporarily disconnected");
          return { externalId: "task-missing", projectId: "configured-list", status: "completed", updatedAt: "2026-09-07T02:30:00.000Z" };
        },
      },
      bitable: {
        findByKey: async () => undefined,
        create: async () => { throw new Error("unused"); },
        update: async (_table, _record, fields) => { writes.push(fields); },
      },
      actionLinksTableId: "tbl-actions",
    });

    assert.equal(await worker.runOnce("2026-09-07T03:00:00.000Z"), true);
    assert.equal(current.actionStates("ticktick").find((state) => state.actionKey === "present")?.deadlineAt, "2026-09-10T09:00:00.000Z");
    const uncertain = current.actionStates("ticktick").find((state) => state.actionKey === "missing");
    assert.equal(uncertain?.externalStatus, "unknown");
    assert.match(uncertain?.uncertaintyReason ?? "", /completion, move, deletion/);
    assert.equal(writes.length, 1);

    queue.close();
    queue = createExternalSyncStore(databasePath);
    targetedFails = false;
    const resumed = createExternalActionSyncWorker({
      currentState: current, queue, projectId: "configured-list", requestBudget: 2,
      personal: {
        create: async () => { throw new Error("unused"); },
        listProjectSnapshot: async () => [{ externalId: "task-present", projectId: "configured-list", status: "open", title: "手机端改期", deadlineAt: "2026-09-10T09:00:00.000Z", updatedAt: "2026-09-07T02:00:00.000Z" }],
        getState: async () => ({ externalId: "task-missing", projectId: "configured-list", status: "completed", updatedAt: "2026-09-07T02:30:00.000Z" }),
      },
    });
    await resumed.runOnce("2026-09-07T03:00:06.000Z");
    assert.equal(current.actionStates("ticktick").find((state) => state.actionKey === "missing")?.externalStatus, "completed");
    assert.equal(current.recordExternalActionState({
      actionKey: "missing", observedAt: "2026-09-07T03:01:00.000Z",
      sourceUpdatedAt: "2026-09-07T02:00:00.000Z", fingerprint: "late-old-open", status: "open",
    }), false);
    assert.equal(current.actionStates("ticktick").find((state) => state.actionKey === "missing")?.externalStatus, "completed");

    const database = new DatabaseSync(databasePath);
    const sync = database.prepare("SELECT status, last_succeeded_at FROM connector_sync_state WHERE connector = 'ticktick'").get() as { status: string; last_succeeded_at: string };
    const verification = database.prepare("SELECT status, attempt_count FROM verification_queue WHERE entity_key = 'missing'").get() as { status: string; attempt_count: number };
    assert.deepEqual({ ...sync }, { status: "idle", last_succeeded_at: "2026-09-07T03:00:06.000Z" });
    assert.deepEqual({ ...verification }, { status: "succeeded", attempt_count: 2 });
    database.close();
  } finally {
    queue.close();
    current.close();
    await rm(directory, { recursive: true, force: true });
  }
});
