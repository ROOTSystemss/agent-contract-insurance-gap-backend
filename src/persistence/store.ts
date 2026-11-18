import type {
  AgentProfile,
  AgentProfileInput,
  Analysis,
  AuthTokenPurpose,
  AttentionScore,
  AuditEvent,
  DocumentRecord,
  Finding,
  FindingStatus,
  Organization,
  OrganizationMember,
  Paginated,
  PaginationInput,
  Project,
  Role,
  ServiceLink,
  ConsoleCertificate,
  ConsoleSubscription,
  ConsoleSigner,
  EvidenceReceiptRecord,
  ConsoleRecord,
  TwoFactorRecord,
  User,
} from "../domain/types.js";

export interface RegistrationRecord {
  user: User;
  organization: Organization;
  membership: OrganizationMember;
}

export interface Store {
  ready(): Promise<boolean>;
  // Encrypts account emails stored before email encryption; returns how many rows changed.
  encryptStoredEmails(): Promise<number>;
  // Encrypts every customer field (emails included) stored before field encryption; returns how many rows changed.
  encryptStoredData(): Promise<number>;
  createRegistration(input: {
    email: string;
    name: string;
    passwordHash: string;
    organizationName: string;
  }): Promise<RegistrationRecord>;
  findUserByEmail(email: string): Promise<User | null>;
  getUser(id: string): Promise<User | null>;
  setEmailVerified(userId: string, at: string): Promise<void>;
  setPassword(userId: string, passwordHash: string, changedAt: string): Promise<void>;
  // Two-factor sign-in state, one row per user (null = never set up).
  getTwoFactor(userId: string): Promise<TwoFactorRecord | null>;
  saveTwoFactor(record: TwoFactorRecord): Promise<void>;
  deleteTwoFactor(userId: string): Promise<void>;
  // One-time account links. Only the SHA-256 of the token is stored. Saving a new token for a user and
  // purpose retires that user's earlier unused tokens of the same purpose.
  saveAuthToken(record: { userId: string; purpose: AuthTokenPurpose; tokenHash: string; expiresAt: string }): Promise<void>;
  // Marks the token used and returns its user, once: null when unknown, used already, expired or for another purpose.
  consumeAuthToken(tokenHash: string, purpose: AuthTokenPurpose, now: string): Promise<{ userId: string } | null>;
  getMembership(userId: string, organizationId?: string): Promise<OrganizationMember | null>;
  getOrganization(id: string): Promise<Organization | null>;
  updateOrganization(id: string, name: string): Promise<Organization | null>;
  listMembers(
    organizationId: string,
  ): Promise<Array<OrganizationMember & { user: Omit<User, "passwordHash"> }>>;

  createProject(
    organizationId: string,
    input: Omit<Project, "id" | "organizationId" | "createdAt" | "updatedAt" | "deletedAt">,
  ): Promise<Project>;
  listProjects(organizationId: string, pagination: PaginationInput): Promise<Paginated<Project>>;
  getProject(organizationId: string, id: string): Promise<Project | null>;
  updateProject(
    organizationId: string,
    id: string,
    input: Partial<
      Pick<
        Project,
        | "name"
        | "description"
        | "primaryCountryCode"
        | "primarySubdivisionCode"
        | "affectedCountryCodes"
      >
    >,
  ): Promise<Project | null>;
  deleteProject(organizationId: string, id: string): Promise<boolean>;

  createAgent(
    organizationId: string,
    projectId: string,
    input: AgentProfileInput,
  ): Promise<AgentProfile>;
  listAgents(organizationId: string, projectId: string): Promise<AgentProfile[]>;
  getAgent(organizationId: string, id: string): Promise<AgentProfile | null>;
  updateAgent(
    organizationId: string,
    id: string,
    input: Partial<AgentProfileInput>,
  ): Promise<AgentProfile | null>;
  deleteAgent(organizationId: string, id: string): Promise<boolean>;

  createDocument(document: DocumentRecord): Promise<DocumentRecord>;
  listDocuments(
    organizationId: string,
    projectId: string,
    pagination: PaginationInput,
  ): Promise<Paginated<DocumentRecord>>;
  getDocument(organizationId: string, id: string): Promise<DocumentRecord | null>;
  updateDocument(document: DocumentRecord): Promise<DocumentRecord | null>;
  deleteDocument(organizationId: string, id: string): Promise<DocumentRecord | null>;
  listDocumentsDueForDeletion(before: string, limit: number): Promise<DocumentRecord[]>;

  createAnalysis(analysis: Analysis): Promise<Analysis>;
  listAnalyses(
    organizationId: string,
    projectId: string,
    pagination: PaginationInput,
  ): Promise<Paginated<Analysis>>;
  getAnalysis(organizationId: string, id: string): Promise<Analysis | null>;
  updateAnalysis(analysis: Analysis): Promise<Analysis | null>;
  replaceFindings(organizationId: string, analysisId: string, findings: Finding[]): Promise<void>;
  listFindings(
    organizationId: string,
    analysisId: string,
    pagination: PaginationInput,
  ): Promise<Paginated<Finding>>;
  getFinding(organizationId: string, id: string): Promise<Finding | null>;
  updateFindingStatus(
    organizationId: string,
    id: string,
    status: FindingStatus,
  ): Promise<Finding | null>;

  addAuditEvent(event: AuditEvent): Promise<void>;
  listAuditEvents(
    organizationId: string,
    projectId: string,
    pagination: PaginationInput,
  ): Promise<Paginated<AuditEvent>>;
  getServiceLink(organizationId: string): Promise<ServiceLink | null>;
  // QA 2026-11-18 F21: workspaces that have a service link (for the one-time issuer-link backfill).
  listServiceLinkOrganizationIds(): Promise<string[]>;
  saveServiceLink(link: Omit<ServiceLink, "createdAt" | "updatedAt">): Promise<ServiceLink>;
  addConsoleCertificate(record: Omit<ConsoleCertificate, "createdAt">): Promise<ConsoleCertificate>;
  getConsoleCertificate(organizationId: string, jti: string): Promise<ConsoleCertificate | null>;
  getConsoleSubscription(organizationId: string): Promise<ConsoleSubscription | null>;
  saveConsoleSubscription(record: Omit<ConsoleSubscription, "updatedAt">): Promise<ConsoleSubscription>;
  // true the first time an event id is seen, false for a redelivery
  claimBillingWebhookEvent(id: string, type: string): Promise<boolean>;
  listConsoleSigners(organizationId: string): Promise<ConsoleSigner[]>;
  addConsoleSigner(record: Omit<ConsoleSigner, "createdAt">): Promise<ConsoleSigner>;
  // Evidence Notary receipts, chained per workspace. addReceipt refuses a second receipt with the same
  // (organizationId, seq) by throwing an error whose code is "SEQ_TAKEN", so two receipts issued at the
  // same moment retry instead of forking the chain.
  lastReceipt(organizationId: string): Promise<EvidenceReceiptRecord | null>;
  addReceipt(record: Omit<EvidenceReceiptRecord, "createdAt" | "otsConfirmedAt" | "otsBlockHeight">): Promise<EvidenceReceiptRecord>;
  listReceipts(organizationId: string): Promise<EvidenceReceiptRecord[]>;
  getReceipt(organizationId: string, seq: number): Promise<EvidenceReceiptRecord | null>;
  // Receipts whose Bitcoin timestamp is not confirmed yet, oldest first, across all workspaces.
  listUnanchoredReceipts(limit: number): Promise<EvidenceReceiptRecord[]>;
  updateReceiptTimestamp(organizationId: string, seq: number, patch: Partial<Pick<EvidenceReceiptRecord, "otsProof" | "otsStatus" | "otsConfirmedAt" | "otsBlockHeight">>): Promise<void>;
  // Console governance records (knock-out Phase 5). Deleted with the workspace (deleteOrganization, reset).
  listConsoleRecords(organizationId: string, kind: string): Promise<ConsoleRecord[]>;
  getConsoleRecord(organizationId: string, kind: string, key: string): Promise<ConsoleRecord | null>;
  saveConsoleRecord(record: { organizationId: string; kind: string; key: string; data: Record<string, unknown> }): Promise<ConsoleRecord>;
  deleteConsoleRecord(organizationId: string, kind: string, key: string): Promise<boolean>;
  // Adds a new user to an existing workspace (team invite). Throws EMAIL_EXISTS if the email is taken.
  addMember(organizationId: string, input: { email: string; name: string; passwordHash: string; role: Role }): Promise<OrganizationMember>;
  reset(): Promise<void>;

  // ---- Account deletion (safeguard S-14, delete on request) ----
  // Every workspace membership the user has.
  listMembershipsForUser(userId: string): Promise<OrganizationMember[]>;
  // The agent certificate ids (jti) this workspace issued through the console, newest first.
  listConsoleCertificateIds(organizationId: string): Promise<string[]>;
  // Deletes a workspace and everything this service keeps for it (projects, agents, documents and their
  // segments, analyses, findings, audit events, console links/certificates/subscription/signers, receipts).
  // Returns the storage keys of its uploaded documents so the caller deletes the files too.
  deleteOrganization(organizationId: string): Promise<{ storageKeys: string[] }>;
  // AD-077 self-serve export (knock-out 2026-11-17): every row this workspace / user holds, decrypted, keyed by
  // model name. Secrets are removed by the caller (security/account-export.ts), not here.
  exportOrganizationData(organizationId: string): Promise<Record<string, unknown[]>>;
  exportUserData(userId: string): Promise<Record<string, unknown[]>>;
  // Takes one person out of a workspace: their membership and their console signer enrolment.
  removeMembership(organizationId: string, userId: string): Promise<void>;
  // Deletes the user row when nothing else refers to it. When a surviving workspace still refers to it (documents
  // the person uploaded, audit lines they wrote), the row stays as a tombstone: email, name and password replaced,
  // two-factor, one-time links and memberships removed, every session ended. Returns which one happened.
  deleteOrAnonymiseUser(userId: string, tombstone: { email: string; passwordHash: string; at: string }): Promise<"deleted" | "anonymised">;
}

export interface PersistedAnalysisResult {
  analysis: Analysis;
  findings: Finding[];
  score: AttentionScore;
}

export const roleRank: Record<Role, number> = { viewer: 0, analyst: 1, admin: 2, owner: 3 };
