import { createHash } from "node:crypto";

import type { BitableAuthorityStore } from "./bitable-authority-store.js";
import {
  bitableValuesEqual,
  selectBitableFields,
} from "./bitable-authority-store.js";
import type { BitableRecordQueryClient, BitableTables } from "./bitable-state-projector.js";
import type { MemoryCandidate } from "./memory.js";

export interface AuthoritativeProjectState {
  readonly recordId: string;
  readonly projectKey: string;
  readonly name: string;
  readonly status?: string;
  readonly goal?: string;
  readonly phase?: string;
  readonly summary?: string;
  readonly updatedAt?: string;
  readonly sourceEventId?: string;
  readonly correctedFields: readonly string[];
}

export interface AuthoritativeItemState {
  readonly recordId: string;
  readonly itemKey: string;
  readonly title: string;
  readonly projectKey?: string;
  readonly type?: string;
  readonly status?: string;
  readonly nextAction?: string;
  readonly summary?: string;
  readonly waitingFor?: string;
  readonly releaseCondition?: string;
  readonly checkpointAt?: string;
  readonly contingency?: string;
  readonly parked: boolean;
  readonly updatedAt?: string;
  readonly sourceEventId?: string;
  readonly inCurrentAttention?: boolean;
  readonly attentionOrder?: number;
  readonly attentionReason?: string;
  readonly correctedFields: readonly string[];
}

export interface AuthoritativeBitableReconciliation {
  readonly projects: readonly AuthoritativeProjectState[];
  readonly items: readonly AuthoritativeItemState[];
  readonly currentProjects?: readonly AuthoritativeProjectState[];
  readonly currentItems?: readonly AuthoritativeItemState[];
  readonly memoryCandidates: readonly MemoryCandidate[];
}

export interface AuthoritativeBitableReader {
  reconcile(now?: string): Promise<AuthoritativeBitableReconciliation>;
}

export interface AuthoritativeBitableReaderOptions {
  readonly bitable: BitableRecordQueryClient;
  readonly tables: Pick<BitableTables, "projects" | "items">;
  readonly store: BitableAuthorityStore;
}

export const authoritativeProjectFields = [
  "项目名",
  "状态",
  "目标",
  "阶段",
  "当前摘要",
] as const;

export const authoritativeItemFields = [
  "事项",
  "项目",
  "类型",
  "状态",
  "下一步",
  "当前摘要",
  "在等什么",
  "解除条件",
  "检查点",
  "条件/预案",
  "稍后区",
] as const;

const projectReadFields = [
  "project_key",
  ...authoritativeProjectFields,
  "最近更新",
  "来源事件",
] as const;
const itemReadFields = [
  "item_key",
  ...authoritativeItemFields,
  "最近更新",
  "来源事件",
  "当前注意力",
  "注意力顺序",
  "注意力依据",
] as const;

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function selection(value: unknown): string | undefined {
  return Array.isArray(value) && typeof value[0] === "string"
    ? value[0]
    : undefined;
}

function linkedRecordId(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  const first = value[0];
  return typeof first === "object" && first !== null && "id" in first
    ? text((first as { readonly id?: unknown }).id)
    : undefined;
}

function optional<K extends string, V>(
  key: K,
  value: V | undefined,
): { readonly [P in K]?: V } {
  return value === undefined ? {} : ({ [key]: value } as { [P in K]: V });
}

function changedFields(
  current: Readonly<Record<string, unknown>>,
  previous: Readonly<Record<string, unknown>>,
  names: readonly string[],
): string[] {
  return names.filter(
    (name) => !bitableValuesEqual(current[name], previous[name]),
  );
}

function correctionFingerprint(
  tableId: string,
  recordId: string,
  fields: Readonly<Record<string, unknown>>,
  changes: readonly string[],
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        tableId,
        recordId,
        values: Object.fromEntries(changes.map((field) => [field, fields[field]])),
      }),
    )
    .digest("hex");
}

function displayValue(value: unknown): string {
  if (value === undefined || value === null || value === "") {
    return "已清空";
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return "已清空";
    }
    return value
      .map((entry) => {
        if (typeof entry === "object" && entry !== null) {
          if ("text" in entry) {
            return String((entry as { readonly text?: unknown }).text ?? "");
          }
          if ("id" in entry) {
            return String((entry as { readonly id?: unknown }).id ?? "");
          }
        }
        return String(entry);
      })
      .join("、");
  }
  return String(value);
}

function correctionCandidate(
  kind: "项目" | "事项",
  title: string,
  fingerprint: string,
  fields: Readonly<Record<string, unknown>>,
  changes: readonly string[],
): MemoryCandidate {
  const values = changes
    .map((field) => `${field}=${displayValue(fields[field]).slice(0, 160)}`)
    .join("；");
  return {
    key: `bitable-correction-${fingerprint.slice(0, 24)}`,
    category: "correction",
    content: `权威纠正：用户在飞书多维表格中修改了${kind}「${title.slice(0, 120)}」的${changes.join("、")}；当前值为：${values.slice(0, 700)}。`,
  };
}

export function createAuthoritativeBitableReader(
  options: AuthoritativeBitableReaderOptions,
): AuthoritativeBitableReader {
  return {
    async reconcile(now = new Date().toISOString()) {
      const [projectRecords, itemRecords] = await Promise.all([
        options.bitable.list(options.tables.projects, projectReadFields),
        options.bitable.list(options.tables.items, itemReadFields),
      ]);
      const projectKeysByRecordId = new Map<string, string>();
      const projects: AuthoritativeProjectState[] = [];
      const items: AuthoritativeItemState[] = [];
      const currentProjects: AuthoritativeProjectState[] = [];
      const currentItems: AuthoritativeItemState[] = [];
      const memoryCandidates: MemoryCandidate[] = [];

      for (const record of projectRecords) {
        const projectKey = text(record.fields.project_key);
        const name = text(record.fields["项目名"]);
        if (projectKey === undefined || name === undefined) {
          continue;
        }
        projectKeysByRecordId.set(record.recordId, projectKey);
        const current = selectBitableFields(
          record.fields,
          authoritativeProjectFields,
        );
        const snapshot = options.store.getSnapshot(
          options.tables.projects,
          projectKey,
        );
        if (snapshot === undefined) {
          options.store.saveSnapshot({
            tableId: options.tables.projects,
            recordId: record.recordId,
            stableKey: projectKey,
            fields: current,
            projectedAt: now,
          });
        }
        const corrections =
          snapshot === undefined
            ? []
            : changedFields(current, snapshot.fields, authoritativeProjectFields);
        if (corrections.length > 0) {
          const fingerprint = correctionFingerprint(
            options.tables.projects,
            record.recordId,
            current,
            corrections,
          );
          if (
            options.store.rememberCorrection({
              fingerprint,
              tableId: options.tables.projects,
              recordId: record.recordId,
              stableKey: projectKey,
              changedFields: corrections,
              observedAt: now,
            })
          ) {
            memoryCandidates.push(
              correctionCandidate(
                "项目",
                name,
                fingerprint,
                current,
                corrections,
              ),
            );
          }
        }
        const status = selection(record.fields["状态"]);
        const goal = text(record.fields["目标"]);
        const phase = selection(record.fields["阶段"]);
        const summary = text(record.fields["当前摘要"]);
        const updatedAt = text(record.fields["最近更新"]);
        const sourceEventId = text(record.fields["来源事件"]);
        const state: AuthoritativeProjectState = {
          recordId: record.recordId,
          projectKey,
          name,
          ...optional("status", status),
          ...optional("goal", goal),
          ...optional("phase", phase),
          ...optional("summary", summary),
          ...optional("updatedAt", updatedAt),
          ...optional("sourceEventId", sourceEventId),
          correctedFields: corrections,
        };
        currentProjects.push(state);
        if (corrections.length > 0) {
          projects.push(state);
        }
      }

      for (const record of itemRecords) {
        const itemKey = text(record.fields.item_key);
        const title = text(record.fields["事项"]);
        if (itemKey === undefined || title === undefined) {
          continue;
        }
        const current = selectBitableFields(record.fields, authoritativeItemFields);
        const snapshot = options.store.getSnapshot(options.tables.items, itemKey);
        if (snapshot === undefined) {
          options.store.saveSnapshot({
            tableId: options.tables.items,
            recordId: record.recordId,
            stableKey: itemKey,
            fields: current,
            projectedAt: now,
          });
        }
        const corrections =
          snapshot === undefined
            ? []
            : changedFields(current, snapshot.fields, authoritativeItemFields);
        if (corrections.length > 0) {
          const fingerprint = correctionFingerprint(
            options.tables.items,
            record.recordId,
            current,
            corrections,
          );
          if (
            options.store.rememberCorrection({
              fingerprint,
              tableId: options.tables.items,
              recordId: record.recordId,
              stableKey: itemKey,
              changedFields: corrections,
              observedAt: now,
            })
          ) {
            memoryCandidates.push(
              correctionCandidate(
                "事项",
                title,
                fingerprint,
                current,
                corrections,
              ),
            );
          }
        }
        const projectRecordId = linkedRecordId(record.fields["项目"]);
        const projectKey =
          projectRecordId === undefined
            ? undefined
            : projectKeysByRecordId.get(projectRecordId);
        const type = selection(record.fields["类型"]);
        const status = selection(record.fields["状态"]);
        const nextAction = text(record.fields["下一步"]);
        const summary = text(record.fields["当前摘要"]);
        const waitingFor = text(record.fields["在等什么"]);
        const releaseCondition = text(record.fields["解除条件"]);
        const checkpointAt = text(record.fields["检查点"]);
        const contingency = text(record.fields["条件/预案"]);
        const updatedAt = text(record.fields["最近更新"]);
        const sourceEventId = text(record.fields["来源事件"]);
        const attentionOrder =
          typeof record.fields["注意力顺序"] === "number"
            ? record.fields["注意力顺序"]
            : undefined;
        const attentionReason = text(record.fields["注意力依据"]);
        const state: AuthoritativeItemState = {
          recordId: record.recordId,
          itemKey,
          title,
          ...optional("projectKey", projectKey),
          ...optional("type", type),
          ...optional("status", status),
          ...optional("nextAction", nextAction),
          ...optional("summary", summary),
          ...optional("waitingFor", waitingFor),
          ...optional("releaseCondition", releaseCondition),
          ...optional("checkpointAt", checkpointAt),
          ...optional("contingency", contingency),
          parked: record.fields["稍后区"] === true,
          ...optional("updatedAt", updatedAt),
          ...optional("sourceEventId", sourceEventId),
          inCurrentAttention: record.fields["当前注意力"] === true,
          ...optional("attentionOrder", attentionOrder),
          ...optional("attentionReason", attentionReason),
          correctedFields: corrections,
        };
        currentItems.push(state);
        if (corrections.length > 0) {
          items.push(state);
        }
      }

      return {
        projects,
        items,
        currentProjects,
        currentItems,
        memoryCandidates,
      };
    },
  };
}
