import {
  compileBitableProjection,
  type ActionLinkProjection,
  type ActionFactOwner,
  type ActionType,
  type CompileBitableProjectionInput,
  type ItemProjection,
  projectPhases,
  type ProjectProjection,
  type ReminderProjection,
} from "./state-operations.js";
import type { BitableAuthorityStore } from "./bitable-authority-store.js";
import {
  bitableValuesEqual,
  selectBitableFields,
} from "./bitable-authority-store.js";
import {
  authoritativeItemFields,
  authoritativeProjectFields,
} from "./authoritative-bitable-reader.js";
import type { CurrentStateStore } from "./current-state-store.js";

export interface BitableRecord {
  readonly recordId: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

export interface BitableRecordClient {
  findByKey(
    tableId: string,
    keyField: string,
    key: string,
    fields?: readonly string[],
  ): Promise<BitableRecord | undefined>;
  create(
    tableId: string,
    keyField: string,
    key: string,
    fields: Readonly<Record<string, unknown>>,
  ): Promise<BitableRecord>;
  update(
    tableId: string,
    recordId: string,
    fields: Readonly<Record<string, unknown>>,
  ): Promise<void>;
}

export interface BitableRecordQueryClient extends BitableRecordClient {
  list(
    tableId: string,
    fields: readonly string[],
  ): Promise<readonly BitableRecord[]>;
  batchUpdate?(
    tableId: string,
    updates: readonly {
      readonly recordId: string;
      readonly fields: Readonly<Record<string, unknown>>;
    }[],
  ): Promise<void>;
}

export interface ReminderProjectionSink {
  schedule(
    reminder: ReminderProjection,
    itemRecordId: string,
    projectRecordId?: string,
  ): Promise<void>;
}

export interface ActionProjectionSink {
  schedule(
    action: ActionLinkProjection,
    actionLinkRecordId: string,
    itemRecordId: string,
    projectRecordId?: string,
  ): Promise<void>;
}

export interface BitableTables {
  readonly projects: string;
  readonly items: string;
  readonly actionLinks: string;
}

export interface BitableStateProjectorOptions {
  readonly client: BitableRecordClient;
  readonly tables: BitableTables;
  readonly reminders: ReminderProjectionSink;
  readonly actions?: ActionProjectionSink;
  readonly authority?: BitableAuthorityStore;
  readonly currentState?: CurrentStateStore;
  readonly clock?: () => string;
}

export interface BitableStateProjector {
  project(input: CompileBitableProjectionInput): Promise<void>;
}

const projectStatus = {
  tracking: "在跟",
  paused: "暂停",
  finished: "结束",
} as const;

const itemType = {
  task: "任务",
  idea: "想法",
  question: "问题",
  decision: "决策",
  information: "信息",
} as const;

const itemStatus = {
  inbox: "收件箱",
  actionable: "可行动",
  in_progress: "进行中",
  waiting: "等待",
  scheduled: "已排期",
  completed: "完成",
  abandoned: "放弃",
  archived: "归档",
} as const;

const actionType = {
  personal_action: "个人行动",
  collaborative_commitment: "协同承诺",
  scheduled_event: "时间安排",
} satisfies Readonly<Record<ActionType, string>>;

const factOwner = {
  ticktick: "滴答",
  feishu_task: "飞书任务",
  bitable: "Bitable",
} satisfies Readonly<Record<ActionFactOwner, string>>;

const validProjectPhases = new Set<string>(projectPhases);

function projectFields(project: ProjectProjection): Record<string, unknown> {
  return {
    项目名: project.name,
    状态: [projectStatus[project.status]],
    project_key: project.key,
    来源事件: project.sourceEventId,
    last_effective_event_id: project.sourceEventId,
    created_by_agent: true,
    ...(project.goal === undefined ? {} : { 目标: project.goal }),
    ...(project.phase === undefined
      ? {}
      : project.phase === null
        ? { 阶段: [] }
        : !validProjectPhases.has(project.phase)
          ? {}
          : { 阶段: [project.phase] }),
    ...(project.summary === undefined ? {} : { 当前摘要: project.summary }),
  };
}

function itemFields(
  item: ItemProjection,
  projectRecordId: string | undefined,
): Record<string, unknown> {
  return {
    事项: item.title,
    状态: [itemStatus[item.status]],
    类型: [itemType[item.type]],
    ...(projectRecordId === undefined
      ? {}
      : projectRecordId === null
        ? { 项目: [] }
        : { 项目: [{ id: projectRecordId }] }),
    ...(item.nextAction === undefined ? {} : { 下一步: item.nextAction }),
    ...(item.summary === undefined ? {} : { 当前摘要: item.summary }),
    ...(item.waitingFor === undefined ? {} : { 在等什么: item.waitingFor }),
    ...(item.releaseCondition === undefined
      ? {}
      : { 解除条件: item.releaseCondition }),
    ...(item.checkpointAt === undefined ? {} : { 检查点: item.checkpointAt }),
    ...(item.contingency === undefined
      ? {}
      : { "条件/预案": item.contingency }),
    ...(item.parked === true ? { 稍后区: true } : {}),
    item_key: item.key,
    来源事件: item.sourceEventId,
    created_by_agent: true,
  };
}

async function upsert(
  client: BitableRecordClient,
  tableId: string,
  keyField: string,
  key: string,
  fields: Readonly<Record<string, unknown>>,
  clearFields: Readonly<Record<string, unknown>> = {},
  authority?: BitableAuthorityStore,
  authoritativeFields: readonly string[] = [],
  now = new Date().toISOString(),
  protectManualEdits = true,
): Promise<BitableRecord> {
  const existing = await client.findByKey(
    tableId,
    keyField,
    key,
    authoritativeFields,
  );
  if (existing === undefined) {
    const created = await client.create(tableId, keyField, key, fields);
    authority?.saveSnapshot({
      tableId,
      recordId: created.recordId,
      stableKey: key,
      fields: selectBitableFields(created.fields, authoritativeFields),
      projectedAt: now,
    });
    return created;
  }
  const currentFields = { ...clearFields, ...fields };
  const snapshot = authority?.getSnapshot(tableId, key);
  const protectedFields = new Set(
    !protectManualEdits || snapshot === undefined
      ? []
      : authoritativeFields.filter(
          (field) =>
            !bitableValuesEqual(existing.fields[field], snapshot.fields[field]) &&
            !bitableValuesEqual(existing.fields[field], currentFields[field]),
        ),
  );
  const permittedFields = Object.fromEntries(
    Object.entries(currentFields).filter(([field]) => !protectedFields.has(field)),
  );
  await client.update(tableId, existing.recordId, permittedFields);
  const resultingFields = { ...existing.fields, ...permittedFields };
  authority?.saveSnapshot({
    tableId,
    recordId: existing.recordId,
    stableKey: key,
    fields: selectBitableFields(resultingFields, authoritativeFields),
    projectedAt: now,
  });
  return {
    recordId: existing.recordId,
    fields: resultingFields,
  };
}

const clearedWaitingFields = {
  在等什么: null,
  解除条件: null,
  检查点: null,
  "条件/预案": null,
} as const;

const clearedActionFields = {
  所属项目: [],
  负责人: null,
  deadline: null,
  开始时间: null,
  结束时间: null,
} as const;

export function createBitableStateProjector(
  options: BitableStateProjectorOptions,
): BitableStateProjector {
  const clock = options.clock ?? (() => new Date().toISOString());
  return {
    async project(input) {
      const projectedAt = clock();
      const plan = options.currentState?.apply({
        sourceKind: "user_intent",
        sourceEventId: input.sourceEventId,
        occurredAt: input.occurredAt ?? projectedAt,
        operations: input.operations,
      }) ?? compileBitableProjection(input);
      const projectRecordIds = new Map<string, string>();
      const itemRecordIds = new Map<string, string>();

      for (const project of plan.projects) {
        const record = await upsert(
          options.client,
          options.tables.projects,
          "project_key",
          project.key,
          projectFields(project),
          {},
          options.authority,
          authoritativeProjectFields,
          projectedAt,
          options.currentState === undefined,
        );
        options.currentState?.bindRecord(
          "project",
          project.key,
          record.recordId,
          projectedAt,
        );
        projectRecordIds.set(project.key, record.recordId);
      }

      const resolveProject = async (
        key: string | null | undefined,
      ): Promise<string | undefined> => {
        if (key === undefined || key === null) {
          return undefined;
        }
        const known = projectRecordIds.get(key);
        if (known !== undefined) {
          return known;
        }
        const existing = await options.client.findByKey(
          options.tables.projects,
          "project_key",
          key,
        );
        if (existing === undefined) {
          throw new Error(`Bitable Project not found for key ${key}`);
        }
        projectRecordIds.set(key, existing.recordId);
        return existing.recordId;
      };

      for (const item of plan.items) {
        const projectRecordId = await resolveProject(item.projectKey);
        const record = await upsert(
          options.client,
          options.tables.items,
          "item_key",
          item.key,
          itemFields(item, projectRecordId),
          item.status === "waiting" ? {} : clearedWaitingFields,
          options.authority,
          authoritativeItemFields,
          projectedAt,
          options.currentState === undefined,
        );
        options.currentState?.bindRecord(
          "item",
          item.key,
          record.recordId,
          projectedAt,
        );
        itemRecordIds.set(item.key, record.recordId);
      }

      const resolveItem = async (key: string): Promise<string> => {
        const known = itemRecordIds.get(key);
        if (known !== undefined) {
          return known;
        }
        const existing = await options.client.findByKey(
          options.tables.items,
          "item_key",
          key,
        );
        if (existing === undefined) {
          throw new Error(`Bitable Item not found for key ${key}`);
        }
        itemRecordIds.set(key, existing.recordId);
        return existing.recordId;
      };

      for (const action of plan.actionLinks) {
        const projectRecordId = await resolveProject(action.projectKey);
        const itemRecordId = await resolveItem(action.itemKey);
        const fields: Record<string, unknown> = {
          行动: action.title,
          行动类型: [actionType[action.actionType]],
          事实源: [factOwner[action.factOwner]],
          ...(projectRecordId === undefined
            ? {}
            : { 所属项目: [{ id: projectRecordId }] }),
          所属事项: [{ id: itemRecordId }],
          ...(action.assignee === undefined
            ? {}
            : { 负责人: action.assignee }),
          ...(action.deadlineAt === undefined
            ? {}
            : { deadline: action.deadlineAt }),
          ...(action.startAt === undefined ? {} : { 开始时间: action.startAt }),
          ...(action.endAt === undefined ? {} : { 结束时间: action.endAt }),
          同步状态: [action.syncStatus],
          action_key: action.key,
          idempotency_key: `${action.sourceEventId}:${action.key}`,
          来源事件: action.sourceEventId,
        };
        const actionRecord = await upsert(
          options.client,
          options.tables.actionLinks,
          "action_key",
          action.key,
          fields,
          clearedActionFields,
        );
        options.currentState?.bindRecord(
          "action_link",
          action.key,
          actionRecord.recordId,
          projectedAt,
        );
        await options.actions?.schedule(
          action,
          actionRecord.recordId,
          itemRecordId,
          projectRecordId,
        );
      }

      for (const reminder of plan.reminders) {
        await options.reminders.schedule(
          reminder,
          await resolveItem(reminder.itemKey),
          await resolveProject(reminder.projectKey),
        );
      }
      options.currentState?.markProjectionSucceeded(
        input.sourceEventId,
        projectedAt,
      );
    },
  };
}
