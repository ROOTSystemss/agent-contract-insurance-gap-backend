import { randomUUID } from "node:crypto";
import type {
  AgentProfile,
  AgentProfileInput,
  Analysis,
  AuditEvent,
  DocumentRecord,
  Finding,
  FindingStatus,
  Organization,
  OrganizationMember,
  Paginated,
  PaginationInput,
  Project,
  User,
  Role,
  ServiceLink,
  ConsoleCertificate,
  ConsoleSubscription,
  ConsoleSigner,
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

  async ready(): Promise<boolean> {
    return true;
  }

  async encryptStoredEmails(): Promise<number> {
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
    const user: User = { id: randomUUID(), email: input.email.toLowerCase(), name: input.name, passwordHash: input.passwordHash, createdAt: timestamp, updatedAt: timestamp };
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

  async reset(): Promise<void> {
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

  setRoleForTesting(userId: string, organizationId: string, role: Role): void {
    const membership = [...this.memberships.values()].find(
      (item) => item.userId === userId && item.organizationId === organizationId,
    );
    if (!membership) throw new Error("Membership not found.");
    this.memberships.set(membership.id, { ...membership, role });
  }
}
