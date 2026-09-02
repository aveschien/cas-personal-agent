import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createPiSessionRegistry } from "../src/pi-session-registry.js";

test("active Pi session metadata survives a Supervisor restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cas-agent-pi-session-"));
  const databasePath = join(directory, "events.sqlite");

  const firstRun = createPiSessionRegistry(databasePath);
  firstRun.activate({
    logicalConversationId: "cas-main",
    piSessionId: "pi-session-1",
    piSessionPath: join(directory, "pi-session-1.jsonl"),
    now: "2026-09-02T18:00:00.000Z",
  });
  firstRun.recordCompletedTurn(
    "pi-session-1",
    "2026-09-02T18:01:00.000Z",
  );
  firstRun.close();

  const restarted = createPiSessionRegistry(databasePath);
  try {
    assert.deepEqual(restarted.getActive("cas-main"), {
      logicalConversationId: "cas-main",
      piSessionId: "pi-session-1",
      piSessionPath: join(directory, "pi-session-1.jsonl"),
      status: "active",
      turnCount: 1,
      lastActivityAt: "2026-09-02T18:01:00.000Z",
    });
  } finally {
    restarted.close();
    await rm(directory, { recursive: true, force: true });
  }
});
