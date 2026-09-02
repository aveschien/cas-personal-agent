import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { createBitableStateProjector } from "./bitable-state-projector.js";
import { createLarkBaseClient } from "./lark-base-client.js";
import { createReminderStore } from "./reminder-store.js";
import type { SemanticOperation } from "./state-operations.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

export async function runBitableSmoke(cwd = process.cwd()): Promise<void> {
  const client = createLarkBaseClient({
    baseToken: required("CAS_BITABLE_BASE_TOKEN"),
  });
  const reminders = createReminderStore(
    join(cwd, "var", "bitable-smoke.sqlite"),
  );
  const tables = {
    projects: required("CAS_BITABLE_PROJECTS_TABLE_ID"),
    items: required("CAS_BITABLE_ITEMS_TABLE_ID"),
    actionLinks: required("CAS_BITABLE_ACTION_LINKS_TABLE_ID"),
  };
  const projector = createBitableStateProjector({
    client,
    tables,
    reminders,
  });
  const operations: SemanticOperation[] = [
    {
      kind: "upsert_project",
      projectKey: "acceptance-hospital-proposal",
      name: "院方方案（开发验收）",
      status: "tracking",
      phase: "方案",
      summary: "用于验证 CAS 混合输入投影",
    },
    {
      kind: "upsert_item",
      itemKey: "acceptance-proposal-feedback",
      projectKey: "acceptance-hospital-proposal",
      title: "等待张总方案反馈",
      type: "task",
      status: "waiting",
      summary: "等待本周反馈",
    },
    {
      kind: "set_waiting",
      itemKey: "acceptance-proposal-feedback",
      waitingFor: "张总的方案反馈",
      releaseCondition: "收到明确反馈",
      checkpointAt: "2026-09-04T09:00:00+08:00",
      contingency: "若周五仍无反馈，则联系张总",
    },
    {
      kind: "upsert_item",
      itemKey: "acceptance-pathology-slide",
      projectKey: "acceptance-hospital-proposal",
      title: "修改病理 PPT 页",
      type: "task",
      status: "actionable",
      nextAction: "今晚完成病理页修改",
    },
    {
      kind: "plan_action",
      actionKey: "acceptance-pathology-tonight",
      itemKey: "acceptance-pathology-slide",
      projectKey: "acceptance-hospital-proposal",
      title: "今晚修改病理 PPT 页",
      actionType: "personal_action",
      factOwner: "ticktick",
      deadlineAt: "2026-09-02T23:59:00+08:00",
    },
    {
      kind: "park_idea",
      itemKey: "acceptance-data-governance-wording",
      projectKey: "acceptance-hospital-proposal",
      title: "换一种数据治理讲法",
      summary: "先暂存，不进入当前注意力",
    },
    {
      kind: "upsert_item",
      itemKey: "acceptance-hospital-meeting",
      projectKey: "acceptance-hospital-proposal",
      title: "和院方开会",
      type: "task",
      status: "scheduled",
      summary: "固定时间安排，不占用事项检查点",
    },
    {
      kind: "create_scheduled_event",
      actionKey: "acceptance-hospital-meeting-event",
      itemKey: "acceptance-hospital-meeting",
      projectKey: "acceptance-hospital-proposal",
      title: "和院方开会",
      startAt: "2026-09-03T15:00:00+08:00",
      endAt: "2026-09-03T16:00:00+08:00",
    },
    {
      kind: "schedule_checkpoint",
      reminderKey: "acceptance-proposal-review",
      itemKey: "acceptance-proposal-feedback",
      fireAt: "2026-09-04T09:00:00+08:00",
    },
  ];

  try {
    const input = {
      sourceEventId: "dev-acceptance-mixed-001",
      operations,
    };
    await projector.project(input);
    await projector.project(input);
    const project = await client.findByKey(
      tables.projects,
      "project_key",
      "acceptance-hospital-proposal",
    );
    const waiting = await client.findByKey(
      tables.items,
      "item_key",
      "acceptance-proposal-feedback",
    );
    const idea = await client.findByKey(
      tables.items,
      "item_key",
      "acceptance-data-governance-wording",
    );
    const action = await client.findByKey(
      tables.actionLinks,
      "action_key",
      "acceptance-pathology-tonight",
    );
    const scheduledEvent = await client.findByKey(
      tables.actionLinks,
      "action_key",
      "acceptance-hospital-meeting-event",
    );
    assert.ok(project && waiting && idea && action && scheduledEvent);
    assert.equal(reminders.get("acceptance-proposal-review")?.status, "pending");
    console.log(
      JSON.stringify({
        status: "ok",
        projectRecordId: project.recordId,
        waitingItemRecordId: waiting.recordId,
        parkedIdeaRecordId: idea.recordId,
        actionLinkRecordId: action.recordId,
        scheduledEventRecordId: scheduledEvent.recordId,
        checkpoint: "pending",
        idempotentReplay: true,
      }),
    );
  } finally {
    reminders.close();
  }
}

const executable = process.argv[1];
if (
  executable !== undefined &&
  pathToFileURL(executable).href === import.meta.url
) {
  runBitableSmoke().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
