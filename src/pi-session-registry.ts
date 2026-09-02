import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { initializeStorage } from "./storage.js";

export interface ActivatePiSession {
  readonly logicalConversationId: string;
  readonly piSessionId: string;
  readonly piSessionPath: string;
  readonly now: string;
}

export interface ActivePiSession {
  readonly logicalConversationId: string;
  readonly piSessionId: string;
  readonly piSessionPath: string;
  readonly status: "active";
  readonly turnCount: number;
  readonly lastActivityAt: string;
}

export interface PiSessionRegistry {
  activate(session: ActivatePiSession): void;
  recordCompletedTurn(piSessionId: string, now: string): void;
  getActive(logicalConversationId: string): ActivePiSession | undefined;
  close(): void;
}

interface ActivePiSessionRow {
  logical_conversation_id: string;
  pi_session_id: string;
  pi_session_path: string;
  status: "active";
  turn_count: number;
  last_activity_at: string;
}

export function createPiSessionRegistry(
  databasePath: string,
): PiSessionRegistry {
  const database = new DatabaseSync(databasePath, {
    enableForeignKeyConstraints: true,
  });
  initializeStorage(database);

  return {
    activate(session) {
      database.exec("BEGIN IMMEDIATE");
      try {
        database
          .prepare(
            `UPDATE pi_sessions
             SET status = 'retired', retired_at = ?, last_activity_at = ?
             WHERE logical_conversation_id = ?
               AND status = 'active'
               AND pi_session_id <> ?`,
          )
          .run(
            session.now,
            session.now,
            session.logicalConversationId,
            session.piSessionId,
          );
        database
          .prepare(
            `INSERT INTO pi_sessions (
              id,
              logical_conversation_id,
              pi_session_id,
              pi_session_path,
              status,
              created_at,
              last_activity_at
            ) VALUES (?, ?, ?, ?, 'active', ?, ?)
            ON CONFLICT(pi_session_id) DO UPDATE SET
              logical_conversation_id = excluded.logical_conversation_id,
              pi_session_path = excluded.pi_session_path,
              status = 'active',
              last_activity_at = excluded.last_activity_at,
              retired_at = NULL`,
          )
          .run(
            randomUUID(),
            session.logicalConversationId,
            session.piSessionId,
            session.piSessionPath,
            session.now,
            session.now,
          );
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },

    recordCompletedTurn(piSessionId, now) {
      database
        .prepare(
          `UPDATE pi_sessions
           SET turn_count = turn_count + 1,
               last_activity_at = ?
           WHERE pi_session_id = ? AND status = 'active'`,
        )
        .run(now, piSessionId);
    },

    getActive(logicalConversationId) {
      const row = database
        .prepare(
          `SELECT logical_conversation_id, pi_session_id, pi_session_path,
                  status, turn_count, last_activity_at
           FROM pi_sessions
           WHERE logical_conversation_id = ? AND status = 'active'
           ORDER BY last_activity_at DESC
           LIMIT 1`,
        )
        .get(logicalConversationId) as unknown as
        | ActivePiSessionRow
        | undefined;
      if (row === undefined) {
        return undefined;
      }
      return {
        logicalConversationId: row.logical_conversation_id,
        piSessionId: row.pi_session_id,
        piSessionPath: row.pi_session_path,
        status: row.status,
        turnCount: row.turn_count,
        lastActivityAt: row.last_activity_at,
      };
    },

    close() {
      database.close();
    },
  };
}
