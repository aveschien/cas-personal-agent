import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createActionOutbox } from "../src/action-outbox.js";
import { createActionWorker } from "../src/action-worker.js";
import type { ActionLinkProjection } from "../src/state-operations.js";

test("a personal Action is created once and its Bitable link is refreshed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cas-action-worker-"));
  const databasePath = join(directory, "events.sqlite");
  const outbox = createActionOutbox(databasePath);
  const action: ActionLinkProjection = {
    key: "proposal-page",
    itemKey: "proposal",
    projectKey: "hospital-proposal",
    title: "完成报价页",
    actionType: "personal_action",
    factOwner: "ticktick",
    deadlineAt: "2026-09-03T23:59:00+08:00",
    syncStatus: "pending",
    sourceEventId: "om_action_1",
  };
  await outbox.schedule(action, "rec_action", "rec_item", "rec_project");
  await outbox.schedule(action, "rec_action", "rec_item", "rec_project");

  const creates: string[] = [];
  const updates: Readonly<Record<string, unknown>>[] = [];
  const worker = createActionWorker({
    databasePath,
    actions: {
      create: async (request) => {
        creates.push(request.idempotencyKey);
        return {
          externalId: "ticktick-task-1",
          projectId: "ticktick-project-1",
          status: "open",
        };
      },
      getState: async () => {
        throw new Error("not used");
      },
    },
    bitable: {
      findByKey: async () => undefined,
      create: async () => {
        throw new Error("not used");
      },
      update: async (_tableId, _recordId, fields) => {
        updates.push(fields);
      },
    },
    actionLinksTableId: "tbl_actions",
  });
  try {
    assert.equal(await worker.runOnce("2026-09-02T12:00:00.000Z"), true);
    assert.equal(await worker.runOnce("2026-09-02T12:00:01.000Z"), false);
    assert.deepEqual(creates, ["ticktick.create:proposal-page"]);
    assert.deepEqual(updates, [
      {
        "外部对象 ID": "ticktick-task-1",
        外部状态镜像: "open",
        最近同步: "2026-09-02T12:00:00.000Z",
        同步状态: ["succeeded"],
      },
    ]);
    const database = new DatabaseSync(databasePath);
    try {
      const row = database
        .prepare(
          `SELECT status, attempt_count FROM outbox
           WHERE operation_type = 'ticktick.create_task'`,
        )
        .get() as unknown as { status: string; attempt_count: number };
      assert.equal(row.status, "succeeded");
      assert.equal(row.attempt_count, 1);
    } finally {
      database.close();
    }
  } finally {
    worker.close();
    outbox.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an Action interrupted while running is recovered after restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cas-action-restart-"));
  const databasePath = join(directory, "events.sqlite");
  const outbox = createActionOutbox(databasePath);
  await outbox.schedule(
    {
      key: "restart-safe-action",
      itemKey: "restart-safe-item",
      title: "恢复个人行动",
      actionType: "personal_action",
      factOwner: "ticktick",
      syncStatus: "pending",
      sourceEventId: "om_action_restart",
    },
    "rec_action_restart",
    "rec_item_restart",
  );
  const database = new DatabaseSync(databasePath);
  database
    .prepare(
      `UPDATE outbox SET status = 'running'
       WHERE operation_type = 'ticktick.create_task'`,
    )
    .run();
  database.close();

  let creates = 0;
  const worker = createActionWorker({
    databasePath,
    actions: {
      create: async () => {
        creates += 1;
        return {
          externalId: "existing-task",
          projectId: "project-1",
          status: "open",
        };
      },
      getState: async () => {
        throw new Error("not used");
      },
    },
    bitable: {
      findByKey: async () => undefined,
      create: async () => {
        throw new Error("not used");
      },
      update: async () => undefined,
    },
    actionLinksTableId: "tbl_actions",
  });
  try {
    assert.equal(await worker.runOnce("2026-09-02T12:00:00.000Z"), true);
    assert.equal(creates, 1);
  } finally {
    worker.close();
    outbox.close();
    await rm(directory, { recursive: true, force: true });
  }
});
