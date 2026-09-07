import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { createInterface, type Interface } from "node:readline";

export interface LarkTaskChangeSignal {
  readonly eventId: string;
  readonly occurredAt: string;
  readonly taskGuid: string;
  readonly eventTypes: readonly string[];
}

export interface LarkTaskEventChannel {
  start(onSignal: (signal: LarkTaskChangeSignal) => Promise<void> | void): Promise<void>;
  stop(): Promise<void>;
}

export interface LarkTaskEventChannelOptions {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly readyTimeoutMs?: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function parseLarkTaskChange(line: string): LarkTaskChangeSignal {
  const root = record(JSON.parse(line) as unknown);
  const event = record(root?.event) ?? root;
  const header = record(root?.header) ?? root;
  const taskGuid = event?.task_guid;
  const eventId = header?.event_id;
  const createTime = header?.create_time;
  const eventTypes = event?.event_types;
  if (typeof taskGuid !== "string" || typeof eventId !== "string" || typeof createTime !== "string" || !Array.isArray(eventTypes)) {
    throw new Error("lark-cli emitted an invalid task.task.update_user_access_v2 event");
  }
  const occurred = new Date(Number(createTime));
  if (!Number.isFinite(occurred.valueOf())) throw new Error("lark-cli emitted an invalid task event create_time");
  return {
    eventId, occurredAt: occurred.toISOString(), taskGuid,
    eventTypes: eventTypes.filter((value): value is string => typeof value === "string"),
  };
}

export function createLarkTaskEventChannel(options: LarkTaskEventChannelOptions = {}): LarkTaskEventChannel {
  const command = options.command ?? "lark-cli";
  const args = options.args ?? ["event", "consume", "task.task.update_user_access_v2", "--as", "user"];
  const readyTimeoutMs = options.readyTimeoutMs ?? 15_000;
  let child: ChildProcessWithoutNullStreams | undefined;
  let stdout: Interface | undefined;
  let stderr: Interface | undefined;
  let loop: Promise<void> | undefined;
  return {
    async start(onSignal) {
      if (child !== undefined) return;
      child = spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"] });
      stdout = createInterface({ input: child.stdout });
      stderr = createInterface({ input: child.stderr });
      const ready = Promise.withResolvers<void>();
      const timer = setTimeout(() => ready.reject(new Error("Timed out waiting for Lark Task event channel")), readyTimeoutMs);
      stderr.on("line", (line) => {
        if (line === "[event] ready event_key=task.task.update_user_access_v2") {
          clearTimeout(timer);
          ready.resolve();
        }
      });
      child.once("error", (error) => { clearTimeout(timer); ready.reject(error); });
      child.once("exit", (code) => {
        if (code !== 0) ready.reject(new Error(`Lark Task event channel exited with ${String(code)}`));
      });
      loop = (async () => {
        for await (const line of stdout!) if (line.trim().length > 0) await onSignal(parseLarkTaskChange(line));
      })();
      try { await ready.promise; } catch (error) {
        if (child.exitCode === null) child.kill("SIGTERM");
        child = undefined;
        throw error;
      }
    },
    async stop() {
      if (child === undefined) return;
      if (child.exitCode === null) { child.kill("SIGTERM"); await once(child, "exit"); }
      await loop;
      stdout?.close();
      stderr?.close();
      child = undefined;
    },
  };
}
