import type {
  ChannelEvent,
  Interpretation,
  Interpreter,
} from "./development-agent.js";
import type { PiSessionRegistry } from "./pi-session-registry.js";

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
}

export function createPiInterpreter(
  options: PiInterpreterOptions,
): PiInterpreter {
  const clock = options.clock ?? (() => new Date().toISOString());
  options.registry.activate({
    logicalConversationId: options.logicalConversationId,
    piSessionId: options.runtime.sessionId,
    piSessionPath: options.runtime.sessionPath,
    now: clock(),
  });

  return {
    async interpret(event: ChannelEvent) {
      const result = await options.runtime.runTurn(event.rawText);
      options.registry.recordCompletedTurn(options.runtime.sessionId, clock());
      return result;
    },

    dispose() {
      options.runtime.dispose();
    },
  };
}
