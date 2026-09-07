import { DatabaseSync } from "node:sqlite";

import type {
  CollaborativeActionAdapter,
  CreateCollaborativeActionRequest,
} from "./action.js";
import type { BitableRecordClient } from "./bitable-state-projector.js";
import { initializeStorage } from "./storage.js";
import type { CurrentStateStore } from "./current-state-store.js";
import type { ExternalSyncStore } from "./external-sync-store.js";

export interface CollaborativeActionWorkerOptions {
  readonly databasePath: string;
  readonly actions: CollaborativeActionAdapter;
  readonly bitable: BitableRecordClient;
  readonly actionLinksTableId: string;
  readonly retryDelayMs?: number;
  readonly currentState?: CurrentStateStore;
  readonly verificationQueue?: ExternalSyncStore;
}

export interface CollaborativeActionWorker {
  runOnce(now?: string): Promise<boolean>;
  close(): void;
}

interface ActionRow {
  id: string;
  payload_json: string;
  attempt_count: number;
}

interface ActionPayload {
  readonly maxAttempts: number;
  readonly actionLinkRecordId: string;
  readonly request: CreateCollaborativeActionRequest;
}

function parsePayload(value: string): ActionPayload {
  const payload = JSON.parse(value) as unknown;
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("maxAttempts" in payload) ||
    typeof payload.maxAttempts !== "number" ||
    !("actionLinkRecordId" in payload) ||
    typeof payload.actionLinkRecordId !== "string" ||
    !("request" in payload) ||
    typeof payload.request !== "object" ||
    payload.request === null ||
    !("idempotencyKey" in payload.request) ||
    typeof payload.request.idempotencyKey !== "string" ||
    !("actionKey" in payload.request) ||
    typeof payload.request.actionKey !== "string" ||
    !("title" in payload.request) ||
    typeof payload.request.title !== "string" ||
    !("itemKey" in payload.request) ||
    typeof payload.request.itemKey !== "string" ||
    !("assigneeId" in payload.request) ||
    typeof payload.request.assigneeId !== "string" ||
    !("assigneeName" in payload.request) ||
    typeof payload.request.assigneeName !== "string" ||
    !("sourceEventId" in payload.request) ||
    typeof payload.request.sourceEventId !== "string"
  ) {
    throw new Error("Invalid Feishu Task action payload");
  }
  return payload as ActionPayload;
}

export function createCollaborativeActionWorker(
  options: CollaborativeActionWorkerOptions,
): CollaborativeActionWorker {
  const database = new DatabaseSync(options.databasePath, {
    enableForeignKeyConstraints: true,
  });
  initializeStorage(database);
  const retryDelayMs = options.retryDelayMs ?? 5_000;
  const recoveredAt = new Date().toISOString();
  database
    .prepare(
      `UPDATE outbox
       SET status = 'retry', next_attempt_at = NULL,
           last_error_json = ?, updated_at = ?
       WHERE operation_type = 'feishu_task.create_task' AND status = 'running'`,
    )
    .run(
      JSON.stringify({
        message: "Feishu Task action interrupted by service restart",
      }),
      recoveredAt,
    );

  return {
    async runOnce(now = new Date().toISOString()) {
      const row = database
        .prepare(
          `SELECT id, payload_json, attempt_count
           FROM outbox
           WHERE operation_type = 'feishu_task.create_task'
             AND status IN ('pending', 'retry')
             AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
           ORDER BY created_at ASC
           LIMIT 1`,
        )
        .get(now) as unknown as ActionRow | undefined;
      if (row === undefined) {
        return false;
      }
      const claim = database
        .prepare(
          `UPDATE outbox
           SET status = 'running', updated_at = ?
           WHERE id = ? AND status IN ('pending', 'retry')`,
        )
        .run(now, row.id);
      if (claim.changes === 0) {
        return false;
      }

      let payload: ActionPayload | undefined;
      try {
        payload = parsePayload(row.payload_json);
        const created = await options.actions.create(payload.request);
        options.currentState?.recordActionExecution({
          actionKey: payload.request.actionKey,
          sourceEventId: payload.request.sourceEventId,
          occurredAt: created.updatedAt ?? now,
          externalObjectId: created.externalId,
          status: "confirmed",
        });
        options.verificationQueue?.enqueue({
          connector: "feishu_task", entityType: "action_link",
          entityKey: payload.request.actionKey, reason: "cas_write",
          payload: { externalId: created.externalId },
        }, now);
        await options.bitable.update(
          options.actionLinksTableId,
          payload.actionLinkRecordId,
          {
            "外部对象 ID": created.externalId,
            外部链接: created.externalUrl,
            外部状态镜像: created.status,
            最近同步: now,
            同步状态: ["succeeded"],
          },
        );
        database
          .prepare(
            `UPDATE outbox
             SET status = 'succeeded', attempt_count = attempt_count + 1,
                 next_attempt_at = NULL, last_error_json = NULL, updated_at = ?
             WHERE id = ?`,
          )
          .run(now, row.id);
      } catch (error) {
        const attemptCount = row.attempt_count + 1;
        const maxAttempts = payload?.maxAttempts ?? 5;
        const status = attemptCount >= maxAttempts ? "dead" : "retry";
        const nextAttemptAt = new Date(
          Date.parse(now) + retryDelayMs * 2 ** Math.max(0, attemptCount - 1),
        ).toISOString();
        database
          .prepare(
            `UPDATE outbox
             SET status = ?, attempt_count = ?, next_attempt_at = ?,
                 last_error_json = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(
            status,
            attemptCount,
            status === "dead" ? null : nextAttemptAt,
            JSON.stringify({
              message: error instanceof Error ? error.message : String(error),
            }),
            now,
            row.id,
          );
        if (payload !== undefined) {
          if (status === "dead") {
            options.currentState?.recordActionExecution({
              actionKey: payload.request.actionKey,
              sourceEventId: payload.request.sourceEventId,
              occurredAt: now,
              status: "failed",
            });
          }
          options.verificationQueue?.enqueue({
            connector: "feishu_task", entityType: "action_link",
            entityKey: payload.request.actionKey, reason: "cas_failure",
            payload: {
              ...(options.currentState?.actionExecution(payload.request.actionKey)?.externalObjectId === undefined
                ? {}
                : { externalId: options.currentState.actionExecution(payload.request.actionKey)!.externalObjectId }),
            },
          }, now);
          try {
            await options.bitable.update(
              options.actionLinksTableId,
              payload.actionLinkRecordId,
              { 同步状态: [status === "dead" ? "conflict" : "retry"] },
            );
          } catch {
            // The durable outbox remains the source of recovery state.
          }
        }
      }
      return true;
    },

    close() {
      database.close();
    },
  };
}
