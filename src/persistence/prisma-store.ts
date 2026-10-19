import { Prisma, PrismaClient } from "@prisma/client";
import type {
  AgentProfile,
  AgentProfileInput,
  Analysis,
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
  User,
  ServiceLink,
  ConsoleCertificate,
  ConsoleSubscription,
  ConsoleSigner,
  EvidenceReceiptRecord,
  Role,
  TextSegment,
} from "../domain/types.js";
import type { RegistrationRecord, Store } from "./store.js";
import { EmailVault, normalizeEmail } from "./email-vault.js";
import { SEALED_PREFIX } from "./field-vault.js";

const iso = (date: Date): string => date.toISOString();
const receiptRow = (row: { organizationId: string; seq: number; receipt: Prisma.JsonValue; anchorHash: string; otsProof: string | null; otsStatus: string; otsConfirmedAt: Date | null; otsBlockHeight: number | null; createdAt: Date }): EvidenceReceiptRecord => ({
  organizationId: row.organizationId,
  seq: row.seq,
  receipt: row.receipt as Record<string, unknown>,
  anchorHash: row.anchorHash,
  otsProof: row.otsProof,
  otsStatus: row.otsStatus as EvidenceReceiptRecord["otsStatus"],
  otsConfirmedAt: row.otsConfirmedAt ? iso(row.otsConfirmedAt) : null,
  otsBlockHeight: row.otsBlockHeight,
  createdAt: iso(row.createdAt),
});
const json = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;

type FieldKind = "text" | "list" | "json";
type FieldData = Record<string, unknown>;
const UPGRADE_BATCH = 200;

// SQL conditions matching rows that still hold plaintext in a sealed column. Column and table
// names passed to these come only from the constants in encryptStoredData.
const pendingCondition: Record<FieldKind, (column: string) => string> = {
  text: (column) => `"${column}" NOT LIKE '${SEALED_PREFIX}%'`,
  list: (column) => `EXISTS (SELECT 1 FROM unnest("${column}") AS item WHERE item NOT LIKE '${SEALED_PREFIX}%')`,
  json: (column) => `jsonb_typeof("${column}") NOT IN ('string', 'null')`,
};

function auditProjectId(metadata: AuditEvent["metadata"]): string | null {
  return typeof metadata.projectId === "string" ? metadata.projectId : null;
}

function subscriptionRow(row: {
  organizationId: string; plan: string; status: string; dodoCustomerId: string | null; dodoSubscriptionId: string | null;
  renewsAt: Date | null; lastEventAt: Date | null; updatedAt: Date;
}): ConsoleSubscription {
  return { ...row, renewsAt: row.renewsAt ? iso(row.renewsAt) : null, lastEventAt: row.lastEventAt ? iso(row.lastEventAt) : null, updatedAt: iso(row.updatedAt) };
}

export class PrismaStore implements Store {
  constructor(
    readonly client = new PrismaClient(),
    private readonly vault = new EmailVault(null),
  ) {}

  async ready(): Promise<boolean> {
    await this.client.$queryRaw`SELECT 1`;
    return true;
  }

  private sealJson(value: unknown): Prisma.InputJsonValue {
    return json(this.vault.sealJson(value));
  }

  private user(row: { id: string; email: string; name: string; passwordHash: string; createdAt: Date; updatedAt: Date }): User {
    return {
      id: row.id,
      email: this.vault.open(row.email),
      name: this.vault.open(row.name),
      passwordHash: row.passwordHash,
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt),
    };
  }

  private userEmailData(email: string): { email: string; emailHash: string | null } {
    const normalized = normalizeEmail(email);
    return { email: this.vault.seal(normalized), emailHash: this.vault.index(normalized) };
  }

  // Encrypts emails stored before email encryption existed (accounts and console signers).
  // Runs at startup; only touches rows not yet upgraded, so it is a no-op once done.
  async encryptStoredEmails(): Promise<number> {
    if (!this.vault.index("probe@example.com")) return 0;
    let upgraded = 0;
    const users = await this.client.user.findMany({ where: { emailHash: null }, select: { id: true, email: true } });
    for (const row of users) {
      try {
        const result = await this.client.user.updateMany({
          where: { id: row.id, emailHash: null },
          data: this.userEmailData(this.vault.open(row.email)),
        });
        upgraded += result.count;
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) throw error;
        process.emitWarning(`User ${row.id} shares an email with another account; left unencrypted for manual review.`);
      }
    }
    const signers = await this.client.consoleSigner.findMany({ where: { NOT: { trustProofEmail: { startsWith: "enc:v1:" } } } });
    for (const row of signers) {
      await this.client.consoleSigner.update({
        where: { organizationId_userId: { organizationId: row.organizationId, userId: row.userId } },
        data: { trustProofEmail: this.vault.seal(row.trustProofEmail) },
      });
      upgraded += 1;
    }
    return upgraded;
  }

  // Seals every customer field written before field encryption existed (and the account emails
  // above). Runs at startup and only touches rows that still hold plaintext, so it is a no-op once
  // done. Rows that change concurrently are left for the next run rather than overwritten.
  async encryptStoredData(): Promise<number> {
    if (!this.vault.enabled) return 0;
    const db = this.client;
    let upgraded = await this.encryptStoredEmails();
    upgraded += await this.upgradeTable("User", "id", { name: "text" },
      (id) => db.user.findUnique({ where: { id } }),
      (row, data) => db.user.updateMany({ where: { id: row.id, updatedAt: row.updatedAt }, data: { ...data, updatedAt: row.updatedAt } }));
    upgraded += await this.upgradeTable("Organization", "id", { name: "text" },
      (id) => db.organization.findUnique({ where: { id } }),
      (row, data) => db.organization.updateMany({ where: { id: row.id, updatedAt: row.updatedAt }, data: { ...data, updatedAt: row.updatedAt } }));
    upgraded += await this.upgradeTable("Project", "id", { name: "text", description: "text" },
      (id) => db.project.findUnique({ where: { id } }),
      (row, data) => db.project.updateMany({ where: { id: row.id, updatedAt: row.updatedAt }, data: { ...data, updatedAt: row.updatedAt } }));
    upgraded += await this.upgradeTable("AgentProfile", "id", { profile: "json" },
      (id) => db.agentProfile.findUnique({ where: { id } }),
      (row, data) => db.agentProfile.updateMany({ where: { id: row.id, updatedAt: row.updatedAt }, data: { ...data, updatedAt: row.updatedAt } }));
    upgraded += await this.upgradeTable(
      "Document", "id",
      { originalFilename: "text", safeFilename: "text", extractedText: "text", extractionError: "text", extractionWarnings: "list" },
      (id) => db.document.findUnique({ where: { id } }),
      (row, data) => db.document.updateMany({ where: { id: row.id, updatedAt: row.updatedAt }, data: { ...data, updatedAt: row.updatedAt } }));
    upgraded += await this.upgradeTable("DocumentSegment", "id", { sectionHeading: "text", normalizedText: "text", originalText: "text" },
      (id) => db.documentSegment.findUnique({ where: { id } }),
      (row, data) => db.documentSegment.updateMany({ where: { id: row.id }, data }));
    upgraded += await this.upgradeTable("Analysis", "id", { attentionScore: "json", warnings: "list", failureReason: "text" },
      (id) => db.analysis.findUnique({ where: { id } }),
      (row, data) => db.analysis.updateMany({ where: { id: row.id, updatedAt: row.updatedAt }, data: { ...data, updatedAt: row.updatedAt } }));
    upgraded += await this.upgradeTable("Finding", "id", { payload: "json" },
      (id) => db.finding.findUnique({ where: { id } }),
      (row, data) => db.finding.updateMany({ where: { id: row.id, updatedAt: row.updatedAt }, data: { ...data, updatedAt: row.updatedAt } }));
    upgraded += await this.upgradeTable("AuditEvent", "id", { metadata: "json" },
      (id) => db.auditEvent.findUnique({ where: { id } }),
      (row, data) => db.auditEvent.updateMany({
        where: { id: row.id },
        data: { ...data, projectId: row.projectId ?? auditProjectId(row.metadata as AuditEvent["metadata"]) },
      }));
    upgraded += await this.upgradeTable("ServiceLink", "organizationId", { atlasEmail: "text", trustProofEmail: "text" },
      (organizationId) => db.serviceLink.findUnique({ where: { organizationId } }),
      (row, data) => db.serviceLink.updateMany({
        where: { organizationId: row.organizationId, updatedAt: row.updatedAt },
        data: { ...data, updatedAt: row.updatedAt },
      }));
    upgraded += await this.upgradeTable("ConsoleCertificate", "jti", { certificate: "text", pqSignature: "json" },
      (jti) => db.consoleCertificate.findUnique({ where: { jti } }),
      (row, data) => db.consoleCertificate.updateMany({ where: { jti: row.jti }, data }));
    return upgraded;
  }

  private async upgradeTable<Row extends FieldData>(
    table: string,
    key: string,
    fields: Record<string, FieldKind>,
    find: (key: string) => Promise<Row | null>,
    save: (row: Row, data: FieldData) => Promise<{ count: number }>,
  ): Promise<number> {
    const conditions = Object.entries(fields).map(([column, kind]) => pendingCondition[kind](column)).join(" OR ");
    let upgraded = 0;
    let after: string | null = null;
    for (;;) {
      const keys: Array<{ key: string }> = await this.client.$queryRawUnsafe(
        `SELECT "${key}"::text AS key FROM "${table}" WHERE (${conditions})${after === null ? "" : ` AND "${key}"::text > $1`} ORDER BY 1 LIMIT ${UPGRADE_BATCH}`,
        ...(after === null ? [] : [after]),
      );
      for (const { key: id } of keys) {
        const row = await find(id);
        const data = row ? this.pendingFieldData(row, fields) : null;
        if (row && data) upgraded += (await save(row, data)).count;
      }
      if (keys.length < UPGRADE_BATCH) return upgraded;
      after = keys[keys.length - 1]!.key;
    }
  }

  private pendingFieldData(row: FieldData, fields: Record<string, FieldKind>): FieldData | null {
    const data: FieldData = {};
    for (const [field, kind] of Object.entries(fields)) {
      const value = row[field];
      if (value === null || value === undefined) continue;
      if (kind === "text" && !this.vault.isSealed(value)) data[field] = this.vault.seal(value as string);
      if (kind === "list" && (value as string[]).some((item) => !this.vault.isSealed(item)))
        data[field] = (value as string[]).map((item) => (this.vault.isSealed(item) ? item : this.vault.seal(item)));
      if (kind === "json" && !this.vault.isSealed(value)) data[field] = this.sealJson(value);
    }
    return Object.keys(data).length ? data : null;
  }

  async createRegistration(input: {
    email: string;
    name: string;
    passwordHash: string;
    organizationName: string;
  }): Promise<RegistrationRecord> {
    try {
      const result = await this.client.$transaction(async (database) => {
        const user = await database.user.create({
          data: {
            ...this.userEmailData(input.email),
            name: this.vault.seal(input.name),
            passwordHash: input.passwordHash,
          },
        });
        const organization = await database.organization.create({
          data: { name: this.vault.seal(input.organizationName) },
        });
        const membership = await database.organizationMember.create({
          data: { userId: user.id, organizationId: organization.id, role: "owner" },
        });
        return { user, organization, membership };
      });
      return {
        user: this.user(result.user),
        organization: this.organization(result.organization),
        membership: { ...result.membership, createdAt: iso(result.membership.createdAt) },
      };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")
        throw new Error("EMAIL_EXISTS");
      throw error;
    }
  }

  // Matches on the email fingerprint; the plain-column fallback covers rows not yet upgraded by
  // encryptStoredEmails and development without a key.
  async findUserByEmail(email: string): Promise<User | null> {
    const normalized = normalizeEmail(email);
    if (!normalized) return null;
    const hash = this.vault.index(normalized);
    const row = hash
      ? await this.client.user.findFirst({ where: { OR: [{ emailHash: hash }, { emailHash: null, email: normalized }] } })
      : await this.client.user.findUnique({ where: { email: normalized } });
    return row ? this.user(row) : null;
  }

  async getUser(id: string): Promise<User | null> {
    const row = await this.client.user.findUnique({ where: { id } });
    return row ? this.user(row) : null;
  }

  async getMembership(userId: string, organizationId?: string): Promise<OrganizationMember | null> {
    const row = await this.client.organizationMember.findFirst({
      where: { userId, ...(organizationId ? { organizationId } : {}) },
    });
    return row ? { ...row, createdAt: iso(row.createdAt) } : null;
  }

  async getOrganization(id: string): Promise<Organization | null> {
    const row = await this.client.organization.findUnique({ where: { id } });
    return row ? this.organization(row) : null;
  }

  async updateOrganization(id: string, name: string): Promise<Organization | null> {
    const result = await this.client.organization.updateMany({ where: { id }, data: { name: this.vault.seal(name) } });
    return result.count ? this.getOrganization(id) : null;
  }

  async listMembers(
    organizationId: string,
  ): Promise<Array<OrganizationMember & { user: Omit<User, "passwordHash"> }>> {
    const rows = await this.client.organizationMember.findMany({
      where: { organizationId },
      include: { user: true },
      orderBy: { createdAt: "asc" },
    });
    return rows.map(({ user, ...membership }) => ({
      ...membership,
      createdAt: iso(membership.createdAt),
      user: {
        id: user.id,
        email: this.vault.open(user.email),
        name: this.vault.open(user.name),
        createdAt: iso(user.createdAt),
        updatedAt: iso(user.updatedAt),
      },
    }));
  }

  async createProject(
    organizationId: string,
    input: Omit<Project, "id" | "organizationId" | "createdAt" | "updatedAt" | "deletedAt">,
  ): Promise<Project> {
    const row = await this.client.project.create({
      data: { organizationId, ...input, name: this.vault.seal(input.name), description: this.vault.sealOptional(input.description) },
    });
    return this.mapProject(row);
  }

  async listProjects(
    organizationId: string,
    pagination: PaginationInput,
  ): Promise<Paginated<Project>> {
    const where = { organizationId, deletedAt: null };
    const [rows, total] = await this.client.$transaction([
      this.client.project.findMany({
        where,
        skip: (pagination.page - 1) * pagination.pageSize,
        take: pagination.pageSize,
        orderBy: { createdAt: "desc" },
      }),
      this.client.project.count({ where }),
    ]);
    return { items: rows.map((row) => this.mapProject(row)), total, ...pagination };
  }

  async getProject(organizationId: string, id: string): Promise<Project | null> {
    const row = await this.client.project.findFirst({
      where: { id, organizationId, deletedAt: null },
    });
    return row ? this.mapProject(row) : null;
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
    const result = await this.client.project.updateMany({
      where: { id, organizationId, deletedAt: null },
      data: {
        ...input,
        ...(input.name !== undefined ? { name: this.vault.seal(input.name) } : {}),
        ...(input.description !== undefined ? { description: this.vault.sealOptional(input.description) } : {}),
      },
    });
    return result.count ? this.getProject(organizationId, id) : null;
  }

  async deleteProject(organizationId: string, id: string): Promise<boolean> {
    const result = await this.client.project.updateMany({
      where: { id, organizationId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    return result.count > 0;
  }

  async createAgent(
    organizationId: string,
    projectId: string,
    input: AgentProfileInput,
  ): Promise<AgentProfile> {
    const row = await this.client.agentProfile.create({
      data: { organizationId, projectId, profile: this.sealJson(input) },
    });
    return this.mapAgent(row);
  }

  async listAgents(organizationId: string, projectId: string): Promise<AgentProfile[]> {
    const rows = await this.client.agentProfile.findMany({
      where: { organizationId, projectId },
      orderBy: { createdAt: "desc" },
    });
    return rows.map((row) => this.mapAgent(row));
  }

  async getAgent(organizationId: string, id: string): Promise<AgentProfile | null> {
    const row = await this.client.agentProfile.findFirst({ where: { id, organizationId } });
    return row ? this.mapAgent(row) : null;
  }

  async updateAgent(
    organizationId: string,
    id: string,
    input: Partial<AgentProfileInput>,
  ): Promise<AgentProfile | null> {
    const existing = await this.getAgent(organizationId, id);
    if (!existing) return null;
    const {
      id: _id,
      organizationId: _organizationId,
      projectId: _projectId,
      createdAt: _createdAt,
      updatedAt: _updatedAt,
      ...profile
    } = existing;
    await this.client.agentProfile.update({
      where: { id },
      data: { profile: this.sealJson({ ...profile, ...input }) },
    });
    return this.getAgent(organizationId, id);
  }

  async deleteAgent(organizationId: string, id: string): Promise<boolean> {
    const result = await this.client.agentProfile.deleteMany({ where: { id, organizationId } });
    return result.count > 0;
  }

  async createDocument(document: DocumentRecord): Promise<DocumentRecord> {
    const row = await this.client.document.create({
      data: {
        id: document.id,
        organizationId: document.organizationId,
        projectId: document.projectId,
        uploaderId: document.uploaderId,
        originalFilename: this.vault.seal(document.originalFilename),
        safeFilename: this.vault.seal(document.safeFilename),
        mimeType: document.mimeType,
        size: document.size,
        checksum: document.checksum,
        documentType: document.documentType,
        countryCode: document.countryCode,
        subdivisionCode: document.subdivisionCode,
        storageKey: document.storageKey,
        extractionStatus: document.extractionStatus,
        extractionError: this.vault.sealOptional(document.extractionError),
        extractionWarnings: this.vault.sealList(document.extractionWarnings),
        pageCount: document.pageCount,
        extractedText: this.vault.seal(document.extractedText),
        retentionStatus: document.retentionStatus,
        deleteAfter: document.deleteAfter ? new Date(document.deleteAfter) : null,
        segments: { create: document.segments.map((segment) => this.segmentData(segment)) },
      },
      include: { segments: { orderBy: { paragraphNumber: "asc" } } },
    });
    return this.mapDocument(row);
  }

  async listDocuments(
    organizationId: string,
    projectId: string,
    pagination: PaginationInput,
  ): Promise<Paginated<DocumentRecord>> {
    const where = { organizationId, projectId, deletedAt: null };
    const [rows, total] = await this.client.$transaction([
      this.client.document.findMany({
        where,
        include: { segments: { orderBy: { paragraphNumber: "asc" } } },
        skip: (pagination.page - 1) * pagination.pageSize,
        take: pagination.pageSize,
        orderBy: { createdAt: "desc" },
      }),
      this.client.document.count({ where }),
    ]);
    return { items: rows.map((row) => this.mapDocument(row)), total, ...pagination };
  }

  async getDocument(organizationId: string, id: string): Promise<DocumentRecord | null> {
    const row = await this.client.document.findFirst({
      where: { id, organizationId, deletedAt: null },
      include: { segments: { orderBy: { paragraphNumber: "asc" } } },
    });
    return row ? this.mapDocument(row) : null;
  }

  async updateDocument(document: DocumentRecord): Promise<DocumentRecord | null> {
    if (!(await this.getDocument(document.organizationId, document.id))) return null;
    await this.client.$transaction([
      this.client.documentSegment.deleteMany({
        where: { documentId: document.id, organizationId: document.organizationId },
      }),
      this.client.document.update({
        where: { id: document.id },
        data: {
          extractionStatus: document.extractionStatus,
          extractionError: this.vault.sealOptional(document.extractionError),
          extractionWarnings: this.vault.sealList(document.extractionWarnings),
          pageCount: document.pageCount,
          extractedText: this.vault.seal(document.extractedText),
          segments: { create: document.segments.map((segment) => this.segmentData(segment)) },
        },
      }),
    ]);
    return this.getDocument(document.organizationId, document.id);
  }

  async deleteDocument(organizationId: string, id: string): Promise<DocumentRecord | null> {
    const existing = await this.getDocument(organizationId, id);
    if (!existing) return null;
    await this.client.document.update({
      where: { id },
      data: {
        retentionStatus: "deleted",
        deletedAt: new Date(),
        extractedText: this.vault.seal(""),
        segments: { deleteMany: {} },
      },
    });
    return {
      ...existing,
      retentionStatus: "deleted",
      deletedAt: new Date().toISOString(),
      extractedText: "",
      segments: [],
    };
  }

  async listDocumentsDueForDeletion(before: string, limit: number): Promise<DocumentRecord[]> {
    const rows = await this.client.document.findMany({
      where: { deletedAt: null, deleteAfter: { lte: new Date(before) } },
      select: { id: true, organizationId: true },
      orderBy: { deleteAfter: "asc" },
      take: limit,
    });
    const documents: DocumentRecord[] = [];
    for (const row of rows) {
      const document = await this.getDocument(row.organizationId, row.id);
      if (document) documents.push(document);
    }
    return documents;
  }

  async createAnalysis(analysis: Analysis): Promise<Analysis> {
    const row = await this.client.analysis.create({
      data: {
        id: analysis.id,
        organizationId: analysis.organizationId,
        projectId: analysis.projectId,
        agentProfileId: analysis.agentProfileId,
        state: analysis.state,
        engineVersion: analysis.engineVersion,
        rulesetVersions: analysis.rulesetVersions,
        jurisdictionPackIds: analysis.jurisdictionPackIds,
        attentionScore: analysis.attentionScore ? this.sealJson(analysis.attentionScore) : Prisma.JsonNull,
        warnings: this.vault.sealList(analysis.warnings),
        failureReason: this.vault.sealOptional(analysis.failureReason),
        completedAt: analysis.completedAt ? new Date(analysis.completedAt) : null,
        documents: { create: analysis.documentIds.map((documentId) => ({ documentId })) },
      },
      include: { documents: true },
    });
    return this.mapAnalysis(row);
  }

  async listAnalyses(
    organizationId: string,
    projectId: string,
    pagination: PaginationInput,
  ): Promise<Paginated<Analysis>> {
    const where = { organizationId, projectId };
    const [rows, total] = await this.client.$transaction([
      this.client.analysis.findMany({
        where,
        include: { documents: true },
        skip: (pagination.page - 1) * pagination.pageSize,
        take: pagination.pageSize,
        orderBy: { createdAt: "desc" },
      }),
      this.client.analysis.count({ where }),
    ]);
    return { items: rows.map((row) => this.mapAnalysis(row)), total, ...pagination };
  }

  async getAnalysis(organizationId: string, id: string): Promise<Analysis | null> {
    const row = await this.client.analysis.findFirst({
      where: { id, organizationId },
      include: { documents: true },
    });
    return row ? this.mapAnalysis(row) : null;
  }

  async updateAnalysis(analysis: Analysis): Promise<Analysis | null> {
    const result = await this.client.analysis.updateMany({
      where: { id: analysis.id, organizationId: analysis.organizationId },
      data: {
        state: analysis.state,
        engineVersion: analysis.engineVersion,
        rulesetVersions: analysis.rulesetVersions,
        jurisdictionPackIds: analysis.jurisdictionPackIds,
        attentionScore: analysis.attentionScore ? this.sealJson(analysis.attentionScore) : Prisma.JsonNull,
        warnings: this.vault.sealList(analysis.warnings),
        failureReason: this.vault.sealOptional(analysis.failureReason),
        completedAt: analysis.completedAt ? new Date(analysis.completedAt) : null,
      },
    });
    return result.count ? this.getAnalysis(analysis.organizationId, analysis.id) : null;
  }

  async replaceFindings(
    organizationId: string,
    analysisId: string,
    findings: Finding[],
  ): Promise<void> {
    await this.client.$transaction(async (database) => {
      await database.finding.deleteMany({ where: { organizationId, analysisId } });
      for (const finding of findings) {
        await database.finding.create({
          data: {
            id: finding.id,
            organizationId,
            analysisId,
            projectId: finding.projectId,
            documentId: finding.affectedDocumentId,
            category: finding.category,
            severity: finding.severity,
            confidence: finding.confidence,
            status: finding.status,
            stableKey: finding.id,
            payload: this.sealJson(finding),
          },
        });
      }
    });
  }

  async listFindings(
    organizationId: string,
    analysisId: string,
    pagination: PaginationInput,
  ): Promise<Paginated<Finding>> {
    const where = { organizationId, analysisId };
    const [rows, total] = await this.client.$transaction([
      this.client.finding.findMany({
        where,
        skip: (pagination.page - 1) * pagination.pageSize,
        take: pagination.pageSize,
        orderBy: { createdAt: "asc" },
      }),
      this.client.finding.count({ where }),
    ]);
    return { items: rows.map((row) => this.vault.openJson<Finding>(row.payload)), total, ...pagination };
  }

  async getFinding(organizationId: string, id: string): Promise<Finding | null> {
    const row = await this.client.finding.findFirst({ where: { id, organizationId } });
    return row ? this.vault.openJson<Finding>(row.payload) : null;
  }

  async updateFindingStatus(
    organizationId: string,
    id: string,
    status: FindingStatus,
  ): Promise<Finding | null> {
    const existing = await this.getFinding(organizationId, id);
    if (!existing) return null;
    const updated = { ...existing, status };
    await this.client.finding.update({ where: { id }, data: { status, payload: this.sealJson(updated) } });
    return updated;
  }

  async addAuditEvent(event: AuditEvent): Promise<void> {
    await this.client.auditEvent.create({
      data: {
        id: event.id,
        organizationId: event.organizationId,
        actorId: event.actorId,
        resourceType: event.resourceType,
        resourceId: event.resourceId,
        action: event.action,
        requestId: event.requestId,
        projectId: auditProjectId(event.metadata),
        metadata: this.sealJson(event.metadata),
        createdAt: new Date(event.createdAt),
      },
    });
  }

  async listAuditEvents(
    organizationId: string,
    projectId: string,
    pagination: PaginationInput,
  ): Promise<Paginated<AuditEvent>> {
    const where: Prisma.AuditEventWhereInput = {
      organizationId,
      OR: [{ resourceId: projectId }, { projectId }],
    };
    const [rows, total] = await this.client.$transaction([
      this.client.auditEvent.findMany({
        where,
        skip: (pagination.page - 1) * pagination.pageSize,
        take: pagination.pageSize,
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      }),
      this.client.auditEvent.count({ where }),
    ]);
    return {
      items: rows.map(({ projectId: _projectId, ...row }) => ({
        ...row,
        metadata: this.vault.openJson<AuditEvent["metadata"]>(row.metadata),
        createdAt: iso(row.createdAt),
      })),
      total,
      ...pagination,
    };
  }

  async getServiceLink(organizationId: string): Promise<ServiceLink | null> {
    const row = await this.client.serviceLink.findUnique({ where: { organizationId } });
    return row ? this.serviceLink(row) : null;
  }

  async saveServiceLink(link: Omit<ServiceLink, "createdAt" | "updatedAt">): Promise<ServiceLink> {
    const { organizationId, ...fields } = link;
    const sealed = { ...fields, atlasEmail: this.vault.seal(fields.atlasEmail), trustProofEmail: this.vault.seal(fields.trustProofEmail) };
    const row = await this.client.serviceLink.upsert({
      where: { organizationId },
      create: { organizationId, ...sealed },
      update: sealed,
    });
    return this.serviceLink(row);
  }

  async addConsoleCertificate(record: Omit<ConsoleCertificate, "createdAt">): Promise<ConsoleCertificate> {
    const row = await this.client.consoleCertificate.create({
      data: {
        ...record,
        certificate: this.vault.seal(record.certificate),
        pqSignature: record.pqSignature === null ? Prisma.JsonNull : this.sealJson(record.pqSignature),
      },
    });
    return this.consoleCertificate(row);
  }

  async getConsoleCertificate(organizationId: string, jti: string): Promise<ConsoleCertificate | null> {
    const row = await this.client.consoleCertificate.findFirst({ where: { jti, organizationId } });
    return row ? this.consoleCertificate(row) : null;
  }

  async getConsoleSubscription(organizationId: string): Promise<ConsoleSubscription | null> {
    const row = await this.client.consoleSubscription.findUnique({ where: { organizationId } });
    return row ? subscriptionRow(row) : null;
  }

  async saveConsoleSubscription(record: Omit<ConsoleSubscription, "updatedAt">): Promise<ConsoleSubscription> {
    const data = {
      plan: record.plan,
      status: record.status,
      dodoCustomerId: record.dodoCustomerId,
      dodoSubscriptionId: record.dodoSubscriptionId,
      renewsAt: record.renewsAt ? new Date(record.renewsAt) : null,
      lastEventAt: record.lastEventAt ? new Date(record.lastEventAt) : null,
    };
    const row = await this.client.consoleSubscription.upsert({
      where: { organizationId: record.organizationId },
      create: { organizationId: record.organizationId, ...data },
      update: data,
    });
    return subscriptionRow(row);
  }

  async claimBillingWebhookEvent(id: string, type: string): Promise<boolean> {
    try {
      await this.client.billingWebhookEvent.create({ data: { id, type } });
      return true;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return false;
      throw error;
    }
  }

  async addMember(organizationId: string, input: { email: string; name: string; passwordHash: string; role: Role }): Promise<OrganizationMember> {
    try {
      const membership = await this.client.$transaction(async (database) => {
        const user = await database.user.create({ data: { ...this.userEmailData(input.email), name: this.vault.seal(input.name), passwordHash: input.passwordHash } });
        return database.organizationMember.create({ data: { organizationId, userId: user.id, role: input.role } });
      });
      return { ...membership, createdAt: iso(membership.createdAt) };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw new Error("EMAIL_EXISTS");
      throw error;
    }
  }

  async listConsoleSigners(organizationId: string): Promise<ConsoleSigner[]> {
    const rows = await this.client.consoleSigner.findMany({ where: { organizationId } });
    return rows.map((row) => ({ ...row, trustProofEmail: this.vault.open(row.trustProofEmail), createdAt: iso(row.createdAt) }));
  }

  async addConsoleSigner(record: Omit<ConsoleSigner, "createdAt">): Promise<ConsoleSigner> {
    const trustProofEmail = this.vault.seal(record.trustProofEmail);
    const row = await this.client.consoleSigner.upsert({
      where: { organizationId_userId: { organizationId: record.organizationId, userId: record.userId } },
      create: { ...record, trustProofEmail },
      update: { trustProofEmail },
    });
    return { ...row, trustProofEmail: record.trustProofEmail, createdAt: iso(row.createdAt) };
  }

  // Evidence Notary receipts. Ids and hashes only (no names or document text), so not sealed.
  async lastReceipt(organizationId: string): Promise<EvidenceReceiptRecord | null> {
    const row = await this.client.evidenceReceipt.findFirst({ where: { organizationId }, orderBy: { seq: "desc" } });
    return row ? receiptRow(row) : null;
  }

  async addReceipt(record: Omit<EvidenceReceiptRecord, "createdAt" | "otsConfirmedAt" | "otsBlockHeight">): Promise<EvidenceReceiptRecord> {
    try {
      const row = await this.client.evidenceReceipt.create({
        data: { organizationId: record.organizationId, seq: record.seq, receipt: json(record.receipt), anchorHash: record.anchorHash, otsProof: record.otsProof, otsStatus: record.otsStatus },
      });
      return receiptRow(row);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw Object.assign(new Error("receipt sequence number taken"), { code: "SEQ_TAKEN" });
      throw error;
    }
  }

  async listReceipts(organizationId: string): Promise<EvidenceReceiptRecord[]> {
    const rows = await this.client.evidenceReceipt.findMany({ where: { organizationId }, orderBy: { seq: "asc" } });
    return rows.map(receiptRow);
  }

  async getReceipt(organizationId: string, seq: number): Promise<EvidenceReceiptRecord | null> {
    const row = await this.client.evidenceReceipt.findUnique({ where: { organizationId_seq: { organizationId, seq } } });
    return row ? receiptRow(row) : null;
  }

  async listUnanchoredReceipts(limit: number): Promise<EvidenceReceiptRecord[]> {
    const rows = await this.client.evidenceReceipt.findMany({ where: { NOT: { otsStatus: "confirmed" } }, orderBy: { createdAt: "asc" }, take: limit });
    return rows.map(receiptRow);
  }

  async updateReceiptTimestamp(organizationId: string, seq: number, patch: Partial<Pick<EvidenceReceiptRecord, "otsProof" | "otsStatus" | "otsConfirmedAt" | "otsBlockHeight">>): Promise<void> {
    await this.client.evidenceReceipt.update({
      where: { organizationId_seq: { organizationId, seq } },
      data: {
        ...(patch.otsProof !== undefined ? { otsProof: patch.otsProof } : {}),
        ...(patch.otsStatus !== undefined ? { otsStatus: patch.otsStatus } : {}),
        ...(patch.otsConfirmedAt !== undefined ? { otsConfirmedAt: patch.otsConfirmedAt ? new Date(patch.otsConfirmedAt) : null } : {}),
        ...(patch.otsBlockHeight !== undefined ? { otsBlockHeight: patch.otsBlockHeight } : {}),
      },
    });
  }

  async reset(): Promise<void> {
    await this.client.$transaction([
      this.client.evidenceReceipt.deleteMany(),
      this.client.consoleSigner.deleteMany(),
      this.client.billingWebhookEvent.deleteMany(),
      this.client.consoleSubscription.deleteMany(),
      this.client.consoleCertificate.deleteMany(),
      this.client.serviceLink.deleteMany(),
      this.client.auditEvent.deleteMany(),
      this.client.finding.deleteMany(),
      this.client.analysisDocument.deleteMany(),
      this.client.analysis.deleteMany(),
      this.client.documentSegment.deleteMany(),
      this.client.document.deleteMany(),
      this.client.agentProfile.deleteMany(),
      this.client.project.deleteMany(),
      this.client.organizationMember.deleteMany(),
      this.client.organization.deleteMany(),
      this.client.user.deleteMany(),
    ]);
  }

  async disconnect(): Promise<void> {
    await this.client.$disconnect();
  }

  private mapProject(row: {
    id: string;
    organizationId: string;
    name: string;
    description: string | null;
    primaryCountryCode: string;
    primarySubdivisionCode: string | null;
    affectedCountryCodes: string[];
    deletedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }): Project {
    return {
      ...row,
      name: this.vault.open(row.name),
      description: this.vault.openOptional(row.description),
      deletedAt: row.deletedAt ? iso(row.deletedAt) : null,
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt),
    };
  }

  private organization(row: { id: string; name: string; createdAt: Date; updatedAt: Date }): Organization {
    return { ...row, name: this.vault.open(row.name), createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) };
  }

  private serviceLink(row: Omit<ServiceLink, "createdAt" | "updatedAt"> & { createdAt: Date; updatedAt: Date }): ServiceLink {
    return {
      ...row,
      atlasEmail: this.vault.open(row.atlasEmail),
      trustProofEmail: this.vault.open(row.trustProofEmail),
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt),
    };
  }

  private consoleCertificate(row: Omit<ConsoleCertificate, "createdAt" | "pqSignature"> & { pqSignature: Prisma.JsonValue; createdAt: Date }): ConsoleCertificate {
    return {
      ...row,
      certificate: this.vault.open(row.certificate),
      pqSignature: row.pqSignature === null ? null : this.vault.openJson(row.pqSignature),
      createdAt: iso(row.createdAt),
    };
  }

  private segmentData({ documentId: _documentId, ...segment }: TextSegment) {
    return {
      ...segment,
      sectionHeading: this.vault.sealOptional(segment.sectionHeading),
      normalizedText: this.vault.seal(segment.normalizedText),
      originalText: this.vault.seal(segment.originalText),
    };
  }

  private mapAgent(row: {
    id: string;
    organizationId: string;
    projectId: string;
    profile: Prisma.JsonValue;
    createdAt: Date;
    updatedAt: Date;
  }): AgentProfile {
    return {
      ...this.vault.openJson<AgentProfileInput>(row.profile),
      id: row.id,
      organizationId: row.organizationId,
      projectId: row.projectId,
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt),
    };
  }

  private mapDocument(
    row: Prisma.DocumentGetPayload<{ include: { segments: true } }>,
  ): DocumentRecord {
    return {
      id: row.id,
      organizationId: row.organizationId,
      projectId: row.projectId,
      uploaderId: row.uploaderId,
      originalFilename: this.vault.open(row.originalFilename),
      safeFilename: this.vault.open(row.safeFilename),
      mimeType: row.mimeType,
      size: row.size,
      checksum: row.checksum,
      documentType: row.documentType as DocumentRecord["documentType"],
      countryCode: row.countryCode,
      subdivisionCode: row.subdivisionCode,
      storageKey: row.storageKey,
      extractionStatus: row.extractionStatus,
      extractionError: this.vault.openOptional(row.extractionError),
      extractionWarnings: this.vault.openList(row.extractionWarnings),
      pageCount: row.pageCount,
      extractedText: this.vault.open(row.extractedText),
      retentionStatus: row.retentionStatus,
      deleteAfter: row.deleteAfter ? iso(row.deleteAfter) : null,
      deletedAt: row.deletedAt ? iso(row.deletedAt) : null,
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt),
      segments: row.segments.map((segment) => ({
        ...segment,
        sectionHeading: this.vault.openOptional(segment.sectionHeading),
        normalizedText: this.vault.open(segment.normalizedText),
        originalText: this.vault.open(segment.originalText),
      })),
    };
  }

  private mapAnalysis(row: Prisma.AnalysisGetPayload<{ include: { documents: true } }>): Analysis {
    return {
      id: row.id,
      organizationId: row.organizationId,
      projectId: row.projectId,
      agentProfileId: row.agentProfileId,
      documentIds: row.documents.map((item) => item.documentId),
      state: row.state,
      engineVersion: row.engineVersion,
      rulesetVersions: row.rulesetVersions,
      jurisdictionPackIds: row.jurisdictionPackIds,
      attentionScore: row.attentionScore ? this.vault.openJson<AttentionScore>(row.attentionScore) : null,
      warnings: this.vault.openList(row.warnings),
      failureReason: this.vault.openOptional(row.failureReason),
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt),
      completedAt: row.completedAt ? iso(row.completedAt) : null,
    };
  }
}
