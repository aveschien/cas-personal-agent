import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createReminderStore } from "../src/reminder-store.js";

test("checkpoint projection is durable and idempotent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cas-reminders-"));
  const store = createReminderStore(join(directory, "events.sqlite"));
  const checkpoint = {
    key: "proposal-review",
    itemKey: "proposal-feedback",
    fireAt: "2026-09-04T09:00:00+08:00",
    sourceEventId: "om_reminder_1",
  };
  try {
    await store.schedule(checkpoint, "rec_item_1");
    await store.schedule(checkpoint, "rec_item_1");
    assert.deepEqual(store.get("proposal-review"), {
      key: "proposal-review",
      itemRecordId: "rec_item_1",
      fireAt: "2026-09-04T09:00:00+08:00",
      kind: "checkpoint",
      status: "pending",
      sourceEventId: "om_reminder_1",
      payload: {
        itemKey: "proposal-feedback",
      },
    });
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
