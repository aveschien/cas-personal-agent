import type {
  AuthoritativeItemState,
  AuthoritativeProjectState,
} from "./authoritative-bitable-reader.js";
import type { BitableRecordQueryClient } from "./bitable-state-projector.js";
import type {
  CognitiveMode,
  FocusStateStore,
} from "./focus-state-store.js";
import { normalizeBusinessTimestamp } from "./business-time.js";

export type AttentionQueryKind = "now" | "waiting" | "continue";

export interface AttentionItem {
  readonly itemKey: string;
  readonly title: string;
  readonly projectKey?: string;
  readonly status?: string;
  readonly nextAction?: string;
  readonly reason: string;
  readonly hardConstraintAt?: string;
  readonly checkpointAt?: string;
}

export interface WaitingItem {
  readonly itemKey: string;
  readonly title: string;
  readonly projectKey?: string;
  readonly waitingFor?: string;
  readonly releaseCondition?: string;
  readonly checkpointAt?: string;
  readonly contingency?: string;
  readonly missingCheckpoint: boolean;
}

export interface ProjectContinuation {
  readonly projectKey: string;
  readonly name: string;
  readonly summary?: string;
  readonly openLoops: readonly {
    readonly itemKey: string;
    readonly title: string;
    readonly status?: string;
  }[];
  readonly waiting: readonly WaitingItem[];
  readonly nextAction?: AttentionItem;
}

export interface CurrentAttentionResolution {
  readonly cognitiveMode: CognitiveMode;
  readonly modeChanged?: CognitiveMode;
  readonly activeFocus?: AttentionItem;
  readonly queryKind?: AttentionQueryKind;
  readonly currentAttention?: readonly AttentionItem[];
  readonly waiting?: readonly WaitingItem[];
  readonly continuation?: ProjectContinuation;
  readonly continuationCandidates?: readonly {
    readonly projectKey: string;
    readonly name: string;
  }[];
}

export interface ResolveCurrentAttentionInput {
  readonly message: string;
  readonly now: string;
  readonly projects: readonly AuthoritativeProjectState[];
  readonly items: readonly AuthoritativeItemState[];
}

export interface CurrentAttentionResolver {
  resolve(input: ResolveCurrentAttentionInput): Promise<CurrentAttentionResolution>;
}

export interface CurrentAttentionResolverOptions {
  readonly logicalConversationId: string;
  readonly bitable: BitableRecordQueryClient;
  readonly itemsTableId: string;
  readonly actionLinksTableId: string;
  readonly focus: FocusStateStore;
  readonly onSyncError?: (error: unknown) => void;
  readonly localActionTimings?: () => readonly {
    readonly itemKey: string;
    readonly status: "open" | "completed" | "unknown";
    readonly deadlineAt?: string;
  }[];
  readonly syncDerivedView?: boolean;
}

interface ItemTiming {
  readonly hardConstraintAt?: string;
  readonly overdue: boolean;
  readonly today: boolean;
}

interface RankedItem {
  readonly item: AuthoritativeItemState;
  readonly score: number;
  readonly forced: boolean;
  readonly timing: ItemTiming;
  readonly reachedCheckpoint: boolean;
}

const actionReadFields = [
  "所属事项",
  "外部状态镜像",
  "deadline",
  "开始时间",
] as const;

const terminalStatuses = new Set(["完成", "放弃", "归档"]);
const normallyActionableStatuses = new Set(["可行动", "进行中", "已排期"]);

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
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

function beijingDate(timestamp: string): string | undefined {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) {
    return undefined;
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function parseTime(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function businessTimestamp(value: string | undefined): string | undefined {
  if (value === undefined || parseTime(value) === undefined) {
    return value;
  }
  return normalizeBusinessTimestamp(value, "current state timestamp");
}

function isSynthetic(
  state: AuthoritativeProjectState | AuthoritativeItemState,
): boolean {
  return /^(?:dev-|smoke-|test-)/.test(state.sourceEventId ?? "");
}

function explicitMode(message: string): Exclude<CognitiveMode, "unknown"> | undefined {
  if (/探索模式|发散模式|先发散|自由探索|别拉回|不要拉回/.test(message)) {
    return "explore";
  }
  if (/执行模式|收束模式|专注模式|拉我回来|盯住当前|保持焦点/.test(message)) {
    return "execute";
  }
  return undefined;
}

export function classifyAttentionQuery(
  message: string,
): AttentionQueryKind | undefined {
  const compact = message.replace(/\s+/g, "");
  if (/我在等什么|有哪些等待|现在等什么|等待事项/.test(compact)) {
    return "waiting";
  }
  if (
    /继续(那个|这个|刚才的)?.*项目|继续做|继续开发|继续推进|接着做|恢复.*项目/.test(
      compact,
    )
  ) {
    return "continue";
  }
  if (/我现在该做什么|现在该做什么|接下来做什么|下一步做什么|现在做什么/.test(compact)) {
    return "now";
  }
  return undefined;
}

function waitingItem(item: AuthoritativeItemState): WaitingItem {
  const checkpointAt = businessTimestamp(item.checkpointAt);
  return {
    itemKey: item.itemKey,
    title: item.title,
    ...(item.projectKey === undefined ? {} : { projectKey: item.projectKey }),
    ...(item.waitingFor === undefined ? {} : { waitingFor: item.waitingFor }),
    ...(item.releaseCondition === undefined
      ? {}
      : { releaseCondition: item.releaseCondition }),
    ...(checkpointAt === undefined ? {} : { checkpointAt }),
    ...(item.contingency === undefined
      ? {}
      : { contingency: item.contingency }),
    missingCheckpoint: item.checkpointAt === undefined,
  };
}

function sortWaiting(items: readonly AuthoritativeItemState[]): WaitingItem[] {
  return items
    .filter((item) => item.status === "等待")
    .sort((left, right) => {
      const leftTime = parseTime(left.checkpointAt) ?? Number.POSITIVE_INFINITY;
      const rightTime = parseTime(right.checkpointAt) ?? Number.POSITIVE_INFINITY;
      return leftTime - rightTime || left.title.localeCompare(right.title, "zh-CN");
    })
    .map(waitingItem);
}

function toAttentionItem(ranked: RankedItem): AttentionItem {
  const reason = ranked.timing.overdue
    ? "硬时间已逾期"
    : ranked.reachedCheckpoint
      ? "等待检查点已到"
      : ranked.timing.today
        ? "今天有硬时间约束"
        : ranked.item.status === "进行中"
          ? "保持当前推进连续性"
          : "当前可行动";
  const hardConstraintAt = businessTimestamp(ranked.timing.hardConstraintAt);
  const checkpointAt = businessTimestamp(ranked.item.checkpointAt);
  return {
    itemKey: ranked.item.itemKey,
    title: ranked.item.title,
    ...(ranked.item.projectKey === undefined
      ? {}
      : { projectKey: ranked.item.projectKey }),
    ...(ranked.item.status === undefined ? {} : { status: ranked.item.status }),
    ...(ranked.item.nextAction === undefined
      ? {}
      : { nextAction: ranked.item.nextAction }),
    reason,
    ...(hardConstraintAt === undefined ? {} : { hardConstraintAt }),
    ...(checkpointAt === undefined ? {} : { checkpointAt }),
  };
}

async function syncCurrentAttention(
  bitable: BitableRecordQueryClient,
  itemsTableId: string,
  allItems: readonly AuthoritativeItemState[],
  selected: readonly RankedItem[],
): Promise<void> {
  const desired = new Map(
    selected.map((candidate, index) => [
      candidate.item.recordId,
      {
        order: index + 1,
        reason: toAttentionItem(candidate).reason,
      },
    ]),
  );
  const updates = allItems.flatMap((item) => {
    const attention = desired.get(item.recordId);
    const isSelected = attention !== undefined;
    if (
      item.inCurrentAttention === isSelected &&
      item.attentionOrder === attention?.order &&
      item.attentionReason === attention?.reason
    ) {
      return [];
    }
    return [
      {
        recordId: item.recordId,
        fields: {
          "当前注意力": isSelected,
          "注意力顺序": attention?.order ?? null,
          "注意力依据": attention?.reason ?? null,
        },
      },
    ];
  });
  if (updates.length === 0) {
    return;
  }
  if (bitable.batchUpdate !== undefined) {
    await bitable.batchUpdate(itemsTableId, updates);
    return;
  }
  await Promise.all(
    updates.map((update) =>
      bitable.update(itemsTableId, update.recordId, update.fields),
    ),
  );
}

function resolveProject(
  message: string,
  projects: readonly AuthoritativeProjectState[],
  activeProjectRecordId: string | undefined,
): AuthoritativeProjectState | readonly AuthoritativeProjectState[] | undefined {
  const normalized = message.toLocaleLowerCase("zh-CN");
  const explicit = projects
    .filter(
      (project) =>
        normalized.includes(project.name.toLocaleLowerCase("zh-CN")) ||
        normalized.includes(project.projectKey.toLocaleLowerCase("zh-CN")),
    )
    .sort((left, right) => right.name.length - left.name.length);
  if (explicit.length > 0) {
    return explicit[0];
  }
  const active = projects.find(
    (project) => project.recordId === activeProjectRecordId,
  );
  if (active !== undefined) {
    return active;
  }
  const tracking = projects.filter((project) => project.status === "在跟");
  return tracking.length === 1 ? tracking[0] : tracking;
}

export function createCurrentAttentionResolver(
  options: CurrentAttentionResolverOptions,
): CurrentAttentionResolver {
  return {
    async resolve(input) {
      const projects = input.projects.filter((project) => !isSynthetic(project));
      const items = input.items.filter((item) => !isSynthetic(item));
      const requestedMode = explicitMode(input.message);
      if (requestedMode !== undefined) {
        options.focus.setMode(
          options.logicalConversationId,
          requestedMode,
          input.now,
        );
      }
      const focus = options.focus.get(options.logicalConversationId);
      const queryKind = classifyAttentionQuery(input.message);
      const base: CurrentAttentionResolution = {
        cognitiveMode: focus.mode,
        ...(requestedMode === undefined ? {} : { modeChanged: requestedMode }),
      };
      const activeItem = items.find(
        (item) => item.recordId === focus.activeItemRecordId,
      );
      const activeProject = projects.find(
        (project) => project.recordId === focus.activeProjectRecordId,
      );

      const timingByItem = new Map<string, string[]>();
      if (options.localActionTimings !== undefined) {
        const recordsByKey = new Map(items.map((item) => [item.itemKey, item.recordId]));
        for (const action of options.localActionTimings()) {
          const itemRecordId = recordsByKey.get(action.itemKey);
          if (itemRecordId !== undefined && action.status !== "completed" && action.deadlineAt !== undefined) {
            timingByItem.set(itemRecordId, [...(timingByItem.get(itemRecordId) ?? []), action.deadlineAt]);
          }
        }
      } else {
        const actionRecords = await options.bitable.list(options.actionLinksTableId, actionReadFields);
        for (const action of actionRecords) {
          if (text(action.fields["外部状态镜像"]) === "completed") continue;
          const itemRecordId = linkedRecordId(action.fields["所属事项"]);
          if (itemRecordId === undefined) continue;
          const times = [text(action.fields.deadline), text(action.fields["开始时间"])]
            .filter((value): value is string => value !== undefined);
          if (times.length > 0) {
            timingByItem.set(itemRecordId, [...(timingByItem.get(itemRecordId) ?? []), ...times]);
          }
        }
      }
      const nowTime = Date.parse(input.now);
      const today = beijingDate(input.now);
      const ranked = items.flatMap((item): RankedItem[] => {
        if (terminalStatuses.has(item.status ?? "") || item.parked || item.type === "想法") {
          return [];
        }
        const hardConstraintAt = (timingByItem.get(item.recordId) ?? [])
          .filter((timestamp) => parseTime(timestamp) !== undefined)
          .sort((left, right) => (parseTime(left) ?? 0) - (parseTime(right) ?? 0))[0];
        const hardTime = parseTime(hardConstraintAt);
        const overdue = hardTime !== undefined && hardTime <= nowTime;
        const dueToday =
          hardConstraintAt !== undefined && beijingDate(hardConstraintAt) === today;
        const checkpointTime = parseTime(item.checkpointAt);
        const reachedCheckpoint =
          checkpointTime !== undefined && checkpointTime <= nowTime;
        const normal = normallyActionableStatuses.has(item.status ?? "");
        const forced = overdue || dueToday || reachedCheckpoint;
        if (!normal && !forced) {
          return [];
        }
        const updatedTime = parseTime(item.updatedAt);
        const ageDays =
          updatedTime === undefined
            ? 0
            : Math.min(90, Math.max(0, (nowTime - updatedTime) / 86_400_000));
        const score =
          (overdue ? 1_200 : 0) +
          (reachedCheckpoint ? 1_000 : 0) +
          (dueToday ? 900 : 0) +
          (item.recordId === focus.activeItemRecordId ? 500 : 0) +
          (item.status === "进行中" ? 300 : item.status === "可行动" ? 200 : 100) +
          (item.projectKey !== undefined &&
          item.projectKey === activeProject?.projectKey
            ? 100
            : 0) +
          (item.nextAction === undefined ? 0 : 50) +
          ageDays -
          (activeProject !== undefined &&
          item.projectKey !== undefined &&
          item.projectKey !== activeProject.projectKey
            ? 30
            : 0);
        return [
          {
            item,
            score,
            forced,
            timing: {
              ...(hardConstraintAt === undefined ? {} : { hardConstraintAt }),
              overdue,
              today: dueToday,
            },
            reachedCheckpoint,
          },
        ];
      });
      ranked.sort(
        (left, right) =>
          right.score - left.score ||
          left.item.title.localeCompare(right.item.title, "zh-CN"),
      );

      const selected = ranked.filter((candidate) => candidate.forced);
      for (const candidate of ranked) {
        if (
          selected.length >= 3 ||
          selected.some(
            (existing) => existing.item.recordId === candidate.item.recordId,
          )
        ) {
          continue;
        }
        selected.push(candidate);
      }
      selected.sort((left, right) => right.score - left.score);
      if (options.syncDerivedView !== false) {
        try {
          await syncCurrentAttention(options.bitable, options.itemsTableId, input.items, selected);
        } catch (error) {
          options.onSyncError?.(error);
        }
      }

      if (queryKind === "waiting") {
        return {
          ...base,
          queryKind,
          waiting: sortWaiting(items),
        };
      }

      if (queryKind === "now") {
        const [first] = selected;
        if (first !== undefined) {
          const project = projects.find(
            (candidate) => candidate.projectKey === first.item.projectKey,
          );
          options.focus.setFocus(
            options.logicalConversationId,
            project?.recordId,
            first.item.recordId,
            input.now,
          );
        }
        return {
          ...base,
          queryKind,
          currentAttention: selected.map(toAttentionItem),
        };
      }

      if (queryKind === "continue") {
        const resolved = resolveProject(
          input.message,
          projects,
          focus.activeProjectRecordId,
        );
        if (resolved === undefined || Array.isArray(resolved)) {
          return {
            ...base,
            queryKind,
            continuationCandidates: (resolved ?? []).map((project) => ({
              projectKey: project.projectKey,
              name: project.name,
            })),
          };
        }
        const project = resolved as AuthoritativeProjectState;
        const projectItems = items.filter(
          (item) => item.projectKey === project.projectKey,
        );
        const openLoops = projectItems
          .filter((item) => !terminalStatuses.has(item.status ?? ""))
          .map((item) => ({
            itemKey: item.itemKey,
            title: item.title,
            ...(item.status === undefined ? {} : { status: item.status }),
          }));
        const next = ranked.find(
          (candidate) => candidate.item.projectKey === project.projectKey,
        );
        options.focus.setFocus(
          options.logicalConversationId,
          project.recordId,
          next?.item.recordId,
          input.now,
        );
        return {
          ...base,
          queryKind,
          continuation: {
            projectKey: project.projectKey,
            name: project.name,
            ...(project.summary === undefined ? {} : { summary: project.summary }),
            openLoops,
            waiting: sortWaiting(projectItems),
            ...(next === undefined ? {} : { nextAction: toAttentionItem(next) }),
          },
        };
      }

      if (focus.mode === "execute" && activeItem !== undefined) {
        return {
          ...base,
          activeFocus: {
            itemKey: activeItem.itemKey,
            title: activeItem.title,
            ...(activeItem.projectKey === undefined
              ? {}
              : { projectKey: activeItem.projectKey }),
            ...(activeItem.status === undefined
              ? {}
              : { status: activeItem.status }),
            ...(activeItem.nextAction === undefined
              ? {}
              : { nextAction: activeItem.nextAction }),
            reason: "执行模式下保持已确认焦点",
          },
        };
      }
      return base;
    },
  };
}
