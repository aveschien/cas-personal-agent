import { createHash } from "node:crypto";

import type {
  CreatePersonalActionRequest,
  ExternalPersonalAction,
  PersonalActionAdapter,
} from "./action.js";

export interface TickTickActionAdapterOptions {
  readonly apiToken: string;
  readonly projectId: string;
  readonly baseUrl?: string;
  readonly fetcher?: typeof fetch;
}

interface TickTickTask {
  readonly id: string;
  readonly projectId: string;
  readonly content?: string;
  readonly status?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTask(value: unknown): TickTickTask {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.projectId !== "string"
  ) {
    throw new Error("TickTick returned an invalid task");
  }
  return {
    id: value.id,
    projectId: value.projectId,
    ...(typeof value.content === "string" ? { content: value.content } : {}),
    ...(typeof value.status === "number" ? { status: value.status } : {}),
  };
}

function toExternal(task: TickTickTask): ExternalPersonalAction {
  return {
    externalId: task.id,
    projectId: task.projectId,
    status: task.status === 2 ? "completed" : "open",
  };
}

function marker(idempotencyKey: string): string {
  return `CAS-IDEMPOTENCY:${createHash("sha256")
    .update(idempotencyKey)
    .digest("hex")}`;
}

function tickTickTimestamp(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error("TickTick deadline must be an ISO timestamp");
  }
  return value.replace(/([+-]\d{2}):(\d{2})$/, "$1$2");
}

export function createTickTickActionAdapter(
  options: TickTickActionAdapterOptions,
): PersonalActionAdapter {
  if (options.apiToken.trim().length === 0) {
    throw new Error("TickTick API token is required");
  }
  if (options.projectId.trim().length === 0) {
    throw new Error("TickTick project ID is required");
  }
  const configuredBaseUrl = new URL(
    options.baseUrl ?? "https://api.ticktick.com/open/v1",
  );
  if (
    configuredBaseUrl.protocol !== "https:" ||
    !["api.ticktick.com", "api.dida365.com"].includes(
      configuredBaseUrl.hostname,
    )
  ) {
    throw new Error(
      "TickTick base URL must use the official TickTick or Dida365 HTTPS API host",
    );
  }
  const baseUrl = configuredBaseUrl.toString().replace(/\/$/, "");
  const fetcher = options.fetcher ?? fetch;
  const headers = {
    Authorization: `Bearer ${options.apiToken}`,
    "Content-Type": "application/json",
  } as const;

  const requestJson = async (url: string, init?: RequestInit): Promise<unknown> => {
    const response = await fetcher(url, {
      ...init,
      headers: { ...headers, ...init?.headers },
    });
    if (!response.ok) {
      throw new Error(`TickTick request failed with status ${response.status}`);
    }
    const text = await response.text();
    return text.trim().length === 0 ? undefined : (JSON.parse(text) as unknown);
  };

  const findExisting = async (
    idempotencyMarker: string,
  ): Promise<TickTickTask | undefined> => {
    const projectData = await requestJson(
      `${baseUrl}/project/${encodeURIComponent(options.projectId)}/data`,
    );
    if (!isRecord(projectData) || !Array.isArray(projectData.tasks)) {
      throw new Error("TickTick returned invalid project data");
    }
    for (const value of projectData.tasks) {
      const task = parseTask(value);
      if (task.content?.includes(idempotencyMarker)) {
        return task;
      }
    }
    return undefined;
  };

  return {
    async create(request) {
      const idempotencyMarker = marker(request.idempotencyKey);
      const existing = await findExisting(idempotencyMarker);
      if (existing !== undefined) {
        return toExternal(existing);
      }

      const content = [
        idempotencyMarker,
        `CAS-ITEM:${request.itemKey}`,
        `CAS-SOURCE:${request.sourceEventId}`,
      ].join("\n");
      const created = await requestJson(`${baseUrl}/task`, {
        method: "POST",
        body: JSON.stringify({
          title: request.title,
          projectId: options.projectId,
          content,
          timeZone: "Asia/Shanghai",
          ...(request.deadlineAt === undefined
            ? {}
            : { dueDate: tickTickTimestamp(request.deadlineAt) }),
        }),
      });
      if (created === undefined) {
        const createdWithoutBody = await findExisting(idempotencyMarker);
        if (createdWithoutBody === undefined) {
          throw new Error(
            "TickTick created the task without returning an ID; awaiting retry reconciliation",
          );
        }
        return toExternal(createdWithoutBody);
      }
      return toExternal(parseTask(created));
    },

    async getState(projectId, externalId) {
      return toExternal(
        parseTask(
          await requestJson(
            `${baseUrl}/project/${encodeURIComponent(projectId)}/task/${encodeURIComponent(externalId)}`,
          ),
        ),
      );
    },
  };
}
