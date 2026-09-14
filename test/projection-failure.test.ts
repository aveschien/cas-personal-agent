import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createDevelopmentAgent } from "../src/development-agent.js";

test("the raw Event remains durable when State projection fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cas-agent-"));
  const agent = createDevelopmentAgent({
    databasePath: join(directory, "events.sqlite"),
    allowedUserIds: ["user-1"],
    interpreter: {
      interpret: async () => ({
        changes: [
          {
            kind: "item",
            title: "跟进张总反馈",
            type: "task",
            status: "waiting",
          },
        ],
        acknowledgement: "已记录等待事项。",
      }),
    },
    stateAdapter: {
      project: async () => {
        throw new Error("state projection unavailable");
      },
    },
  });

  try {
    await assert.rejects(
      agent.ingest({
        sourceMessageId: "message-projection-failure",
        receivedAt: "2026-09-02T17:25:00.000Z",
        userId: "user-1",
        rawText: "继续等张总反馈",
        rawPayload: { event_id: "delivery-projection-failure" },
      }),
      /state projection unavailable/,
    );
    assert.deepEqual(agent.getEvent("message-projection-failure"), {
      source: "feishu",
      sourceMessageId: "message-projection-failure",
      userId: "user-1",
      rawText: "继续等张总反馈",
      processingStatus: "degraded",
      acknowledgement: null,
    });
  } finally {
    agent.close();
    await rm(directory, { recursive: true, force: true });
  }
});
