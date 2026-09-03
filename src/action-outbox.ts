import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import type { ActionProjectionSink } from "./bitable-state-projector.js";
import { initializeStorage } from "./storage.js";

export interface ActionOutbox extends ActionProjectionSink {
  close(): void;
}

export function createActionOutbox(databasePath: string): ActionOutbox {
  const database = new DatabaseSync(databasePath, {
    enableForeignKeyConstraints: true,
  });
  initializeStorage(database);

  return {
    async schedule(
      action,
      actionLinkRecordId,
      itemRecordId,
      projectRecordId,
    ) {
      if (
        action.actionType !== "personal_action" ||
        action.factOwner !== "ticktick"
      ) {
        return;
      }
      const now = new Date().toISOString();
      database
        .prepare(
          `INSERT OR IGNORE INTO outbox (
            id, operation_type, idempotency_key, payload_json, status,
            attempt_count, next_attempt_at, last_error_json,
            created_at, updated_at
          ) VALUES (?, 'ticktick.create_task', ?, ?, 'pending', 0, NULL, NULL, ?, ?)`,
        )
        .run(
          randomUUID(),
          `ticktick.create:${action.key}`,
          JSON.stringify({
            maxAttempts: 5,
            actionLinkRecordId,
            itemRecordId,
            ...(projectRecordId === undefined ? {} : { projectRecordId }),
            request: {
              idempotencyKey: `ticktick.create:${action.key}`,
              actionKey: action.key,
              title: action.title,
              itemKey: action.itemKey,
              ...(action.projectKey === undefined
                ? {}
                : { projectKey: action.projectKey }),
              ...(action.deadlineAt === undefined
                ? {}
                : { deadlineAt: action.deadlineAt }),
              sourceEventId: action.sourceEventId,
            },
          }),
          now,
          now,
        );
    },

    close() {
      database.close();
    },
  };
}
