import { DatabaseSync } from "node:sqlite";

import { initializeStorage } from "./storage.js";

export interface BitableProjectionSnapshot {
  readonly tableId: string;
  readonly recordId: string;
  readonly stableKey: string;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly projectedAt: string;
}

export interface RememberBitableCorrection {
  readonly fingerprint: string;
  readonly tableId: string;
  readonly recordId: string;
  readonly stableKey: string;
  readonly changedFields: readonly string[];
  readonly observedAt: string;
}

export interface BitableAuthorityStore {
  getSnapshot(
    tableId: string,
    stableKey: string,
  ): BitableProjectionSnapshot | undefined;
  saveSnapshot(snapshot: BitableProjectionSnapshot): void;
  rememberCorrection(correction: RememberBitableCorrection): boolean;
  close(): void;
}

interface SnapshotRow {
  table_id: string;
  record_id: string;
  stable_key: string;
  fields_json: string;
  projected_at: string;
}

export function createBitableAuthorityStore(
  databasePath: string,
): BitableAuthorityStore {
  const database = new DatabaseSync(databasePath, {
    enableForeignKeyConstraints: true,
  });
  initializeStorage(database);

  return {
    getSnapshot(tableId, stableKey) {
      const row = database
        .prepare(
          `SELECT table_id, record_id, stable_key, fields_json, projected_at
           FROM bitable_projection_snapshots
           WHERE table_id = ? AND stable_key = ?`,
        )
        .get(tableId, stableKey) as unknown as SnapshotRow | undefined;
      if (row === undefined) {
        return undefined;
      }
      return {
        tableId: row.table_id,
        recordId: row.record_id,
        stableKey: row.stable_key,
        fields: JSON.parse(row.fields_json) as Record<string, unknown>,
        projectedAt: row.projected_at,
      };
    },

    saveSnapshot(snapshot) {
      database
        .prepare(
          `INSERT INTO bitable_projection_snapshots (
             table_id, record_id, stable_key, fields_json, projected_at
           ) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(table_id, stable_key) DO UPDATE SET
             record_id = excluded.record_id,
             fields_json = excluded.fields_json,
             projected_at = excluded.projected_at`,
        )
        .run(
          snapshot.tableId,
          snapshot.recordId,
          snapshot.stableKey,
          JSON.stringify(snapshot.fields),
          snapshot.projectedAt,
        );
    },

    rememberCorrection(correction) {
      const result = database
        .prepare(
          `INSERT OR IGNORE INTO bitable_authoritative_corrections (
             fingerprint, table_id, record_id, stable_key,
             changed_fields_json, observed_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          correction.fingerprint,
          correction.tableId,
          correction.recordId,
          correction.stableKey,
          JSON.stringify(correction.changedFields),
          correction.observedAt,
        );
      return result.changes > 0;
    },

    close() {
      database.close();
    },
  };
}

function normalized(value: unknown): unknown {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    const timestamp = Date.parse(trimmed);
    return /^\d{4}-\d{2}-\d{2}[T ]/.test(trimmed) && Number.isFinite(timestamp)
      ? timestamp
      : trimmed;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return null;
    }
    return value
      .map(normalized)
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, normalized(nested)]),
    );
  }
  return value;
}

export function bitableValuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(normalized(left)) === JSON.stringify(normalized(right));
}

export function selectBitableFields(
  fields: Readonly<Record<string, unknown>>,
  names: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(names.map((name) => [name, fields[name] ?? null]));
}
