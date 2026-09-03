import assert from "node:assert/strict";
import test from "node:test";

import {
  createBitableStateProjector,
  type BitableRecordClient,
} from "../src/bitable-state-projector.js";
import type { SemanticOperation } from "../src/state-operations.js";

test("typed state operations upsert linked Bitable records idempotently", async () => {
  const records = new Map<
    string,
    Map<string, { recordId: string; fields: Record<string, unknown> }>
  >();
  let nextId = 1;
  const client: BitableRecordClient = {
    findByKey: async (tableId, keyField, key) =>
      records.get(tableId)?.get(`${keyField}:${key}`),
    create: async (tableId, keyField, key, fields) => {
      const record = { recordId: `rec_${nextId++}`, fields: { ...fields } };
      const table = records.get(tableId) ?? new Map();
      table.set(`${keyField}:${key}`, record);
      records.set(tableId, table);
      return record;
    },
    update: async (tableId, recordId, fields) => {
      const record = [...(records.get(tableId)?.values() ?? [])].find(
        (candidate) => candidate.recordId === recordId,
      );
      assert.ok(record);
      Object.assign(record.fields, fields);
    },
  };
  const reminders = new Map<string, unknown>();
  const projector = createBitableStateProjector({
    client,
    tables: {
      projects: "tbl_projects",
      items: "tbl_items",
      actionLinks: "tbl_actions",
    },
    reminders: {
      schedule: async (checkpoint) => {
        reminders.set(checkpoint.key, checkpoint);
      },
    },
  });
  const operations: SemanticOperation[] = [
    {
      kind: "upsert_project",
      projectKey: "hospital-proposal",
      name: "院方方案",
      status: "tracking",
      phase: "方案",
    },
    {
      kind: "upsert_item",
      itemKey: "proposal-feedback",
      projectKey: "hospital-proposal",
      title: "等待方案反馈",
      type: "task",
      status: "waiting",
    },
    {
      kind: "set_waiting",
      itemKey: "proposal-feedback",
      waitingFor: "张总反馈",
      releaseCondition: "收到明确反馈",
      checkpointAt: "2026-09-04T09:00:00+08:00",
      contingency: "若无反馈则联系张总",
    },
    {
      kind: "plan_action",
      actionKey: "proposal-follow-up",
      itemKey: "proposal-feedback",
      projectKey: "hospital-proposal",
      title: "联系张总",
      actionType: "personal_action",
      factOwner: "ticktick",
      deadlineAt: "2026-09-04T17:00:00+08:00",
    },
    {
      kind: "schedule_checkpoint",
      reminderKey: "proposal-review",
      itemKey: "proposal-feedback",
      fireAt: "2026-09-04T09:00:00+08:00",
    },
  ];

  await projector.project({ sourceEventId: "om_projection_1", operations });
  await projector.project({ sourceEventId: "om_projection_1", operations });

  assert.equal(records.get("tbl_projects")?.size, 1);
  assert.equal(records.get("tbl_items")?.size, 1);
  assert.equal(records.get("tbl_actions")?.size, 1);
  const project = records
    .get("tbl_projects")
    ?.get("project_key:hospital-proposal");
  const item = records.get("tbl_items")?.get("item_key:proposal-feedback");
  const action = records
    .get("tbl_actions")
    ?.get("action_key:proposal-follow-up");
  assert.deepEqual(item?.fields, {
    事项: "等待方案反馈",
    状态: ["等待"],
    类型: ["任务"],
    项目: [{ id: project?.recordId }],
    下一步: null,
    当前摘要: null,
    在等什么: "张总反馈",
    解除条件: "收到明确反馈",
    检查点: "2026-09-04T09:00:00+08:00",
    "条件/预案": "若无反馈则联系张总",
    稍后区: false,
    item_key: "proposal-feedback",
    来源事件: "om_projection_1",
    created_by_agent: true,
  });
  assert.deepEqual(action?.fields, {
    行动: "联系张总",
    行动类型: ["个人行动"],
    事实源: ["滴答"],
    所属项目: [{ id: project?.recordId }],
    所属事项: [{ id: item?.recordId }],
    负责人: null,
    deadline: "2026-09-04T17:00:00+08:00",
    开始时间: null,
    结束时间: null,
    同步状态: ["pending"],
    action_key: "proposal-follow-up",
    idempotency_key: "om_projection_1:proposal-follow-up",
    来源事件: "om_projection_1",
  });
  assert.equal(reminders.size, 2);

  await projector.project({
    sourceEventId: "om_projection_2",
    operations: [
      {
        kind: "upsert_item",
        itemKey: "proposal-feedback",
        title: "处理方案反馈",
        type: "task",
        status: "actionable",
        nextAction: "阅读反馈并决定下一步",
      },
    ],
  });

  assert.deepEqual(
    records.get("tbl_items")?.get("item_key:proposal-feedback")?.fields,
    {
      事项: "处理方案反馈",
      状态: ["可行动"],
      类型: ["任务"],
      项目: [],
      下一步: "阅读反馈并决定下一步",
      当前摘要: null,
      在等什么: null,
      解除条件: null,
      检查点: null,
      "条件/预案": null,
      稍后区: false,
      item_key: "proposal-feedback",
      来源事件: "om_projection_2",
      created_by_agent: true,
    },
  );
});
