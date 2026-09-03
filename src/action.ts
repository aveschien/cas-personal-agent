export interface CreatePersonalActionRequest {
  readonly idempotencyKey: string;
  readonly actionKey: string;
  readonly title: string;
  readonly itemKey: string;
  readonly projectKey?: string;
  readonly deadlineAt?: string;
  readonly sourceEventId: string;
}

export interface ExternalPersonalAction {
  readonly externalId: string;
  readonly projectId: string;
  readonly status: "open" | "completed";
}

export interface PersonalActionAdapter {
  create(
    request: CreatePersonalActionRequest,
  ): Promise<ExternalPersonalAction>;
  getState(
    projectId: string,
    externalId: string,
  ): Promise<ExternalPersonalAction>;
}

export interface CreateCollaborativeActionRequest {
  readonly idempotencyKey: string;
  readonly actionKey: string;
  readonly title: string;
  readonly itemKey: string;
  readonly projectKey?: string;
  readonly assigneeId: string;
  readonly assigneeName: string;
  readonly deadlineAt?: string;
  readonly sourceEventId: string;
}

export interface ExternalCollaborativeAction {
  readonly externalId: string;
  readonly externalUrl: string;
  readonly status: "open" | "completed";
  readonly assigneeIds: readonly string[];
  readonly deadlineAt?: string;
}

export interface CollaborativeActionAdapter {
  create(
    request: CreateCollaborativeActionRequest,
  ): Promise<ExternalCollaborativeAction>;
  getState(externalId: string): Promise<ExternalCollaborativeAction>;
}
