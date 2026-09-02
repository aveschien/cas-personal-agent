import type {
  ChannelEvent,
  Interpretation,
  Interpreter,
} from "./development-agent.js";
import type { PiSessionRegistry } from "./pi-session-registry.js";
import type { MemoryAdapter, RecalledMemory } from "./memory.js";

export interface PiConversationRuntime {
  readonly sessionId: string;
  readonly sessionPath: string;
  runTurn(prompt: string): Promise<Interpretation>;
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
  readonly userTimeZone?: string;
  readonly memory?: Pick<MemoryAdapter, "recall">;
  readonly memoryRecallTimeoutMs?: number;
  readonly memoryRecallMaxResults?: number;
  readonly memoryRecallMaxTokens?: number;
  readonly onMemoryError?: (error: unknown) => void;
}

function localDateTime(isoTimestamp: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(isoTimestamp));
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}:${part("second")}`;
}

export function createPiInterpreter(
  options: PiInterpreterOptions,
): PiInterpreter {
  const clock = options.clock ?? (() => new Date().toISOString());
  const userTimeZone = options.userTimeZone ?? "America/Los_Angeles";
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
  options.registry.activate({
    logicalConversationId: options.logicalConversationId,
    piSessionId: options.runtime.sessionId,
    piSessionPath: options.runtime.sessionPath,
    now: clock(),
  });

  return {
    async interpret(event: ChannelEvent) {
      const recalledMemories = await recallMemory(event);
      const result = await options.runtime.runTurn(
        JSON.stringify({
          trustedContext: {
            receivedAt: event.receivedAt,
            receivedLocalDateTime: localDateTime(
              event.receivedAt,
              userTimeZone,
            ),
            userTimeZone,
            ...(recalledMemories.length === 0
              ? {}
              : { recalledMemories }),
          },
          userMessage: event.rawText,
        }),
      );
      options.registry.recordCompletedTurn(options.runtime.sessionId, clock());
      return result;
    },

    dispose() {
      options.runtime.dispose();
    },
  };
}
