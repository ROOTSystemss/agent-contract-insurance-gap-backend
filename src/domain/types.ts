export const roles = ["owner", "admin", "analyst", "viewer"] as const;
export type Role = (typeof roles)[number];

export const deploymentStatuses = ["planning", "pilot", "production", "retired"] as const;
export type DeploymentStatus = (typeof deploymentStatuses)[number];

export const humanOversightLevels = [
  "continuous",
  "pre_action_approval",
  "threshold_approval",
  "periodic_review",
  "exception_only",
  "none",
] as const;
export type HumanOversightLevel = (typeof humanOversightLevels)[number];

export const documentTypes = [
  "commercial_contract",
  "master_services_agreement",
  "statement_of_work",
  "vendor_agreement",
  "customer_agreement",
  "terms_of_service",
  "data_processing_agreement",
  "employment_or_contractor_agreement",
  "insurance_policy",
  "insurance_endorsement",
  "insurance_certificate",
  "insurance_schedule",
  "other",
] as const;
export type DocumentType = (typeof documentTypes)[number];

export const insuranceCategories = [
  "commercial_general_liability",
  "cyber",
  "technology_errors_and_omissions",
  "professional_liability",
  "directors_and_officers",
  "crime_and_fidelity",
  "media_liability",
  "product_liability",
  "employment_practices_liability",
  "other_or_unknown",
] as const;
export type InsuranceCategory = (typeof insuranceCategories)[number];

export const analysisStates = [
  "draft",
  "waiting_for_documents",
  "extracting",
  "ready",
  "running",
  "completed",
  "completed_with_warnings",
  "failed",
] as const;
export type AnalysisState = (typeof analysisStates)[number];

export const findingStatuses = [
  "open",
  "under_review",
  "accepted",
  "mitigated",
  "false_positive",
  "not_applicable",
] as const;
export type FindingStatus = (typeof findingStatuses)[number];

export const findingCategories = [
  "absent_language",
  "ambiguous_language",
  "authority_mismatch",
  "autonomy_mismatch",
  "approval_control_mismatch",
  "transaction_limit_mismatch",
  "delegation_gap",
  "sub_agent_gap",
  "data_access_gap",
  "confidentiality_gap",
  "privacy_gap",
  "security_gap",
  "intellectual_property_gap",
  "incident_response_gap",
  "recordkeeping_gap",
  "territorial_scope_gap",
  "insurance_definition_gap",
  "potential_exclusion_relevance",
  "covered_services_ambiguity",
  "insured_person_or_actor_ambiguity",
  "limit_or_sublimit_attention",
  "endorsement_attention",
  "governing_law_uncertainty",
  "jurisdiction_support_limitation",
  "missing_document",
  "insufficient_evidence",
  "professional_review_required",
] as const;
export type FindingCategory = (typeof findingCategories)[number];
export type Severity = "informational" | "low" | "moderate" | "high" | "critical";

export interface User {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  createdAt: string;
  updatedAt: string;
}

export interface Organization {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

// Agent Governance console: the Atlas identity and Trust Proof organization acting for a workspace.
// atlasSecret, trustProofSecret and trustProofApiKey are ciphertext (see governance/secret-box.ts).
export interface ServiceLink {
  organizationId: string;
  atlasEmail: string;
  atlasSecret: string;
  trustProofEmail: string;
  trustProofSecret: string;
  trustProofApiKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConsoleCertificate {
  jti: string;
  organizationId: string;
  agentId: string;
  certificate: string;
  pqSignature: unknown;
  createdAt: string;
}

// RootSystems Trunk continuous authority checks: the item keys seen at the last daily check.
export interface TrunkWatchState {
  organizationId: string;
  keys: string[];
  checkedAt: string;
  alertedAt: string | null;
}

// Agent Governance console plan, mirrored from Dodo Payments webhooks. No record = free plan.
export interface ConsoleSubscription {
  organizationId: string;
  plan: string;
  status: string;
  dodoCustomerId: string | null;
  dodoSubscriptionId: string | null;
  renewsAt: string | null;
  lastEventAt: string | null;
  updatedAt: string;
}

export interface ConsoleSigner {
  organizationId: string;
  userId: string;
  trustProofEmail: string;
  createdAt: string;
}

export interface OrganizationMember {
  id: string;
  organizationId: string;
  userId: string;
  role: Role;
  createdAt: string;
}

export interface AuthenticatedActor {
  userId: string;
  organizationId: string;
  role: Role;
}

export interface Project {
  id: string;
  organizationId: string;
  name: string;
  description: string | null;
  primaryCountryCode: string;
  primarySubdivisionCode: string | null;
  affectedCountryCodes: string[];
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentProfileInput {
  name: string;
  description?: string;
  deploymentStatus: DeploymentStatus;
  businessPurpose: string;
  operatorOrganization: string;
  developerProvider?: string;
  deploymentCountries: string[];
  affectedCountries: string[];
  primaryJurisdiction: string;
  jurisdictionSubdivisions: string[];
  agentType: string;
  autonomyLevel: 0 | 1 | 2 | 3 | 4 | 5;
  humanOversightLevel: HumanOversightLevel;
  canCommunicateExternally: boolean;
  canMakeRepresentations: boolean;
  canAcceptTerms: boolean;
  canExecuteTransactions: boolean;
  canSpendMoney: boolean;
  perTransactionLimit?: number;
  aggregateSpendingLimit?: number;
  currency?: string;
  canIssueRefundsOrCredits: boolean;
  canChangePrices: boolean;
  canEnterContracts: boolean;
  canApproveOrRejectPeople: boolean;
  canApproveOrRejectVendors: boolean;
  canAccessPersonalData: boolean;
  canAccessSensitivePersonalData: boolean;
  canAccessConfidentialBusinessData: boolean;
  canAccessRegulatedData: boolean;
  canModifyOrDeleteData: boolean;
  canCreateIntellectualProperty: boolean;
  canPublishContent: boolean;
  canDeployCode: boolean;
  canControlInfrastructure: boolean;
  canHireOrTerminateWorkers: boolean;
  canDelegateToSubAgents: boolean;
  thirdPartyToolsUsed: string[];
  systemsAccessed: string[];
  reversibility: "fully_reversible" | "partially_reversible" | "irreversible" | "unknown";
  loggingLevel: "none" | "basic" | "detailed" | "tamper_evident";
  approvalThresholds: string[];
  emergencyStopMechanism?: string;
  incidentResponseOwner?: string;
  knownLimitations: string[];
  notes?: string;
}

export interface AgentProfile extends AgentProfileInput {
  id: string;
  organizationId: string;
  projectId: string;
  createdAt: string;
  updatedAt: string;
}

export type ExtractionStatus =
  "pending" | "completed" | "completed_with_warnings" | "ocr_required" | "failed";

export interface TextSegment {
  id: string;
  organizationId: string;
  documentId: string;
  pageNumber: number | null;
  sectionHeading: string | null;
  paragraphNumber: number;
  characterStart: number;
  characterEnd: number;
  normalizedText: string;
  originalText: string;
  extractionConfidence: number;
}

export interface DocumentRecord {
  id: string;
  organizationId: string;
  projectId: string;
  uploaderId: string;
  originalFilename: string;
  safeFilename: string;
  mimeType: string;
  size: number;
  checksum: string;
  documentType: DocumentType;
  countryCode: string;
  subdivisionCode: string | null;
  storageKey: string;
  extractionStatus: ExtractionStatus;
  extractionError: string | null;
  extractionWarnings: string[];
  pageCount: number | null;
  extractedText: string;
  segments: TextSegment[];
  retentionStatus: "active" | "scheduled_for_deletion" | "deleted";
  deleteAfter: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EvidenceReference {
  segmentId: string;
  documentId: string;
  pageNumber: number | null;
  excerpt: string;
  characterStart: number;
  characterEnd: number;
}

export interface ClauseDetection {
  category: string;
  evidence: EvidenceReference;
  confidence: number;
  detectorId: string;
  ruleVersion: string;
  explanation: string;
  limitations: string[];
}

export interface Finding {
  id: string;
  organizationId: string;
  analysisId: string;
  projectId: string;
  title: string;
  category: FindingCategory;
  severity: Severity;
  confidence: number;
  status: FindingStatus;
  affectedAgentCapability: string | null;
  affectedDocumentId: string | null;
  clauseCategory: string | null;
  documentFact: string;
  agentProfileFact: string;
  systemInference: string;
  reviewRule: string;
  factualBasis: string;
  analysisExplanation: string;
  evidence: EvidenceReference[];
  applicableUniversalRule: string;
  applicableJurisdictionRule: string | null;
  uncertainty: string;
  limitations: string[];
  recommendedReviewQuestions: string[];
  suggestedProfessionalReviewer:
    "legal_counsel" | "insurance_broker_or_insurer" | "security_or_privacy";
  disclaimer: string;
  ruleVersion: string;
  createdAt: string;
}

export interface ScoreContribution {
  dimension: string;
  points: number;
  maximum: number;
  explanation: string;
}

export interface AttentionScore {
  score: number;
  label: "low_attention" | "moderate_attention" | "high_attention" | "critical_review";
  confidence: number;
  contributions: ScoreContribution[];
}

export interface Analysis {
  id: string;
  organizationId: string;
  projectId: string;
  agentProfileId: string;
  documentIds: string[];
  state: AnalysisState;
  engineVersion: string;
  rulesetVersions: string[];
  jurisdictionPackIds: string[];
  attentionScore: AttentionScore | null;
  warnings: string[];
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface AuditEvent {
  id: string;
  organizationId: string;
  actorId: string;
  resourceType: string;
  resourceId: string;
  action: string;
  requestId: string;
  metadata: Record<string, string | number | boolean | null>;
  createdAt: string;
}

export interface PaginationInput {
  page: number;
  pageSize: number;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
