import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { AnalysisService } from "../analysis/analysis-service.js";
import { loadConfig } from "../config/env.js";
import type { PqSigner } from "../crypto/pq-sign.js";
import { DocumentService } from "../documents/document-service.js";
import { MemoryDocumentStorage } from "../documents/storage.js";
import type { AgentProfileInput, DocumentRecord, Finding } from "../domain/types.js";
import { MemoryStore } from "../persistence/memory-store.js";
import { buildAssurancePack } from "./assurance-pack.js";

// Public SAMPLE Agent Assurance Pack (knock-out 2026-11-16, O-24). Made-up organization, agent, contract and
// insurance text; the REAL clause detectors, gap engine and pack builder run on them entirely in memory (a
// throwaway MemoryStore and MemoryDocumentStorage: nothing reaches the database or disk). The pack carries
// sample: true and a notice inside its hashed, signed content and is signed with this service's real key.
// Cached in memory for the life of the process.

export const SAMPLE_NOTICE =
  "SAMPLE. Made-up organization, agent, contract and insurance text; nobody was reviewed and this is not evidence about anyone. Decision support only: not legal advice, insurance advice or a coverage opinion.";
const SAMPLE_DATE = new Date("2026-11-16T00:00:00Z");

const CONTRACT = `SAMPLE SOFTWARE-ASSISTED ACCOUNTS PAYABLE AGREEMENT - MADE-UP TEXT FOR A PUBLIC SAMPLE ONLY

Authorized Tools and Approval Requirements

Authorized users may use software tools to prepare invoices and payment runs. Software tools may not make a binding commitment. Human approval is required before any commitment and before a transaction above USD 1,000.

Authority to Act

Only an identified human finance manager is authorized to act on behalf of SAMPLE Co when accepting terms or entering into an agreement.

Audit Log and Security

Detailed audit log records must be retained. Information security measures apply to personal data and confidential information processed through the payables service.
`;

const INSURANCE = `SAMPLE TECHNOLOGY ERRORS AND OMISSIONS SUMMARY - MADE-UP TEXT FOR A PUBLIC SAMPLE ONLY

This text was written for a public sample. It is not an insurance policy, binder, certificate, endorsement, or reproduction of standard policy wording.

Professional Services

Professional services means the technology services listed in the made-up schedule when performed by the named insured for a customer. The description does not state whether software-performed or autonomous-agent activity is included.

Limitations

All terms, conditions, exclusions, limits, sublimits, and endorsements in the complete made-up policy would control. This summary cannot establish coverage.
`;

function sampleAgent(): AgentProfileInput {
  return {
    name: "SAMPLE Invoice-Paying Agent",
    description: "Made-up agent that prepares and pays supplier invoices.",
    deploymentStatus: "pilot",
    businessPurpose: "Pay approved supplier invoices (made-up example).",
    operatorOrganization: "SAMPLE Co (example.com)",
    developerProvider: "SAMPLE Agent Works",
    deploymentCountries: ["US"],
    affectedCountries: ["US"],
    primaryJurisdiction: "US",
    jurisdictionSubdivisions: ["US-IL"],
    agentType: "accounts_payable_workflow",
    autonomyLevel: 3,
    humanOversightLevel: "threshold_approval",
    canCommunicateExternally: true,
    canMakeRepresentations: false,
    canAcceptTerms: false,
    canExecuteTransactions: true,
    canSpendMoney: true,
    perTransactionLimit: 5_000,
    aggregateSpendingLimit: 50_000,
    currency: "USD",
    canIssueRefundsOrCredits: false,
    canChangePrices: false,
    canEnterContracts: false,
    canApproveOrRejectPeople: false,
    canApproveOrRejectVendors: false,
    canAccessPersonalData: true,
    canAccessSensitivePersonalData: false,
    canAccessConfidentialBusinessData: true,
    canAccessRegulatedData: false,
    canModifyOrDeleteData: false,
    canCreateIntellectualProperty: false,
    canPublishContent: false,
    canDeployCode: false,
    canControlInfrastructure: false,
    canHireOrTerminateWorkers: false,
    canDelegateToSubAgents: false,
    thirdPartyToolsUsed: ["SAMPLE ERP"],
    systemsAccessed: ["SAMPLE ERP payables"],
    reversibility: "partially_reversible",
    loggingLevel: "detailed",
    approvalThresholds: ["Human approval above USD 1,000"],
    emergencyStopMechanism: "Pause switch in the SAMPLE ERP",
    incidentResponseOwner: "SAMPLE finance manager",
    knownLimitations: ["Made-up example"],
  };
}

export interface SamplePack {
  pack: Record<string, unknown>;
  contentHash: string;
  signature: { value: string; publicKey: string; keyId: string; algorithm: string; standard: string; status: "signed"; signs: string };
}

const cache = new Map<string, SamplePack>();

export async function buildSamplePack(signer: PqSigner): Promise<SamplePack> {
  const hit = cache.get(signer.keyId);
  if (hit) return hit;
  const store = new MemoryStore();
  const config = loadConfig({ NODE_ENV: "test", JWT_SECRET: randomBytes(32).toString("hex"), UPLOAD_DIRECTORY: tmpdir(), LOG_LEVEL: "silent", PERSISTENCE_DRIVER: "memory" });
  const reg = await store.createRegistration({ email: "sample@example.com", name: "SAMPLE", passwordHash: "not-used", organizationName: "SAMPLE Co (example.com)" });
  const orgId = reg.organization.id;
  const project = await store.createProject(orgId, { name: "SAMPLE Invoice Agent Review", description: "Made-up public sample", primaryCountryCode: "US", primarySubdivisionCode: "US-IL", affectedCountryCodes: [] });
  const agent = await store.createAgent(orgId, project.id, sampleAgent());
  const docs = new DocumentService(store, new MemoryDocumentStorage(), config);
  const upload = (filename: string, text: string, documentType: DocumentRecord["documentType"]) =>
    docs.upload({ organizationId: orgId, projectId: project.id, uploaderId: reg.user.id, filename, mimeType: "text/plain", buffer: Buffer.from(text, "utf8"), documentType, countryCode: "US", subdivisionCode: "US-IL" });
  const contract = await upload("sample-contract.txt", CONTRACT, "commercial_contract");
  const insurance = await upload("sample-insurance.txt", INSURANCE, "insurance_policy");
  const analyses = new AnalysisService(store);
  const created = await analyses.create({ organizationId: orgId, projectId: project.id, agentProfileId: agent.id, documentIds: [contract.id, insurance.id] });
  const { analysis, findings } = await analyses.run(orgId, created.id);
  const documents = [contract, insurance].map((d) => d) as DocumentRecord[];
  const built = buildAssurancePack(
    { organizationName: "SAMPLE Co (example.com)", projectName: project.name, agent, analysis, findings: findings as Finding[], documents, now: SAMPLE_DATE, sample: { notice: SAMPLE_NOTICE } },
    signer,
  );
  if (built.signature.status !== "signed") throw new Error("sample pack needs a signing key");
  const out: SamplePack = { pack: built.pack as unknown as Record<string, unknown>, contentHash: built.contentHash, signature: built.signature };
  cache.set(signer.keyId, out);
  return out;
}
