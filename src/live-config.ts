import { resolve } from "node:path";

import type { LiveServiceConfig } from "./live-service.js";

export interface LiveEnvironment {
  readonly [key: string]: string | undefined;
  readonly CAS_ALLOWED_USER_IDS?: string;
  readonly CAS_DATABASE_PATH?: string;
  readonly CAS_PI_SESSION_DIR?: string;
  readonly CAS_PI_MODEL?: string;
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

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value.trim().length === 0) {
    return defaultValue;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error("MEMORY_ENABLED must be true or false");
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

export function loadLiveConfig(
  environment: LiveEnvironment,
  cwd: string,
): LiveServiceConfig {
  const piModel = environment.CAS_PI_MODEL ?? "openai-codex/gpt-5.6-luna";
  if (!/^[^/]+\/[^/]+$/.test(piModel)) {
    throw new Error("CAS_PI_MODEL must use provider/model format");
  }
  const memoryEnabled = parseBoolean(environment.MEMORY_ENABLED, true);
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
  };
}
