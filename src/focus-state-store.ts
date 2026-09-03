import { DatabaseSync } from "node:sqlite";

import { initializeStorage } from "./storage.js";

export type CognitiveMode = "explore" | "execute" | "unknown";

export interface FocusState {
  readonly logicalConversationId: string;
  readonly mode: CognitiveMode;
  readonly activeProjectRecordId?: string;
  readonly activeItemRecordId?: string;
  readonly focusStartedAt?: string;
  readonly lastConfirmedAt?: string;
}

export interface FocusStateStore {
  get(logicalConversationId: string): FocusState;
  setMode(
    logicalConversationId: string,
    mode: Exclude<CognitiveMode, "unknown">,
    now: string,
  ): void;
  setFocus(
    logicalConversationId: string,
    projectRecordId: string | undefined,
    itemRecordId: string | undefined,
    now: string,
  ): void;
  close(): void;
}

interface FocusStateRow {
  logical_conversation_id: string;
  mode: string;
  active_project_id: string | null;
  active_item_id: string | null;
  focus_started_at: string | null;
  last_confirmed_at: string | null;
}

function optional<K extends string, V>(
  key: K,
  value: V | null,
): { readonly [P in K]?: V } {
  return value === null ? {} : ({ [key]: value } as { [P in K]: V });
}

export function createFocusStateStore(databasePath: string): FocusStateStore {
  const database = new DatabaseSync(databasePath, {
    enableForeignKeyConstraints: true,
  });
  initializeStorage(database);

  const ensure = (logicalConversationId: string): void => {
    database
      .prepare(
        `INSERT OR IGNORE INTO focus_state (
           logical_conversation_id, mode, parking_lot_count
         ) VALUES (?, 'unknown', 0)`,
      )
      .run(logicalConversationId);
  };

  return {
    get(logicalConversationId) {
      ensure(logicalConversationId);
      const row = database
        .prepare(
          `SELECT logical_conversation_id, mode, active_project_id,
                  active_item_id, focus_started_at, last_confirmed_at
           FROM focus_state
           WHERE logical_conversation_id = ?`,
        )
        .get(logicalConversationId) as unknown as FocusStateRow;
      const mode: CognitiveMode = ["explore", "execute"].includes(row.mode)
        ? (row.mode as CognitiveMode)
        : "unknown";
      return {
        logicalConversationId: row.logical_conversation_id,
        mode,
        ...optional("activeProjectRecordId", row.active_project_id),
        ...optional("activeItemRecordId", row.active_item_id),
        ...optional("focusStartedAt", row.focus_started_at),
        ...optional("lastConfirmedAt", row.last_confirmed_at),
      };
    },

    setMode(logicalConversationId, mode, now) {
      ensure(logicalConversationId);
      database
        .prepare(
          `UPDATE focus_state
           SET mode = ?, last_confirmed_at = ?
           WHERE logical_conversation_id = ?`,
        )
        .run(mode, now, logicalConversationId);
    },

    setFocus(
      logicalConversationId,
      projectRecordId,
      itemRecordId,
      now,
    ) {
      ensure(logicalConversationId);
      database
        .prepare(
          `UPDATE focus_state
           SET active_project_id = ?, active_item_id = ?,
               focus_started_at = ?, last_confirmed_at = ?
           WHERE logical_conversation_id = ?`,
        )
        .run(
          projectRecordId ?? null,
          itemRecordId ?? null,
          now,
          now,
          logicalConversationId,
        );
    },

    close() {
      database.close();
    },
  };
}
