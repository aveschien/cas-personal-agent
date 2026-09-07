import assert from "node:assert/strict";
import test from "node:test";

import { parseLarkTaskChange } from "../src/lark-task-event-channel.js";

test("real Feishu Task update events become targeted verification signals", () => {
  assert.deepEqual(parseLarkTaskChange(JSON.stringify({
    schema: "2.0",
    header: { event_id: "evt-1", create_time: "1788757200000" },
    event: { task_guid: "task-guid-1", event_types: ["task_start_due_update", "task_completed_update"] },
  })), {
    eventId: "evt-1",
    occurredAt: "2026-09-07T05:00:00.000Z",
    taskGuid: "task-guid-1",
    eventTypes: ["task_start_due_update", "task_completed_update"],
  });
});
