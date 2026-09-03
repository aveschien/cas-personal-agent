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

export interface BitableRecord {
  readonly recordId: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

export interface BitableRecordClient {
  findByKey(
    tableId: string,
    keyField: string,
    key: string,
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
    ...(project.phase === undefined || !validProjectPhases.has(project.phase)
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
): Promise<BitableRecord> {
  const existing = await client.findByKey(tableId, keyField, key);
  if (existing === undefined) {
    return client.create(tableId, keyField, key, fields);
  }
  const currentFields = { ...clearFields, ...fields };
  await client.update(tableId, existing.recordId, currentFields);
  return {
    recordId: existing.recordId,
    fields: { ...existing.fields, ...currentFields },
  };
}

const clearedProjectFields = {
  目标: null,
  阶段: [],
  当前摘要: null,
} as const;

const clearedItemFields = {
  项目: [],
  下一步: null,
  当前摘要: null,
  在等什么: null,
  解除条件: null,
  检查点: null,
  "条件/预案": null,
  稍后区: false,
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
  return {
    async project(input) {
      const plan = compileBitableProjection(input);
      const projectRecordIds = new Map<string, string>();
      const itemRecordIds = new Map<string, string>();

      for (const project of plan.projects) {
        const record = await upsert(
          options.client,
          options.tables.projects,
          "project_key",
          project.key,
          projectFields(project),
          clearedProjectFields,
        );
        projectRecordIds.set(project.key, record.recordId);
      }

      const resolveProject = async (
        key: string | undefined,
      ): Promise<string | undefined> => {
        if (key === undefined) {
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
          clearedItemFields,
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
    },
  };
}
