import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { createInterface, type Interface } from "node:readline";

import type { ChannelEvent } from "./development-agent.js";

export interface IncomingChannelMessage {
  readonly event: ChannelEvent;
  readonly chatType: "p2p" | "group";
  readonly messageType: string;
  readonly senderType: "user" | "bot";
}

export type ChannelStatus = "stopped" | "starting" | "running" | "stopping";

export interface LarkEventChannel {
  start(
    onMessage: (message: IncomingChannelMessage) => Promise<void>,
  ): Promise<void>;
  stop(): Promise<void>;
  waitForExit(): Promise<void>;
  status(): ChannelStatus;
}

export interface LarkEventChannelOptions {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly readyTimeoutMs?: number;
}

interface LarkMessageEvent {
  readonly type: "im.message.receive_v1";
  readonly message_id: string;
  readonly chat_type: "p2p" | "group";
  readonly message_type: string;
  readonly sender_id: string;
  readonly sender_type: "user" | "bot";
  readonly content: string;
  readonly create_time: string;
  readonly [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMessage(line: string): IncomingChannelMessage {
  const value = JSON.parse(line) as unknown;
  if (
    !isRecord(value) ||
    value.type !== "im.message.receive_v1" ||
    typeof value.message_id !== "string" ||
    (value.chat_type !== "p2p" && value.chat_type !== "group") ||
    typeof value.message_type !== "string" ||
    typeof value.sender_id !== "string" ||
    (value.sender_type !== "user" && value.sender_type !== "bot") ||
    typeof value.content !== "string" ||
    typeof value.create_time !== "string"
  ) {
    throw new Error("lark-cli emitted an invalid im.message.receive_v1 event");
  }

  const rawEvent = value as LarkMessageEvent;
  const receivedAt = new Date(Number(rawEvent.create_time));
  if (Number.isNaN(receivedAt.valueOf())) {
    throw new Error("lark-cli emitted an invalid message create_time");
  }

  return {
    event: {
      sourceMessageId: rawEvent.message_id,
      receivedAt: receivedAt.toISOString(),
      userId: rawEvent.sender_id,
      rawText: rawEvent.content,
      rawPayload: rawEvent,
    },
    chatType: rawEvent.chat_type,
    messageType: rawEvent.message_type,
    senderType: rawEvent.sender_type,
  };
}

export function createLarkEventChannel(
  options: LarkEventChannelOptions = {},
): LarkEventChannel {
  const command = options.command ?? "lark-cli";
  const args = options.args ?? [
    "event",
    "consume",
    "im.message.receive_v1",
    "--as",
    "bot",
  ];
  const readyTimeoutMs = options.readyTimeoutMs ?? 15_000;
  let channelStatus: ChannelStatus = "stopped";
  let child: ChildProcessWithoutNullStreams | undefined;
  let stdoutLines: Interface | undefined;
  let stderrLines: Interface | undefined;
  let eventLoop: Promise<void> | undefined;
  let exitPromise = new Promise<void>(() => undefined);

  return {
    async start(onMessage) {
      if (channelStatus !== "stopped") {
        throw new Error(`Lark Event Channel is already ${channelStatus}`);
      }
      channelStatus = "starting";
      const exit = Promise.withResolvers<void>();
      exitPromise = exit.promise;
      void exit.promise.catch(() => undefined);
      child = spawn(command, [...args], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      stdoutLines = createInterface({ input: child.stdout });
      stderrLines = createInterface({ input: child.stderr });

      const ready = Promise.withResolvers<void>();
      let stderr = "";
      const readyTimer = setTimeout(() => {
        ready.reject(new Error("Timed out waiting for lark-cli ready marker"));
      }, readyTimeoutMs);

      stderrLines.on("line", (line) => {
        stderr = `${stderr}${line}\n`;
        if (line === "[event] ready event_key=im.message.receive_v1") {
          clearTimeout(readyTimer);
          ready.resolve();
        }
      });
      child.once("error", (error) => {
        clearTimeout(readyTimer);
        ready.reject(error);
      });
      child.once("exit", (code) => {
        if (channelStatus === "starting") {
          clearTimeout(readyTimer);
          ready.reject(
            new Error(
              `lark-cli exited before ready (code ${String(code)}): ${stderr.trim()}`,
            ),
          );
          exit.resolve();
        } else if (channelStatus === "stopping" || channelStatus === "stopped") {
          exit.resolve();
        } else {
          channelStatus = "stopped";
          exit.reject(
            new Error(`lark-cli exited unexpectedly (code ${String(code)})`),
          );
        }
      });

      eventLoop = (async () => {
        for await (const line of stdoutLines!) {
          if (line.trim().length > 0) {
            await onMessage(parseMessage(line));
          }
        }
      })();

      try {
        await ready.promise;
        channelStatus = "running";
      } catch (error) {
        if (child.exitCode === null) {
          child.kill("SIGTERM");
        }
        channelStatus = "stopped";
        throw error;
      }
    },

    async stop() {
      if (channelStatus === "stopped") {
        return;
      }
      if (child === undefined) {
        channelStatus = "stopped";
        return;
      }

      channelStatus = "stopping";
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await once(child, "exit");
      }
      await eventLoop;
      stdoutLines?.close();
      stderrLines?.close();
      channelStatus = "stopped";
    },

    waitForExit() {
      return exitPromise;
    },

    status() {
      return channelStatus;
    },
  };
}
