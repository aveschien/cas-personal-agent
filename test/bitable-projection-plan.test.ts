import assert from "node:assert/strict";
import test from "node:test";

import {
  compileBitableProjection,
  type SemanticOperation,
} from "../src/state-operations.js";

test("mixed semantic operations compile into separate waiting, action, idea, and checkpoint state", () => {
  const operations: SemanticOperation[] = [
    {
      kind: "upsert_item",
      itemKey: "proposal-feedback",
      title: "方案反馈",
      type: "task",
      status: "waiting",
      summary: "等待张总本周反馈",
    },
    {
      kind: "set_waiting",
      itemKey: "proposal-feedback",
      waitingFor: "张总的方案反馈",
      releaseCondition: "收到张总反馈",
      checkpointAt: "2026-09-04T09:00:00+08:00",
      contingency: "若周五仍无反馈，则联系张总",
    },
    {
      kind: "upsert_item",
      itemKey: "pathology-slide",
      title: "修改病理 PPT 页",
      type: "task",
      status: "actionable",
      nextAction: "今晚完成病理页修改",
    },
    {
      kind: "plan_action",
      actionKey: "pathology-slide-tonight",
      itemKey: "pathology-slide",
      title: "今晚修改病理 PPT 页",
      actionType: "personal_action",
      factOwner: "ticktick",
      deadlineAt: "2026-09-02T23:59:00+08:00",
    },
    {
      kind: "park_idea",
      itemKey: "data-governance-wording",
      title: "换一种数据治理讲法",
      summary: "先暂存，不进入当前注意力",
    },
    {
      kind: "schedule_checkpoint",
      reminderKey: "proposal-feedback-2026-09-04",
      itemKey: "proposal-feedback",
      fireAt: "2026-09-04T09:00:00+08:00",
    },
  ];

  assert.deepEqual(
    compileBitableProjection({
      sourceEventId: "om_mixed_1",
      operations,
    }),
    {
      projects: [],
      items: [
        {
          key: "proposal-feedback",
          title: "方案反馈",
          type: "task",
          status: "waiting",
          summary: "等待张总本周反馈",
          waitingFor: "张总的方案反馈",
          releaseCondition: "收到张总反馈",
          checkpointAt: "2026-09-04T09:00:00+08:00",
          contingency: "若周五仍无反馈，则联系张总",
          sourceEventId: "om_mixed_1",
        },
        {
          key: "pathology-slide",
          title: "修改病理 PPT 页",
          type: "task",
          status: "actionable",
          nextAction: "今晚完成病理页修改",
          sourceEventId: "om_mixed_1",
        },
        {
          key: "data-governance-wording",
          title: "换一种数据治理讲法",
          type: "idea",
          status: "inbox",
          summary: "先暂存，不进入当前注意力",
          parked: true,
          sourceEventId: "om_mixed_1",
        },
      ],
      actionLinks: [
        {
          key: "pathology-slide-tonight",
          itemKey: "pathology-slide",
          title: "今晚修改病理 PPT 页",
          actionType: "personal_action",
          factOwner: "ticktick",
          deadlineAt: "2026-09-02T23:59:00+08:00",
          syncStatus: "pending",
          sourceEventId: "om_mixed_1",
        },
      ],
      reminders: [
        {
          key: "pathology-slide-tonight-deadline",
          itemKey: "pathology-slide",
          title: "今晚修改病理 PPT 页",
          context: "截止时间：2026-09-02T23:59:00+08:00",
          suggestedAction: "确认是否完成；如果未完成，决定新的下一步。",
          fireAt: "2026-09-02T23:59:00+08:00",
          kind: "deadline",
          sourceEventId: "om_mixed_1",
        },
        {
          key: "proposal-feedback-2026-09-04",
          itemKey: "proposal-feedback",
          title: "方案反馈",
          context: "在等：张总的方案反馈；解除条件：收到张总反馈",
          suggestedAction: "若周五仍无反馈，则联系张总",
          fireAt: "2026-09-04T09:00:00+08:00",
          kind: "checkpoint",
          sourceEventId: "om_mixed_1",
        },
      ],
      clarifications: [],
    },
  );
});

test("fixed-time events, deadlines, and checkpoints remain distinct", () => {
  const operations: SemanticOperation[] = [
    {
      kind: "create_scheduled_event",
      actionKey: "hospital-meeting",
      itemKey: "hospital-coordination",
      title: "和院方开会",
      startAt: "2026-09-03T15:00:00+08:00",
      endAt: "2026-09-03T16:00:00+08:00",
    },
    {
      kind: "plan_action",
      actionKey: "finish-proposal",
      itemKey: "proposal",
      title: "完成方案",
      actionType: "personal_action",
      factOwner: "ticktick",
      deadlineAt: "2026-09-03T23:59:00+08:00",
    },
    {
      kind: "schedule_checkpoint",
      reminderKey: "review-proposal",
      itemKey: "proposal",
      fireAt: "2026-09-04T09:00:00+08:00",
    },
  ];

  const plan = compileBitableProjection({
    sourceEventId: "om_times_1",
    operations,
  });
  assert.deepEqual(plan.actionLinks[0], {
    key: "hospital-meeting",
    itemKey: "hospital-coordination",
    title: "和院方开会",
    actionType: "scheduled_event",
    factOwner: "bitable",
    startAt: "2026-09-03T15:00:00+08:00",
    endAt: "2026-09-03T16:00:00+08:00",
    syncStatus: "pending",
    sourceEventId: "om_times_1",
  });
  assert.equal(plan.actionLinks[1]?.deadlineAt, "2026-09-03T23:59:00+08:00");
  assert.equal(plan.actionLinks[1]?.startAt, undefined);
  assert.deepEqual(
    plan.reminders.map(({ kind, fireAt }) => ({ kind, fireAt })),
    [
      {
        kind: "scheduled_event",
        fireAt: "2026-09-03T15:00:00+08:00",
      },
      { kind: "deadline", fireAt: "2026-09-03T23:59:00+08:00" },
      { kind: "checkpoint", fireAt: "2026-09-04T09:00:00+08:00" },
    ],
  );
});

test("missing or vague times never manufacture a Reminder", () => {
  const plan = compileBitableProjection({
    sourceEventId: "om_without_time",
    operations: [
      {
        kind: "upsert_item",
        itemKey: "undated-action",
        title: "整理方案",
        type: "task",
        status: "actionable",
        nextAction: "打开方案文档",
      },
      {
        kind: "plan_action",
        actionKey: "undated-action",
        itemKey: "undated-action",
        title: "整理方案",
        actionType: "personal_action",
        factOwner: "ticktick",
      },
    ],
  });
  assert.deepEqual(plan.reminders, []);
});

test("a collaborative commitment requires one resolved assignee", () => {
  const base = {
    kind: "plan_action",
    actionKey: "api-inventory",
    itemKey: "api-inventory-item",
    title: "补充接口清单",
    actionType: "collaborative_commitment",
    factOwner: "feishu_task",
    assignee: "小王",
  } as const;
  assert.throws(
    () =>
      compileBitableProjection({
        sourceEventId: "om_unresolved",
        operations: [base],
      }),
    /resolved Feishu assignee/,
  );
  const plan = compileBitableProjection({
    sourceEventId: "om_resolved",
    operations: [
      {
        ...base,
        assigneeId: "ou_xiaowang",
        deadlineAt: "2026-09-04T17:00:00+08:00",
      },
    ],
  });
  assert.deepEqual(plan.actionLinks, [
    {
      key: "api-inventory",
      itemKey: "api-inventory-item",
      title: "补充接口清单",
      actionType: "collaborative_commitment",
      factOwner: "feishu_task",
      assignee: "小王",
      assigneeId: "ou_xiaowang",
      deadlineAt: "2026-09-04T17:00:00+08:00",
      syncStatus: "pending",
      sourceEventId: "om_resolved",
    },
  ]);
});
