import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createDevelopmentAgent,
  type DevelopmentAgent,
} from "../src/development-agent.js";

test("the raw Event remains durable when interpretation fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cas-agent-"));
  let agent: DevelopmentAgent;
  agent = createDevelopmentAgent({
    databasePath: join(directory, "events.sqlite"),
    allowedUserIds: ["user-1"],
    interpreter: {
      interpret: async () => {
        assert.equal(
          agent.getEvent("message-failure")?.processingStatus,
          "received",
        );
        throw new Error("interpretation unavailable");
      },
    },
    stateAdapter: {
      project: async () => {
        assert.fail("projection must not run after interpretation fails");
      },
    },
  });

  try {
    await assert.rejects(
      agent.ingest({
        sourceMessageId: "message-failure",
        receivedAt: "2026-09-02T17:05:00.000Z",
        userId: "user-1",
        rawText: "先记下来，稍后再处理",
        rawPayload: { event_id: "delivery-failure" },
      }),
      /interpretation unavailable/,
    );

    assert.deepEqual(agent.getEvent("message-failure"), {
      sourceMessageId: "message-failure",
      userId: "user-1",
      rawText: "先记下来，稍后再处理",
      processingStatus: "failed",
      acknowledgement: null,
    });
  } finally {
    agent.close();
    await rm(directory, { recursive: true, force: true });
  }
});
