import { spawn } from "node:child_process";

import type {
  BitableRecord,
  BitableRecordClient,
} from "./bitable-state-projector.js";
import type {
  CommandResult,
  CommandRunner,
} from "./lark-reply-adapter.js";

export interface LarkBaseClientOptions {
  readonly baseToken: string;
  readonly command?: string;
  readonly runner?: CommandRunner;
}

const processRunner: CommandRunner = {
  run(command, args): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, [...args], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.once("error", reject);
      child.once("exit", (code) => {
        resolve({ exitCode: code ?? 1, stdout, stderr });
      });
    });
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSuccess(result: CommandResult, operation: string): Record<string, unknown> {
  if (result.exitCode !== 0) {
    const diagnostic = `${result.stderr}\n${result.stdout}`;
    const code = diagnostic.match(/\b\d{6,}\b/)?.[0];
    throw new Error(
      `Lark Base ${operation} failed${code === undefined ? "" : ` (code ${code})`}`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(result.stdout) as unknown;
  } catch {
    throw new Error(`Lark Base ${operation} returned invalid JSON`);
  }
  if (!isRecord(value) || value.ok !== true || !isRecord(value.data)) {
    throw new Error(`Lark Base ${operation} was rejected`);
  }
  return value.data;
}

function recordIds(data: Record<string, unknown>): string[] {
  const direct = data.record_id_list;
  if (Array.isArray(direct) && direct.every((id) => typeof id === "string")) {
    return direct;
  }
  const nested = data.data;
  if (isRecord(nested)) {
    return recordIds(nested);
  }
  return [];
}

export function createLarkBaseClient(
  options: LarkBaseClientOptions,
): BitableRecordClient {
  const command = options.command ?? "lark-cli";
  const runner = options.runner ?? processRunner;

  return {
    async findByKey(tableId, keyField, key) {
      const result = await runner.run(command, [
        "base",
        "+record-search",
        "--base-token",
        options.baseToken,
        "--table-id",
        tableId,
        "--json",
        JSON.stringify({
          keyword: key,
          search_fields: [keyField],
          select_fields: [keyField],
          filter: {
            logic: "and",
            conditions: [[keyField, "==", key]],
          },
          limit: 2,
        }),
        "--format",
        "json",
        "--as",
        "user",
      ]);
      const data = parseSuccess(result, "record lookup");
      const rows = Array.isArray(data.data) ? data.data : [];
      const fields = Array.isArray(data.fields) ? data.fields : [];
      const ids = recordIds(data);
      const keyIndex = fields.findIndex((field) => field === keyField);
      if (keyIndex < 0 && ids.length > 0) {
        throw new Error(`Lark Base lookup omitted key field ${keyField}`);
      }
      const matches = ids.flatMap((recordId, index) => {
        const row = rows[index];
        if (!Array.isArray(row) || row[keyIndex] !== key) {
          return [];
        }
        return [{ recordId, fields: { [keyField]: key } }];
      });
      if (matches.length > 1) {
        throw new Error(`Bitable contains duplicate ${keyField} ${key}`);
      }
      return matches[0];
    },

    async create(tableId, keyField, key, fields) {
      const completeFields = { ...fields, [keyField]: key };
      const result = await runner.run(command, [
        "base",
        "+record-batch-create",
        "--base-token",
        options.baseToken,
        "--table-id",
        tableId,
        "--json",
        JSON.stringify({ create_records: [completeFields] }),
        "--as",
        "user",
        "--format",
        "json",
      ]);
      const data = parseSuccess(result, "record create");
      const [recordId] = recordIds(data);
      if (recordId === undefined) {
        throw new Error("Lark Base record create omitted record ID");
      }
      return { recordId, fields: completeFields } satisfies BitableRecord;
    },

    async update(tableId, recordId, fields) {
      const result = await runner.run(command, [
        "base",
        "+record-batch-update",
        "--base-token",
        options.baseToken,
        "--table-id",
        tableId,
        "--json",
        JSON.stringify({ update_records: { [recordId]: fields } }),
        "--as",
        "user",
        "--format",
        "json",
      ]);
      parseSuccess(result, "record update");
    },
  };
}
