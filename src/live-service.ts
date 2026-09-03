import { createActionOutbox } from "./action-outbox.js";
import { createActionWorker } from "./action-worker.js";
import type {
  CollaborativeActionAdapter,
  PersonalActionAdapter,
} from "./action.js";
import type { CollaboratorResolver } from "./collaborator.js";
import {
  createAuthoritativeActionReader,
  type AuthoritativeActionReader,
} from "./authoritative-action-reader.js";
import {
  createAuthoritativeBitableReader,
  type AuthoritativeBitableReader,
} from "./authoritative-bitable-reader.js";
import { createBitableAuthorityStore } from "./bitable-authority-store.js";
import { createCollaborativeActionOutbox } from "./collaborative-action-outbox.js";
import { createCollaborativeActionWorker } from "./collaborative-action-worker.js";
import { createDevelopmentAgent } from "./development-agent.js";
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
import type { PiThinkingLevel } from "./pi-sdk-runtime.js";
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
}

export interface LiveService {
  start(): Promise<void>;
  stop(): Promise<void>;
  waitForExit(): Promise<void>;
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
  readonly messageImageLoader?: MessageImageLoader;
  readonly reminderNotifier?: ReminderNotifier;
}

export async function createLiveService(
  config: LiveServiceConfig,
  dependencies: LiveServiceDependencies = {},
): Promise<LiveService> {
  const onError =
    dependencies.onError ?? ((error: unknown) => console.error(error));
  const registry = createPiSessionRegistry(config.databasePath);
  const collaborativeActionsEnabled =
    config.collaborativeActions?.enabled === true;
  const collaboratorResolver = collaborativeActionsEnabled
    ? (dependencies.collaboratorResolver ?? createLarkCollaboratorResolver())
    : undefined;
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
      ...(collaboratorResolver === undefined ? {} : { collaboratorResolver }),
    });
  } catch (error) {
    registry.close();
    throw error;
  }

  const memory = config.memory.enabled
    ? (dependencies.memoryAdapter ??
      createHindsightMemoryAdapter({
        baseUrl: config.memory.baseUrl,
        bankId: config.memory.bankId,
      }))
    : undefined;

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
  const authoritativeActions =
    dependencies.authoritativeActionReader ??
    (bitableClient === undefined ||
    (personalActionAdapter === undefined &&
      collaborativeActionAdapter === undefined)
      ? undefined
      : createAuthoritativeActionReader({
          bitable: bitableClient,
          actionLinksTableId: config.bitableTables.actionLinks,
          ...(personalActionAdapter === undefined ||
          config.personalActions?.enabled !== true
            ? {}
            : {
                personal: {
                  adapter: personalActionAdapter,
                  projectId: config.personalActions.projectId,
                },
              }),
          ...(collaborativeActionAdapter === undefined
            ? {}
            : { collaborative: { adapter: collaborativeActionAdapter } }),
          onError,
        }));
  const authoritativeBitable =
    dependencies.authoritativeBitableReader ??
    (bitableClient === undefined || bitableAuthorityStore === undefined
      ? undefined
      : createAuthoritativeBitableReader({
          bitable: bitableClient,
          tables: config.bitableTables,
          store: bitableAuthorityStore,
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
    memoryRecallTimeoutMs: config.memory.recallTimeoutMs,
    memoryRecallMaxResults: config.memory.recallMaxResults,
    memoryRecallMaxTokens: config.memory.recallMaxTokens,
    onMemoryError: onError,
    onCurrentStateError: onError,
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
        await stateProjector.project({
          sourceEventId: context.sourceEventId,
          operations: changes,
        });
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
        });
  const collaborativeActionWorker =
    collaborativeActionOutbox === undefined || bitableClient === undefined
      ? undefined
      : createCollaborativeActionWorker({
          databasePath: config.databasePath,
          actions: collaborativeActionAdapter!,
          bitable: bitableClient,
          actionLinksTableId: config.bitableTables.actionLinks,
        });
  const channel = dependencies.channel ?? createLarkEventChannel();
  const replies = dependencies.replies ?? createLarkReplyAdapter();
  const batcher =
    config.messageBatching?.enabled === true
      ? createMessageBatcher({
          databasePath: config.databasePath,
          allowedUserIds: config.allowedUserIds,
          agent,
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
    agent,
    ...(batcher === undefined ? {} : { batcher }),
    onError,
  });
  let started = false;
  let stopped = false;
  let repairTimer: NodeJS.Timeout | undefined;
  let repairRun = Promise.resolve();
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
      await supervisor.start();
      started = true;
      drainRepairs();
      repairTimer = setInterval(drainRepairs, 5_000);
      repairTimer.unref();
    },

    waitForExit() {
      return channel.waitForExit();
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
        await supervisor.stop();
        drainRepairs();
        await repairRun;
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
      }
    },
  };
}
