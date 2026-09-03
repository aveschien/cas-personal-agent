import assert from "node:assert/strict";
import test from "node:test";

import { createAuthoritativeActionReader } from "../src/authoritative-action-reader.js";

test("external manual edits override stale Bitable Action mirrors", async () => {
  const updates: Readonly<Record<string, unknown>>[] = [];
  const reader = createAuthoritativeActionReader({
    bitable: {
      list: async () => [
        {
          recordId: "rec_ticktick",
          fields: {
            action_key: "finish-proposal",
            行动: "完成方案",
            事实源: ["滴答"],
            "外部对象 ID": "task-1",
            外部状态镜像: "open",
            负责人: null,
            deadline: "2026-09-04T09:00:00+08:00",
          },
        },
        {
          recordId: "rec_feishu",
          fields: {
            action_key: "api-inventory",
            行动: "补充接口清单",
            事实源: ["飞书任务"],
            "外部对象 ID": "task-guid-1",
            外部状态镜像: "open",
            负责人: "小王",
            deadline: null,
          },
        },
      ],
      findByKey: async () => undefined,
      create: async () => {
        throw new Error("not used");
      },
      update: async (_tableId, _recordId, fields) => {
        updates.push(fields);
      },
    },
    actionLinksTableId: "tbl_actions",
    personal: {
      projectId: "project-1",
      adapter: {
        create: async () => {
          throw new Error("not used");
        },
        getState: async () => ({
          externalId: "task-1",
          projectId: "project-1",
          status: "completed",
          title: "完成最终方案",
          deadlineAt: null,
          updatedAt: "2026-09-03T01:00:00.000Z",
        }),
      },
    },
    collaborative: {
      adapter: {
        create: async () => {
          throw new Error("not used");
        },
        getState: async () => ({
          externalId: "task-guid-1",
          externalUrl: "https://example.com/task-guid-1",
          status: "open",
          assigneeIds: ["ou_xiaoli"],
          assigneeNames: ["小李"],
          title: "补齐接口清单",
          deadlineAt: "2026-09-05T09:00:00.000Z",
          updatedAt: "2026-09-03T02:00:00.000Z",
        }),
      },
    },
  });

  const result = await reader.reconcile("2026-09-03T03:00:00.000Z");

  assert.deepEqual(
    result.states.map((state) => ({
      actionKey: state.actionKey,
      status: state.status,
      correctedFields: state.correctedFields,
    })),
    [
      {
        actionKey: "finish-proposal",
        status: "completed",
        correctedFields: ["完成状态", "标题", "截止时间"],
      },
      {
        actionKey: "api-inventory",
        status: "open",
        correctedFields: ["标题", "截止时间", "负责人"],
      },
    ],
  );
  assert.deepEqual(updates, [
    {
      行动: "完成最终方案",
      外部状态镜像: "completed",
      最近同步: "2026-09-03T03:00:00.000Z",
      同步状态: ["succeeded"],
      deadline: null,
    },
    {
      行动: "补齐接口清单",
      外部状态镜像: "open",
      最近同步: "2026-09-03T03:00:00.000Z",
      同步状态: ["succeeded"],
      deadline: "2026-09-05T09:00:00.000Z",
      负责人: "小李",
    },
  ]);
  assert.equal(result.memoryCandidates.length, 2);
  assert.equal(result.memoryCandidates[0]?.category, "correction");
  assert.match(
    result.memoryCandidates[0]?.content ?? "",
    /权威纠正.*完成状态、标题、截止时间.*completed/,
  );
});

test("one external read failure does not block other authoritative state", async () => {
  const errors: unknown[] = [];
  const reader = createAuthoritativeActionReader({
    bitable: {
      list: async () => [
        {
          recordId: "rec_ticktick",
          fields: {
            action_key: "finish-proposal",
            行动: "完成方案",
            事实源: ["滴答"],
            "外部对象 ID": "task-1",
            外部状态镜像: "open",
          },
        },
      ],
      findByKey: async () => undefined,
      create: async () => {
        throw new Error("not used");
      },
      update: async () => undefined,
    },
    actionLinksTableId: "tbl_actions",
    personal: {
      projectId: "project-1",
      adapter: {
        create: async () => {
          throw new Error("not used");
        },
        getState: async () => {
          throw new Error("TickTick unavailable");
        },
      },
    },
    onError: (error) => errors.push(error),
  });

  assert.deepEqual(await reader.reconcile(), {
    states: [],
    memoryCandidates: [],
  });
  assert.equal(errors.length, 1);
});
