import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { initializeStorage } from "./storage.js";

export type VerificationConnector = "ticktick" | "feishu_task" | "bitable";

export interface VerificationRequest {
  readonly connector: VerificationConnector;
  readonly entityType: string;
  readonly entityKey: string;
  readonly reason: "cas_write" | "cas_failure" | "external_signal" | "snapshot_missing" | "explicit_refresh";
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface ClaimedVerification extends VerificationRequest {
  readonly id: string;
  readonly attemptCount: number;
}

export interface ExternalSyncStore {
  enqueue(request: VerificationRequest, now?: string): void;
  claim(connector: VerificationConnector, now?: string, entityKey?: string): ClaimedVerification | undefined;
  succeed(id: string, now?: string): void;
  fail(id: string, error: unknown, now?: string, maxAttempts?: number): void;
  begin(connector: VerificationConnector, scope: unknown, now?: string): boolean;
  complete(connector: VerificationConnector, fingerprint: string | undefined, now?: string): void;
  failConnector(connector: VerificationConnector, error: unknown, now?: string): void;
  close(): void;
}

interface QueueRow {
  id: string;
  connector: VerificationConnector;
  entity_type: string;
  entity_key: string;
  reason: VerificationRequest["reason"];
  payload_json: string;
  attempt_count: number;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createExternalSyncStore(databasePath: string): ExternalSyncStore {
  const database = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });
  initializeStorage(database);
  const recoveredAt = new Date().toISOString();
  database.prepare(
    `UPDATE verification_queue SET status = 'retry', next_attempt_at = NULL,
       last_error_json = ?, updated_at = ? WHERE status = 'running'`,
  ).run(JSON.stringify({ message: "verification interrupted by restart" }), recoveredAt);
  database.prepare(
    `UPDATE connector_sync_state SET status = 'retry', next_attempt_at = NULL,
       last_error_json = ?, updated_at = ? WHERE status = 'running'`,
  ).run(JSON.stringify({ message: "sync interrupted by restart" }), recoveredAt);

  return {
    enqueue(request, now = new Date().toISOString()) {
      database.prepare(
        `INSERT INTO verification_queue (
           id, connector, entity_type, entity_key, reason, payload_json,
           status, attempt_count, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
         ON CONFLICT(connector, entity_type, entity_key, reason) DO UPDATE SET
           payload_json = excluded.payload_json,
           status = CASE WHEN verification_queue.status = 'succeeded' THEN 'pending' ELSE verification_queue.status END,
           next_attempt_at = CASE WHEN verification_queue.status = 'succeeded' THEN NULL ELSE verification_queue.next_attempt_at END,
           last_error_json = CASE WHEN verification_queue.status = 'succeeded' THEN NULL ELSE verification_queue.last_error_json END,
           updated_at = excluded.updated_at`,
      ).run(
        randomUUID(), request.connector, request.entityType, request.entityKey,
        request.reason, JSON.stringify(request.payload), now, now,
      );
    },
    claim(connector, now = new Date().toISOString(), entityKey) {
      const row = database.prepare(
        `SELECT id, connector, entity_type, entity_key, reason, payload_json, attempt_count
         FROM verification_queue WHERE connector = ? AND status IN ('pending', 'retry')
           AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
           AND (? IS NULL OR entity_key = ?)
         ORDER BY created_at, id LIMIT 1`,
      ).get(connector, now, entityKey ?? null, entityKey ?? null) as unknown as QueueRow | undefined;
      if (row === undefined) return undefined;
      const claimed = database.prepare(
        `UPDATE verification_queue SET status = 'running', updated_at = ?
         WHERE id = ? AND status IN ('pending', 'retry')`,
      ).run(now, row.id);
      if (claimed.changes === 0) return undefined;
      return {
        id: row.id,
        connector: row.connector,
        entityType: row.entity_type,
        entityKey: row.entity_key,
        reason: row.reason,
        payload: JSON.parse(row.payload_json) as Record<string, unknown>,
        attemptCount: row.attempt_count,
      };
    },
    succeed(id, now = new Date().toISOString()) {
      database.prepare(
        `UPDATE verification_queue SET status = 'succeeded', attempt_count = attempt_count + 1,
         next_attempt_at = NULL, last_error_json = NULL, updated_at = ? WHERE id = ?`,
      ).run(now, id);
    },
    fail(id, error, now = new Date().toISOString(), maxAttempts = 5) {
      const row = database.prepare("SELECT attempt_count FROM verification_queue WHERE id = ?").get(id) as
        | { attempt_count: number }
        | undefined;
      if (row === undefined) return;
      const attempts = row.attempt_count + 1;
      const dead = attempts >= maxAttempts;
      const next = new Date(Date.parse(now) + 5_000 * 2 ** Math.max(0, attempts - 1)).toISOString();
      database.prepare(
        `UPDATE verification_queue SET status = ?, attempt_count = ?, next_attempt_at = ?,
         last_error_json = ?, updated_at = ? WHERE id = ?`,
      ).run(dead ? "dead" : "retry", attempts, dead ? null : next, JSON.stringify({ message: message(error) }), now, id);
    },
    begin(connector, scope, now = new Date().toISOString()) {
      database.prepare(
        `INSERT OR IGNORE INTO connector_sync_state
         (connector, scope_json, status, failure_count, updated_at)
         VALUES (?, ?, 'idle', 0, ?)`,
      ).run(connector, JSON.stringify(scope), now);
      const result = database.prepare(
        `UPDATE connector_sync_state SET scope_json = ?, status = 'running',
         last_started_at = ?, updated_at = ? WHERE connector = ?
         AND status != 'running' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)`,
      ).run(JSON.stringify(scope), now, now, connector, now);
      return result.changes === 1;
    },
    complete(connector, fingerprint, now = new Date().toISOString()) {
      database.prepare(
        `UPDATE connector_sync_state SET status = 'idle', last_succeeded_at = ?,
         next_attempt_at = NULL, failure_count = 0, last_error_json = NULL,
         last_fingerprint = COALESCE(?, last_fingerprint), updated_at = ? WHERE connector = ?`,
      ).run(now, fingerprint ?? null, now, connector);
    },
    failConnector(connector, error, now = new Date().toISOString()) {
      const row = database.prepare("SELECT failure_count FROM connector_sync_state WHERE connector = ?").get(connector) as
        | { failure_count: number }
        | undefined;
      const failures = (row?.failure_count ?? 0) + 1;
      const next = new Date(Date.parse(now) + 5_000 * 2 ** Math.min(failures - 1, 6)).toISOString();
      database.prepare(
        `UPDATE connector_sync_state SET status = 'retry', failure_count = ?, next_attempt_at = ?,
         last_error_json = ?, updated_at = ? WHERE connector = ?`,
      ).run(failures, next, JSON.stringify({ message: message(error) }), now, connector);
    },
    close() { database.close(); },
  };
}
