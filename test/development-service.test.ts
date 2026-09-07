import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface, type Interface } from "node:readline";
import test from "node:test";

interface RunningService {
  readonly process: ChildProcessWithoutNullStreams;
  readonly lines: Interface;
  readonly output: AsyncIterator<string>;
}

function startService(databasePath: string): RunningService {
  const child = spawn(process.execPath, [join(process.cwd(), "dist/src/cli.js")], {
    env: {
      ...process.env,
      CAS_DATABASE_PATH: databasePath,
      CAS_ALLOWED_USER_IDS: "user-1",
    },
  });
  const lines = createInterface({ input: child.stdout });
  return {
    process: child,
    lines,
    output: lines[Symbol.asyncIterator](),
  };
}

async function readOutput(service: RunningService): Promise<unknown> {
  const next = await service.output.next();
  if (next.done) {
    const stderr = service.process.stderr.read()?.toString() ?? "";
    throw new Error(`development service exited without output: ${stderr}`);
  }
  return JSON.parse(next.value) as unknown;
}

async function stopService(service: RunningService): Promise<void> {
  service.process.stdin.end();
  const [exitCode] = (await once(service.process, "exit")) as [number | null];
  service.lines.close();
  assert.equal(exitCode, 0);
}

test("the development service starts, reports health, ingests NDJSON, and restarts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cas-agent-service-"));
  const databasePath = join(directory, "events.sqlite");
  const eventCommand = {
    type: "event",
    event: {
      sourceMessageId: "message-service",
      receivedAt: "2026-09-02T17:30:00.000Z",
      userId: "user-1",
      rawText: "把报价页改完",
      rawPayload: { event_id: "delivery-service" },
    },
  };

  try {
    const firstRun = startService(databasePath);
    firstRun.process.stdin.write(`${JSON.stringify({ type: "health" })}\n`);
    assert.deepEqual(await readOutput(firstRun), {
      status: "ok",
      mode: "development",
      storage: { journalMode: "wal", schemaVersion: 4 },
    });
    firstRun.process.stdin.write(`${JSON.stringify(eventCommand)}\n`);
    assert.deepEqual(await readOutput(firstRun), {
      status: "completed",
      acknowledgement: "已记录：把报价页改完。",
    });
    await stopService(firstRun);

    const restarted = startService(databasePath);
    restarted.process.stdin.write(`${JSON.stringify(eventCommand)}\n`);
    assert.deepEqual(await readOutput(restarted), {
      status: "duplicate",
      acknowledgement: "已记录：把报价页改完。",
    });
    await stopService(restarted);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
