export interface CollaboratorCandidate {
  readonly openId: string;
  readonly name: string;
  readonly department?: string;
  readonly enterpriseEmail?: string;
  readonly isCrossTenant: boolean;
}

export interface CollaboratorResolver {
  resolve(query: string): Promise<readonly CollaboratorCandidate[]>;
}
