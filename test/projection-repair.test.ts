import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createDevelopmentAgent } from "../src/development-agent.js";

test("a Bitable projection failure degrades the Event and queues one bounded repair", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cas-agent-repair-"));
  const databasePath = join(directory, "events.sqlite");
  const change = {
    kind: "item" as const,
    title: "跟进张总反馈",
    type: "task" as const,
    status: "waiting" as const,
  };
  const agent = createDevelopmentAgent({
    databasePath,
    allowedUserIds: ["user-1"],
    interpreter: {
      interpret: async () => ({
        changes: [change],
        acknowledgement: "已记录等待事项。",
      }),
    },
    stateAdapter: {
      project: async () => {
        throw new Error("Bitable unavailable");
      },
    },
  });

  try {
    await assert.rejects(
      agent.ingest({
        sourceMessageId: "message-projection-repair",
        receivedAt: "2026-09-02T17:25:00.000Z",
        userId: "user-1",
        rawText: "继续等张总反馈",
        rawPayload: { event_id: "delivery-projection-repair" },
      }),
      /Bitable unavailable/,
    );

    assert.equal(
      agent.getEvent("message-projection-repair")?.processingStatus,
      "degraded",
    );
    assert.deepEqual(agent.getRepair("message-projection-repair"), {
      operationType: "bitable.project",
      idempotencyKey: "bitable.project:message-projection-repair",
      status: "retry",
      attemptCount: 1,
      maxAttempts: 5,
      payload: {
        sourceEventId: "message-projection-repair",
        changes: [change],
      },
      lastError: "Bitable unavailable",
    });
  } finally {
    agent.close();
    await rm(directory, { recursive: true, force: true });
  }
});
