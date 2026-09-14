import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createDevelopmentAgent } from "../src/development-agent.js";

test("an authorized Channel event becomes one durable Event and a concise acknowledgement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cas-agent-"));
  const projectedChanges: unknown[] = [];
  const agent = createDevelopmentAgent({
    databasePath: join(directory, "events.sqlite"),
    allowedUserIds: ["user-1"],
    interpreter: {
      interpret: async () => ({
        changes: [{ kind: "item", title: "修改病理 PPT 页", type: "task", status: "actionable" }],
        acknowledgement: "已记录：修改病理 PPT 页。",
      }),
    },
    stateAdapter: {
      project: async (changes) => {
        projectedChanges.push(...changes);
      },
    },
  });

  try {
    const result = await agent.ingest({
      sourceMessageId: "message-1",
      receivedAt: "2026-09-02T17:00:00.000Z",
      userId: "user-1",
      rawText: "晚上把病理那页 PPT 改一下",
      rawPayload: { event_id: "delivery-1" },
    });

    assert.deepEqual(result, {
      status: "completed",
      acknowledgement: "已记录：修改病理 PPT 页。",
    });
    assert.deepEqual(projectedChanges, [
      { kind: "item", title: "修改病理 PPT 页", type: "task", status: "actionable" },
    ]);
    assert.deepEqual(agent.getEvent("message-1"), {
      source: "feishu",
      sourceMessageId: "message-1",
      userId: "user-1",
      rawText: "晚上把病理那页 PPT 改一下",
      processingStatus: "completed",
      acknowledgement: "已记录：修改病理 PPT 页。",
    });
  } finally {
    agent.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a Grok Channel event is stored with source grok", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cas-agent-grok-"));
  const agent = createDevelopmentAgent({
    databasePath: join(directory, "events.sqlite"),
    allowedUserIds: ["ou_authorized"],
    interpreter: {
      interpret: async () => ({
        changes: [],
        acknowledgement: "已从 Grok 入口记下。",
      }),
    },
    stateAdapter: {
      project: async () => undefined,
    },
  });

  try {
    const result = await agent.ingest({
      sourceMessageId: "grok-message-1",
      receivedAt: "2026-09-14T08:00:00.000Z",
      userId: "ou_authorized",
      rawText: "从 Grok 记下这条",
      rawPayload: { channel: "grok" },
      source: "grok",
    });
    assert.deepEqual(result, {
      status: "completed",
      acknowledgement: "已从 Grok 入口记下。",
    });
    assert.equal(agent.getEvent("grok-message-1")?.source, "grok");
  } finally {
    agent.close();
    await rm(directory, { recursive: true, force: true });
  }
});
