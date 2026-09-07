import { createHash } from "node:crypto";

import type { CollaborativeActionAdapter, ExternalCollaborativeAction } from "./action.js";
import type { BitableRecordClient } from "./bitable-state-projector.js";
import type { CurrentStateStore } from "./current-state-store.js";
import type { ExternalSyncStore } from "./external-sync-store.js";

export interface ExternalCollaborativeSyncWorkerOptions {
  readonly currentState: CurrentStateStore;
  readonly queue: ExternalSyncStore;
  readonly actions: CollaborativeActionAdapter;
  readonly bitable?: BitableRecordClient;
  readonly actionLinksTableId?: string;
  readonly requestBudget?: number;
  readonly timeoutMs?: number;
  readonly onError?: (error: unknown) => void;
}

function fingerprint(state: ExternalCollaborativeAction): string {
  return createHash("sha256").update(JSON.stringify({
    externalId: state.externalId, status: state.status, title: state.title ?? null,
    deadlineAt: state.deadlineAt ?? null, assigneeIds: [...state.assigneeIds].sort(),
    updatedAt: state.updatedAt ?? null,
  })).digest("hex");
}

async function bounded<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`connector request timed out after ${timeoutMs}ms`)), timeoutMs);
    })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function createExternalCollaborativeSyncWorker(options: ExternalCollaborativeSyncWorkerOptions) {
  const budget = Math.max(1, options.requestBudget ?? 5);
  const timeoutMs = options.timeoutMs ?? 5_000;
  return {
    requestRefresh(actionKey: string, reason: "external_signal" | "explicit_refresh" = "explicit_refresh", now = new Date().toISOString()) {
      const local = options.currentState.actionStates("feishu_task").find((state) => state.actionKey === actionKey);
      if (local?.externalObjectId === undefined) return;
      options.queue.enqueue({
        connector: "feishu_task", entityType: "action_link", entityKey: actionKey, reason,
        payload: { externalId: local.externalObjectId },
      }, now);
    },
    signalExternalId(externalId: string, now = new Date().toISOString()) {
      const local = options.currentState.actionStates("feishu_task").find((state) => state.externalObjectId === externalId);
      if (local !== undefined) this.requestRefresh(local.actionKey, "external_signal", now);
    },
    async refreshNow(actionKey: string, now = new Date().toISOString()) {
      this.requestRefresh(actionKey, "explicit_refresh", now);
      if (!options.queue.begin("feishu_task", { requestBudget: 1, targeted: actionKey }, now)) return options.currentState.actionStates("feishu_task").find((state) => state.actionKey === actionKey);
      const claimed = options.queue.claim("feishu_task", now, actionKey);
      if (claimed === undefined) {
        options.queue.complete("feishu_task", undefined, now);
        return options.currentState.actionStates("feishu_task").find((state) => state.actionKey === actionKey);
      }
      try {
        const local = options.currentState.actionStates("feishu_task").find((state) => state.actionKey === actionKey);
        if (local?.externalObjectId === undefined) throw new Error("verification target has no external ID");
        const external = await bounded(options.actions.getState(local.externalObjectId), timeoutMs);
        options.currentState.recordExternalActionState({
          actionKey, observedAt: now, ...(external.updatedAt === undefined ? {} : { sourceUpdatedAt: external.updatedAt }),
          fingerprint: fingerprint(external), status: external.status,
          ...(external.title === undefined ? {} : { title: external.title }),
          ...(external.deadlineAt === undefined ? {} : { deadlineAt: external.deadlineAt }),
          ...(external.assigneeNames === undefined ? {} : { assignee: external.assigneeNames.join("、") || null }),
        });
        options.queue.succeed(claimed.id, now);
        options.queue.complete("feishu_task", fingerprint(external), now);
      } catch (error) {
        options.queue.fail(claimed.id, error, now);
        options.queue.failConnector("feishu_task", error, now);
        options.onError?.(error);
      }
      return options.currentState.actionStates("feishu_task").find((state) => state.actionKey === actionKey);
    },
    async runOnce(now = new Date().toISOString()) {
      if (!options.queue.begin("feishu_task", { requestBudget: budget }, now)) return false;
      try {
        for (let used = 0; used < budget; used += 1) {
          const claimed = options.queue.claim("feishu_task", now);
          if (claimed === undefined) break;
          try {
            const externalId = String(claimed.payload.externalId ?? "");
            if (externalId.length === 0) throw new Error("verification target has no external ID");
            const external = await bounded(options.actions.getState(externalId), timeoutMs);
            const local = options.currentState.actionStates("feishu_task").find((state) => state.actionKey === claimed.entityKey);
            if (local !== undefined) {
              const changed = options.currentState.recordExternalActionState({
                actionKey: local.actionKey, observedAt: now,
                ...(external.updatedAt === undefined ? {} : { sourceUpdatedAt: external.updatedAt }),
                fingerprint: fingerprint(external), status: external.status,
                ...(external.title === undefined ? {} : { title: external.title }),
                ...(external.deadlineAt === undefined ? {} : { deadlineAt: external.deadlineAt }),
                ...(external.assigneeNames === undefined ? {} : { assignee: external.assigneeNames.join("、") || null }),
              });
              if (changed && local.recordId !== undefined && options.bitable !== undefined && options.actionLinksTableId !== undefined) {
                await options.bitable.update(options.actionLinksTableId, local.recordId, {
                  ...(external.title === undefined ? {} : { 行动: external.title }),
                  外部状态镜像: external.status, 最近同步: now, 同步状态: ["succeeded"],
                  ...(external.deadlineAt === undefined ? {} : { deadline: external.deadlineAt }),
                  ...(external.assigneeNames === undefined ? {} : { 负责人: external.assigneeNames.join("、") || null }),
                });
              }
            }
            options.queue.succeed(claimed.id, now);
          } catch (error) {
            options.queue.fail(claimed.id, error, now);
            options.onError?.(error);
          }
        }
        options.queue.complete("feishu_task", undefined, now);
        return true;
      } catch (error) {
        options.queue.failConnector("feishu_task", error, now);
        options.onError?.(error);
        return true;
      }
    },
  };
}
