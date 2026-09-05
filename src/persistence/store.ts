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
  Role,
  User,
} from "../domain/types.js";

export interface RegistrationRecord {
  user: User;
  organization: Organization;
  membership: OrganizationMember;
}

export interface Store {
  ready(): Promise<boolean>;
  createRegistration(input: {
    email: string;
    name: string;
    passwordHash: string;
    organizationName: string;
  }): Promise<RegistrationRecord>;
  findUserByEmail(email: string): Promise<User | null>;
  getUser(id: string): Promise<User | null>;
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
  reset(): Promise<void>;
}

export interface PersistedAnalysisResult {
  analysis: Analysis;
  findings: Finding[];
  score: AttentionScore;
}

export const roleRank: Record<Role, number> = { viewer: 0, analyst: 1, admin: 2, owner: 3 };
