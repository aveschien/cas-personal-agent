import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import type {
  AuthoritativeBitableReconciliation,
  AuthoritativeItemState,
  AuthoritativeProjectState,
} from "./authoritative-bitable-reader.js";
import type { BitableRecord } from "./bitable-state-projector.js";
import {
  compileBitableProjection,
  type ActionLinkProjection,
  type BitableProjectionPlan,
  type ItemProjection,
  type ItemStatus,
  type ItemType,
  type ProjectPhase,
  type ProjectProjection,
  type ProjectStatus,
  type SemanticOperation,
} from "./state-operations.js";
import { initializeStorage } from "./storage.js";

export type CurrentStateSource =
  | "migration"
  | "user_intent"
  | "external_correction"
  | "execution_result";

export interface ApplyCurrentStateInput {
  readonly sourceKind: CurrentStateSource;
  readonly sourceEventId: string;
  readonly occurredAt: string;
  readonly operations: readonly SemanticOperation[];
  readonly baseRevisions?: Readonly<Record<string, number>>;
}

export interface CurrentStateVersion {
  readonly entityType: "project" | "item" | "action_link";
  readonly entityKey: string;
  readonly revision: number;
  readonly sourceKind: CurrentStateSource;
  readonly sourceEventId: string;
  readonly sourceOccurredAt: string;
  readonly baseRevision?: number;
  readonly applied: boolean;
  readonly rejectionReason?: string;
}

export interface CurrentStateSnapshot {
  readonly projects: readonly ProjectProjection[];
  readonly items: readonly ItemProjection[];
  readonly actionLinks: readonly ActionLinkProjection[];
}

export interface ActionExecutionState {
  readonly actionKey: string;
  readonly externalObjectId?: string;
  readonly status: "requested" | "confirmed" | "failed" | "unknown";
  readonly revision: number;
  readonly sourceEventId: string;
}

export interface CurrentActionState extends ActionExecutionState {
  readonly recordId?: string;
  readonly itemKey: string;
  readonly projectKey?: string;
  readonly title: string;
  readonly factOwner: "ticktick" | "feishu_task" | "bitable";
  readonly deadlineAt?: string;
  readonly assignee?: string;
  readonly externalStatus: "open" | "completed" | "unknown";
  readonly externalFingerprint?: string;
  readonly lastVerifiedAt?: string;
  readonly uncertaintyReason?: string;
}

export interface CurrentStateStore {
  apply(input: ApplyCurrentStateInput): BitableProjectionPlan;
  importBitable(
    reconciliation: AuthoritativeBitableReconciliation,
    observedAt: string,
    actionRecords?: readonly BitableRecord[],
  ): void;
  read(): AuthoritativeBitableReconciliation;
  snapshot(): CurrentStateSnapshot;
  versions(entityType: CurrentStateVersion["entityType"], entityKey: string): readonly CurrentStateVersion[];
  bindRecord(
    entityType: CurrentStateVersion["entityType"],
    entityKey: string,
    recordId: string,
    confirmedAt: string,
  ): void;
  markProjectionSucceeded(sourceEventId: string, confirmedAt: string): void;
  markProjectionFailed(sourceEventId: string, failedAt: string): void;
  recordActionExecution(input: {
    readonly actionKey: string;
    readonly sourceEventId: string;
    readonly occurredAt: string;
    readonly externalObjectId?: string;
    readonly status: "confirmed" | "failed";
  }): void;
  actionExecution(actionKey: string): ActionExecutionState | undefined;
  actionStates(factOwner?: CurrentActionState["factOwner"]): readonly CurrentActionState[];
  recordExternalActionState(input: {
    readonly actionKey: string;
    readonly observedAt: string;
    readonly sourceUpdatedAt?: string;
    readonly fingerprint: string;
    readonly status: "open" | "completed" | "unknown";
    readonly title?: string;
    readonly deadlineAt?: string | null;
    readonly assignee?: string | null;
    readonly uncertaintyReason?: string;
  }): boolean;
  close(): void;
}

interface ProjectRow {
  project_key: string;
  record_id: string | null;
  name: string;
  status: ProjectStatus;
  goal: string | null;
  phase: ProjectPhase | null;
  summary: string | null;
  revision: number;
  source_kind: CurrentStateSource;
  source_event_id: string;
  source_occurred_at: string;
  projection_status: "local_only" | "pending" | "confirmed" | "failed";
}

interface ItemRow {
  item_key: string;
  record_id: string | null;
  title: string;
  type: ItemType;
  status: ItemStatus;
  project_key: string | null;
  next_action: string | null;
  summary: string | null;
  waiting_for: string | null;
  release_condition: string | null;
  checkpoint_at: string | null;
  contingency: string | null;
  parked: number;
  revision: number;
  source_kind: CurrentStateSource;
  source_event_id: string;
  source_occurred_at: string;
  projection_status: "local_only" | "pending" | "confirmed" | "failed";
}

interface ActionRow {
  action_key: string;
  record_id: string | null;
  item_key: string;
  project_key: string | null;
  title: string;
  action_type: ActionLinkProjection["actionType"];
  fact_owner: ActionLinkProjection["factOwner"];
  assignee: string | null;
  assignee_id: string | null;
  deadline_at: string | null;
  start_at: string | null;
  end_at: string | null;
  external_object_id: string | null;
  external_status: "open" | "completed" | "unknown";
  external_fingerprint: string | null;
  external_updated_at: string | null;
  last_verified_at: string | null;
  uncertainty_reason: string | null;
  execution_status: "requested" | "confirmed" | "failed" | "unknown";
  revision: number;
  source_kind: CurrentStateSource;
  source_event_id: string;
  source_occurred_at: string;
}

interface VersionRow {
  entity_type: CurrentStateVersion["entityType"];
  entity_key: string;
  revision: number;
  source_kind: CurrentStateSource;
  source_event_id: string;
  source_occurred_at: string;
  base_revision: number | null;
  applied: number;
  rejection_reason: string | null;
}

const projectStatusLabel: Readonly<Record<ProjectStatus, string>> = {
  tracking: "在跟",
  paused: "暂停",
  finished: "结束",
};
const itemTypeLabel: Readonly<Record<ItemType, string>> = {
  task: "任务",
  idea: "想法",
  question: "问题",
  decision: "决策",
  information: "信息",
};
const itemStatusLabel: Readonly<Record<ItemStatus, string>> = {
  inbox: "收件箱",
  actionable: "可行动",
  in_progress: "进行中",
  waiting: "等待",
  scheduled: "已排期",
  completed: "完成",
  abandoned: "放弃",
  archived: "归档",
};
const projectStatusValue = new Map(
  Object.entries(projectStatusLabel).map(([key, value]) => [value, key as ProjectStatus]),
);
const itemTypeValue = new Map(
  Object.entries(itemTypeLabel).map(([key, value]) => [value, key as ItemType]),
);
const itemStatusValue = new Map(
  Object.entries(itemStatusLabel).map(([key, value]) => [value, key as ItemStatus]),
);

function text(entry: unknown): string | undefined {
  return typeof entry === "string" && entry.trim().length > 0
    ? entry.trim()
    : undefined;
}

function selection(entry: unknown): string | undefined {
  return Array.isArray(entry) && typeof entry[0] === "string"
    ? entry[0]
    : undefined;
}

function linkedRecord(entry: unknown): string | undefined {
  if (!Array.isArray(entry) || entry.length === 0) return undefined;
  const first = entry[0];
  return typeof first === "object" && first !== null && "id" in first
    ? text((first as { readonly id?: unknown }).id)
    : undefined;
}

function value<T>(incoming: T | null | undefined, current: T | null): T | null {
  return incoming === undefined ? current : incoming;
}

function optional<T>(key: string, entry: T | null): Record<string, T> {
  return entry === null ? {} : { [key]: entry };
}

function projectFromRow(row: ProjectRow): ProjectProjection {
  return {
    key: row.project_key,
    name: row.name,
    status: row.status,
    goal: row.goal,
    phase: row.phase,
    summary: row.summary,
    sourceEventId: row.source_event_id,
  } as ProjectProjection;
}

function itemFromRow(row: ItemRow): ItemProjection {
  return {
    key: row.item_key,
    title: row.title,
    type: row.type,
    status: row.status,
    projectKey: row.project_key,
    nextAction: row.next_action,
    summary: row.summary,
    waitingFor: row.waiting_for,
    releaseCondition: row.release_condition,
    checkpointAt: row.checkpoint_at,
    contingency: row.contingency,
    ...(row.parked === 1 ? { parked: true as const } : {}),
    sourceEventId: row.source_event_id,
  } as ItemProjection;
}

function actionFromRow(row: ActionRow): ActionLinkProjection {
  return {
    key: row.action_key,
    itemKey: row.item_key,
    ...optional("projectKey", row.project_key),
    title: row.title,
    actionType: row.action_type,
    factOwner: row.fact_owner,
    ...optional("assignee", row.assignee),
    ...optional("assigneeId", row.assignee_id),
    ...optional("deadlineAt", row.deadline_at),
    ...optional("startAt", row.start_at),
    ...optional("endAt", row.end_at),
    syncStatus: "pending",
    sourceEventId: row.source_event_id,
  } as ActionLinkProjection;
}

function staleReason(
  current: { readonly revision: number; readonly source_occurred_at: string } | undefined,
  occurredAt: string,
  baseRevision: number | undefined,
): string | undefined {
  if (current === undefined) {
    return undefined;
  }
  if (baseRevision !== undefined && baseRevision < current.revision) {
    return `base revision ${baseRevision} is behind current revision ${current.revision}`;
  }
  if (Date.parse(occurredAt) < Date.parse(current.source_occurred_at)) {
    return `source occurrence ${occurredAt} is older than ${current.source_occurred_at}`;
  }
  return undefined;
}

export function createCurrentStateStore(databasePath: string): CurrentStateStore {
  const database = new DatabaseSync(databasePath, {
    enableForeignKeyConstraints: true,
  });
  initializeStorage(database);

  const project = (key: string): ProjectRow | undefined =>
    database.prepare("SELECT * FROM current_projects WHERE project_key = ?").get(key) as
      | ProjectRow
      | undefined;
  const item = (key: string): ItemRow | undefined =>
    database.prepare("SELECT * FROM current_items WHERE item_key = ?").get(key) as
      | ItemRow
      | undefined;
  const action = (key: string): ActionRow | undefined =>
    database.prepare("SELECT * FROM current_action_links WHERE action_key = ?").get(key) as
      | ActionRow
      | undefined;

  const hasVersion = (
    sourceKind: CurrentStateSource,
    sourceEventId: string,
    entityType: CurrentStateVersion["entityType"],
    entityKey: string,
  ): boolean =>
    database
      .prepare(
        `SELECT 1 FROM current_state_versions
         WHERE source_kind = ? AND source_event_id = ?
           AND entity_type = ? AND entity_key = ?`,
      )
      .get(sourceKind, sourceEventId, entityType, entityKey) !== undefined;

  const rememberVersion = (
    entityType: CurrentStateVersion["entityType"],
    entityKey: string,
    revision: number,
    input: ApplyCurrentStateInput,
    change: unknown,
    applied: boolean,
    rejectionReason?: string,
  ): void => {
    database
      .prepare(
        `INSERT OR IGNORE INTO current_state_versions (
           entity_type, entity_key, revision, source_kind, source_event_id,
           source_occurred_at, base_revision, change_json, applied,
           rejection_reason, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entityType,
        entityKey,
        revision,
        input.sourceKind,
        input.sourceEventId,
        input.occurredAt,
        input.baseRevisions?.[`${entityType}:${entityKey}`] ?? null,
        JSON.stringify(change),
        applied ? 1 : 0,
        rejectionReason ?? null,
        input.occurredAt,
      );
  };

  const apply = (input: ApplyCurrentStateInput): BitableProjectionPlan => {
    const proposed = compileBitableProjection({
      sourceEventId: input.sourceEventId,
      operations: input.operations,
    });
    const effectiveProjects: ProjectProjection[] = [];
    const effectiveItems: ItemProjection[] = [];
    const effectiveActions: ActionLinkProjection[] = [];
    database.exec("BEGIN IMMEDIATE");
    try {
      for (const change of proposed.projects) {
        const current = project(change.key);
        if (hasVersion(input.sourceKind, input.sourceEventId, "project", change.key)) {
          if (current !== undefined) effectiveProjects.push(projectFromRow(current));
          continue;
        }
        const baseRevision = input.baseRevisions?.[`project:${change.key}`];
        const rejection = staleReason(current, input.occurredAt, baseRevision);
        const revision = (current?.revision ?? 0) + (rejection === undefined ? 1 : 0);
        rememberVersion("project", change.key, revision, input, change, rejection === undefined, rejection);
        if (rejection !== undefined) {
          if (current !== undefined) effectiveProjects.push(projectFromRow(current));
          continue;
        }
        database
          .prepare(
            `INSERT INTO current_projects (
               project_key, record_id, name, status, goal, phase, summary,
               revision, source_kind, source_event_id, source_occurred_at,
               projection_status, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(project_key) DO UPDATE SET
               name = excluded.name, status = excluded.status, goal = excluded.goal,
               phase = excluded.phase, summary = excluded.summary,
               revision = excluded.revision, source_kind = excluded.source_kind,
               source_event_id = excluded.source_event_id,
               source_occurred_at = excluded.source_occurred_at,
               projection_status = excluded.projection_status,
               updated_at = excluded.updated_at`,
          )
          .run(
            change.key,
            current?.record_id ?? null,
            change.name,
            change.status,
            value(change.goal, current?.goal ?? null),
            value(change.phase, current?.phase ?? null),
            value(change.summary, current?.summary ?? null),
            revision,
            input.sourceKind,
            input.sourceEventId,
            input.occurredAt,
            input.sourceKind === "user_intent" ? "pending" : "local_only",
            input.occurredAt,
          );
        effectiveProjects.push(projectFromRow(project(change.key)!));
      }

      for (const change of proposed.items) {
        const current = item(change.key);
        if (hasVersion(input.sourceKind, input.sourceEventId, "item", change.key)) {
          if (current !== undefined) effectiveItems.push(itemFromRow(current));
          continue;
        }
        const baseRevision = input.baseRevisions?.[`item:${change.key}`];
        const rejection = staleReason(current, input.occurredAt, baseRevision);
        const revision = (current?.revision ?? 0) + (rejection === undefined ? 1 : 0);
        rememberVersion("item", change.key, revision, input, change, rejection === undefined, rejection);
        if (rejection !== undefined) {
          if (current !== undefined) effectiveItems.push(itemFromRow(current));
          continue;
        }
        const leavingWaiting = current?.status === "waiting" && change.status !== "waiting";
        const parked = change.parked === true ? 1 : change.status === "inbox" && current?.parked === 1 ? 1 : 0;
        database
          .prepare(
            `INSERT INTO current_items (
               item_key, record_id, title, type, status, project_key,
               next_action, summary, waiting_for, release_condition,
               checkpoint_at, contingency, parked, revision, source_kind,
               source_event_id, source_occurred_at, projection_status, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(item_key) DO UPDATE SET
               title = excluded.title, type = excluded.type, status = excluded.status,
               project_key = excluded.project_key, next_action = excluded.next_action,
               summary = excluded.summary, waiting_for = excluded.waiting_for,
               release_condition = excluded.release_condition,
               checkpoint_at = excluded.checkpoint_at, contingency = excluded.contingency,
               parked = excluded.parked, revision = excluded.revision,
               source_kind = excluded.source_kind, source_event_id = excluded.source_event_id,
               source_occurred_at = excluded.source_occurred_at,
               projection_status = excluded.projection_status,
               updated_at = excluded.updated_at`,
          )
          .run(
            change.key,
            current?.record_id ?? null,
            change.title,
            change.type,
            change.status,
            value(change.projectKey, current?.project_key ?? null),
            value(change.nextAction, current?.next_action ?? null),
            value(change.summary, current?.summary ?? null),
            leavingWaiting ? null : value(change.waitingFor, current?.waiting_for ?? null),
            leavingWaiting ? null : value(change.releaseCondition, current?.release_condition ?? null),
            leavingWaiting ? null : value(change.checkpointAt, current?.checkpoint_at ?? null),
            leavingWaiting ? null : value(change.contingency, current?.contingency ?? null),
            parked,
            revision,
            input.sourceKind,
            input.sourceEventId,
            input.occurredAt,
            input.sourceKind === "user_intent" ? "pending" : "local_only",
            input.occurredAt,
          );
        effectiveItems.push(itemFromRow(item(change.key)!));
      }

      for (const change of proposed.actionLinks) {
        const current = action(change.key);
        if (hasVersion(input.sourceKind, input.sourceEventId, "action_link", change.key)) {
          if (current !== undefined) effectiveActions.push(actionFromRow(current));
          continue;
        }
        const baseRevision = input.baseRevisions?.[`action_link:${change.key}`];
        const rejection = staleReason(current, input.occurredAt, baseRevision);
        const revision = (current?.revision ?? 0) + (rejection === undefined ? 1 : 0);
        rememberVersion("action_link", change.key, revision, input, change, rejection === undefined, rejection);
        if (rejection !== undefined) {
          if (current !== undefined) effectiveActions.push(actionFromRow(current));
          continue;
        }
        database
          .prepare(
            `INSERT INTO current_action_links (
               action_key, record_id, item_key, project_key, title, action_type,
               fact_owner, assignee, assignee_id, deadline_at, start_at, end_at,
               execution_status, revision, source_kind, source_event_id,
               source_occurred_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'requested', ?, ?, ?, ?, ?)
             ON CONFLICT(action_key) DO UPDATE SET
               item_key = excluded.item_key, project_key = excluded.project_key,
               title = excluded.title, action_type = excluded.action_type,
               fact_owner = excluded.fact_owner, assignee = excluded.assignee,
               assignee_id = excluded.assignee_id, deadline_at = excluded.deadline_at,
               start_at = excluded.start_at, end_at = excluded.end_at,
               execution_status = 'requested', revision = excluded.revision,
               source_kind = excluded.source_kind, source_event_id = excluded.source_event_id,
               source_occurred_at = excluded.source_occurred_at, updated_at = excluded.updated_at`,
          )
          .run(
            change.key,
            current?.record_id ?? null,
            change.itemKey,
            change.projectKey ?? current?.project_key ?? null,
            change.title,
            change.actionType,
            change.factOwner,
            change.assignee ?? current?.assignee ?? null,
            change.assigneeId ?? current?.assignee_id ?? null,
            change.deadlineAt ?? current?.deadline_at ?? null,
            change.startAt ?? current?.start_at ?? null,
            change.endAt ?? current?.end_at ?? null,
            revision,
            input.sourceKind,
            input.sourceEventId,
            input.occurredAt,
            input.occurredAt,
          );
        effectiveActions.push(actionFromRow(action(change.key)!));
      }
      if (input.sourceKind === "user_intent") {
        database.prepare(
          `INSERT OR IGNORE INTO outbox (
             id, operation_type, idempotency_key, payload_json, status,
             attempt_count, next_attempt_at, last_error_json, created_at, updated_at
           ) VALUES (?, 'bitable.project', ?, ?, 'pending', 0, ?, NULL, ?, ?)`,
        ).run(
          randomUUID(),
          `bitable.project:${input.sourceEventId}`,
          JSON.stringify({
            maxAttempts: 5,
            repair: {
              sourceEventId: input.sourceEventId,
              occurredAt: input.occurredAt,
              changes: input.operations,
            },
          }),
          input.occurredAt,
          input.occurredAt,
          input.occurredAt,
        );
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    return {
      projects: effectiveProjects,
      items: effectiveItems,
      actionLinks: effectiveActions,
      reminders: proposed.reminders,
      clarifications: proposed.clarifications,
    };
  };

  const importBitable = (
    reconciliation: AuthoritativeBitableReconciliation,
    observedAt: string,
    actionRecords: readonly BitableRecord[] = [],
  ): void => {
    const projects = reconciliation.currentProjects ?? reconciliation.projects;
    const items = reconciliation.currentItems ?? reconciliation.items;
    for (const state of projects) {
      const status = projectStatusValue.get(state.status ?? "") ?? "tracking";
      const sourceKind = state.correctedFields.length > 0 ? "external_correction" : "migration";
      const occurredAt = state.updatedAt ?? observedAt;
      apply({
        sourceKind,
        sourceEventId: sourceKind === "migration"
          ? `bitable-project:${state.recordId}`
          : `bitable-project:${state.recordId}:${occurredAt}`,
        occurredAt,
        operations: [{
          kind: "upsert_project",
          projectKey: state.projectKey,
          name: state.name,
          status,
          ...(state.goal === undefined ? {} : { goal: state.goal }),
          ...(state.phase === undefined ? {} : { phase: state.phase as ProjectPhase }),
          ...(state.summary === undefined ? {} : { summary: state.summary }),
        }],
      });
      database.prepare("UPDATE current_projects SET record_id = ? WHERE project_key = ?")
        .run(state.recordId, state.projectKey);
    }
    for (const state of items) {
      const type = itemTypeValue.get(state.type ?? "") ?? "information";
      const status = itemStatusValue.get(state.status ?? "") ?? "inbox";
      const sourceKind = state.correctedFields.length > 0 ? "external_correction" : "migration";
      const occurredAt = state.updatedAt ?? observedAt;
      const operations: SemanticOperation[] = [{
        kind: "upsert_item",
        itemKey: state.itemKey,
        title: state.title,
        type,
        status,
        ...(state.projectKey === undefined ? {} : { projectKey: state.projectKey }),
        ...(state.nextAction === undefined ? {} : { nextAction: state.nextAction }),
        ...(state.summary === undefined ? {} : { summary: state.summary }),
      }];
      if (status === "waiting" && state.waitingFor !== undefined && state.releaseCondition !== undefined) {
        operations.push({
          kind: "set_waiting",
          itemKey: state.itemKey,
          waitingFor: state.waitingFor,
          releaseCondition: state.releaseCondition,
          ...(state.checkpointAt === undefined ? {} : { checkpointAt: state.checkpointAt }),
          ...(state.contingency === undefined ? {} : { contingency: state.contingency }),
        });
      }
      apply({
        sourceKind,
        sourceEventId: sourceKind === "migration"
          ? `bitable-item:${state.recordId}`
          : `bitable-item:${state.recordId}:${occurredAt}`,
        occurredAt,
        operations,
      });
      database.prepare("UPDATE current_items SET record_id = ? WHERE item_key = ?")
        .run(state.recordId, state.itemKey);
    }
    for (const record of actionRecords) {
      const actionKey = text(record.fields.action_key);
      const title = text(record.fields["行动"]);
      const itemRecordId = linkedRecord(record.fields["所属事项"]);
      const itemRow = itemRecordId === undefined
        ? undefined
        : database.prepare("SELECT * FROM current_items WHERE record_id = ?").get(itemRecordId) as ItemRow | undefined;
      const actionTypeLabel = selection(record.fields["行动类型"]);
      const ownerLabel = selection(record.fields["事实源"]);
      const mirroredExternalStatus = text(record.fields["外部状态镜像"]);
      const externalStatus = mirroredExternalStatus === "open" || mirroredExternalStatus === "completed"
        ? mirroredExternalStatus
        : "unknown";
      if (actionKey === undefined || title === undefined || itemRow === undefined) continue;
      const projectRecordId = linkedRecord(record.fields["所属项目"]);
      const projectRow = projectRecordId === undefined
        ? undefined
        : database.prepare("SELECT * FROM current_projects WHERE record_id = ?").get(projectRecordId) as ProjectRow | undefined;
      const common = {
        actionKey,
        itemKey: itemRow.item_key,
        ...(projectRow === undefined ? {} : { projectKey: projectRow.project_key }),
        title,
      };
      let operation: SemanticOperation | undefined;
      if (actionTypeLabel === "个人行动" && ownerLabel === "滴答") {
        operation = {
          kind: "plan_action",
          ...common,
          actionType: "personal_action",
          factOwner: "ticktick",
          ...(text(record.fields.deadline) === undefined ? {} : { deadlineAt: text(record.fields.deadline)! }),
        };
      } else if (actionTypeLabel === "协同承诺" && ownerLabel === "飞书任务") {
        const assignee = text(record.fields["负责人"]);
        const assigneeId = text(record.fields.assignee_id);
        if (assignee === undefined || assigneeId === undefined) {
          const sourceEventId = `bitable-action:${record.recordId}`;
          if (!hasVersion("migration", sourceEventId, "action_link", actionKey)) {
            const input: ApplyCurrentStateInput = {
              sourceKind: "migration",
              sourceEventId,
              occurredAt: text(record.fields["最近同步"]) ?? observedAt,
              operations: [],
            };
            database.exec("BEGIN IMMEDIATE");
            try {
              rememberVersion("action_link", actionKey, 1, input, record.fields, true);
              database.prepare(
                `INSERT OR IGNORE INTO current_action_links (
                   action_key, record_id, item_key, project_key, title,
                   action_type, fact_owner, assignee, assignee_id,
                   deadline_at, start_at, end_at, external_object_id,
                   execution_status, revision, source_kind, source_event_id,
                   source_occurred_at, updated_at
                 ) VALUES (?, ?, ?, ?, ?, 'collaborative_commitment',
                           'feishu_task', ?, NULL, ?, NULL, NULL, ?, ?, 1,
                           'migration', ?, ?, ?)`,
              ).run(
                actionKey,
                record.recordId,
                itemRow.item_key,
                projectRow?.project_key ?? null,
                title,
                assignee ?? null,
                text(record.fields.deadline) ?? null,
                text(record.fields["外部对象 ID"]) ?? null,
                text(record.fields["外部状态镜像"]) === undefined ? "unknown" : "confirmed",
                sourceEventId,
                input.occurredAt,
                input.occurredAt,
              );
              database.prepare("UPDATE current_action_links SET external_status = ? WHERE action_key = ?")
                .run(externalStatus, actionKey);
              database.exec("COMMIT");
            } catch (error) {
              database.exec("ROLLBACK");
              throw error;
            }
          }
          continue;
        }
        operation = {
          kind: "plan_action",
          ...common,
          actionType: "collaborative_commitment",
          factOwner: "feishu_task",
          assignee,
          assigneeId,
          ...(text(record.fields.deadline) === undefined ? {} : { deadlineAt: text(record.fields.deadline)! }),
        };
      } else if (actionTypeLabel === "时间安排" && ownerLabel === "Bitable") {
        const startAt = text(record.fields["开始时间"]);
        const endAt = text(record.fields["结束时间"]);
        if (startAt === undefined || endAt === undefined) continue;
        operation = { kind: "create_scheduled_event", ...common, startAt, endAt };
      }
      if (operation === undefined) continue;
      apply({
        sourceKind: "migration",
        sourceEventId: `bitable-action:${record.recordId}`,
        occurredAt: text(record.fields["最近同步"]) ?? observedAt,
        operations: [operation],
      });
      database.prepare(
        `UPDATE current_action_links
         SET record_id = ?, external_object_id = ?, execution_status = ?, external_status = ?
         WHERE action_key = ?`,
      ).run(
        record.recordId,
        text(record.fields["外部对象 ID"]) ?? null,
        text(record.fields["外部状态镜像"]) === undefined ? "unknown" : "confirmed",
        externalStatus,
        actionKey,
      );
    }
  };

  const snapshot = (): CurrentStateSnapshot => ({
    projects: (database.prepare("SELECT * FROM current_projects ORDER BY project_key").all() as unknown as ProjectRow[]).map(projectFromRow),
    items: (database.prepare("SELECT * FROM current_items ORDER BY item_key").all() as unknown as ItemRow[]).map(itemFromRow),
    actionLinks: (database.prepare("SELECT * FROM current_action_links ORDER BY action_key").all() as unknown as ActionRow[]).map(actionFromRow),
  });

  return {
    apply,
    importBitable,
    read() {
      const projectRows = database.prepare("SELECT * FROM current_projects ORDER BY project_key").all() as unknown as ProjectRow[];
      const itemRows = database.prepare("SELECT * FROM current_items ORDER BY item_key").all() as unknown as ItemRow[];
      const projects: AuthoritativeProjectState[] = projectRows.map((row) => ({
        recordId: row.record_id ?? `local:project:${row.project_key}`,
        projectKey: row.project_key,
        name: row.name,
        status: projectStatusLabel[row.status],
        ...optional("goal", row.goal),
        ...optional("phase", row.phase),
        ...optional("summary", row.summary),
        updatedAt: row.source_occurred_at,
        sourceEventId: row.source_event_id,
        correctedFields: [],
      } as AuthoritativeProjectState));
      const items: AuthoritativeItemState[] = itemRows.map((row) => ({
        recordId: row.record_id ?? `local:item:${row.item_key}`,
        itemKey: row.item_key,
        title: row.title,
        ...optional("projectKey", row.project_key),
        type: itemTypeLabel[row.type],
        status: itemStatusLabel[row.status],
        ...optional("nextAction", row.next_action),
        ...optional("summary", row.summary),
        ...optional("waitingFor", row.waiting_for),
        ...optional("releaseCondition", row.release_condition),
        ...optional("checkpointAt", row.checkpoint_at),
        ...optional("contingency", row.contingency),
        parked: row.parked === 1,
        updatedAt: row.source_occurred_at,
        sourceEventId: row.source_event_id,
        inCurrentAttention: false,
        correctedFields: [],
      } as AuthoritativeItemState));
      return { projects, items, currentProjects: projects, currentItems: items, memoryCandidates: [] };
    },
    snapshot,
    versions(entityType, entityKey) {
      const rows = database
        .prepare(
          `SELECT entity_type, entity_key, revision, source_kind, source_event_id,
                  source_occurred_at, base_revision, applied, rejection_reason
           FROM current_state_versions
           WHERE entity_type = ? AND entity_key = ? ORDER BY id`,
        )
        .all(entityType, entityKey) as unknown as VersionRow[];
      return rows.map((row) => ({
        entityType: row.entity_type,
        entityKey: row.entity_key,
        revision: row.revision,
        sourceKind: row.source_kind,
        sourceEventId: row.source_event_id,
        sourceOccurredAt: row.source_occurred_at,
        ...(row.base_revision === null ? {} : { baseRevision: row.base_revision }),
        applied: row.applied === 1,
        ...(row.rejection_reason === null ? {} : { rejectionReason: row.rejection_reason }),
      }));
    },
    bindRecord(entityType, entityKey, recordId, confirmedAt) {
      const table = entityType === "project" ? "current_projects" : entityType === "item" ? "current_items" : "current_action_links";
      const key = entityType === "project" ? "project_key" : entityType === "item" ? "item_key" : "action_key";
      const projection = entityType === "action_link" ? "" : ", projection_status = 'confirmed'";
      database.prepare(`UPDATE ${table} SET record_id = ?, updated_at = ?${projection} WHERE ${key} = ?`)
        .run(recordId, confirmedAt, entityKey);
    },
    markProjectionSucceeded(sourceEventId, confirmedAt) {
      database.prepare(
        `UPDATE outbox
         SET status = 'succeeded',
             attempt_count = attempt_count + CASE WHEN status = 'pending' THEN 1 ELSE 0 END,
             next_attempt_at = NULL, last_error_json = NULL, updated_at = ?
         WHERE idempotency_key = ? AND status IN ('pending', 'retry', 'running')`,
      ).run(confirmedAt, `bitable.project:${sourceEventId}`);
      database.prepare(
        `UPDATE current_projects SET projection_status = 'confirmed', updated_at = ?
         WHERE source_event_id = ?`,
      ).run(confirmedAt, sourceEventId);
      database.prepare(
        `UPDATE current_items SET projection_status = 'confirmed', updated_at = ?
         WHERE source_event_id = ?`,
      ).run(confirmedAt, sourceEventId);
    },
    markProjectionFailed(sourceEventId, failedAt) {
      database.prepare(
        `UPDATE current_projects SET projection_status = 'failed', updated_at = ?
         WHERE source_event_id = ? AND projection_status = 'pending'`,
      ).run(failedAt, sourceEventId);
      database.prepare(
        `UPDATE current_items SET projection_status = 'failed', updated_at = ?
         WHERE source_event_id = ? AND projection_status = 'pending'`,
      ).run(failedAt, sourceEventId);
    },
    recordActionExecution(input) {
      const current = action(input.actionKey);
      if (current === undefined) {
        throw new Error(`Current State Action Link not found for ${input.actionKey}`);
      }
      const sourceEventId = `execution:${input.sourceEventId}:${input.status}`;
      if (hasVersion("execution_result", sourceEventId, "action_link", input.actionKey)) {
        return;
      }
      const applyInput: ApplyCurrentStateInput = {
        sourceKind: "execution_result",
        sourceEventId,
        occurredAt: input.occurredAt,
        operations: [],
      };
      const rejection = staleReason(current, input.occurredAt, undefined);
      const revision = current.revision + (rejection === undefined ? 1 : 0);
      database.exec("BEGIN IMMEDIATE");
      try {
        rememberVersion(
          "action_link",
          input.actionKey,
          revision,
          applyInput,
          input,
          rejection === undefined,
          rejection,
        );
        if (rejection === undefined) {
          database.prepare(
            `UPDATE current_action_links
             SET external_object_id = COALESCE(?, external_object_id),
                 execution_status = ?, revision = ?, source_kind = 'execution_result',
                 source_event_id = ?, source_occurred_at = ?, updated_at = ?
             WHERE action_key = ?`,
          ).run(
            input.externalObjectId ?? null,
            input.status,
            revision,
            sourceEventId,
            input.occurredAt,
            input.occurredAt,
            input.actionKey,
          );
        }
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
    actionExecution(actionKey) {
      const row = action(actionKey);
      return row === undefined
        ? undefined
        : {
            actionKey: row.action_key,
            ...(row.external_object_id === null ? {} : { externalObjectId: row.external_object_id }),
            status: row.execution_status,
            revision: row.revision,
            sourceEventId: row.source_event_id,
          };
    },
    actionStates(factOwner) {
      const rows = database.prepare(
        `SELECT * FROM current_action_links
         ${factOwner === undefined ? "" : "WHERE fact_owner = ?"}
         ORDER BY action_key`,
      ).all(...(factOwner === undefined ? [] : [factOwner])) as unknown as ActionRow[];
      return rows.map((row) => ({
        actionKey: row.action_key,
        ...(row.record_id === null ? {} : { recordId: row.record_id }),
        itemKey: row.item_key,
        ...(row.project_key === null ? {} : { projectKey: row.project_key }),
        title: row.title,
        factOwner: row.fact_owner,
        ...(row.deadline_at === null ? {} : { deadlineAt: row.deadline_at }),
        ...(row.assignee === null ? {} : { assignee: row.assignee }),
        ...(row.external_object_id === null ? {} : { externalObjectId: row.external_object_id }),
        status: row.execution_status,
        externalStatus: row.external_status,
        ...(row.external_fingerprint === null ? {} : { externalFingerprint: row.external_fingerprint }),
        ...(row.last_verified_at === null ? {} : { lastVerifiedAt: row.last_verified_at }),
        ...(row.uncertainty_reason === null ? {} : { uncertaintyReason: row.uncertainty_reason }),
        revision: row.revision,
        sourceEventId: row.source_event_id,
      }));
    },
    recordExternalActionState(input) {
      const current = action(input.actionKey);
      if (current === undefined) throw new Error(`Current State Action Link not found for ${input.actionKey}`);
      if (
        current.external_updated_at !== null &&
        input.sourceUpdatedAt !== undefined &&
        Date.parse(input.sourceUpdatedAt) < Date.parse(current.external_updated_at)
      ) return false;
      if (current.external_fingerprint === input.fingerprint) {
        database.prepare(
          `UPDATE current_action_links SET last_verified_at = ?, updated_at = ? WHERE action_key = ?`,
        ).run(input.observedAt, input.observedAt, input.actionKey);
        return false;
      }
      const sourceEventId = `external:${input.fingerprint}`;
      if (hasVersion("external_correction", sourceEventId, "action_link", input.actionKey)) return false;
      const revision = current.revision + 1;
      const applyInput: ApplyCurrentStateInput = {
        sourceKind: "external_correction",
        sourceEventId,
        occurredAt: input.observedAt,
        operations: [],
      };
      database.exec("BEGIN IMMEDIATE");
      try {
        rememberVersion("action_link", input.actionKey, revision, applyInput, input, true);
        database.prepare(
          `UPDATE current_action_links SET
             title = COALESCE(?, title), deadline_at = CASE WHEN ? THEN ? ELSE deadline_at END,
             assignee = CASE WHEN ? THEN ? ELSE assignee END,
             external_status = ?, external_fingerprint = ?, last_verified_at = ?,
             external_updated_at = COALESCE(?, external_updated_at), uncertainty_reason = ?, revision = ?, source_kind = 'external_correction',
             source_event_id = ?, source_occurred_at = ?, updated_at = ?
           WHERE action_key = ?`,
        ).run(
          input.title ?? null,
          Object.prototype.hasOwnProperty.call(input, "deadlineAt") ? 1 : 0,
          input.deadlineAt ?? null,
          Object.prototype.hasOwnProperty.call(input, "assignee") ? 1 : 0,
          input.assignee ?? null,
          input.status,
          input.fingerprint,
          input.observedAt,
          input.sourceUpdatedAt ?? null,
          input.uncertaintyReason ?? null,
          revision,
          sourceEventId,
          input.observedAt,
          input.observedAt,
          input.actionKey,
        );
        database.exec("COMMIT");
        return true;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
    close() {
      database.close();
    },
  };
}
