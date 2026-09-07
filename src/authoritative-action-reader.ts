import { createHash } from "node:crypto";

import type {
  CollaborativeActionAdapter,
  ExternalCollaborativeAction,
  ExternalPersonalAction,
  PersonalActionAdapter,
} from "./action.js";
import type { BitableRecordQueryClient } from "./bitable-state-projector.js";
import type { MemoryCandidate } from "./memory.js";

export interface AuthoritativeActionState {
  readonly actionKey: string;
  readonly title: string;
  readonly factOwner: "ticktick" | "feishu_task";
  readonly status: "open" | "completed";
  readonly deadlineAt?: string | null;
  readonly assignees?: readonly string[];
  readonly updatedAt?: string;
  readonly correctedFields: readonly string[];
}

export interface AuthoritativeActionReconciliation {
  readonly states: readonly AuthoritativeActionState[];
  readonly memoryCandidates: readonly MemoryCandidate[];
}

export interface AuthoritativeActionReader {
  reconcile(now?: string): Promise<AuthoritativeActionReconciliation>;
}

export interface AuthoritativeActionReaderOptions {
  readonly bitable: BitableRecordQueryClient;
  readonly actionLinksTableId: string;
  readonly personal?: {
    readonly adapter: PersonalActionAdapter;
    readonly projectId: string;
  };
  readonly collaborative?: {
    readonly adapter: CollaborativeActionAdapter;
  };
  readonly onError?: (error: unknown) => void;
}

const actionFields = [
  "action_key",
  "行动",
  "事实源",
  "外部对象 ID",
  "外部状态镜像",
  "负责人",
  "deadline",
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

function sameTime(left: string | undefined, right: string | null): boolean {
  if (left === undefined || right === null) {
    return left === undefined && right === null;
  }
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  return Number.isFinite(leftTime) && Number.isFinite(rightTime)
    ? leftTime === rightTime
    : left === right;
}

function correctionCandidate(
  state: AuthoritativeActionState,
  changes: readonly string[],
  observedAt: string,
): MemoryCandidate | undefined {
  if (changes.length === 0) {
    return undefined;
  }
  const suffix = createHash("sha256")
    .update(`${state.actionKey}:${state.updatedAt ?? observedAt}:${changes.join(",")}`)
    .digest("hex")
    .slice(0, 16);
  return {
    key: `action-correction-${state.actionKey}-${suffix}`.slice(0, 120),
    category: "correction",
    content: `权威纠正：行动「${state.title}」在${state.factOwner === "ticktick" ? "滴答" : "飞书任务"}中的${changes.join("、")}已被人工修改；当前状态为 ${state.status}${state.deadlineAt == null ? "" : `，截止时间为 ${state.deadlineAt}`}${state.assignees === undefined ? "" : `，负责人为 ${state.assignees.join("、") || "无"}`}。`,
  };
}

function externalFields(
  external: ExternalPersonalAction | ExternalCollaborativeAction,
): {
  readonly title?: string;
  readonly deadlineAt?: string | null;
  readonly updatedAt?: string;
  readonly assignees?: readonly string[];
} {
  return {
    ...(external.title === undefined ? {} : { title: external.title }),
    ...(!("deadlineAt" in external)
      ? {}
      : { deadlineAt: external.deadlineAt }),
    ...(external.updatedAt === undefined
      ? {}
      : { updatedAt: external.updatedAt }),
    ...(!("assigneeNames" in external) || external.assigneeNames === undefined
      ? {}
      : { assignees: external.assigneeNames }),
  };
}

export function createAuthoritativeActionReader(
  options: AuthoritativeActionReaderOptions,
): AuthoritativeActionReader {
  return {
    async reconcile(now = new Date().toISOString()) {
      const records = await options.bitable.list(
        options.actionLinksTableId,
        actionFields,
      );
      const states: AuthoritativeActionState[] = [];
      const memoryCandidates: MemoryCandidate[] = [];

      for (const record of records) {
        const actionKey = text(record.fields.action_key);
        const mirroredTitle = text(record.fields["行动"]);
        const owner = selection(record.fields["事实源"]);
        const externalId = text(record.fields["外部对象 ID"]);
        if (
          actionKey === undefined ||
          mirroredTitle === undefined ||
          externalId === undefined ||
          !["滴答", "飞书任务"].includes(owner ?? "")
        ) {
          continue;
        }

        try {
          const external =
            owner === "滴答"
              ? await options.personal?.adapter.getState(
                  options.personal.projectId,
                  externalId,
                )
              : await options.collaborative?.adapter.getState(externalId);
          if (external === undefined) {
            continue;
          }
          const details = externalFields(external);
          const title = details.title ?? mirroredTitle;
          const correctedFields: string[] = [];
          const mirroredStatus = text(record.fields["外部状态镜像"]);
          if (
            mirroredStatus !== undefined &&
            mirroredStatus !== external.status
          ) {
            correctedFields.push("完成状态");
          }
          if (details.title !== undefined && details.title !== mirroredTitle) {
            correctedFields.push("标题");
          }
          const mirroredDeadline = text(record.fields.deadline);
          if (
            "deadlineAt" in details &&
            !sameTime(mirroredDeadline, details.deadlineAt ?? null)
          ) {
            correctedFields.push("截止时间");
          }
          const mirroredAssignee = text(record.fields["负责人"]);
          if (
            details.assignees !== undefined &&
            (mirroredAssignee ?? "") !== details.assignees.join("、")
          ) {
            correctedFields.push("负责人");
          }

          const state: AuthoritativeActionState = {
            actionKey,
            title,
            factOwner: owner === "滴答" ? "ticktick" : "feishu_task",
            status: external.status,
            ...(details.deadlineAt === undefined
              ? {}
              : { deadlineAt: details.deadlineAt }),
            ...(details.assignees === undefined
              ? {}
              : { assignees: details.assignees }),
            ...(details.updatedAt === undefined
              ? {}
              : { updatedAt: details.updatedAt }),
            correctedFields,
          };
          states.push(state);
          const candidate = correctionCandidate(state, correctedFields, now);
          if (candidate !== undefined) {
            memoryCandidates.push(candidate);
          }

          if (correctedFields.length > 0) {
            await options.bitable.update(
              options.actionLinksTableId,
              record.recordId,
              {
              行动: title,
              外部状态镜像: external.status,
              最近同步: now,
              同步状态: ["succeeded"],
              ...(details.deadlineAt === undefined
                ? {}
                : { deadline: details.deadlineAt }),
              ...(details.assignees === undefined
                ? {}
                : { 负责人: details.assignees.join("、") || null }),
              },
            );
          }
        } catch (error) {
          options.onError?.(error);
        }
      }

      return { states, memoryCandidates };
    },
  };
}
