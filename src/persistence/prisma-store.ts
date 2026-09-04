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
} from "../domain/types.js";
import type { RegistrationRecord, Store } from "./store.js";

const iso = (date: Date): string => date.toISOString();
const json = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;

export class PrismaStore implements Store {
  constructor(readonly client = new PrismaClient()) {}

  async ready(): Promise<boolean> {
    await this.client.$queryRaw`SELECT 1`;
    return true;
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
            email: input.email.toLowerCase(),
            name: input.name,
            passwordHash: input.passwordHash,
          },
        });
        const organization = await database.organization.create({
          data: { name: input.organizationName },
        });
        const membership = await database.organizationMember.create({
          data: { userId: user.id, organizationId: organization.id, role: "owner" },
        });
        return { user, organization, membership };
      });
      return {
        user: {
          ...result.user,
          createdAt: iso(result.user.createdAt),
          updatedAt: iso(result.user.updatedAt),
        },
        organization: {
          ...result.organization,
          createdAt: iso(result.organization.createdAt),
          updatedAt: iso(result.organization.updatedAt),
        },
        membership: { ...result.membership, createdAt: iso(result.membership.createdAt) },
      };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")
        throw new Error("EMAIL_EXISTS");
      throw error;
    }
  }

  async findUserByEmail(email: string): Promise<User | null> {
    const row = await this.client.user.findUnique({ where: { email: email.toLowerCase() } });
    return row ? { ...row, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) } : null;
  }

  async getUser(id: string): Promise<User | null> {
    const row = await this.client.user.findUnique({ where: { id } });
    return row ? { ...row, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) } : null;
  }

  async getMembership(userId: string, organizationId?: string): Promise<OrganizationMember | null> {
    const row = await this.client.organizationMember.findFirst({
      where: { userId, ...(organizationId ? { organizationId } : {}) },
    });
    return row ? { ...row, createdAt: iso(row.createdAt) } : null;
  }

  async getOrganization(id: string): Promise<Organization | null> {
    const row = await this.client.organization.findUnique({ where: { id } });
    return row ? { ...row, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) } : null;
  }

  async updateOrganization(id: string, name: string): Promise<Organization | null> {
    const result = await this.client.organization.updateMany({ where: { id }, data: { name } });
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
        email: user.email,
        name: user.name,
        createdAt: iso(user.createdAt),
        updatedAt: iso(user.updatedAt),
      },
    }));
  }

  async createProject(
    organizationId: string,
    input: Omit<Project, "id" | "organizationId" | "createdAt" | "updatedAt" | "deletedAt">,
  ): Promise<Project> {
    const row = await this.client.project.create({ data: { organizationId, ...input } });
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
      data: input,
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
      data: { organizationId, projectId, profile: json(input) },
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
      data: { profile: json({ ...profile, ...input }) },
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
        originalFilename: document.originalFilename,
        safeFilename: document.safeFilename,
        mimeType: document.mimeType,
        size: document.size,
        checksum: document.checksum,
        documentType: document.documentType,
        countryCode: document.countryCode,
        subdivisionCode: document.subdivisionCode,
        storageKey: document.storageKey,
        extractionStatus: document.extractionStatus,
        extractionError: document.extractionError,
        extractionWarnings: document.extractionWarnings,
        pageCount: document.pageCount,
        extractedText: document.extractedText,
        retentionStatus: document.retentionStatus,
        deleteAfter: document.deleteAfter ? new Date(document.deleteAfter) : null,
        segments: {
          create: document.segments.map(
            ({ id, organizationId, documentId: _documentId, ...segment }) => ({
              ...segment,
              id,
              organizationId,
            }),
          ),
        },
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
          extractionError: document.extractionError,
          extractionWarnings: document.extractionWarnings,
          pageCount: document.pageCount,
          extractedText: document.extractedText,
          segments: {
            create: document.segments.map(
              ({ id, organizationId, documentId: _documentId, ...segment }) => ({
                ...segment,
                id,
                organizationId,
              }),
            ),
          },
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
        extractedText: "",
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
        attentionScore: analysis.attentionScore ? json(analysis.attentionScore) : Prisma.JsonNull,
        warnings: analysis.warnings,
        failureReason: analysis.failureReason,
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
        attentionScore: analysis.attentionScore ? json(analysis.attentionScore) : Prisma.JsonNull,
        warnings: analysis.warnings,
        failureReason: analysis.failureReason,
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
            payload: json(finding),
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
    return { items: rows.map((row) => row.payload as unknown as Finding), total, ...pagination };
  }

  async getFinding(organizationId: string, id: string): Promise<Finding | null> {
    const row = await this.client.finding.findFirst({ where: { id, organizationId } });
    return row ? (row.payload as unknown as Finding) : null;
  }

  async updateFindingStatus(
    organizationId: string,
    id: string,
    status: FindingStatus,
  ): Promise<Finding | null> {
    const existing = await this.getFinding(organizationId, id);
    if (!existing) return null;
    const updated = { ...existing, status };
    await this.client.finding.update({ where: { id }, data: { status, payload: json(updated) } });
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
        metadata: json(event.metadata),
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
      OR: [{ resourceId: projectId }, { metadata: { path: ["projectId"], equals: projectId } }],
    };
    const [rows, total] = await this.client.$transaction([
      this.client.auditEvent.findMany({
        where,
        skip: (pagination.page - 1) * pagination.pageSize,
        take: pagination.pageSize,
        orderBy: { createdAt: "desc" },
      }),
      this.client.auditEvent.count({ where }),
    ]);
    return {
      items: rows.map((row) => ({
        ...row,
        metadata: row.metadata as AuditEvent["metadata"],
        createdAt: iso(row.createdAt),
      })),
      total,
      ...pagination,
    };
  }

  async reset(): Promise<void> {
    await this.client.$transaction([
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
      deletedAt: row.deletedAt ? iso(row.deletedAt) : null,
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt),
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
      ...(row.profile as unknown as AgentProfileInput),
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
      originalFilename: row.originalFilename,
      safeFilename: row.safeFilename,
      mimeType: row.mimeType,
      size: row.size,
      checksum: row.checksum,
      documentType: row.documentType as DocumentRecord["documentType"],
      countryCode: row.countryCode,
      subdivisionCode: row.subdivisionCode,
      storageKey: row.storageKey,
      extractionStatus: row.extractionStatus,
      extractionError: row.extractionError,
      extractionWarnings: row.extractionWarnings,
      pageCount: row.pageCount,
      extractedText: row.extractedText,
      retentionStatus: row.retentionStatus,
      deleteAfter: row.deleteAfter ? iso(row.deleteAfter) : null,
      deletedAt: row.deletedAt ? iso(row.deletedAt) : null,
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt),
      segments: row.segments.map((segment) => ({
        ...segment,
        pageNumber: segment.pageNumber,
        sectionHeading: segment.sectionHeading,
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
      attentionScore: row.attentionScore ? (row.attentionScore as unknown as AttentionScore) : null,
      warnings: row.warnings,
      failureReason: row.failureReason,
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt),
      completedAt: row.completedAt ? iso(row.completedAt) : null,
    };
  }
}
