import assert from "node:assert/strict";
import test from "node:test";

import { createLarkTaskActionAdapter } from "../src/lark-task-action-adapter.js";

test("a confirmed collaborative commitment uses a stable Feishu client token", async () => {
  const calls: readonly string[][] = [];
  const mutableCalls = calls as string[][];
  const adapter = createLarkTaskActionAdapter({
    runner: {
      run: async (_command, args) => {
        mutableCalls.push([...args]);
        if (args[1] === "+create") {
          return {
            exitCode: 0,
            stderr: "",
            stdout: JSON.stringify({
              ok: true,
              identity: "user",
              data: {
                guid: "task-guid-1",
                url: "https://applink.feishu.cn/client/todo/detail?guid=task-guid-1",
              },
            }),
          };
        }
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify({
            ok: true,
            identity: "user",
            data: {
              task: {
                guid: "task-guid-1",
                url: "https://applink.feishu.cn/client/todo/detail?guid=task-guid-1",
                status: "done",
                members: [
                  { id: "ou_xiaowang", role: "assignee", type: "user" },
                ],
                due: { timestamp: "1788454800000", is_all_day: false },
              },
            },
          }),
        };
      },
    },
  });

  const request = {
    idempotencyKey: "feishu_task.create:api-inventory",
    actionKey: "api-inventory",
    title: "补充接口清单",
    itemKey: "api-inventory-item",
    projectKey: "platform-project",
    assigneeId: "ou_xiaowang",
    assigneeName: "小王",
    deadlineAt: "2026-09-04T17:00:00+08:00",
    sourceEventId: "om_confirmed_1",
  } as const;
  assert.deepEqual(await adapter.create(request), {
    externalId: "task-guid-1",
    externalUrl:
      "https://applink.feishu.cn/client/todo/detail?guid=task-guid-1",
    status: "open",
    assigneeIds: ["ou_xiaowang"],
    deadlineAt: "2026-09-04T17:00:00+08:00",
  });
  const createArgs = mutableCalls[0] ?? [];
  assert.deepEqual(createArgs.slice(0, 8), [
    "task",
    "+create",
    "--summary",
    "补充接口清单",
    "--description",
    "由 CAS Personal Agent 根据用户明确确认创建。\n事项：api-inventory-item\n项目：platform-project\n来源事件：om_confirmed_1",
    "--assignee",
    "ou_xiaowang",
  ]);
  const tokenIndex = createArgs.indexOf("--idempotency-key");
  assert.match(createArgs[tokenIndex + 1] ?? "", /^[a-f0-9]{64}$/);
  assert.deepEqual(createArgs.slice(-5), [
    "--due",
    "2026-09-04T17:00:00+08:00",
    "--as",
    "user",
    "--json",
  ]);

  const state = await adapter.getState("task-guid-1");
  assert.equal(state.status, "completed");
  assert.deepEqual(state.assigneeIds, ["ou_xiaowang"]);
  assert.deepEqual(mutableCalls[1], [
    "task",
    "tasks",
    "get",
    "--task-guid",
    "task-guid-1",
    "--as",
    "user",
    "--json",
  ]);
});

test("Feishu Task creation rejects an unresolved assignee before running CLI", async () => {
  let calls = 0;
  const adapter = createLarkTaskActionAdapter({
    runner: {
      run: async () => {
        calls += 1;
        throw new Error("must not run");
      },
    },
  });
  await assert.rejects(
    adapter.create({
      idempotencyKey: "feishu_task.create:bad",
      actionKey: "bad",
      title: "不要创建",
      itemKey: "bad-item",
      assigneeId: "小王",
      assigneeName: "小王",
      sourceEventId: "om_bad",
    }),
    /resolved open_id/,
  );
  assert.equal(calls, 0);
});
