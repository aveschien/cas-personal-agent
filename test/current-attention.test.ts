import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  AuthoritativeItemState,
  AuthoritativeProjectState,
} from "../src/authoritative-bitable-reader.js";
import {
  classifyAttentionQuery,
  createCurrentAttentionResolver,
} from "../src/current-attention.js";
import { createFocusStateStore } from "../src/focus-state-store.js";

const projects: readonly AuthoritativeProjectState[] = [
  {
    recordId: "rec_project_a",
    projectKey: "hospital-proposal",
    name: "院方方案",
    status: "在跟",
    summary: "等待验收前的最后修改",
    correctedFields: [],
  },
  {
    recordId: "rec_project_b",
    projectKey: "personal-agent",
    name: "个人助理",
    status: "在跟",
    correctedFields: [],
  },
];

function item(
  recordId: string,
  itemKey: string,
  title: string,
  values: Partial<AuthoritativeItemState> = {},
): AuthoritativeItemState {
  return {
    recordId,
    itemKey,
    title,
    type: "任务",
    status: "可行动",
    parked: false,
    correctedFields: [],
    ...values,
  };
}

async function fixture(
  actionRows: readonly {
    readonly recordId: string;
    readonly fields: Readonly<Record<string, unknown>>;
  }[] = [],
  failSync = false,
  localActionTimings?: () => readonly { itemKey: string; status: "open" | "completed" | "unknown"; deadlineAt?: string }[],
) {
  const directory = await mkdtemp(join(tmpdir(), "cas-attention-"));
  const focus = createFocusStateStore(join(directory, "events.sqlite"));
  const updates: {
    readonly recordId: string;
    readonly fields: Readonly<Record<string, unknown>>;
  }[] = [];
  const syncErrors: unknown[] = [];
  let listCalls = 0;
  const resolver = createCurrentAttentionResolver({
    logicalConversationId: "cas-main",
    bitable: {
      list: async () => { listCalls += 1; return actionRows; },
      findByKey: async () => undefined,
      create: async () => {
        throw new Error("not used");
      },
      update: async () => undefined,
      batchUpdate: async (_tableId, values) => {
        if (failSync) {
          throw new Error("sync unavailable");
        }
        updates.push(...values);
      },
    },
    itemsTableId: "tbl_items",
    actionLinksTableId: "tbl_actions",
    focus,
    onSyncError: (error) => syncErrors.push(error),
    ...(localActionTimings === undefined ? {} : { localActionTimings, syncDerivedView: false }),
  });
  return { directory, focus, resolver, updates, syncErrors, listCalls: () => listCalls };
}

test("attention query classification stays narrow", () => {
  assert.equal(classifyAttentionQuery("我现在该做什么？"), "now");
  assert.equal(classifyAttentionQuery("我在等什么"), "waiting");
  assert.equal(classifyAttentionQuery("继续那个项目"), "continue");
  assert.equal(classifyAttentionQuery("继续开发"), "continue");
  assert.equal(classifyAttentionQuery("记录一个新想法"), undefined);
});

test("production attention can rank from local action timing without Bitable reads or writes", async () => {
  const { directory, focus, resolver, updates, listCalls } = await fixture([], false, () => [{
    itemKey: "due", status: "open", deadlineAt: "2026-09-03T08:30:00+08:00",
  }]);
  const result = await resolver.resolve({
    message: "我现在该做什么？", now: "2026-09-03T02:00:00.000Z", projects,
    items: [item("rec_due", "due", "提交承诺", { status: "收件箱" })],
  });
  assert.equal(result.currentAttention?.[0]?.itemKey, "due");
  assert.equal(listCalls(), 0);
  assert.equal(updates.length, 0);
  focus.close();
  await rm(directory, { recursive: true, force: true });
});

test("Current Attention excludes parked and Waiting Items but never hides due work", async () => {
  const { directory, focus, resolver } = await fixture([
    {
      recordId: "rec_action_due",
      fields: {
        所属事项: [{ id: "rec_due" }],
        外部状态镜像: "open",
        deadline: "2026-09-03T08:30:00+08:00",
      },
    },
    {
      recordId: "rec_action_today",
      fields: {
        所属事项: [{ id: "rec_today" }],
        外部状态镜像: "open",
        deadline: "2026-09-03T20:00:00+08:00",
      },
    },
  ]);
  const items = [
    item("rec_active", "active", "完成正在推进的文档", {
      projectKey: "hospital-proposal",
      status: "进行中",
      nextAction: "补齐最后两页",
    }),
    item("rec_second", "second", "整理访谈笔记"),
    item("rec_third", "third", "回复普通邮件"),
    item("rec_due", "due", "提交逾期承诺", { status: "收件箱" }),
    item("rec_today", "today", "完成今晚交付", { status: "等待" }),
    item("rec_waiting", "waiting", "等待院方回复", {
      status: "等待",
      waitingFor: "院方回复",
    }),
    item("rec_idea", "idea", "尝试新的讲法", {
      type: "想法",
      status: "收件箱",
      parked: true,
    }),
  ];

  const result = await resolver.resolve({
    message: "我现在该做什么？",
    now: "2026-09-03T02:00:00.000Z",
    projects,
    items,
  });

  assert.equal(result.queryKind, "now");
  assert.deepEqual(
    result.currentAttention?.map((candidate) => candidate.itemKey),
    ["due", "today", "active"],
  );
  assert.equal(
    result.currentAttention?.some((candidate) => candidate.itemKey === "waiting"),
    false,
  );
  assert.equal(focus.get("cas-main").activeItemRecordId, "rec_due");

  focus.close();
  await rm(directory, { recursive: true, force: true });
});

test("all forced Items remain visible even when they exceed the normal focus size", async () => {
  const actionRows = ["one", "two", "three", "four", "fixture"].map((key, index) => ({
    recordId: `rec_action_${key}`,
    fields: {
      所属事项: [{ id: `rec_${key}` }],
      外部状态镜像: "open",
      deadline: `2026-09-03T0${index + 1}:00:00+08:00`,
    },
  }));
  const { directory, focus, resolver } = await fixture(actionRows);
  const result = await resolver.resolve({
    message: "现在该做什么",
    now: "2026-09-03T02:00:00.000Z",
    projects,
    items: ["one", "two", "three", "four", "fixture"].map((key) =>
      item(`rec_${key}`, key, key, {
        status: "收件箱",
        ...(key === "fixture" ? { sourceEventId: "dev-acceptance-1" } : {}),
      }),
    ),
  });
  assert.equal(result.currentAttention?.length, 4);
  focus.close();
  await rm(directory, { recursive: true, force: true });
});

test("the selector persists one ordered Current Attention view and clears stale rows", async () => {
  const { directory, focus, resolver, updates } = await fixture();
  await resolver.resolve({
    message: "先记下这条补充",
    now: "2026-09-03T02:00:00.000Z",
    projects,
    items: [
      item("rec_active", "active", "推进方案", {
        status: "进行中",
        inCurrentAttention: false,
      }),
      item("rec_next", "next", "整理材料", {
        inCurrentAttention: false,
      }),
      item("rec_stale", "stale", "旧焦点", {
        status: "等待",
        inCurrentAttention: true,
        attentionOrder: 1,
        attentionReason: "旧值",
      }),
    ],
  });
  assert.deepEqual(updates, [
    {
      recordId: "rec_active",
      fields: {
        当前注意力: true,
        注意力顺序: 1,
        注意力依据: "保持当前推进连续性",
      },
    },
    {
      recordId: "rec_next",
      fields: {
        当前注意力: true,
        注意力顺序: 2,
        注意力依据: "当前可行动",
      },
    },
    {
      recordId: "rec_stale",
      fields: {
        当前注意力: false,
        注意力顺序: null,
        注意力依据: null,
      },
    },
  ]);
  focus.close();
  await rm(directory, { recursive: true, force: true });
});

test("a derived view sync failure does not block an attention answer", async () => {
  const { directory, focus, resolver, syncErrors } = await fixture([], true);
  const result = await resolver.resolve({
    message: "我现在该做什么？",
    now: "2026-09-03T02:00:00.000Z",
    projects,
    items: [item("rec_active", "active", "推进方案", { status: "进行中" })],
  });
  assert.equal(result.currentAttention?.[0]?.itemKey, "active");
  assert.equal(syncErrors.length, 1);
  focus.close();
  await rm(directory, { recursive: true, force: true });
});

test("Waiting queries expose missing Checkpoints without inventing dates", async () => {
  const { directory, focus, resolver } = await fixture();
  const result = await resolver.resolve({
    message: "我在等什么？",
    now: "2026-09-03T02:00:00.000Z",
    projects,
    items: [
      item("rec_wait_1", "wait-1", "等待合同", {
        status: "等待",
        waitingFor: "法务确认",
        releaseCondition: "收到盖章版",
        checkpointAt: "2026-09-04T09:00:00+08:00",
      }),
      item("rec_wait_2", "wait-2", "等待报价", {
        status: "等待",
        waitingFor: "供应商报价",
      }),
    ],
  });
  assert.equal(result.waiting?.length, 2);
  assert.equal(result.waiting?.[0]?.missingCheckpoint, false);
  assert.equal(result.waiting?.[1]?.missingCheckpoint, true);
  assert.equal(result.waiting?.[1]?.checkpointAt, undefined);
  focus.close();
  await rm(directory, { recursive: true, force: true });
});

test("Project continuation restores open loops, Waiting state, and one Next Action", async () => {
  const { directory, focus, resolver } = await fixture();
  const result = await resolver.resolve({
    message: "继续院方方案项目",
    now: "2026-09-03T02:00:00.000Z",
    projects,
    items: [
      item("rec_edit", "edit", "修改方案", {
        projectKey: "hospital-proposal",
        status: "进行中",
        nextAction: "修改定价页",
      }),
      item("rec_feedback", "feedback", "等待反馈", {
        projectKey: "hospital-proposal",
        status: "等待",
        waitingFor: "院方反馈",
      }),
      item("rec_done", "done", "发送初稿", {
        projectKey: "hospital-proposal",
        status: "完成",
      }),
    ],
  });
  assert.equal(result.continuation?.projectKey, "hospital-proposal");
  assert.deepEqual(
    result.continuation?.openLoops.map((loop) => loop.itemKey),
    ["edit", "feedback"],
  );
  assert.equal(result.continuation?.waiting.length, 1);
  assert.equal(result.continuation?.nextAction?.nextAction, "修改定价页");
  assert.equal(focus.get("cas-main").activeItemRecordId, "rec_edit");
  focus.close();
  await rm(directory, { recursive: true, force: true });
});

test("execute mode carries active focus while explore mode does not pull back", async () => {
  const { directory, focus, resolver } = await fixture();
  focus.setFocus(
    "cas-main",
    "rec_project_a",
    "rec_active",
    "2026-09-03T01:00:00.000Z",
  );
  const items = [
    item("rec_active", "active", "修改方案", {
      projectKey: "hospital-proposal",
      status: "进行中",
      nextAction: "修改定价页",
    }),
  ];
  const execute = await resolver.resolve({
    message: "进入执行模式，另外记一下竞品的新想法",
    now: "2026-09-03T02:00:00.000Z",
    projects,
    items,
  });
  assert.equal(execute.cognitiveMode, "execute");
  assert.equal(execute.activeFocus?.itemKey, "active");
  const explore = await resolver.resolve({
    message: "先发散一下这个竞品思路",
    now: "2026-09-03T03:00:00.000Z",
    projects,
    items,
  });
  assert.equal(explore.cognitiveMode, "explore");
  assert.equal(explore.activeFocus, undefined);
  focus.close();
  await rm(directory, { recursive: true, force: true });
});
