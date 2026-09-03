import type {
  ChannelEvent,
  Interpretation,
  Interpreter,
} from "./development-agent.js";
import {
  businessTimeZone,
  formatBusinessLocalDateTime,
} from "./business-time.js";
import type { PiSessionRegistry } from "./pi-session-registry.js";
import type { MemoryAdapter, RecalledMemory } from "./memory.js";
import type { PromptImage } from "./prompt-image.js";
import type {
  AuthoritativeActionReader,
  AuthoritativeActionReconciliation,
} from "./authoritative-action-reader.js";

export interface PiConversationRuntime {
  readonly sessionId: string;
  readonly sessionPath: string;
  runTurn(
    prompt: string,
    images?: readonly PromptImage[],
  ): Promise<Interpretation>;
  dispose(): void;
}

export interface PiInterpreter extends Interpreter {
  dispose(): void;
}

export interface PiInterpreterOptions {
  readonly logicalConversationId: string;
  readonly registry: PiSessionRegistry;
  readonly runtime: PiConversationRuntime;
  readonly clock?: () => string;
  readonly memory?: Pick<MemoryAdapter, "recall">;
  readonly memoryRecallTimeoutMs?: number;
  readonly memoryRecallMaxResults?: number;
  readonly memoryRecallMaxTokens?: number;
  readonly onMemoryError?: (error: unknown) => void;
  readonly authoritativeActions?: AuthoritativeActionReader;
  readonly onCurrentStateError?: (error: unknown) => void;
}

export function createPiInterpreter(
  options: PiInterpreterOptions,
): PiInterpreter {
  const clock = options.clock ?? (() => new Date().toISOString());
  const recallMemory = async (event: ChannelEvent): Promise<readonly RecalledMemory[]> => {
    if (options.memory === undefined) {
      return [];
    }
    const controller = new AbortController();
    const timeoutMs = options.memoryRecallTimeoutMs ?? 2_000;
    let timeout: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new Error(`Hindsight recall timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    try {
      return await Promise.race([
        options.memory.recall({
          query: event.rawText,
          maxResults: options.memoryRecallMaxResults ?? 5,
          maxTokens: options.memoryRecallMaxTokens ?? 800,
          signal: controller.signal,
        }),
        timeoutPromise,
      ]);
    } catch (error) {
      options.onMemoryError?.(error);
      return [];
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }
  };
  const reconcileActions = async (): Promise<AuthoritativeActionReconciliation> => {
    if (options.authoritativeActions === undefined) {
      return { states: [], memoryCandidates: [] };
    }
    try {
      return await options.authoritativeActions.reconcile(clock());
    } catch (error) {
      options.onCurrentStateError?.(error);
      return { states: [], memoryCandidates: [] };
    }
  };
  options.registry.activate({
    logicalConversationId: options.logicalConversationId,
    piSessionId: options.runtime.sessionId,
    piSessionPath: options.runtime.sessionPath,
    now: clock(),
  });

  return {
    async interpret(event: ChannelEvent) {
      const [recalledMemories, authoritativeActions] = await Promise.all([
        recallMemory(event),
        reconcileActions(),
      ]);
      const result = await options.runtime.runTurn(
        JSON.stringify({
          trustedContext: {
            receivedAt: event.receivedAt,
            receivedLocalDateTime: formatBusinessLocalDateTime(event.receivedAt),
            userTimeZone: businessTimeZone,
            ...(recalledMemories.length === 0
              ? {}
              : { recalledMemories }),
            ...(authoritativeActions.states.length === 0
              ? {}
              : { authoritativeActions: authoritativeActions.states }),
          },
          userMessage: event.rawText,
        }),
        event.images,
      );
      options.registry.recordCompletedTurn(options.runtime.sessionId, clock());
      const memoryCandidates = [
        ...authoritativeActions.memoryCandidates,
        ...(result.memoryCandidates ?? []),
      ];
      return {
        ...result,
        ...(memoryCandidates.length === 0 ? {} : { memoryCandidates }),
      };
    },

    dispose() {
      options.runtime.dispose();
    },
  };
}
