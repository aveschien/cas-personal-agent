import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { createBitableStateProjector } from "./bitable-state-projector.js";
import { createLarkBaseClient } from "./lark-base-client.js";
import { createPiSdkRuntime } from "./pi-sdk-runtime.js";
import { createReminderStore } from "./reminder-store.js";
import {
  compileBitableProjection,
  isSemanticOperation,
} from "./state-operations.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

export async function runMixedInputSmoke(cwd = process.cwd()): Promise<void> {
  const runtime = await createPiSdkRuntime({
    cwd,
    sessionDirectory: join(cwd, "var", "pi-mixed-smoke-v3"),
    modelName: process.env.CAS_PI_MODEL ?? "openai-codex/gpt-5.6-luna",
  });
  const reminders = createReminderStore(
    join(cwd, "var", "mixed-smoke.sqlite"),
  );
  const projector = createBitableStateProjector({
    client: createLarkBaseClient({
      baseToken: required("CAS_BITABLE_BASE_TOKEN"),
    }),
    tables: {
      projects: required("CAS_BITABLE_PROJECTS_TABLE_ID"),
      items: required("CAS_BITABLE_ITEMS_TABLE_ID"),
      actionLinks: required("CAS_BITABLE_ACTION_LINKS_TABLE_ID"),
    },
    reminders,
  });

  try {
    const mixed = await runtime.runTurn(
      JSON.stringify({
        trustedContext: {
          receivedAt: "2026-09-02T16:00:00.000Z",
          receivedLocalDateTime: "2026-09-02 09:00:00",
          userTimeZone: "America/Los_Angeles",
        },
        userMessage:
          "张总说方案这周应该有反馈，2026年9月4日上午9点如果没消息我再找他。今晚11点前把病理那页 PPT 改一下。数据治理那里也许可以换个讲法，不过先别管。",
      }),
    );
    assert.ok(mixed.changes.every(isSemanticOperation));
    const operations = mixed.changes.filter(isSemanticOperation);
    const kinds = new Set(operations.map((operation) => operation.kind));
    for (const requiredKind of [
      "set_waiting",
      "plan_action",
      "park_idea",
    ]) {
      assert.ok(kinds.has(requiredKind as never), `missing ${requiredKind}`);
    }
    assert.equal(kinds.has("create_scheduled_event"), false);
    const plan = compileBitableProjection({
      sourceEventId: "dev-pi-mixed-001",
      operations,
    });
    assert.equal(plan.checkpoints.length, 1);
    assert.equal(
      plan.actionLinks.find(
        (action) => action.actionType === "personal_action",
      )?.deadlineAt,
      "2026-09-02T23:00:00-07:00",
    );
    await projector.project({
      sourceEventId: "dev-pi-mixed-001",
      operations,
    });

    const ambiguous = await runtime.runTurn(
      JSON.stringify({
        trustedContext: {
          receivedAt: "2026-09-02T16:05:00.000Z",
          receivedLocalDateTime: "2026-09-02 09:05:00",
          userTimeZone: "America/Los_Angeles",
        },
        userMessage: "下周想和院方开个会。",
      }),
    );
    assert.ok(ambiguous.changes.every(isSemanticOperation));
    const ambiguousOperations = ambiguous.changes.filter(isSemanticOperation);
    const clarificationOperations = ambiguousOperations.filter(
      (operation) => operation.kind === "clarify",
    );
    assert.ok(clarificationOperations.length <= 1);
    assert.equal(
      ambiguousOperations.some(
        (operation) => operation.kind === "create_scheduled_event",
      ),
      false,
    );
    assert.match(ambiguous.acknowledgement, /[？?]/);

    console.log(
      JSON.stringify({
        status: "ok",
        sessionId: runtime.sessionId,
        mixedOperationKinds: [...kinds],
        acknowledgement: mixed.acknowledgement,
        ambiguousClarifications:
          clarificationOperations.length === 1 ? "operation" : "reply",
        ambiguousAcknowledgement: ambiguous.acknowledgement,
      }),
    );
  } finally {
    runtime.dispose();
    reminders.close();
  }
}

const executable = process.argv[1];
if (
  executable !== undefined &&
  pathToFileURL(executable).href === import.meta.url
) {
  runMixedInputSmoke().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
