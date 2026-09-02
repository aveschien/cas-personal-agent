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

export function loadLiveConfig(
  environment: LiveEnvironment,
  cwd: string,
): LiveServiceConfig {
  const piModel = environment.CAS_PI_MODEL ?? "openai-codex/gpt-5.6-luna";
  if (!/^[^/]+\/[^/]+$/.test(piModel)) {
    throw new Error("CAS_PI_MODEL must use provider/model format");
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
  };
}
