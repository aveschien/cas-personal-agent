import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createCollaborativeActionOutbox } from "../src/collaborative-action-outbox.js";
import { createCollaborativeActionWorker } from "../src/collaborative-action-worker.js";
import type { ActionLinkProjection } from "../src/state-operations.js";

test("a resolved collaborative commitment is created once and linked back", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cas-collaborative-action-"));
  const databasePath = join(directory, "events.sqlite");
  const outbox = createCollaborativeActionOutbox(databasePath);
  const action: ActionLinkProjection = {
    key: "api-inventory",
    itemKey: "api-inventory-item",
    projectKey: "platform-project",
    title: "补充接口清单",
    actionType: "collaborative_commitment",
    factOwner: "feishu_task",
    assignee: "小王",
    assigneeId: "ou_xiaowang",
    deadlineAt: "2026-09-04T17:00:00+08:00",
    syncStatus: "pending",
    sourceEventId: "om_collaborative_1",
  };
  await outbox.schedule(action, "rec_action", "rec_item", "rec_project");
  await outbox.schedule(action, "rec_action", "rec_item", "rec_project");

  const creates: string[] = [];
  const updates: Readonly<Record<string, unknown>>[] = [];
  const worker = createCollaborativeActionWorker({
    databasePath,
    actions: {
      create: async (request) => {
        creates.push(request.idempotencyKey);
        assert.equal(request.assigneeId, "ou_xiaowang");
        return {
          externalId: "task-guid-1",
          externalUrl:
            "https://applink.feishu.cn/client/todo/detail?guid=task-guid-1",
          status: "open",
          assigneeIds: ["ou_xiaowang"],
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
    assert.deepEqual(creates, ["feishu_task.create:api-inventory"]);
    assert.deepEqual(updates, [
      {
        "外部对象 ID": "task-guid-1",
        外部链接:
          "https://applink.feishu.cn/client/todo/detail?guid=task-guid-1",
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
           WHERE operation_type = 'feishu_task.create_task'`,
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

test("an unresolved collaborative commitment never reaches the outbox", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cas-unresolved-action-"));
  const databasePath = join(directory, "events.sqlite");
  const outbox = createCollaborativeActionOutbox(databasePath);
  try {
    await assert.rejects(
      outbox.schedule(
        {
          key: "unresolved",
          itemKey: "unresolved-item",
          title: "不要创建",
          actionType: "collaborative_commitment",
          factOwner: "feishu_task",
          assignee: "小王",
          syncStatus: "pending",
          sourceEventId: "om_unresolved",
        },
        "rec_action",
        "rec_item",
      ),
      /uniquely resolved assignee/,
    );
    const database = new DatabaseSync(databasePath);
    try {
      const row = database
        .prepare(
          `SELECT COUNT(*) AS count FROM outbox
           WHERE operation_type = 'feishu_task.create_task'`,
        )
        .get() as unknown as { count: number };
      assert.equal(row.count, 0);
    } finally {
      database.close();
    }
  } finally {
    outbox.close();
    await rm(directory, { recursive: true, force: true });
  }
});
