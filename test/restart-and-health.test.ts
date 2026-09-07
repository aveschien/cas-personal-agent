import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createDevelopmentAgent, type DevelopmentAgentOptions } from "../src/development-agent.js";

test("the development service reports healthy storage and preserves Events across restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cas-agent-"));
  const databasePath = join(directory, "events.sqlite");
  const dependencies: DevelopmentAgentOptions = {
    databasePath,
    allowedUserIds: ["user-1"],
    interpreter: {
      interpret: async () => ({
        changes: [{ kind: "item", title: "准备报价页", type: "task", status: "actionable" }],
        acknowledgement: "已记录：准备报价页。",
      }),
    },
    stateAdapter: {
      project: async () => undefined,
    },
  };

  const firstRun = createDevelopmentAgent(dependencies);
  await firstRun.ingest({
    sourceMessageId: "message-before-restart",
    receivedAt: "2026-09-02T17:20:00.000Z",
    userId: "user-1",
    rawText: "准备报价页",
    rawPayload: { event_id: "delivery-before-restart" },
  });
  firstRun.close();

  const restarted = createDevelopmentAgent(dependencies);
  try {
    assert.deepEqual(restarted.health(), {
      status: "ok",
      mode: "development",
      storage: {
        journalMode: "wal",
        schemaVersion: 4,
      },
    });
    assert.equal(
      restarted.getEvent("message-before-restart")?.processingStatus,
      "completed",
    );
  } finally {
    restarted.close();
    await rm(directory, { recursive: true, force: true });
  }
});
