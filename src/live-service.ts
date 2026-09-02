import { createDevelopmentAgent } from "./development-agent.js";
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
import { createSupervisor } from "./supervisor.js";

export interface LiveServiceConfig {
  readonly cwd: string;
  readonly databasePath: string;
  readonly allowedUserIds: readonly string[];
  readonly piSessionDirectory: string;
  readonly piModel: string;
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
}

export interface LiveServiceDependencies {
  readonly channel?: LarkEventChannel;
  readonly replies?: ReplyAdapter;
  readonly runtimeFactory?: (
    input: RuntimeFactoryInput,
  ) => Promise<PiConversationRuntime>;
  readonly clock?: () => string;
  readonly onError?: (error: unknown) => void;
}

export async function createLiveService(
  config: LiveServiceConfig,
  dependencies: LiveServiceDependencies = {},
): Promise<LiveService> {
  const registry = createPiSessionRegistry(config.databasePath);
  let runtime: PiConversationRuntime;
  try {
    runtime = await (dependencies.runtimeFactory ?? createPiSdkRuntime)({
      cwd: config.cwd,
      sessionDirectory: config.piSessionDirectory,
      modelName: config.piModel,
    });
  } catch (error) {
    registry.close();
    throw error;
  }

  const interpreter = createPiInterpreter({
    logicalConversationId: "cas-main",
    registry,
    runtime,
    ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
  });
  const agent = createDevelopmentAgent({
    databasePath: config.databasePath,
    allowedUserIds: config.allowedUserIds,
    interpreter,
    stateAdapter: {
      project: async () => undefined,
    },
  });
  const channel = dependencies.channel ?? createLarkEventChannel();
  const supervisor = createSupervisor({
    channel,
    replies: dependencies.replies ?? createLarkReplyAdapter(),
    agent,
    ...(dependencies.onError === undefined
      ? {}
      : { onError: dependencies.onError }),
  });
  let started = false;
  let stopped = false;

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
        await supervisor.stop();
      } finally {
        interpreter.dispose();
        agent.close();
        registry.close();
      }
    },
  };
}
