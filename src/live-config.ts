import { resolve } from "node:path";

import type { LiveServiceConfig } from "./live-service.js";
import type { PiThinkingLevel } from "./pi-sdk-runtime.js";

export interface LiveEnvironment {
  readonly [key: string]: string | undefined;
  readonly CAS_ALLOWED_USER_IDS?: string;
  readonly CAS_DATABASE_PATH?: string;
  readonly CAS_PI_SESSION_DIR?: string;
  readonly CAS_PI_MODEL?: string;
  readonly CAS_PI_THINKING_LEVEL?: string;
  readonly CAS_BITABLE_BASE_TOKEN?: string;
  readonly CAS_BITABLE_PROJECTS_TABLE_ID?: string;
  readonly CAS_BITABLE_ITEMS_TABLE_ID?: string;
  readonly CAS_BITABLE_ACTION_LINKS_TABLE_ID?: string;
  readonly MEMORY_ENABLED?: string;
  readonly HINDSIGHT_BASE_URL?: string;
  readonly HINDSIGHT_BANK_ID?: string;
  readonly HINDSIGHT_RECALL_TIMEOUT_MS?: string;
  readonly HINDSIGHT_RECALL_MAX_RESULTS?: string;
  readonly HINDSIGHT_RECALL_MAX_TOKENS?: string;
  readonly TICKTICK_ENABLED?: string;
  readonly TICKTICK_API_TOKEN?: string;
  readonly TICKTICK_PROJECT_ID?: string;
  readonly TICKTICK_BASE_URL?: string;
  readonly FEISHU_TASK_ENABLED?: string;
  readonly CAS_MESSAGE_BATCHING_ENABLED?: string;
  readonly CAS_MESSAGE_SETTLE_MS?: string;
  readonly CAS_MESSAGE_MAX_WAIT_MS?: string;
  readonly CAS_EXTERNAL_SYNC_INTERVAL_MS?: string;
  readonly CAS_EXTERNAL_SYNC_REQUEST_BUDGET?: string;
  readonly CAS_EXTERNAL_SYNC_TIMEOUT_MS?: string;
}

function required(environment: LiveEnvironment, name: keyof LiveEnvironment): string {
  const value = environment[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`${String(name)} is required`);
  }
  return value;
}

function parseAllowlist(value: string | undefined): string[] {
  const userIds = [
    ...new Set(
      (value ?? "")
        .split(",")
        .map((candidate) => candidate.trim())
        .filter((candidate) => candidate.length > 0),
    ),
  ];
  if (userIds.length === 0) {
    throw new Error(
      "CAS_ALLOWED_USER_IDS must contain at least one Feishu user ID",
    );
  }
  return userIds;
}

function parseBoolean(
  value: string | undefined,
  defaultValue: boolean,
  name: string,
): boolean {
  if (value === undefined || value.trim().length === 0) {
    return defaultValue;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error(`${name} must be true or false`);
}

function positiveInteger(
  value: string | undefined,
  defaultValue: number,
  name: string,
): number {
  if (value === undefined || value.trim().length === 0) {
    return defaultValue;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function thinkingLevel(value: string | undefined): PiThinkingLevel {
  const normalized = value?.trim() || "max";
  if (
    !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
      normalized,
    )
  ) {
    throw new Error("CAS_PI_THINKING_LEVEL is invalid");
  }
  return normalized as PiThinkingLevel;
}

function hindsightBaseUrl(value: string | undefined): string {
  const raw = value?.trim() || "http://127.0.0.1:8888";
  const url = new URL(raw);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  ) {
    throw new Error("HINDSIGHT_BASE_URL must be a loopback HTTP URL");
  }
  return url.toString().replace(/\/$/, "");
}

function tickTickBaseUrl(value: string | undefined): string {
  const url = new URL(
    value?.trim() || "https://api.ticktick.com/open/v1",
  );
  if (
    url.protocol !== "https:" ||
    !["api.ticktick.com", "api.dida365.com"].includes(url.hostname)
  ) {
    throw new Error(
      "TICKTICK_BASE_URL must use the official TickTick or Dida365 HTTPS API host",
    );
  }
  return url.toString().replace(/\/$/, "");
}

export function loadLiveConfig(
  environment: LiveEnvironment,
  cwd: string,
): LiveServiceConfig {
  const piModel = environment.CAS_PI_MODEL ?? "openai-codex/gpt-5.6-luna";
  if (!/^[^/]+\/[^/]+$/.test(piModel)) {
    throw new Error("CAS_PI_MODEL must use provider/model format");
  }
  const memoryEnabled = parseBoolean(
    environment.MEMORY_ENABLED,
    true,
    "MEMORY_ENABLED",
  );
  const tickTickEnabled = parseBoolean(
    environment.TICKTICK_ENABLED,
    false,
    "TICKTICK_ENABLED",
  );
  const feishuTaskEnabled = parseBoolean(
    environment.FEISHU_TASK_ENABLED,
    false,
    "FEISHU_TASK_ENABLED",
  );
  const messageBatchingEnabled = parseBoolean(
    environment.CAS_MESSAGE_BATCHING_ENABLED,
    true,
    "CAS_MESSAGE_BATCHING_ENABLED",
  );
  const messageSettleMs = positiveInteger(
    environment.CAS_MESSAGE_SETTLE_MS,
    8_000,
    "CAS_MESSAGE_SETTLE_MS",
  );
  const messageMaxWaitMs = positiveInteger(
    environment.CAS_MESSAGE_MAX_WAIT_MS,
    30_000,
    "CAS_MESSAGE_MAX_WAIT_MS",
  );
  if (messageMaxWaitMs < messageSettleMs) {
    throw new Error("CAS_MESSAGE_MAX_WAIT_MS must be at least CAS_MESSAGE_SETTLE_MS");
  }
  const bankId = environment.HINDSIGHT_BANK_ID?.trim() || "cas-personal-agent";
  if (!/^[a-z0-9][a-z0-9._-]{0,119}$/.test(bankId)) {
    throw new Error("HINDSIGHT_BANK_ID must be a stable lowercase key");
  }

  return {
    cwd,
    databasePath: resolve(
      cwd,
      environment.CAS_DATABASE_PATH ?? "./var/cas-agent.sqlite",
    ),
    allowedUserIds: parseAllowlist(environment.CAS_ALLOWED_USER_IDS),
    piSessionDirectory: resolve(
      cwd,
      environment.CAS_PI_SESSION_DIR ?? "./var/pi-sessions",
    ),
    piModel,
    piThinkingLevel: thinkingLevel(environment.CAS_PI_THINKING_LEVEL),
    bitableBaseToken: required(environment, "CAS_BITABLE_BASE_TOKEN"),
    bitableTables: {
      projects: required(environment, "CAS_BITABLE_PROJECTS_TABLE_ID"),
      items: required(environment, "CAS_BITABLE_ITEMS_TABLE_ID"),
      actionLinks: required(
        environment,
        "CAS_BITABLE_ACTION_LINKS_TABLE_ID",
      ),
    },
    memory: {
      enabled: memoryEnabled,
      baseUrl: hindsightBaseUrl(environment.HINDSIGHT_BASE_URL),
      bankId,
      recallTimeoutMs: positiveInteger(
        environment.HINDSIGHT_RECALL_TIMEOUT_MS,
        2_000,
        "HINDSIGHT_RECALL_TIMEOUT_MS",
      ),
      recallMaxResults: positiveInteger(
        environment.HINDSIGHT_RECALL_MAX_RESULTS,
        5,
        "HINDSIGHT_RECALL_MAX_RESULTS",
      ),
      recallMaxTokens: positiveInteger(
        environment.HINDSIGHT_RECALL_MAX_TOKENS,
        800,
        "HINDSIGHT_RECALL_MAX_TOKENS",
      ),
    },
    personalActions: tickTickEnabled
      ? {
          enabled: true,
          apiToken: required(environment, "TICKTICK_API_TOKEN"),
          projectId: required(environment, "TICKTICK_PROJECT_ID"),
          baseUrl: tickTickBaseUrl(environment.TICKTICK_BASE_URL),
        }
      : { enabled: false },
    collaborativeActions: { enabled: feishuTaskEnabled },
    messageBatching: {
      enabled: messageBatchingEnabled,
      settleMs: messageSettleMs,
      maxWaitMs: messageMaxWaitMs,
    },
    externalSync: {
      intervalMs: positiveInteger(environment.CAS_EXTERNAL_SYNC_INTERVAL_MS, 60_000, "CAS_EXTERNAL_SYNC_INTERVAL_MS"),
      requestBudget: positiveInteger(environment.CAS_EXTERNAL_SYNC_REQUEST_BUDGET, 5, "CAS_EXTERNAL_SYNC_REQUEST_BUDGET"),
      timeoutMs: positiveInteger(environment.CAS_EXTERNAL_SYNC_TIMEOUT_MS, 5_000, "CAS_EXTERNAL_SYNC_TIMEOUT_MS"),
    },
  };
}
