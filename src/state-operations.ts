import { normalizeBusinessTimestamp } from "./business-time.js";

export type ItemType = "task" | "idea" | "question" | "decision" | "information";
export type ItemStatus =
  | "inbox"
  | "actionable"
  | "in_progress"
  | "waiting"
  | "scheduled"
  | "completed"
  | "abandoned"
  | "archived";
export type ProjectStatus = "tracking" | "paused" | "finished";
export type ActionType =
  | "personal_action"
  | "collaborative_commitment"
  | "scheduled_event";
export type ActionFactOwner = "ticktick" | "feishu_task" | "bitable";

export interface UpsertProjectOperation {
  readonly kind: "upsert_project";
  readonly projectKey: string;
  readonly name: string;
  readonly status: ProjectStatus;
  readonly goal?: string;
  readonly phase?: string;
  readonly summary?: string;
}

export interface UpsertItemOperation {
  readonly kind: "upsert_item";
  readonly itemKey: string;
  readonly title: string;
  readonly type: ItemType;
  readonly status: ItemStatus;
  readonly projectKey?: string;
  readonly nextAction?: string;
  readonly summary?: string;
}

export interface SetWaitingOperation {
  readonly kind: "set_waiting";
  readonly itemKey: string;
  readonly waitingFor: string;
  readonly releaseCondition: string;
  readonly checkpointAt?: string;
  readonly contingency?: string;
}

export interface ParkIdeaOperation {
  readonly kind: "park_idea";
  readonly itemKey: string;
  readonly title: string;
  readonly projectKey?: string;
  readonly summary?: string;
}

export interface PlanActionOperation {
  readonly kind: "plan_action";
  readonly actionKey: string;
  readonly itemKey: string;
  readonly projectKey?: string;
  readonly title: string;
  readonly actionType: Exclude<ActionType, "scheduled_event">;
  readonly factOwner: Exclude<ActionFactOwner, "bitable">;
  readonly assignee?: string;
  readonly deadlineAt?: string;
}

export interface CreateScheduledEventOperation {
  readonly kind: "create_scheduled_event";
  readonly actionKey: string;
  readonly itemKey: string;
  readonly projectKey?: string;
  readonly title: string;
  readonly startAt: string;
  readonly endAt: string;
}

export interface ScheduleCheckpointOperation {
  readonly kind: "schedule_checkpoint";
  readonly reminderKey: string;
  readonly itemKey: string;
  readonly fireAt: string;
}

export interface ClarifyOperation {
  readonly kind: "clarify";
  readonly question: string;
  readonly reason: string;
}

export type SemanticOperation =
  | UpsertProjectOperation
  | UpsertItemOperation
  | SetWaitingOperation
  | ParkIdeaOperation
  | PlanActionOperation
  | CreateScheduledEventOperation
  | ScheduleCheckpointOperation
  | ClarifyOperation;

const semanticOperationKinds = new Set<SemanticOperation["kind"]>([
  "upsert_project",
  "upsert_item",
  "set_waiting",
  "park_idea",
  "plan_action",
  "create_scheduled_event",
  "schedule_checkpoint",
  "clarify",
]);

export function isSemanticOperation(value: unknown): value is SemanticOperation {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    typeof value.kind === "string" &&
    semanticOperationKinds.has(value.kind as SemanticOperation["kind"])
  );
}

export interface ProjectProjection {
  readonly key: string;
  readonly name: string;
  readonly status: ProjectStatus;
  readonly goal?: string;
  readonly phase?: string;
  readonly summary?: string;
  readonly sourceEventId: string;
}

export interface ItemProjection {
  readonly key: string;
  readonly title: string;
  readonly type: ItemType;
  readonly status: ItemStatus;
  readonly projectKey?: string;
  readonly nextAction?: string;
  readonly summary?: string;
  readonly waitingFor?: string;
  readonly releaseCondition?: string;
  readonly checkpointAt?: string;
  readonly contingency?: string;
  readonly parked?: true;
  readonly sourceEventId: string;
}

export interface ActionLinkProjection {
  readonly key: string;
  readonly itemKey: string;
  readonly projectKey?: string;
  readonly title: string;
  readonly actionType: ActionType;
  readonly factOwner: ActionFactOwner;
  readonly assignee?: string;
  readonly deadlineAt?: string;
  readonly startAt?: string;
  readonly endAt?: string;
  readonly syncStatus: "pending";
  readonly sourceEventId: string;
}

export type ReminderKind = "checkpoint" | "deadline" | "scheduled_event";

export interface ReminderProjection {
  readonly key: string;
  readonly itemKey: string;
  readonly projectKey?: string;
  readonly title: string;
  readonly context?: string;
  readonly suggestedAction?: string;
  readonly fireAt: string;
  readonly kind: ReminderKind;
  readonly sourceEventId: string;
}

export interface BitableProjectionPlan {
  readonly projects: readonly ProjectProjection[];
  readonly items: readonly ItemProjection[];
  readonly actionLinks: readonly ActionLinkProjection[];
  readonly reminders: readonly ReminderProjection[];
  readonly clarifications: readonly ClarifyOperation[];
}

export interface CompileBitableProjectionInput {
  readonly sourceEventId: string;
  readonly operations: readonly SemanticOperation[];
}

function assertKey(value: string, label: string): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,119}$/.test(value)) {
    throw new Error(`${label} must be a stable lowercase key`);
  }
}

function optional<T>(
  value: T | undefined,
  name: string,
): { readonly [key: string]: T } | Record<string, never> {
  return value === undefined ? {} : { [name]: value };
}

export function compileBitableProjection(
  input: CompileBitableProjectionInput,
): BitableProjectionPlan {
  if (input.sourceEventId.trim().length === 0) {
    throw new Error("sourceEventId is required");
  }
  const projects = new Map<string, ProjectProjection>();
  const items = new Map<string, ItemProjection>();
  const actionLinks: ActionLinkProjection[] = [];
  const reminders = new Map<string, ReminderProjection>();
  const clarifications: ClarifyOperation[] = [];

  const addReminder = (reminder: ReminderProjection): void => {
    const existing = reminders.get(reminder.key);
    if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(reminder)) {
      throw new Error(`Reminder key ${reminder.key} has conflicting definitions`);
    }
    reminders.set(reminder.key, reminder);
  };

  const waitingReminderDetails = (
    item: ItemProjection | undefined,
  ): Pick<ReminderProjection, "context" | "suggestedAction"> | undefined => {
    if (item === undefined || item.waitingFor === undefined) {
      return undefined;
    }
    return {
      context: `在等：${item.waitingFor}${
        item.releaseCondition === undefined
          ? ""
          : `；解除条件：${item.releaseCondition}`
      }`,
      suggestedAction:
        item.contingency ?? "确认等待结果是否已经出现。",
    };
  };

  for (const operation of input.operations) {
    switch (operation.kind) {
      case "upsert_project": {
        assertKey(operation.projectKey, "projectKey");
        projects.set(operation.projectKey, {
          key: operation.projectKey,
          name: operation.name,
          status: operation.status,
          ...optional(operation.goal, "goal"),
          ...optional(operation.phase, "phase"),
          ...optional(operation.summary, "summary"),
          sourceEventId: input.sourceEventId,
        } as ProjectProjection);
        break;
      }
      case "upsert_item": {
        assertKey(operation.itemKey, "itemKey");
        items.set(operation.itemKey, {
          key: operation.itemKey,
          title: operation.title,
          type: operation.type,
          status: operation.status,
          ...optional(operation.projectKey, "projectKey"),
          ...optional(operation.nextAction, "nextAction"),
          ...optional(operation.summary, "summary"),
          sourceEventId: input.sourceEventId,
        } as ItemProjection);
        break;
      }
      case "set_waiting": {
        assertKey(operation.itemKey, "itemKey");
        const item = items.get(operation.itemKey);
        if (item === undefined) {
          throw new Error(`set_waiting references unknown Item ${operation.itemKey}`);
        }
        const checkpointAt =
          operation.checkpointAt === undefined
            ? undefined
            : normalizeBusinessTimestamp(
                operation.checkpointAt,
                "checkpointAt",
              );
        items.set(operation.itemKey, {
          ...item,
          status: "waiting",
          waitingFor: operation.waitingFor,
          releaseCondition: operation.releaseCondition,
          ...optional(checkpointAt, "checkpointAt"),
          ...optional(operation.contingency, "contingency"),
        } as ItemProjection);
        break;
      }
      case "park_idea": {
        assertKey(operation.itemKey, "itemKey");
        items.set(operation.itemKey, {
          key: operation.itemKey,
          title: operation.title,
          type: "idea",
          status: "inbox",
          ...optional(operation.projectKey, "projectKey"),
          ...optional(operation.summary, "summary"),
          parked: true,
          sourceEventId: input.sourceEventId,
        } as ItemProjection);
        break;
      }
      case "plan_action": {
        assertKey(operation.actionKey, "actionKey");
        assertKey(operation.itemKey, "itemKey");
        const deadlineAt =
          operation.deadlineAt === undefined
            ? undefined
            : normalizeBusinessTimestamp(operation.deadlineAt, "deadlineAt");
        actionLinks.push({
          key: operation.actionKey,
          itemKey: operation.itemKey,
          ...optional(operation.projectKey, "projectKey"),
          title: operation.title,
          actionType: operation.actionType,
          factOwner: operation.factOwner,
          ...optional(operation.assignee, "assignee"),
          ...optional(deadlineAt, "deadlineAt"),
          syncStatus: "pending",
          sourceEventId: input.sourceEventId,
        } as ActionLinkProjection);
        if (deadlineAt !== undefined) {
          addReminder({
            key: `${operation.actionKey}-deadline`,
            itemKey: operation.itemKey,
            ...optional(operation.projectKey, "projectKey"),
            title: operation.title,
            context: `截止时间：${deadlineAt}`,
            suggestedAction: "确认是否完成；如果未完成，决定新的下一步。",
            fireAt: deadlineAt,
            kind: "deadline",
            sourceEventId: input.sourceEventId,
          } as ReminderProjection);
        }
        break;
      }
      case "create_scheduled_event": {
        assertKey(operation.actionKey, "actionKey");
        assertKey(operation.itemKey, "itemKey");
        const startAt = normalizeBusinessTimestamp(operation.startAt, "startAt");
        const endAt = normalizeBusinessTimestamp(operation.endAt, "endAt");
        if (Date.parse(endAt) <= Date.parse(startAt)) {
          throw new Error("scheduled event endAt must be after startAt");
        }
        actionLinks.push({
          key: operation.actionKey,
          itemKey: operation.itemKey,
          ...optional(operation.projectKey, "projectKey"),
          title: operation.title,
          actionType: "scheduled_event",
          factOwner: "bitable",
          startAt,
          endAt,
          syncStatus: "pending",
          sourceEventId: input.sourceEventId,
        } as ActionLinkProjection);
        addReminder({
          key: `${operation.actionKey}-scheduled-event`,
          itemKey: operation.itemKey,
          ...optional(operation.projectKey, "projectKey"),
          title: operation.title,
          context: `时间：${startAt} 至 ${endAt}`,
          suggestedAction: "准备进入该时间安排。",
          fireAt: startAt,
          kind: "scheduled_event",
          sourceEventId: input.sourceEventId,
        } as ReminderProjection);
        break;
      }
      case "schedule_checkpoint": {
        assertKey(operation.reminderKey, "reminderKey");
        assertKey(operation.itemKey, "itemKey");
        const fireAt = normalizeBusinessTimestamp(operation.fireAt, "fireAt");
        const item = items.get(operation.itemKey);
        addReminder({
          key: operation.reminderKey,
          itemKey: operation.itemKey,
          ...(item?.projectKey === undefined
            ? {}
            : { projectKey: item.projectKey }),
          title: item?.title ?? operation.itemKey,
          ...(waitingReminderDetails(item) ?? {}),
          fireAt,
          kind: "checkpoint",
          sourceEventId: input.sourceEventId,
        });
        break;
      }
      case "clarify":
        clarifications.push(operation);
        break;
    }
  }

  for (const item of items.values()) {
    if (
      item.checkpointAt !== undefined &&
      ![...reminders.values()].some(
        (reminder) =>
          reminder.kind === "checkpoint" &&
          reminder.itemKey === item.key &&
          reminder.fireAt === item.checkpointAt,
      )
    ) {
      addReminder({
        key: `${item.key}-checkpoint`,
        itemKey: item.key,
        ...optional(item.projectKey, "projectKey"),
        title: item.title,
        ...(waitingReminderDetails(item) ?? {}),
        fireAt: item.checkpointAt,
        kind: "checkpoint",
        sourceEventId: input.sourceEventId,
      });
    }
  }

  return {
    projects: [...projects.values()],
    items: [...items.values()],
    actionLinks,
    reminders: [...reminders.values()],
    clarifications,
  };
}
