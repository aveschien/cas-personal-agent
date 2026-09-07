import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { createCurrentStateStore } from "../src/current-state-store.js";
import { initializeStorage } from "../src/storage.js";

test("Current State keeps omitted fields, supports explicit clearing, and rejects stale replay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cas-current-state-"));
  const databasePath = join(directory, "events.sqlite");
  let store = createCurrentStateStore(databasePath);
  try {
    store.apply({
      sourceKind: "user_intent",
      sourceEventId: "event-waiting",
      occurredAt: "2026-09-07T01:00:00.000Z",
      operations: [
        {
          kind: "upsert_item",
          itemKey: "proposal-feedback",
          title: "院方报价反馈",
          type: "task",
          status: "waiting",
          projectKey: "hospital-proposal",
          nextAction: "整理反馈",
          summary: "报价已发给院方",
        },
        {
          kind: "set_waiting",
          itemKey: "proposal-feedback",
          waitingFor: "院方回复",
          releaseCondition: "收到明确意见",
          checkpointAt: "2026-09-08T09:00:00+08:00",
        },
      ],
    });

    store.apply({
      sourceKind: "external_correction",
      sourceEventId: "bitable-completed-v2",
      occurredAt: "2026-09-07T02:00:00.000Z",
      baseRevisions: { "item:proposal-feedback": 1 },
      operations: [{
        kind: "upsert_item",
        itemKey: "proposal-feedback",
        title: "院方报价反馈",
        type: "task",
        status: "completed",
      }],
    });

    store.apply({
      sourceKind: "user_intent",
      sourceEventId: "event-reopen",
      occurredAt: "2026-09-07T03:00:00.000Z",
      baseRevisions: { "item:proposal-feedback": 2 },
      operations: [{
        kind: "upsert_item",
        itemKey: "proposal-feedback",
        title: "院方报价反馈",
        type: "task",
        status: "in_progress",
      }],
    });

    store.apply({
      sourceKind: "external_correction",
      sourceEventId: "late-old-waiting",
      occurredAt: "2026-09-07T01:30:00.000Z",
      baseRevisions: { "item:proposal-feedback": 1 },
      operations: [{
        kind: "upsert_item",
        itemKey: "proposal-feedback",
        title: "院方报价反馈",
        type: "task",
        status: "waiting",
      }],
    });

    const current = store.snapshot().items[0];
    assert.deepEqual(current, {
      key: "proposal-feedback",
      title: "院方报价反馈",
      type: "task",
      status: "in_progress",
      projectKey: "hospital-proposal",
      nextAction: "整理反馈",
      summary: "报价已发给院方",
      waitingFor: null,
      releaseCondition: null,
      checkpointAt: null,
      contingency: null,
      sourceEventId: "event-reopen",
    });
    assert.deepEqual(
      store.versions("item", "proposal-feedback").map((version) => ({
        sourceEventId: version.sourceEventId,
        revision: version.revision,
        applied: version.applied,
      })),
      [
        { sourceEventId: "event-waiting", revision: 1, applied: true },
        { sourceEventId: "bitable-completed-v2", revision: 2, applied: true },
        { sourceEventId: "event-reopen", revision: 3, applied: true },
        { sourceEventId: "late-old-waiting", revision: 3, applied: false },
      ],
    );

    store.apply({
      sourceKind: "user_intent",
      sourceEventId: "event-clear-next",
      occurredAt: "2026-09-07T04:00:00.000Z",
      operations: [{
        kind: "upsert_item",
        itemKey: "proposal-feedback",
        title: "院方报价反馈",
        type: "task",
        status: "in_progress",
        nextAction: null,
      }],
    });
    assert.equal(store.snapshot().items[0]?.projectKey, "hospital-proposal");
    assert.equal(store.snapshot().items[0]?.summary, "报价已发给院方");
    assert.equal(store.snapshot().items[0]?.nextAction, null);

    store.close();
    store = createCurrentStateStore(databasePath);
    assert.equal(store.snapshot().items[0]?.status, "in_progress");
    assert.equal(store.snapshot().items[0]?.summary, "报价已发给院方");
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Bitable Project, Item, and Action Link migrate idempotently with stable links", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cas-current-migration-"));
  const store = createCurrentStateStore(join(directory, "events.sqlite"));
  const reconciliation = {
    projects: [],
    items: [],
    currentProjects: [{
      recordId: "rec_project",
      projectKey: "hospital-proposal",
      name: "院方报价",
      status: "在跟",
      summary: "等待确认",
      correctedFields: [],
    }],
    currentItems: [{
      recordId: "rec_item",
      itemKey: "proposal-feedback",
      title: "院方反馈",
      projectKey: "hospital-proposal",
      type: "任务",
      status: "可行动",
      nextAction: "整理修改项",
      parked: false,
      correctedFields: [],
    }],
    memoryCandidates: [],
  } as const;
  const actionRecords = [
    {
      recordId: "rec_action",
      fields: {
        action_key: "revise-proposal",
        行动: "修改报价",
        行动类型: ["个人行动"],
        事实源: ["滴答"],
        所属项目: [{ id: "rec_project" }],
        所属事项: [{ id: "rec_item" }],
        "外部对象 ID": "ticktick-42",
        外部状态镜像: "open",
      },
    },
    {
      recordId: "rec_collaborative",
      fields: {
        action_key: "review-proposal",
        行动: "请同事复核报价",
        行动类型: ["协同承诺"],
        事实源: ["飞书任务"],
        所属项目: [{ id: "rec_project" }],
        所属事项: [{ id: "rec_item" }],
        负责人: "小王",
        "外部对象 ID": "feishu-task-7",
        外部状态镜像: "open",
      },
    },
  ];
  try {
    store.importBitable(reconciliation, "2026-09-07T01:00:00.000Z", actionRecords);
    store.importBitable(reconciliation, "2026-09-07T02:00:00.000Z", actionRecords);
    const snapshot = store.snapshot();
    assert.equal(snapshot.projects[0]?.key, "hospital-proposal");
    assert.equal(snapshot.items[0]?.projectKey, "hospital-proposal");
    assert.deepEqual(snapshot.actionLinks.find((action) => action.key === "revise-proposal"), {
      key: "revise-proposal",
      itemKey: "proposal-feedback",
      projectKey: "hospital-proposal",
      title: "修改报价",
      actionType: "personal_action",
      factOwner: "ticktick",
      syncStatus: "pending",
      sourceEventId: "bitable-action:rec_action",
    });
    const collaborative = snapshot.actionLinks.find((action) => action.key === "review-proposal");
    assert.equal(collaborative?.factOwner, "feishu_task");
    assert.equal(collaborative?.assignee, "小王");
    assert.equal(store.versions("action_link", "revise-proposal").length, 1);
    assert.equal(store.versions("action_link", "review-proposal").length, 1);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("schema v4 migration preserves Events, Pi sessions, outbox, and reminders", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cas-current-schema-"));
  const databasePath = join(directory, "events.sqlite");
  const database = new DatabaseSync(databasePath);
  initializeStorage(database);
  database.exec(`
    INSERT INTO events (
      id, source, source_message_id, received_at, user_id, raw_text,
      raw_payload_json, logical_conversation_id, processing_status,
      created_at, updated_at
    ) VALUES (
      'event-1', 'feishu', 'message-1', '2026-09-07T01:00:00Z', 'user-1',
      '原始输入', '{}', 'cas-main', 'completed',
      '2026-09-07T01:00:00Z', '2026-09-07T01:00:00Z'
    );
    INSERT INTO pi_sessions (
      id, logical_conversation_id, pi_session_id, pi_session_path, status,
      created_at, last_activity_at
    ) VALUES (
      'session-row', 'cas-main', 'pi-session', '/tmp/pi-session.jsonl', 'active',
      '2026-09-07T01:00:00Z', '2026-09-07T01:00:00Z'
    );
    INSERT INTO outbox (
      id, operation_type, idempotency_key, payload_json, status,
      created_at, updated_at
    ) VALUES (
      'outbox-1', 'memory.retain', 'memory:1', '{}', 'pending',
      '2026-09-07T01:00:00Z', '2026-09-07T01:00:00Z'
    );
    INSERT INTO reminders (
      id, item_record_id, fire_at, kind, status, payload_json,
      source_event_id, created_at, updated_at
    ) VALUES (
      'reminder-1', 'rec_item', '2026-09-08T01:00:00Z', 'checkpoint',
      'pending', '{}', 'message-1',
      '2026-09-07T01:00:00Z', '2026-09-07T01:00:00Z'
    );
    PRAGMA user_version = 3;
  `);
  database.close();

  const store = createCurrentStateStore(databasePath);
  store.close();
  const migrated = new DatabaseSync(databasePath);
  try {
    for (const table of ["events", "pi_sessions", "outbox", "reminders"]) {
      const row = migrated.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
      assert.equal(row.count, 1, `${table} should be preserved`);
    }
    assert.equal(
      (migrated.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
      4,
    );
  } finally {
    migrated.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an external execution result is versioned separately from the requested Action", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cas-current-execution-"));
  const store = createCurrentStateStore(join(directory, "events.sqlite"));
  try {
    store.apply({
      sourceKind: "user_intent",
      sourceEventId: "message-action",
      occurredAt: "2026-09-07T01:00:00.000Z",
      operations: [
        {
          kind: "upsert_item",
          itemKey: "send-proposal",
          title: "发送报价",
          type: "task",
          status: "actionable",
        },
        {
          kind: "plan_action",
          actionKey: "send-proposal-action",
          itemKey: "send-proposal",
          title: "发送报价",
          actionType: "personal_action",
          factOwner: "ticktick",
        },
      ],
    });
    assert.equal(store.actionExecution("send-proposal-action")?.status, "requested");

    store.recordActionExecution({
      actionKey: "send-proposal-action",
      sourceEventId: "message-action",
      occurredAt: "2026-09-07T01:01:00.000Z",
      externalObjectId: "ticktick-created-1",
      status: "confirmed",
    });
    store.recordActionExecution({
      actionKey: "send-proposal-action",
      sourceEventId: "message-action",
      occurredAt: "2026-09-07T01:01:00.000Z",
      externalObjectId: "ticktick-created-1",
      status: "confirmed",
    });

    assert.deepEqual(store.actionExecution("send-proposal-action"), {
      actionKey: "send-proposal-action",
      externalObjectId: "ticktick-created-1",
      status: "confirmed",
      revision: 2,
      sourceEventId: "execution:message-action:confirmed",
    });
    assert.equal(store.versions("action_link", "send-proposal-action").length, 2);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
