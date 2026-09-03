import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import type { ActionProjectionSink } from "./bitable-state-projector.js";
import { initializeStorage } from "./storage.js";

export interface CollaborativeActionOutbox extends ActionProjectionSink {
  close(): void;
}

export function createCollaborativeActionOutbox(
  databasePath: string,
): CollaborativeActionOutbox {
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
        action.actionType !== "collaborative_commitment" ||
        action.factOwner !== "feishu_task"
      ) {
        return;
      }
      if (
        action.confirmed !== true ||
        !/^ou_[A-Za-z0-9]+$/.test(action.assigneeId ?? "") ||
        (action.assignee ?? "").trim().length === 0
      ) {
        throw new Error(
          "Feishu Task creation requires explicit confirmation and a resolved assignee",
        );
      }
      const now = new Date().toISOString();
      database
        .prepare(
          `INSERT OR IGNORE INTO outbox (
            id, operation_type, idempotency_key, payload_json, status,
            attempt_count, next_attempt_at, last_error_json,
            created_at, updated_at
          ) VALUES (?, 'feishu_task.create_task', ?, ?, 'pending', 0, NULL, NULL, ?, ?)`,
        )
        .run(
          randomUUID(),
          `feishu_task.create:${action.key}`,
          JSON.stringify({
            maxAttempts: 5,
            actionLinkRecordId,
            itemRecordId,
            ...(projectRecordId === undefined ? {} : { projectRecordId }),
            request: {
              idempotencyKey: `feishu_task.create:${action.key}`,
              actionKey: action.key,
              title: action.title,
              itemKey: action.itemKey,
              ...(action.projectKey === undefined
                ? {}
                : { projectKey: action.projectKey }),
              assigneeId: action.assigneeId,
              assigneeName: action.assignee,
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
