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
