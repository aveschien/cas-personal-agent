import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createDevelopmentAgent } from "../src/development-agent.js";

test("an unauthorized Channel user is rejected before Agent processing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cas-agent-"));
  const agent = createDevelopmentAgent({
    databasePath: join(directory, "events.sqlite"),
    allowedUserIds: ["user-1"],
    interpreter: {
      interpret: async () => {
        assert.fail("an unauthorized user must not reach interpretation");
      },
    },
    stateAdapter: {
      project: async () => {
        assert.fail("an unauthorized user must not reach state projection");
      },
    },
  });

  try {
    const result = await agent.ingest({
      sourceMessageId: "message-unauthorized",
      receivedAt: "2026-09-02T17:15:00.000Z",
      userId: "someone-else",
      rawText: "把这条内容写进去",
      rawPayload: { event_id: "delivery-unauthorized" },
    });

    assert.deepEqual(result, {
      status: "rejected",
      acknowledgement: "这个 Bot 仅供已授权用户使用。",
    });
    assert.equal(agent.getEvent("message-unauthorized"), undefined);
  } finally {
    agent.close();
    await rm(directory, { recursive: true, force: true });
  }
});
