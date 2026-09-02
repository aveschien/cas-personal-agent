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
import {
  createLarkReplyAdapter,
  type ReplyAdapter,
} from "./lark-reply-adapter.js";
import {
  createPiInterpreter,
  type PiConversationRuntime,
} from "./pi-interpreter.js";
import { createPiSdkRuntime } from "./pi-sdk-runtime.js";
import { createPiSessionRegistry } from "./pi-session-registry.js";
import { createProjectionRepairWorker } from "./projection-repair-worker.js";
import { createReminderStore } from "./reminder-store.js";
import { isSemanticOperation } from "./state-operations.js";
import { createSupervisor } from "./supervisor.js";

export interface LiveServiceConfig {
  readonly cwd: string;
  readonly databasePath: string;
  readonly allowedUserIds: readonly string[];
  readonly piSessionDirectory: string;
  readonly piModel: string;
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
  readonly memoryEnabled: boolean;
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
}

export async function createLiveService(
  config: LiveServiceConfig,
  dependencies: LiveServiceDependencies = {},
): Promise<LiveService> {
  const onError =
    dependencies.onError ?? ((error: unknown) => console.error(error));
  const registry = createPiSessionRegistry(config.databasePath);
  let runtime: PiConversationRuntime;
  try {
    runtime = await (dependencies.runtimeFactory ?? createPiSdkRuntime)({
      cwd: config.cwd,
      sessionDirectory: config.piSessionDirectory,
      modelName: config.piModel,
      memoryEnabled: config.memory.enabled,
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

  const interpreter = createPiInterpreter({
    logicalConversationId: "cas-main",
    registry,
    runtime,
    ...(memory === undefined ? {} : { memory }),
    memoryRecallTimeoutMs: config.memory.recallTimeoutMs,
    memoryRecallMaxResults: config.memory.recallMaxResults,
    memoryRecallMaxTokens: config.memory.recallMaxTokens,
    onMemoryError: onError,
    ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
  });
  const reminderStore =
    dependencies.stateProjector === undefined
      ? createReminderStore(config.databasePath)
      : undefined;
  const stateProjector =
    dependencies.stateProjector ??
    createBitableStateProjector({
      client: createLarkBaseClient({ baseToken: config.bitableBaseToken }),
      tables: config.bitableTables,
      reminders: reminderStore!,
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
  const channel = dependencies.channel ?? createLarkEventChannel();
  const supervisor = createSupervisor({
    channel,
    replies: dependencies.replies ?? createLarkReplyAdapter(),
    agent,
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
        repairWorker.close();
        memoryWorker?.close();
      }
    },
  };
}
