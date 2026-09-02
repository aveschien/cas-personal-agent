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
        changes: [{ kind: "item", title: "修改病理 PPT 页" }],
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
      { kind: "item", title: "修改病理 PPT 页" },
    ]);
    assert.deepEqual(agent.getEvent("message-1"), {
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
