import { createHash } from "node:crypto";

import type { PersonalActionAdapter, ExternalPersonalAction } from "./action.js";
import type { BitableRecordClient } from "./bitable-state-projector.js";
import type { CurrentActionState, CurrentStateStore } from "./current-state-store.js";
import type { ExternalSyncStore } from "./external-sync-store.js";

export interface ExternalActionSyncWorkerOptions {
  readonly currentState: CurrentStateStore;
  readonly queue: ExternalSyncStore;
  readonly personal: PersonalActionAdapter;
  readonly projectId: string;
  readonly bitable?: BitableRecordClient;
  readonly actionLinksTableId?: string;
  readonly requestBudget?: number;
  readonly timeoutMs?: number;
  readonly onError?: (error: unknown) => void;
}

export interface ExternalActionSyncWorker {
  runOnce(now?: string): Promise<boolean>;
  requestRefresh(actionKey: string, now?: string): void;
}

function fingerprint(state: ExternalPersonalAction): string {
  return createHash("sha256").update(JSON.stringify({
    externalId: state.externalId,
    projectId: state.projectId,
    status: state.status,
    title: state.title ?? null,
    deadlineAt: state.deadlineAt ?? null,
    updatedAt: state.updatedAt ?? null,
  })).digest("hex");
}

async function bounded<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`connector request timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function createExternalActionSyncWorker(
  options: ExternalActionSyncWorkerOptions,
): ExternalActionSyncWorker {
  const budget = Math.max(1, options.requestBudget ?? 5);
  const timeoutMs = options.timeoutMs ?? 5_000;

  const apply = async (local: CurrentActionState, external: ExternalPersonalAction, now: string) => {
    const changed = options.currentState.recordExternalActionState({
      actionKey: local.actionKey,
      observedAt: now,
      ...(external.updatedAt === undefined ? {} : { sourceUpdatedAt: external.updatedAt }),
      fingerprint: fingerprint(external),
      status: external.status,
      ...(external.title === undefined ? {} : { title: external.title }),
      ...(external.deadlineAt === undefined ? {} : { deadlineAt: external.deadlineAt }),
    });
    if (changed && local.recordId !== undefined && options.bitable !== undefined && options.actionLinksTableId !== undefined) {
      await options.bitable.update(options.actionLinksTableId, local.recordId, {
        ...(external.title === undefined ? {} : { 行动: external.title }),
        外部状态镜像: external.status,
        最近同步: now,
        同步状态: ["succeeded"],
        ...(external.deadlineAt === undefined ? {} : { deadline: external.deadlineAt }),
      });
    }
  };

  return {
    requestRefresh(actionKey, now = new Date().toISOString()) {
      const local = options.currentState.actionStates("ticktick").find((state) => state.actionKey === actionKey);
      if (local?.externalObjectId === undefined) return;
      options.queue.enqueue({
        connector: "ticktick", entityType: "action_link", entityKey: actionKey,
        reason: "explicit_refresh",
        payload: { projectId: options.projectId, externalId: local.externalObjectId },
      }, now);
    },
    async runOnce(now = new Date().toISOString()) {
      if (options.personal.listProjectSnapshot === undefined) return false;
      if (!options.queue.begin("ticktick", { projectId: options.projectId, requestBudget: budget }, now)) return false;
      try {
        const snapshot = await bounded(options.personal.listProjectSnapshot(options.projectId), timeoutMs);
        const byId = new Map(snapshot.map((state) => [state.externalId, state]));
        const localStates = options.currentState.actionStates("ticktick")
          .filter((state) => state.externalObjectId !== undefined);
        for (const local of localStates) {
          const external = byId.get(local.externalObjectId!);
          if (external !== undefined) {
            await apply(local, external, now);
            continue;
          }
          const missingFingerprint = createHash("sha256")
            .update(`snapshot-missing:${local.externalObjectId}`)
            .digest("hex");
          options.currentState.recordExternalActionState({
            actionKey: local.actionKey,
            observedAt: now,
            fingerprint: missingFingerprint,
            status: "unknown",
            uncertaintyReason: "not present in configured open-task snapshot; completion, move, deletion, or access loss requires targeted verification",
          });
          options.queue.enqueue({
            connector: "ticktick", entityType: "action_link", entityKey: local.actionKey,
            reason: "snapshot_missing",
            payload: { projectId: options.projectId, externalId: local.externalObjectId },
          }, now);
        }

        for (let used = 1; used < budget; used += 1) {
          const claimed = options.queue.claim("ticktick", now);
          if (claimed === undefined) break;
          try {
            const projectId = String(claimed.payload.projectId ?? options.projectId);
            const externalId = String(claimed.payload.externalId ?? "");
            if (externalId.length === 0) throw new Error("verification target has no external ID");
            const external = await bounded(options.personal.getState(projectId, externalId), timeoutMs);
            const local = options.currentState.actionStates("ticktick")
              .find((state) => state.actionKey === claimed.entityKey);
            if (local !== undefined) await apply(local, external, now);
            options.queue.succeed(claimed.id, now);
          } catch (error) {
            options.queue.fail(claimed.id, error, now);
            options.onError?.(error);
          }
        }
        const aggregate = createHash("sha256")
          .update(snapshot.map(fingerprint).sort().join(":"))
          .digest("hex");
        options.queue.complete("ticktick", aggregate, now);
        return true;
      } catch (error) {
        options.queue.failConnector("ticktick", error, now);
        options.onError?.(error);
        return true;
      }
    },
  };
}
