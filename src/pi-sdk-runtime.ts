import { mkdirSync } from "node:fs";

import {
  createAgentSession,
  createExtensionRuntime,
  defineTool,
  ModelRuntime,
  type ResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type {
  Interpretation,
  ItemStateChange,
  ItemStatus,
  ItemType,
  StateChange,
} from "./development-agent.js";
import type { PiConversationRuntime } from "./pi-interpreter.js";

export const productionPiToolNames = ["state_propose_item"] as const;

const productionSystemPrompt = `你是 CAS Personal Agent 的当前回合推理器。
用简短中文回复用户，并保持多轮上下文连续。
遇到需要保存或推进的事项时，调用 state_propose_item；想法必须使用 type=idea，不能伪装成任务。
该工具只提出当前状态变化，不代表已经写入外部系统；不得声称已写入 Bitable、滴答或飞书任务。
不得使用 shell、任意文件读写、任意 HTTP 请求或未列出的工具。`;

export interface ProposedItem {
  readonly title: string;
  readonly type: ItemType;
  readonly status: ItemStatus;
}

export interface PiSdkSessionFactoryInput {
  readonly cwd: string;
  readonly sessionDirectory: string;
  readonly modelName: string;
  readonly systemPrompt: string;
  readonly enabledToolNames: readonly string[];
  readonly disableBuiltinTools: boolean;
  readonly proposeItem: (item: ProposedItem) => void;
}

export interface PiSdkSession {
  readonly sessionId: string;
  readonly sessionPath: string;
  subscribeText(onText: (delta: string) => void): () => void;
  prompt(prompt: string): Promise<void>;
  dispose(): void;
}

export interface PiSdkSessionFactory {
  create(input: PiSdkSessionFactoryInput): Promise<PiSdkSession>;
}

export interface PiSdkRuntimeOptions {
  readonly cwd: string;
  readonly sessionDirectory: string;
  readonly modelName: string;
  readonly sdkFactory?: PiSdkSessionFactory;
}

function splitModelName(modelName: string): {
  provider: string;
  model: string;
} {
  const separator = modelName.indexOf("/");
  if (separator <= 0 || separator === modelName.length - 1) {
    throw new Error("Pi model must use provider/model format");
  }
  return {
    provider: modelName.slice(0, separator),
    model: modelName.slice(separator + 1),
  };
}

const productionSdkFactory: PiSdkSessionFactory = {
  async create(input) {
    mkdirSync(input.sessionDirectory, { recursive: true });
    const stateProposalTool = defineTool({
      name: "state_propose_item",
      label: "Propose Item state",
      description:
        "Propose one Project-linked or standalone Item classification for deterministic projection.",
      parameters: Type.Object({
        title: Type.String({ minLength: 1 }),
        type: Type.Union([
          Type.Literal("task"),
          Type.Literal("idea"),
          Type.Literal("question"),
          Type.Literal("decision"),
          Type.Literal("information"),
        ]),
        status: Type.Union([
          Type.Literal("inbox"),
          Type.Literal("actionable"),
          Type.Literal("in_progress"),
          Type.Literal("waiting"),
          Type.Literal("scheduled"),
          Type.Literal("completed"),
          Type.Literal("abandoned"),
          Type.Literal("archived"),
        ]),
      }),
      execute: async (_toolCallId, params) => {
        input.proposeItem(params);
        return {
          content: [{ type: "text", text: "Item state proposal accepted." }],
          details: {},
        };
      },
    });
    const resourceLoader: ResourceLoader = {
      getExtensions: () => ({
        extensions: [],
        errors: [],
        runtime: createExtensionRuntime(),
      }),
      getSkills: () => ({ skills: [], diagnostics: [] }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }),
      getSystemPrompt: () => input.systemPrompt,
      getSystemPromptSource: () => undefined,
      getAppendSystemPrompt: () => [],
      getAppendSystemPromptSources: () => [],
      extendResources: () => undefined,
      reload: async () => undefined,
    };
    const modelRuntime = await ModelRuntime.create();
    const modelReference = splitModelName(input.modelName);
    const model = modelRuntime.getModel(
      modelReference.provider,
      modelReference.model,
    );
    if (model === undefined) {
      throw new Error(`Pi model is unavailable: ${input.modelName}`);
    }
    const settingsManager = SettingsManager.inMemory();
    const sessionManager = SessionManager.continueRecent(
      input.cwd,
      input.sessionDirectory,
    );
    const { session } = await createAgentSession({
      cwd: input.cwd,
      model,
      modelRuntime,
      resourceLoader,
      sessionManager,
      settingsManager,
      thinkingLevel: "low",
      ...(input.disableBuiltinTools ? { noTools: "builtin" as const } : {}),
      tools: [...input.enabledToolNames],
      customTools: [stateProposalTool],
    });
    const actualToolNames = session.agent.state.tools.map((tool) => tool.name);
    if (
      actualToolNames.length !== input.enabledToolNames.length ||
      actualToolNames.some((name) => !input.enabledToolNames.includes(name))
    ) {
      session.dispose();
      throw new Error(
        `Unsafe Pi tool configuration: ${actualToolNames.join(", ")}`,
      );
    }
    if (session.sessionFile === undefined) {
      session.dispose();
      throw new Error("Pi persistent session file was not created");
    }

    return {
      sessionId: session.sessionId,
      sessionPath: session.sessionFile,
      subscribeText(onText) {
        return session.subscribe((event) => {
          if (
            event.type === "message_update" &&
            event.assistantMessageEvent.type === "text_delta"
          ) {
            onText(event.assistantMessageEvent.delta);
          }
        });
      },
      prompt: async (prompt) => session.prompt(prompt),
      dispose: () => session.dispose(),
    };
  },
};

export async function createPiSdkRuntime(
  options: PiSdkRuntimeOptions,
): Promise<PiConversationRuntime> {
  let pendingChanges: StateChange[] | undefined;
  const sdkFactory = options.sdkFactory ?? productionSdkFactory;
  const session = await sdkFactory.create({
    cwd: options.cwd,
    sessionDirectory: options.sessionDirectory,
    modelName: options.modelName,
    systemPrompt: productionSystemPrompt,
    enabledToolNames: productionPiToolNames,
    disableBuiltinTools: true,
    proposeItem(item) {
      if (pendingChanges === undefined) {
        throw new Error("Pi state tool was called outside an active turn");
      }
      const change: ItemStateChange = {
        kind: "item",
        ...item,
      };
      pendingChanges.push(change);
    },
  });

  return {
    sessionId: session.sessionId,
    sessionPath: session.sessionPath,

    async runTurn(prompt): Promise<Interpretation> {
      if (pendingChanges !== undefined) {
        throw new Error("Pi runtime does not accept concurrent turns");
      }
      pendingChanges = [];
      let acknowledgement = "";
      const unsubscribe = session.subscribeText((delta) => {
        acknowledgement += delta;
      });
      try {
        await session.prompt(prompt);
        return {
          changes: pendingChanges,
          acknowledgement:
            acknowledgement.trim() || "已收到，我会继续处理这条信息。",
        };
      } finally {
        unsubscribe();
        pendingChanges = undefined;
      }
    },

    dispose() {
      session.dispose();
    },
  };
}
