import { createHash } from "node:crypto";

import type {
  CollaborativeActionAdapter,
  CreateCollaborativeActionRequest,
  ExternalCollaborativeAction,
} from "./action.js";
import {
  processCommandRunner,
  type CommandRunner,
} from "./lark-reply-adapter.js";

export interface LarkTaskActionAdapterOptions {
  readonly command?: string;
  readonly runner?: CommandRunner;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseEnvelope(stdout: string): Record<string, unknown> {
  const envelope = record(JSON.parse(stdout) as unknown);
  if (envelope?.ok !== true) {
    throw new Error("lark-cli returned an invalid success envelope");
  }
  const data = record(envelope.data);
  if (data === undefined) {
    throw new Error("lark-cli returned no task data");
  }
  return data;
}

function taskUrl(guid: string, value: unknown): string {
  if (typeof value === "string" && value.startsWith("https://")) {
    return value;
  }
  return `https://applink.feishu.cn/client/todo/detail?guid=${encodeURIComponent(guid)}`;
}

function idempotencyToken(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function description(request: CreateCollaborativeActionRequest): string {
  return [
    "由 CAS Personal Agent 根据用户明确确认创建。",
    `事项：${request.itemKey}`,
    ...(request.projectKey === undefined
      ? []
      : [`项目：${request.projectKey}`]),
    `来源事件：${request.sourceEventId}`,
  ].join("\n");
}

function parseTask(value: Record<string, unknown>): ExternalCollaborativeAction {
  const task = record(value.task) ?? value;
  if (typeof task.guid !== "string") {
    throw new Error("lark-cli returned a task without a guid");
  }
  const members = Array.isArray(task.members) ? task.members : [];
  const assigneeIds = members.flatMap((candidate) => {
    const member = record(candidate);
    return member?.role === "assignee" && typeof member.id === "string"
      ? [member.id]
      : [];
  });
  const due = record(task.due);
  const dueTimestamp = due?.timestamp;
  return {
    externalId: task.guid,
    externalUrl: taskUrl(task.guid, task.url),
    status: task.status === "done" ? "completed" : "open",
    assigneeIds,
    ...(typeof dueTimestamp === "string" && /^\d+$/.test(dueTimestamp)
      ? { deadlineAt: new Date(Number(dueTimestamp)).toISOString() }
      : {}),
  };
}

export function createLarkTaskActionAdapter(
  options: LarkTaskActionAdapterOptions = {},
): CollaborativeActionAdapter {
  const command = options.command ?? "lark-cli";
  const runner = options.runner ?? processCommandRunner;
  const run = async (args: readonly string[]): Promise<Record<string, unknown>> => {
    const result = await runner.run(command, args);
    if (result.exitCode !== 0) {
      throw new Error(
        `lark-cli task operation failed with exit code ${result.exitCode}: ${result.stderr.trim()}`,
      );
    }
    return parseEnvelope(result.stdout);
  };

  return {
    async create(request) {
      if (!/^ou_[A-Za-z0-9]+$/.test(request.assigneeId)) {
        throw new Error("Feishu Task assignee must be a resolved open_id");
      }
      const args = [
        "task",
        "+create",
        "--summary",
        request.title,
        "--description",
        description(request),
        "--assignee",
        request.assigneeId,
        "--idempotency-key",
        idempotencyToken(request.idempotencyKey),
        ...(request.deadlineAt === undefined
          ? []
          : ["--due", request.deadlineAt]),
        "--as",
        "user",
        "--json",
      ];
      const unilateral = await run(args);
      if (typeof unilateral.guid !== "string") {
        throw new Error("lark-cli returned a task without a guid");
      }
      return {
        externalId: unilateral.guid,
        externalUrl: taskUrl(unilateral.guid, unilateral.url),
        status: "open",
        assigneeIds: [request.assigneeId],
        ...(request.deadlineAt === undefined
          ? {}
          : { deadlineAt: request.deadlineAt }),
      };
    },

    async getState(externalId) {
      const data = await run([
        "task",
        "tasks",
        "get",
        "--task-guid",
        externalId,
        "--as",
        "user",
        "--json",
      ]);
      return parseTask(data);
    },
  };
}
