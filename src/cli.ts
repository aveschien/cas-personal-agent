import { createInterface } from "node:readline";

import { loadDevelopmentConfig } from "./config.js";
import {
  createDevelopmentAgent,
  type ChannelEvent,
  type DevelopmentAgent,
} from "./development-agent.js";

interface HealthCommand {
  readonly type: "health";
}

interface EventCommand {
  readonly type: "event";
  readonly event: ChannelEvent;
}

type DevelopmentCommand = HealthCommand | EventCommand;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCommand(line: string): DevelopmentCommand {
  const value = JSON.parse(line) as unknown;
  if (!isRecord(value)) {
    throw new Error("command must be a JSON object");
  }
  if (value.type === "health") {
    return { type: "health" };
  }
  if (value.type !== "event" || !isRecord(value.event)) {
    throw new Error("command type must be health or event");
  }

  const event = value.event;
  if (
    typeof event.sourceMessageId !== "string" ||
    typeof event.receivedAt !== "string" ||
    typeof event.userId !== "string" ||
    typeof event.rawText !== "string" ||
    !isRecord(event.rawPayload)
  ) {
    throw new Error("event command has invalid fields");
  }

  return {
    type: "event",
    event: {
      sourceMessageId: event.sourceMessageId,
      receivedAt: event.receivedAt,
      userId: event.userId,
      rawText: event.rawText,
      rawPayload: event.rawPayload,
    },
  };
}

function writeOutput(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function run(): Promise<void> {
  const config = loadDevelopmentConfig();
  const agent = createDevelopmentAgent({
    ...config,
    interpreter: {
      interpret: async (event) => ({
        changes: [
          {
            kind: "item",
            type: "information",
            status: "inbox",
            title: event.rawText,
          },
        ],
        acknowledgement: `已记录：${event.rawText}。`,
      }),
    },
    stateAdapter: {
      project: async () => undefined,
    },
  });
  let closed = false;
  const close = (): void => {
    if (!closed) {
      closed = true;
      agent.close();
    }
  };

  process.once("SIGTERM", () => {
    close();
    process.exit(0);
  });

  const input = createInterface({ input: process.stdin });
  try {
    for await (const line of input) {
      if (line.trim().length === 0) {
        continue;
      }
      try {
        const command = parseCommand(line);
        if (command.type === "health") {
          writeOutput(agent.health());
        } else {
          writeOutput(await agent.ingest(command.event));
        }
      } catch (error) {
        writeOutput({
          status: "failed",
          acknowledgement: "这条输入暂时无法处理，请检查格式后重试。",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    close();
  }
}

await run();
