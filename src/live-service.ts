import { createHash } from "node:crypto";

import { createActionOutbox } from "./action-outbox.js";
import { createActionWorker } from "./action-worker.js";
import type {
  CollaborativeActionAdapter,
  PersonalActionAdapter,
} from "./action.js";
import type { CollaboratorResolver } from "./collaborator.js";
import type { AuthoritativeActionReader } from "./authoritative-action-reader.js";
import {
  createAuthoritativeBitableReader,
  type AuthoritativeBitableReader,
} from "./authoritative-bitable-reader.js";
import { createBitableAuthorityStore } from "./bitable-authority-store.js";
import {
  createCurrentAttentionResolver,
  type CurrentAttentionResolver,
} from "./current-attention.js";
import { createCollaborativeActionOutbox } from "./collaborative-action-outbox.js";
import { createCollaborativeActionWorker } from "./collaborative-action-worker.js";
import {
  createDevelopmentAgent,
  type ChannelEvent,
} from "./development-agent.js";
import {
  createHttpIngestServer,
  type HttpIngestServer,
} from "./http-ingest-server.js";
import { isLoopbackHost } from "./live-config.js";
import { createSerialQueue } from "./serial-queue.js";
import {
  createBitableStateProjector,
  type BitableStateProjector,
  type BitableTables,
} from "./bitable-state-projector.js";
import { createLarkBaseClient } from "./lark-base-client.js";
import {
  createHindsightMemoryAdapter,
  type MemoryAdapter,
} from "./memory.js";
import { createMemoryRetainWorker } from "./memory-retain-worker.js";
import {
  createLarkEventChannel,
  type LarkEventChannel,
} from "./lark-event-channel.js";
import { createLarkCollaboratorResolver } from "./lark-collaborator-resolver.js";
import {
  createLarkReplyAdapter,
  processCommandRunner,
  type ReplyAdapter,
} from "./lark-reply-adapter.js";
import { createLarkReminderNotifier } from "./lark-reminder-notifier.js";
import { createLarkTaskActionAdapter } from "./lark-task-action-adapter.js";
import {
  createLarkMessageImageLoader,
  type MessageImageLoader,
} from "./lark-message-images.js";
import { createMessageBatcher } from "./message-batcher.js";
import {
  createPiInterpreter,
  type PiConversationRuntime,
} from "./pi-interpreter.js";
import { createPiSdkRuntime } from "./pi-sdk-runtime.js";
import type { PiContextTools, PiThinkingLevel } from "./pi-sdk-runtime.js";
import { createPiSessionRegistry } from "./pi-session-registry.js";
import { createProjectionRepairWorker } from "./projection-repair-worker.js";
import { createReminderStore } from "./reminder-store.js";
import {
  createReminderWorker,
  type ReminderNotifier,
} from "./reminder-worker.js";
import { isSemanticOperation } from "./state-operations.js";
import { createSupervisor } from "./supervisor.js";
import { createTickTickActionAdapter } from "./ticktick-action-adapter.js";
import { createFocusStateStore } from "./focus-state-store.js";
import { createCurrentStateStore } from "./current-state-store.js";
import { createExternalSyncStore } from "./external-sync-store.js";
import { createExternalActionSyncWorker } from "./external-action-sync-worker.js";
import { createExternalCollaborativeSyncWorker } from "./external-collaborative-sync-worker.js";
import { createLarkTaskEventChannel, type LarkTaskEventChannel } from "./lark-task-event-channel.js";
import { createWorkingSetStore } from "./working-set-store.js";

export interface LiveServiceConfig {
  readonly cwd: string;
  readonly databasePath: string;
  readonly allowedUserIds: readonly string[];
  readonly piSessionDirectory: string;
  readonly piModel: string;
  readonly piThinkingLevel?: PiThinkingLevel;
  readonly bitableBaseToken: string;
  readonly bitableTables: BitableTables;
  readonly memory: {
    readonly enabled: boolean;
    readonly baseUrl: string;
    readonly bankId: string;
    readonly recallTimeoutMs: number;
    readonly recallMaxResults: number;
    readonly recallMaxTokens: number;
  };
  readonly personalActions?:
    | { readonly enabled: false }
    | {
        readonly enabled: true;
        readonly apiToken: string;
        readonly projectId: string;
        readonly baseUrl: string;
      };
  readonly collaborativeActions?: { readonly enabled: boolean };
  readonly messageBatching?: {
    readonly enabled: boolean;
    readonly settleMs: number;
    readonly maxWaitMs: number;
  };
  readonly externalSync?: {
    readonly intervalMs?: number;
    readonly requestBudget?: number;
    readonly timeoutMs?: number;
  };
  readonly httpIngest?:
    | { readonly enabled: false }
    | {
        readonly enabled: true;
        readonly host: string;
        readonly port: number;
        readonly token: string;
        readonly queueWaitMs?: number;
      };
}

export const defaultHttpIngestQueueWaitMs = 120_000;

export interface LiveService {
  start(): Promise<void>;
  stop(): Promise<void>;
  waitForExit(): Promise<void>;
  httpIngestUrl(): string | undefined;
}

export interface RuntimeFactoryInput {
  readonly cwd: string;
  readonly sessionDirectory: string;
  readonly modelName: string;
  readonly thinkingLevel: PiThinkingLevel;
  readonly memoryEnabled: boolean;
  readonly personalActionsEnabled: boolean;
  readonly collaborativeActionsEnabled: boolean;
  readonly collaboratorResolver?: CollaboratorResolver;
  readonly contextTools?: PiContextTools;
}

export interface LiveServiceDependencies {
  readonly channel?: LarkEventChannel;
  readonly replies?: ReplyAdapter;
  readonly runtimeFactory?: (
    input: RuntimeFactoryInput,
  ) => Promise<PiConversationRuntime>;
  readonly clock?: () => string;
  readonly onError?: (error: unknown) => void;
  readonly stateProjector?: BitableStateProjector;
  readonly memoryAdapter?: MemoryAdapter;
  readonly personalActionAdapter?: PersonalActionAdapter;
  readonly collaborativeActionAdapter?: CollaborativeActionAdapter;
  readonly collaboratorResolver?: CollaboratorResolver;
  readonly authoritativeActionReader?: AuthoritativeActionReader;
  readonly authoritativeBitableReader?: AuthoritativeBitableReader;
  readonly currentAttentionResolver?: CurrentAttentionResolver;
  readonly messageImageLoader?: MessageImageLoader;
  readonly reminderNotifier?: ReminderNotifier;
  readonly taskEventChannel?: LarkTaskEventChannel;
  readonly ingestHttp?: HttpIngestServer;
}

export async function createLiveService(
  config: LiveServiceConfig,
  dependencies: LiveServiceDependencies = {},
): Promise<LiveService> {
  const onError =
    dependencies.onError ?? ((error: unknown) => console.error(error));
  const registry = createPiSessionRegistry(config.databasePath);
  const currentStateStore = createCurrentStateStore(config.databasePath);
  const externalSyncStore = createExternalSyncStore(config.databasePath);
  const workingSetStore = createWorkingSetStore(config.databasePath);
  const collaborativeActionsEnabled =
    config.collaborativeActions?.enabled === true;
  const collaboratorResolver = collaborativeActionsEnabled
    ? (dependencies.collaboratorResolver ?? createLarkCollaboratorResolver())
    : undefined;
  const memory = config.memory.enabled
    ? (dependencies.memoryAdapter ?? createHindsightMemoryAdapter({ baseUrl: config.memory.baseUrl, bankId: config.memory.bankId }))
    : undefined;
  let refreshCurrentAction = async (actionKey: string): Promise<unknown> => {
    const action = currentStateStore.actionStates().find((candidate) => candidate.actionKey === actionKey);
    if (action?.externalObjectId === undefined || action.factOwner === "bitable") return { refreshed: false, reason: "unknown action or no external object" };
    externalSyncStore.enqueue({ connector: action.factOwner, entityType: "action_link", entityKey: action.actionKey, reason: "explicit_refresh", payload: { externalId: action.externalObjectId } });
    return { refreshed: false, queued: true, actionKey, currentStatus: action.externalStatus };
  };
  const contextTools: PiContextTools = {
    queryLocal({ entity, query, limit }) {
      const needle = query?.trim().toLocaleLowerCase("zh-CN");
      const state = currentStateStore.snapshot();
      if (entity === "project") {
        return { results: state.projects.filter((project) => needle === undefined || `${project.name} ${project.key}`.toLocaleLowerCase("zh-CN").includes(needle)).slice(0, limit).map((project) => ({ key: project.key, name: project.name, status: project.status, ...(project.summary == null ? {} : { summary: project.summary.slice(0, 500) }) })) };
      }
      const matches = state.items.filter((item) => needle === undefined || `${item.title} ${item.key}`.toLocaleLowerCase("zh-CN").includes(needle));
      return { results: (entity === "attention" ? matches.filter((item) => ["actionable", "in_progress", "scheduled", "waiting"].includes(item.status)) : matches).slice(0, limit).map((item) => ({ key: item.key, title: item.title, status: item.status, ...(item.projectKey == null ? {} : { projectKey: item.projectKey }), ...(item.nextAction == null ? {} : { nextAction: item.nextAction.slice(0, 500) }) })) };
    },
    async searchMemory({ query, limit, maxTokens }) {
      return memory === undefined ? [] : await memory.recall({ query, maxResults: limit, maxTokens, signal: new AbortController().signal });
    },
    refreshAction: (actionKey) => refreshCurrentAction(actionKey),
  };
  let runtime: PiConversationRuntime;
  try {
    runtime = await (dependencies.runtimeFactory ?? createPiSdkRuntime)({
      cwd: config.cwd,
      sessionDirectory: config.piSessionDirectory,
      modelName: config.piModel,
      thinkingLevel: config.piThinkingLevel ?? "max",
      memoryEnabled: config.memory.enabled,
      personalActionsEnabled: config.personalActions?.enabled === true,
      collaborativeActionsEnabled,
      contextTools,
      ...(collaboratorResolver === undefined ? {} : { collaboratorResolver }),
    });
  } catch (error) {
    externalSyncStore.close();
    workingSetStore.close();
    currentStateStore.close();
    registry.close();
    throw error;
  }

  const ownsStateProjector = dependencies.stateProjector === undefined;
  const reminderStore = ownsStateProjector
    ? createReminderStore(config.databasePath)
    : undefined;
  const actionOutbox =
    ownsStateProjector && config.personalActions?.enabled === true
      ? createActionOutbox(config.databasePath)
      : undefined;
  const collaborativeActionOutbox =
    ownsStateProjector && collaborativeActionsEnabled
      ? createCollaborativeActionOutbox(config.databasePath)
      : undefined;
  const bitableClient = ownsStateProjector
    ? createLarkBaseClient({ baseToken: config.bitableBaseToken })
    : undefined;
  const bitableAuthorityStore =
    bitableClient === undefined
      ? undefined
      : createBitableAuthorityStore(config.databasePath);
  const focusStateStore =
    bitableClient === undefined
      ? undefined
      : createFocusStateStore(config.databasePath);
  const personalActionAdapter =
    config.personalActions?.enabled === true
      ? (dependencies.personalActionAdapter ??
        createTickTickActionAdapter({
          apiToken: config.personalActions.apiToken,
          projectId: config.personalActions.projectId,
          baseUrl: config.personalActions.baseUrl,
        }))
      : undefined;
  const collaborativeActionAdapter = collaborativeActionsEnabled
    ? (dependencies.collaborativeActionAdapter ??
      createLarkTaskActionAdapter())
    : undefined;
  const remoteBitable =
    dependencies.authoritativeBitableReader ??
    (bitableClient === undefined || bitableAuthorityStore === undefined
      ? undefined
      : createAuthoritativeBitableReader({
          bitable: bitableClient,
          tables: config.bitableTables,
          store: bitableAuthorityStore,
        }));
  const synchronizeBitable = async (observedAt: string): Promise<void> => {
    if (remoteBitable === undefined || !externalSyncStore.begin("bitable", config.bitableTables, observedAt)) return;
    let timeout: NodeJS.Timeout | undefined;
    try {
      const work = Promise.all([
        remoteBitable.reconcile(observedAt),
        bitableClient?.list(config.bitableTables.actionLinks, [
          "action_key",
          "行动",
          "行动类型",
          "事实源",
          "所属事项",
          "所属项目",
          "负责人",
          "assignee_id",
          "deadline",
          "开始时间",
          "结束时间",
          "外部对象 ID",
          "外部状态镜像",
          "最近同步",
        ]) ?? Promise.resolve([]),
      ]);
      const [reconciliation, actionRecords] = await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error(`Bitable sync timed out after ${config.externalSync?.timeoutMs ?? 5_000}ms`)), config.externalSync?.timeoutMs ?? 5_000);
        }),
      ]);
      currentStateStore.importBitable(
        reconciliation,
        observedAt,
        actionRecords,
      );
      externalSyncStore.complete("bitable", createHash("sha256").update(JSON.stringify({ reconciliation, actionRecords })).digest("hex"), observedAt);
    } catch (error) {
      externalSyncStore.failConnector("bitable", error, observedAt);
      onError(error);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  };
  if (dependencies.authoritativeBitableReader === undefined && remoteBitable !== undefined) {
    await synchronizeBitable(dependencies.clock?.() ?? new Date().toISOString());
  }
  const authoritativeActions = dependencies.authoritativeActionReader ?? {
    reconcile: async () => ({
      states: currentStateStore.actionStates().filter((state) => state.factOwner !== "bitable" && state.externalStatus !== "unknown").map((state) => ({
        actionKey: state.actionKey,
        title: state.title,
        factOwner: state.factOwner as "ticktick" | "feishu_task",
        status: state.externalStatus as "open" | "completed",
        ...(state.deadlineAt === undefined ? {} : { deadlineAt: state.deadlineAt }),
        correctedFields: [],
      })),
      memoryCandidates: [],
    }),
  };
  const authoritativeBitable =
    dependencies.authoritativeBitableReader ?? {
      reconcile: async () => currentStateStore.read(),
    };
  const currentAttention =
    dependencies.currentAttentionResolver ??
    (bitableClient === undefined || focusStateStore === undefined
      ? undefined
      : createCurrentAttentionResolver({
          logicalConversationId: "cas-main",
          bitable: bitableClient,
          itemsTableId: config.bitableTables.items,
          actionLinksTableId: config.bitableTables.actionLinks,
          focus: focusStateStore,
          localActionTimings: () => currentStateStore.actionStates().map((action) => ({
            itemKey: action.itemKey,
            status: action.externalStatus,
            ...(action.deadlineAt === undefined ? {} : { deadlineAt: action.deadlineAt }),
          })),
          syncDerivedView: false,
          onSyncError: onError,
        }));
  const interpreter = createPiInterpreter({
    logicalConversationId: "cas-main",
    registry,
    runtime,
    ...(memory === undefined ? {} : { memory }),
    ...(authoritativeActions === undefined
      ? {}
      : { authoritativeActions }),
    ...(authoritativeBitable === undefined
      ? {}
      : { authoritativeBitable }),
    ...(currentAttention === undefined ? {} : { currentAttention }),
    memoryRecallTimeoutMs: config.memory.recallTimeoutMs,
    memoryRecallMaxResults: config.memory.recallMaxResults,
    memoryRecallMaxTokens: config.memory.recallMaxTokens,
    onMemoryError: onError,
    onCurrentStateError: onError,
    workingSet: workingSetStore,
    currentStateSnapshot: () => currentStateStore.snapshot(),
    ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
  });
  const stateProjector =
    dependencies.stateProjector ??
    createBitableStateProjector({
      client: bitableClient!,
      tables: config.bitableTables,
      reminders: reminderStore!,
      ...(bitableAuthorityStore === undefined
        ? {}
        : { authority: bitableAuthorityStore }),
      currentState: currentStateStore,
      ...(actionOutbox === undefined && collaborativeActionOutbox === undefined
        ? {}
        : {
            actions: {
              async schedule(
                action,
                actionLinkRecordId,
                itemRecordId,
                projectRecordId,
              ) {
                await actionOutbox?.schedule(
                  action,
                  actionLinkRecordId,
                  itemRecordId,
                  projectRecordId,
                );
                await collaborativeActionOutbox?.schedule(
                  action,
                  actionLinkRecordId,
                  itemRecordId,
                  projectRecordId,
                );
              },
            },
          }),
    });
  const agent = createDevelopmentAgent({
    databasePath: config.databasePath,
    allowedUserIds: config.allowedUserIds,
    interpreter,
    stateAdapter: {
      async project(changes, context) {
        if (!changes.every(isSemanticOperation)) {
          throw new Error("Pi returned a non-semantic production state change");
        }
        if (!ownsStateProjector) {
          currentStateStore.apply({
            sourceKind: "user_intent",
            sourceEventId: context.sourceEventId,
            occurredAt: context.receivedAt,
            operations: changes,
          });
        }
        try {
          await stateProjector.project({
            sourceEventId: context.sourceEventId,
            occurredAt: context.receivedAt,
            operations: changes,
          });
        } catch (error) {
          currentStateStore.markProjectionFailed(
            context.sourceEventId,
            new Date().toISOString(),
          );
          throw error;
        }
      },
    },
    memoryRetentionEnabled: config.memory.enabled,
    onBackgroundError: onError,
  });
  const repairWorker = createProjectionRepairWorker({
    databasePath: config.databasePath,
    projector: stateProjector,
  });
  const memoryWorker =
    memory === undefined
      ? undefined
      : createMemoryRetainWorker({
          databasePath: config.databasePath,
          memory,
        });
  const reminderWorker =
    reminderStore === undefined
      ? undefined
      : createReminderWorker({
          databasePath: config.databasePath,
        notifier:
            dependencies.reminderNotifier ??
            createLarkReminderNotifier({
              userId: config.allowedUserIds[0]!,
              runner: processCommandRunner,
            }),
          onVerificationNeeded(action) {
            externalSyncStore.enqueue({
              connector: action.factOwner, entityType: "action_link", entityKey: action.actionKey,
              reason: "explicit_refresh", payload: { externalId: action.externalObjectId, ...(action.factOwner === "ticktick" && config.personalActions?.enabled === true ? { projectId: config.personalActions.projectId } : {}) },
            });
          },
        });
  const actionWorker =
    actionOutbox === undefined ||
    bitableClient === undefined ||
    config.personalActions?.enabled !== true
      ? undefined
      : createActionWorker({
          databasePath: config.databasePath,
          actions: personalActionAdapter!,
          bitable: bitableClient,
          actionLinksTableId: config.bitableTables.actionLinks,
          currentState: currentStateStore,
          verificationQueue: externalSyncStore,
        });
  const collaborativeActionWorker =
    collaborativeActionOutbox === undefined || bitableClient === undefined
      ? undefined
      : createCollaborativeActionWorker({
          databasePath: config.databasePath,
          actions: collaborativeActionAdapter!,
          bitable: bitableClient,
          actionLinksTableId: config.bitableTables.actionLinks,
          currentState: currentStateStore,
          verificationQueue: externalSyncStore,
        });
  const channel = dependencies.channel ?? createLarkEventChannel();
  const replies = dependencies.replies ?? createLarkReplyAdapter();
  const ingestTurns = createSerialQueue();
  const serializedIngest = (event: ChannelEvent) =>
    ingestTurns.run(() => agent.ingest(event));
  const httpIngestQueueWaitMs =
    config.httpIngest?.enabled === true
      ? (config.httpIngest.queueWaitMs ?? defaultHttpIngestQueueWaitMs)
      : defaultHttpIngestQueueWaitMs;
  const serializedHttpIngest = (event: ChannelEvent) =>
    ingestTurns.run(() => agent.ingest(event), {
      waitTimeoutMs: httpIngestQueueWaitMs,
    });
  const ingestHttp =
    dependencies.ingestHttp ??
    (config.httpIngest?.enabled === true
      ? createHttpIngestServer({
          host: config.httpIngest.host,
          port: config.httpIngest.port,
          token: config.httpIngest.token,
          ingest: serializedHttpIngest,
          ...(dependencies.clock === undefined
            ? {}
            : { clock: dependencies.clock }),
        })
      : undefined);
  const batcher =
    config.messageBatching?.enabled === true
      ? createMessageBatcher({
          databasePath: config.databasePath,
          allowedUserIds: config.allowedUserIds,
          agent: { ingest: serializedIngest },
          replies,
          images:
            dependencies.messageImageLoader ?? createLarkMessageImageLoader(),
          settleMs: config.messageBatching.settleMs,
          maxWaitMs: config.messageBatching.maxWaitMs,
          onError,
        })
      : undefined;
  const supervisor = createSupervisor({
    channel,
    replies,
    agent: { ingest: serializedIngest },
    ...(batcher === undefined ? {} : { batcher }),
    onError,
  });
  const externalActionSync =
    config.personalActions?.enabled === true && personalActionAdapter?.listProjectSnapshot !== undefined
      ? createExternalActionSyncWorker({
          currentState: currentStateStore,
          queue: externalSyncStore,
          personal: personalActionAdapter,
          projectId: config.personalActions.projectId,
          ...(bitableClient === undefined ? {} : { bitable: bitableClient, actionLinksTableId: config.bitableTables.actionLinks }),
          requestBudget: config.externalSync?.requestBudget ?? 5,
          timeoutMs: config.externalSync?.timeoutMs ?? 5_000,
          onError,
        })
      : undefined;
  const externalCollaborativeSync = collaborativeActionAdapter === undefined
    ? undefined
    : createExternalCollaborativeSyncWorker({
        currentState: currentStateStore,
        queue: externalSyncStore,
        actions: collaborativeActionAdapter,
        ...(bitableClient === undefined ? {} : { bitable: bitableClient, actionLinksTableId: config.bitableTables.actionLinks }),
        requestBudget: config.externalSync?.requestBudget ?? 5,
        timeoutMs: config.externalSync?.timeoutMs ?? 5_000,
        onError,
      });
  refreshCurrentAction = async (actionKey) => {
    const action = currentStateStore.actionStates().find((candidate) => candidate.actionKey === actionKey);
    if (action === undefined || action.factOwner === "bitable") return { refreshed: false, reason: "unknown or locally-owned action" };
    const refreshed = action.factOwner === "ticktick"
      ? await externalActionSync?.refreshNow(actionKey)
      : await externalCollaborativeSync?.refreshNow(actionKey);
    return refreshed === undefined
      ? { refreshed: false, queued: true, actionKey, currentStatus: action.externalStatus }
      : { refreshed: refreshed.lastVerifiedAt !== action.lastVerifiedAt, ...(refreshed.lastVerifiedAt === action.lastVerifiedAt ? { queued: true } : {}), actionKey, currentStatus: refreshed.externalStatus, lastVerifiedAt: refreshed.lastVerifiedAt ?? null, uncertaintyReason: refreshed.uncertaintyReason ?? null };
  };
  const taskEventChannel = collaborativeActionsEnabled
    ? (dependencies.taskEventChannel ?? createLarkTaskEventChannel())
    : undefined;
  let started = false;
  let stopped = false;
  let repairTimer: NodeJS.Timeout | undefined;
  let externalSyncTimer: NodeJS.Timeout | undefined;
  let repairRun = Promise.resolve();
  let externalSyncRun = Promise.resolve();
  const runExternalSync = (includeSnapshots = true): void => {
    externalSyncRun = externalSyncRun.then(async () => {
      if (includeSnapshots) await externalActionSync?.runOnce();
      await externalCollaborativeSync?.runOnce();
      if (includeSnapshots) await synchronizeBitable(dependencies.clock?.() ?? new Date().toISOString());
    }).catch(onError);
  };
  const drainRepairs = (): void => {
    repairRun = repairRun
      .then(async () => {
        for (let count = 0; count < 10; count += 1) {
          if (!(await repairWorker.runOnce())) {
            break;
          }
        }
        if (memoryWorker !== undefined) {
          for (let count = 0; count < 10; count += 1) {
            if (!(await memoryWorker.runOnce())) {
              break;
            }
          }
        }
        if (actionWorker !== undefined) {
          for (let count = 0; count < 10; count += 1) {
            if (!(await actionWorker.runOnce())) {
              break;
            }
          }
        }
        if (collaborativeActionWorker !== undefined) {
          for (let count = 0; count < 10; count += 1) {
            if (!(await collaborativeActionWorker.runOnce())) {
              break;
            }
          }
        }
        if (reminderWorker !== undefined) {
          for (let count = 0; count < 10; count += 1) {
            if (!(await reminderWorker.runOnce())) {
              break;
            }
          }
        }
      })
      .catch(onError);
  };

  return {
    async start() {
      if (stopped) {
        throw new Error("Live service cannot restart after it has stopped");
      }
      if (started) {
        return;
      }
      try {
        await supervisor.start();
      } catch (error) {
        await supervisor.stop().catch(onError);
        throw error;
      }
      try {
        await ingestHttp?.start();
        if (
          config.httpIngest?.enabled === true &&
          !isLoopbackHost(config.httpIngest.host)
        ) {
          onError(
            new Error(
              `CAS_INGEST_HOST=${config.httpIngest.host} is not loopback; HTTP ingest is reachable beyond this machine`,
            ),
          );
        }
      } catch (error) {
        await ingestHttp?.stop().catch(onError);
        const detail = error instanceof Error ? error.message : String(error);
        onError(
          new Error(
            `HTTP ingest failed to start; Feishu ingress continues: ${detail}`,
          ),
        );
      }
      try {
        await taskEventChannel?.start((signal) => {
          externalCollaborativeSync?.signalExternalId(signal.taskGuid, signal.occurredAt);
          runExternalSync(false);
        });
      } catch (error) {
        await ingestHttp?.stop().catch(onError);
        await taskEventChannel?.stop().catch(onError);
        await supervisor.stop().catch(onError);
        throw error;
      }
      started = true;
      drainRepairs();
      repairTimer = setInterval(drainRepairs, 5_000);
      repairTimer.unref();
      runExternalSync();
      externalSyncTimer = setInterval(runExternalSync, config.externalSync?.intervalMs ?? 60_000);
      externalSyncTimer.unref();
    },

    waitForExit() {
      return channel.waitForExit();
    },

    httpIngestUrl() {
      return ingestHttp?.url();
    },

    async stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      try {
        if (repairTimer !== undefined) {
          clearInterval(repairTimer);
        }
        if (externalSyncTimer !== undefined) clearInterval(externalSyncTimer);
        await ingestHttp?.stop();
        await supervisor.stop();
        await taskEventChannel?.stop();
        drainRepairs();
        await repairRun;
        await externalSyncRun;
      } finally {
        interpreter.dispose();
        agent.close();
        registry.close();
        reminderStore?.close();
        actionOutbox?.close();
        collaborativeActionOutbox?.close();
        repairWorker.close();
        memoryWorker?.close();
        actionWorker?.close();
        collaborativeActionWorker?.close();
        reminderWorker?.close();
        bitableAuthorityStore?.close();
        focusStateStore?.close();
        currentStateStore.close();
        externalSyncStore.close();
        workingSetStore.close();
      }
    },
  };
}
