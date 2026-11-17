import { randomUUID } from "node:crypto";
import type {
  AgentProfile,
  AgentProfileInput,
  Analysis,
  AuditEvent,
  AuthTokenPurpose,
  DocumentRecord,
  Finding,
  FindingStatus,
  Organization,
  OrganizationMember,
  Paginated,
  PaginationInput,
  Project,
  TwoFactorRecord,
  User,
  Role,
  ServiceLink,
  ConsoleCertificate,
  ConsoleSubscription,
  ConsoleSigner,
  EvidenceReceiptRecord,
  ConsoleRecord,
} from "../domain/types.js";
import type { RegistrationRecord, Store } from "./store.js";

function now(): string {
  return new Date().toISOString();
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function paginate<T>(items: T[], input: PaginationInput): Paginated<T> {
  const start = (input.page - 1) * input.pageSize;
  return {
    items: clone(items.slice(start, start + input.pageSize)),
    total: items.length,
    page: input.page,
    pageSize: input.pageSize,
  };
}

export class MemoryStore implements Store {
  private users = new Map<string, User>();
  private twoFactor = new Map<string, TwoFactorRecord>();
  private organizations = new Map<string, Organization>();
  private memberships = new Map<string, OrganizationMember>();
  private projects = new Map<string, Project>();
  private agents = new Map<string, AgentProfile>();
  private documents = new Map<string, DocumentRecord>();
  private analyses = new Map<string, Analysis>();
  private findings = new Map<string, Finding>();
  private auditEvents = new Map<string, AuditEvent>();
  private serviceLinks = new Map<string, ServiceLink>();
  private consoleCertificates = new Map<string, ConsoleCertificate>();
  private consoleSubscriptions = new Map<string, ConsoleSubscription>();
  private billingEvents = new Set<string>();
  private consoleSigners = new Map<string, ConsoleSigner>();
  private receipts = new Map<string, EvidenceReceiptRecord>();
  private consoleRecords = new Map<string, ConsoleRecord>();
  private authTokens = new Map<string, { userId: string; purpose: AuthTokenPurpose; tokenHash: string; expiresAt: string; usedAt: string | null }>();

  async ready(): Promise<boolean> {
    return true;
  }

  async encryptStoredEmails(): Promise<number> {
    return 0;
  }

  async encryptStoredData(): Promise<number> {
    return 0;
  }

  async createRegistration(input: {
    email: string;
    name: string;
    passwordHash: string;
    organizationName: string;
  }): Promise<RegistrationRecord> {
    if (await this.findUserByEmail(input.email)) throw new Error("EMAIL_EXISTS");
    const timestamp = now();
    const user: User = {
      id: randomUUID(),
      email: input.email.toLowerCase(),
      name: input.name,
      passwordHash: input.passwordHash,
      emailVerifiedAt: null,
      passwordChangedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const organization: Organization = {
      id: randomUUID(),
      name: input.organizationName,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const membership: OrganizationMember = {
      id: randomUUID(),
      userId: user.id,
      organizationId: organization.id,
      role: "owner",
      createdAt: timestamp,
    };
    this.users.set(user.id, user);
    this.organizations.set(organization.id, organization);
    this.memberships.set(membership.id, membership);
    return clone({ user, organization, membership });
  }

  async findUserByEmail(email: string): Promise<User | null> {
    const found = [...this.users.values()].find((user) => user.email === email.toLowerCase());
    return found ? clone(found) : null;
  }

  async getUser(id: string): Promise<User | null> {
    const found = this.users.get(id);
    return found ? clone(found) : null;
  }

  async setEmailVerified(userId: string, at: string): Promise<void> {
    const found = this.users.get(userId);
    if (found && !found.emailVerifiedAt) this.users.set(userId, { ...found, emailVerifiedAt: at, updatedAt: now() });
  }

  async getTwoFactor(userId: string): Promise<TwoFactorRecord | null> {
    const found = this.twoFactor.get(userId);
    return found ? { ...found, recoveryHashes: [...found.recoveryHashes] } : null;
  }

  async saveTwoFactor(record: TwoFactorRecord): Promise<void> {
    this.twoFactor.set(record.userId, { ...record, recoveryHashes: [...record.recoveryHashes] });
  }

  async deleteTwoFactor(userId: string): Promise<void> {
    this.twoFactor.delete(userId);
  }

  async setPassword(userId: string, passwordHash: string, changedAt: string): Promise<void> {
    const found = this.users.get(userId);
    if (found) this.users.set(userId, { ...found, passwordHash, passwordChangedAt: changedAt, updatedAt: now() });
  }

  async saveAuthToken(record: { userId: string; purpose: AuthTokenPurpose; tokenHash: string; expiresAt: string }): Promise<void> {
    for (const [hash, token] of this.authTokens) if (token.userId === record.userId && token.purpose === record.purpose && !token.usedAt) this.authTokens.delete(hash);
    this.authTokens.set(record.tokenHash, { ...record, usedAt: null });
  }

  async consumeAuthToken(tokenHash: string, purpose: AuthTokenPurpose, at: string): Promise<{ userId: string } | null> {
    const token = this.authTokens.get(tokenHash);
    if (!token || token.purpose !== purpose || token.usedAt || token.expiresAt <= at) return null;
    token.usedAt = at;
    return { userId: token.userId };
  }

  async getMembership(userId: string, organizationId?: string): Promise<OrganizationMember | null> {
    const found = [...this.memberships.values()].find(
      (membership) =>
        membership.userId === userId &&
        (organizationId === undefined || membership.organizationId === organizationId),
    );
    return found ? clone(found) : null;
  }

  async getOrganization(id: string): Promise<Organization | null> {
    const found = this.organizations.get(id);
    return found ? clone(found) : null;
  }

  async updateOrganization(id: string, name: string): Promise<Organization | null> {
    const found = this.organizations.get(id);
    if (!found) return null;
    const updated = { ...found, name, updatedAt: now() };
    this.organizations.set(id, updated);
    return clone(updated);
  }

  async listMembers(
    organizationId: string,
  ): Promise<Array<OrganizationMember & { user: Omit<User, "passwordHash"> }>> {
    return [...this.memberships.values()]
      .filter((membership) => membership.organizationId === organizationId)
      .flatMap((membership) => {
        const user = this.users.get(membership.userId);
        if (!user) return [];
        const { passwordHash: _passwordHash, ...safeUser } = user;
        return [{ ...clone(membership), user: clone(safeUser) }];
      });
  }

  async createProject(
    organizationId: string,
    input: Omit<Project, "id" | "organizationId" | "createdAt" | "updatedAt" | "deletedAt">,
  ): Promise<Project> {
    const timestamp = now();
    const project: Project = {
      id: randomUUID(),
      organizationId,
      ...input,
      deletedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.projects.set(project.id, project);
    return clone(project);
  }

  async listProjects(
    organizationId: string,
    pagination: PaginationInput,
  ): Promise<Paginated<Project>> {
    return paginate(
      [...this.projects.values()].filter(
        (project) => project.organizationId === organizationId && !project.deletedAt,
      ),
      pagination,
    );
  }

  async getProject(organizationId: string, id: string): Promise<Project | null> {
    const found = this.projects.get(id);
    return found && found.organizationId === organizationId && !found.deletedAt
      ? clone(found)
      : null;
  }

  async updateProject(
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
  ): Promise<Project | null> {
    const found = await this.getProject(organizationId, id);
    if (!found) return null;
    const updated = { ...found, ...input, updatedAt: now() };
    this.projects.set(id, updated);
    return clone(updated);
  }

  async deleteProject(organizationId: string, id: string): Promise<boolean> {
    const found = await this.getProject(organizationId, id);
    if (!found) return false;
    this.projects.set(id, { ...found, deletedAt: now(), updatedAt: now() });
    return true;
  }

  async createAgent(
    organizationId: string,
    projectId: string,
    input: AgentProfileInput,
  ): Promise<AgentProfile> {
    const timestamp = now();
    const agent = {
      ...input,
      id: randomUUID(),
      organizationId,
      projectId,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.agents.set(agent.id, agent);
    return clone(agent);
  }

  async listAgents(organizationId: string, projectId: string): Promise<AgentProfile[]> {
    return clone(
      [...this.agents.values()].filter(
        (agent) => agent.organizationId === organizationId && agent.projectId === projectId,
      ),
    );
  }

  async getAgent(organizationId: string, id: string): Promise<AgentProfile | null> {
    const found = this.agents.get(id);
    return found && found.organizationId === organizationId ? clone(found) : null;
  }

  async updateAgent(
    organizationId: string,
    id: string,
    input: Partial<AgentProfileInput>,
  ): Promise<AgentProfile | null> {
    const found = await this.getAgent(organizationId, id);
    if (!found) return null;
    const updated = { ...found, ...input, updatedAt: now() };
    this.agents.set(id, updated);
    return clone(updated);
  }

  async deleteAgent(organizationId: string, id: string): Promise<boolean> {
    const found = await this.getAgent(organizationId, id);
    return found ? this.agents.delete(id) : false;
  }

  async createDocument(document: DocumentRecord): Promise<DocumentRecord> {
    this.documents.set(document.id, clone(document));
    return clone(document);
  }

  async listDocuments(
    organizationId: string,
    projectId: string,
    pagination: PaginationInput,
  ): Promise<Paginated<DocumentRecord>> {
    return paginate(
      [...this.documents.values()].filter(
        (document) =>
          document.organizationId === organizationId &&
          document.projectId === projectId &&
          !document.deletedAt,
      ),
      pagination,
    );
  }

  async getDocument(organizationId: string, id: string): Promise<DocumentRecord | null> {
    const found = this.documents.get(id);
    return found && found.organizationId === organizationId && !found.deletedAt
      ? clone(found)
      : null;
  }

  async updateDocument(document: DocumentRecord): Promise<DocumentRecord | null> {
    const found = this.documents.get(document.id);
    if (!found || found.organizationId !== document.organizationId) return null;
    this.documents.set(document.id, clone(document));
    return clone(document);
  }

  async deleteDocument(organizationId: string, id: string): Promise<DocumentRecord | null> {
    const found = await this.getDocument(organizationId, id);
    if (!found) return null;
    const deleted: DocumentRecord = {
      ...found,
      extractedText: "",
      segments: [],
      retentionStatus: "deleted",
      deletedAt: now(),
      updatedAt: now(),
    };
    this.documents.set(id, deleted);
    return clone(deleted);
  }

  async listDocumentsDueForDeletion(before: string, limit: number): Promise<DocumentRecord[]> {
    return [...this.documents.values()]
      .filter(
        (document) =>
          !document.deletedAt && Boolean(document.deleteAfter) && document.deleteAfter! <= before,
      )
      .sort((left, right) => left.deleteAfter!.localeCompare(right.deleteAfter!))
      .slice(0, limit)
      .map(clone);
  }

  async createAnalysis(analysis: Analysis): Promise<Analysis> {
    this.analyses.set(analysis.id, clone(analysis));
    return clone(analysis);
  }

  async listAnalyses(
    organizationId: string,
    projectId: string,
    pagination: PaginationInput,
  ): Promise<Paginated<Analysis>> {
    return paginate(
      [...this.analyses.values()].filter(
        (analysis) =>
          analysis.organizationId === organizationId && analysis.projectId === projectId,
      ),
      pagination,
    );
  }

  async getAnalysis(organizationId: string, id: string): Promise<Analysis | null> {
    const found = this.analyses.get(id);
    return found && found.organizationId === organizationId ? clone(found) : null;
  }

  async updateAnalysis(analysis: Analysis): Promise<Analysis | null> {
    const found = this.analyses.get(analysis.id);
    if (!found || found.organizationId !== analysis.organizationId) return null;
    this.analyses.set(analysis.id, clone(analysis));
    return clone(analysis);
  }

  async replaceFindings(
    organizationId: string,
    analysisId: string,
    findings: Finding[],
  ): Promise<void> {
    for (const [id, finding] of this.findings) {
      if (finding.organizationId === organizationId && finding.analysisId === analysisId)
        this.findings.delete(id);
    }
    for (const finding of findings) this.findings.set(finding.id, clone(finding));
  }

  async listFindings(
    organizationId: string,
    analysisId: string,
    pagination: PaginationInput,
  ): Promise<Paginated<Finding>> {
    return paginate(
      [...this.findings.values()].filter(
        (finding) => finding.organizationId === organizationId && finding.analysisId === analysisId,
      ),
      pagination,
    );
  }

  async getFinding(organizationId: string, id: string): Promise<Finding | null> {
    const found = this.findings.get(id);
    return found && found.organizationId === organizationId ? clone(found) : null;
  }

  async updateFindingStatus(
    organizationId: string,
    id: string,
    status: FindingStatus,
  ): Promise<Finding | null> {
    const found = await this.getFinding(organizationId, id);
    if (!found) return null;
    const updated = { ...found, status };
    this.findings.set(id, updated);
    return clone(updated);
  }

  async addAuditEvent(event: AuditEvent): Promise<void> {
    this.auditEvents.set(event.id, clone(event));
  }

  async listAuditEvents(
    organizationId: string,
    projectId: string,
    pagination: PaginationInput,
  ): Promise<Paginated<AuditEvent>> {
    return paginate(
      [...this.auditEvents.values()].filter(
        (event) =>
          event.organizationId === organizationId &&
          (event.resourceId === projectId || event.metadata.projectId === projectId),
      ),
      pagination,
    );
  }

  async getServiceLink(organizationId: string): Promise<ServiceLink | null> {
    return this.serviceLinks.get(organizationId) ?? null;
  }

  async saveServiceLink(link: Omit<ServiceLink, "createdAt" | "updatedAt">): Promise<ServiceLink> {
    const existing = this.serviceLinks.get(link.organizationId);
    const timestamp = now();
    const saved: ServiceLink = { ...link, createdAt: existing?.createdAt ?? timestamp, updatedAt: timestamp };
    this.serviceLinks.set(link.organizationId, saved);
    return saved;
  }

  async addConsoleCertificate(record: Omit<ConsoleCertificate, "createdAt">): Promise<ConsoleCertificate> {
    const saved: ConsoleCertificate = { ...record, createdAt: now() };
    this.consoleCertificates.set(record.jti, saved);
    return saved;
  }

  async getConsoleCertificate(organizationId: string, jti: string): Promise<ConsoleCertificate | null> {
    const record = this.consoleCertificates.get(jti);
    return record && record.organizationId === organizationId ? record : null;
  }

  async getConsoleSubscription(organizationId: string): Promise<ConsoleSubscription | null> {
    return this.consoleSubscriptions.get(organizationId) ?? null;
  }

  async saveConsoleSubscription(record: Omit<ConsoleSubscription, "updatedAt">): Promise<ConsoleSubscription> {
    const saved: ConsoleSubscription = { ...record, updatedAt: now() };
    this.consoleSubscriptions.set(record.organizationId, saved);
    return saved;
  }

  async claimBillingWebhookEvent(id: string): Promise<boolean> {
    if (this.billingEvents.has(id)) return false;
    this.billingEvents.add(id);
    return true;
  }

  async addMember(organizationId: string, input: { email: string; name: string; passwordHash: string; role: Role }): Promise<OrganizationMember> {
    if (await this.findUserByEmail(input.email)) throw new Error("EMAIL_EXISTS");
    const timestamp = now();
    const user: User = { id: randomUUID(), email: input.email.toLowerCase(), name: input.name, passwordHash: input.passwordHash, emailVerifiedAt: null, passwordChangedAt: null, createdAt: timestamp, updatedAt: timestamp };
    this.users.set(user.id, user);
    const membership: OrganizationMember = { id: randomUUID(), organizationId, userId: user.id, role: input.role, createdAt: timestamp };
    this.memberships.set(membership.id, membership);
    return membership;
  }

  async listConsoleSigners(organizationId: string): Promise<ConsoleSigner[]> {
    return [...this.consoleSigners.values()].filter((item) => item.organizationId === organizationId);
  }

  async addConsoleSigner(record: Omit<ConsoleSigner, "createdAt">): Promise<ConsoleSigner> {
    const saved: ConsoleSigner = { ...record, createdAt: now() };
    this.consoleSigners.set(`${record.organizationId}:${record.userId}`, saved);
    return saved;
  }

  private receiptKey = (organizationId: string, seq: number) => `${organizationId}:${seq}`;

  async lastReceipt(organizationId: string): Promise<EvidenceReceiptRecord | null> {
    const mine = [...this.receipts.values()].filter((r) => r.organizationId === organizationId);
    return mine.length ? clone(mine.reduce((a, b) => (b.seq > a.seq ? b : a))) : null;
  }

  async addReceipt(record: Omit<EvidenceReceiptRecord, "createdAt" | "otsConfirmedAt" | "otsBlockHeight">): Promise<EvidenceReceiptRecord> {
    const key = this.receiptKey(record.organizationId, record.seq);
    if (this.receipts.has(key)) throw Object.assign(new Error("receipt sequence number taken"), { code: "SEQ_TAKEN" });
    const saved: EvidenceReceiptRecord = { ...clone(record), otsConfirmedAt: null, otsBlockHeight: null, createdAt: now() };
    this.receipts.set(key, saved);
    return clone(saved);
  }

  async listReceipts(organizationId: string): Promise<EvidenceReceiptRecord[]> {
    return clone([...this.receipts.values()].filter((r) => r.organizationId === organizationId).sort((a, b) => a.seq - b.seq));
  }

  async getReceipt(organizationId: string, seq: number): Promise<EvidenceReceiptRecord | null> {
    const found = this.receipts.get(this.receiptKey(organizationId, seq));
    return found ? clone(found) : null;
  }

  async listUnanchoredReceipts(limit: number): Promise<EvidenceReceiptRecord[]> {
    return clone([...this.receipts.values()].filter((r) => r.otsStatus !== "confirmed").sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(0, limit));
  }

  async updateReceiptTimestamp(organizationId: string, seq: number, patch: Partial<Pick<EvidenceReceiptRecord, "otsProof" | "otsStatus" | "otsConfirmedAt" | "otsBlockHeight">>): Promise<void> {
    const key = this.receiptKey(organizationId, seq);
    const found = this.receipts.get(key);
    if (found) this.receipts.set(key, { ...found, ...patch });
  }

  async reset(): Promise<void> {
    this.twoFactor.clear();
    this.authTokens.clear();
    this.receipts.clear();
    this.consoleSigners.clear();
    this.consoleSubscriptions.clear();
    this.billingEvents.clear();
    this.serviceLinks.clear();
    this.consoleCertificates.clear();
    this.users.clear();
    this.organizations.clear();
    this.memberships.clear();
    this.projects.clear();
    this.agents.clear();
    this.documents.clear();
    this.analyses.clear();
    this.findings.clear();
    this.auditEvents.clear();
  }

  // ---- Console governance records (knock-out Phase 5) ----
  async listConsoleRecords(organizationId: string, kind: string): Promise<ConsoleRecord[]> {
    return clone([...this.consoleRecords.values()].filter((r) => r.organizationId === organizationId && r.kind === kind).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.key.localeCompare(b.key)));
  }

  async getConsoleRecord(organizationId: string, kind: string, key: string): Promise<ConsoleRecord | null> {
    const found = this.consoleRecords.get(`${organizationId}:${kind}:${key}`);
    return found ? clone(found) : null;
  }

  async saveConsoleRecord(record: { organizationId: string; kind: string; key: string; data: Record<string, unknown> }): Promise<ConsoleRecord> {
    const id = `${record.organizationId}:${record.kind}:${record.key}`;
    const existing = this.consoleRecords.get(id);
    const stamp = now();
    const saved: ConsoleRecord = { ...record, data: clone(record.data), createdAt: existing?.createdAt ?? stamp, updatedAt: stamp };
    this.consoleRecords.set(id, saved);
    return clone(saved);
  }

  async deleteConsoleRecord(organizationId: string, kind: string, key: string): Promise<boolean> {
    return this.consoleRecords.delete(`${organizationId}:${kind}:${key}`);
  }

  // ---- Account deletion (S-14) ----
  async listMembershipsForUser(userId: string): Promise<OrganizationMember[]> {
    return clone([...this.memberships.values()].filter((m) => m.userId === userId).sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
  }

  async listConsoleCertificateIds(organizationId: string): Promise<string[]> {
    return [...this.consoleCertificates.values()].filter((c) => c.organizationId === organizationId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((c) => c.jti);
  }

  async deleteOrganization(organizationId: string): Promise<{ storageKeys: string[] }> {
    const storageKeys = [...this.documents.values()].filter((d) => d.organizationId === organizationId).map((d) => d.storageKey);
    const drop = <V extends { organizationId: string }>(map: Map<string, V>) => { for (const [k, v] of map) if (v.organizationId === organizationId) map.delete(k); };
    drop(this.receipts); drop(this.consoleRecords); drop(this.consoleSigners); drop(this.consoleSubscriptions); drop(this.consoleCertificates); drop(this.serviceLinks);
    drop(this.auditEvents); drop(this.findings); drop(this.analyses); drop(this.documents); drop(this.agents); drop(this.projects); drop(this.memberships);
    this.organizations.delete(organizationId);
    return { storageKeys };
  }

  async removeMembership(organizationId: string, userId: string): Promise<void> {
    this.consoleSigners.delete(`${organizationId}:${userId}`);
    for (const [k, m] of this.memberships) if (m.organizationId === organizationId && m.userId === userId) this.memberships.delete(k);
  }

  async deleteOrAnonymiseUser(userId: string, tombstone: { email: string; passwordHash: string; at: string }): Promise<"deleted" | "anonymised"> {
    const referenced = [...this.documents.values()].some((d) => d.uploaderId === userId) || [...this.auditEvents.values()].some((e) => e.actorId === userId);
    this.twoFactor.delete(userId);
    for (const [k, t] of this.authTokens) if (t.userId === userId) this.authTokens.delete(k);
    for (const [k, s] of this.consoleSigners) if (s.userId === userId) this.consoleSigners.delete(k);
    for (const [k, m] of this.memberships) if (m.userId === userId) this.memberships.delete(k);
    if (!referenced) { this.users.delete(userId); return "deleted"; }
    const found = this.users.get(userId);
    if (found) this.users.set(userId, { ...found, email: tombstone.email, name: "Deleted user", passwordHash: tombstone.passwordHash, emailVerifiedAt: null, passwordChangedAt: tombstone.at, updatedAt: now() });
    return "anonymised";
  }

  setRoleForTesting(userId: string, organizationId: string, role: Role): void {
    const membership = [...this.memberships.values()].find(
      (item) => item.userId === userId && item.organizationId === organizationId,
    );
    if (!membership) throw new Error("Membership not found.");
    this.memberships.set(membership.id, { ...membership, role });
  }
}
