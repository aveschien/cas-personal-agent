import assert from "node:assert/strict";
import test from "node:test";

import { createTickTickActionAdapter } from "../src/ticktick-action-adapter.js";

test("TickTick creation uses Beijing time and finds its durable idempotency marker", async () => {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  let createdContent = "";
  let projectReads = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/project/project-1/data")) {
      projectReads += 1;
      return Response.json({
        tasks:
          projectReads === 1
            ? []
            : [
                {
                  id: "task-1",
                  projectId: "project-1",
                  content: createdContent,
                  status: 0,
                },
              ],
      });
    }
    assert.equal(url.endsWith("/task"), true);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.equal(body.title, "完成报价页");
    assert.equal(body.projectId, "project-1");
    assert.equal(body.timeZone, "Asia/Shanghai");
    assert.equal(body.dueDate, "2026-09-03T23:59:00+0800");
    createdContent = String(body.content);
    assert.match(createdContent, /^CAS-IDEMPOTENCY:[a-f0-9]{64}/);
    return Response.json({
      id: "task-1",
      projectId: "project-1",
      content: createdContent,
      status: 0,
    });
  };
  const adapter = createTickTickActionAdapter({
    apiToken: "secret-token",
    projectId: "project-1",
    fetcher,
  });
  const request = {
    idempotencyKey: "ticktick.create:proposal-page",
    actionKey: "proposal-page",
    title: "完成报价页",
    itemKey: "proposal",
    deadlineAt: "2026-09-03T23:59:00+08:00",
    sourceEventId: "om_ticktick_1",
  };

  assert.deepEqual(await adapter.create(request), {
    externalId: "task-1",
    projectId: "project-1",
    status: "open",
  });
  assert.deepEqual(await adapter.create(request), {
    externalId: "task-1",
    projectId: "project-1",
    status: "open",
  });
  assert.equal(calls.filter(({ init }) => init?.method === "POST").length, 1);
  assert.equal(
    calls.every(
      ({ init }) =>
        (init?.headers as Record<string, string>).Authorization ===
        "Bearer secret-token",
    ),
    true,
  );
});

test("a bodyless TickTick create response is reconciled by its marker", async () => {
  let markerContent = "";
  let projectReads = 0;
  const adapter = createTickTickActionAdapter({
    apiToken: "secret-token",
    projectId: "project-1",
    fetcher: async (input, init) => {
      if (String(input).endsWith("/project/project-1/data")) {
        projectReads += 1;
        return Response.json({
          tasks:
            projectReads === 1
              ? []
              : [
                  {
                    id: "task-from-reconciliation",
                    projectId: "project-1",
                    content: markerContent,
                    status: 0,
                  },
                ],
        });
      }
      markerContent = String(
        (JSON.parse(String(init?.body)) as Record<string, unknown>).content,
      );
      return new Response(null, { status: 201 });
    },
  });

  assert.deepEqual(
    await adapter.create({
      idempotencyKey: "ticktick.create:bodyless",
      actionKey: "bodyless",
      title: "验证无响应体创建",
      itemKey: "bodyless",
      sourceEventId: "om_bodyless",
    }),
    {
      externalId: "task-from-reconciliation",
      projectId: "project-1",
      status: "open",
    },
  );
});

test("TickTick state exposes authoritative title, deadline, and modification time", async () => {
  const adapter = createTickTickActionAdapter({
    apiToken: "secret-token",
    projectId: "project-1",
    fetcher: async () =>
      Response.json({
        id: "task-1",
        projectId: "project-1",
        title: "人工改过的标题",
        dueDate: "2026-09-05T18:00:00+0800",
        modifiedTime: "2026-09-03T09:00:00.000Z",
        status: 2,
      }),
  });

  assert.deepEqual(await adapter.getState("project-1", "task-1"), {
    externalId: "task-1",
    projectId: "project-1",
    status: "completed",
    title: "人工改过的标题",
    deadlineAt: "2026-09-05T18:00:00+0800",
    updatedAt: "2026-09-03T09:00:00.000Z",
  });
});

test("TickTick reads the configured project as one scoped open-task snapshot", async () => {
  const calls: string[] = [];
  const adapter = createTickTickActionAdapter({
    apiToken: "secret-token",
    projectId: "project-1",
    fetcher: async (input) => {
      calls.push(String(input));
      return Response.json({ tasks: [{ id: "task-1", projectId: "project-1", title: "手机修改", status: 0 }] });
    },
  });
  assert.deepEqual(await adapter.listProjectSnapshot?.("project-1"), [{
    externalId: "task-1", projectId: "project-1", status: "open", title: "手机修改", deadlineAt: null,
  }]);
  assert.equal(calls.length, 1);
  await assert.rejects(() => adapter.listProjectSnapshot!("another-project"), /configured project/);
});

test("TickTick credentials cannot be sent to an untrusted API host", () => {
  assert.throws(
    () =>
      createTickTickActionAdapter({
        apiToken: "secret-token",
        projectId: "project-1",
        baseUrl: "https://example.com/open/v1",
      }),
    /official TickTick or Dida365/,
  );
});
