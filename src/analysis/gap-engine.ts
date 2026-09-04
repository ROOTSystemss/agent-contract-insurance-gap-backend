import { createHash } from "node:crypto";
import type {
  AgentProfile,
  ClauseDetection,
  DocumentRecord,
  Finding,
  FindingCategory,
  Severity,
} from "../domain/types.js";
import { CANONICAL_DISCLAIMER } from "../shared/disclaimer.js";
import type { PackSelection } from "../jurisdictions/packs.js";

export const ENGINE_VERSION = "gap-engine@1.0.0";
export const UNIVERSAL_RULE_VERSION = "universal-gap-rules@1.0.0";

interface FindingDraft {
  key: string;
  title: string;
  category: FindingCategory;
  severity: Severity;
  confidence: number;
  capability: string | null;
  document: DocumentRecord | null;
  clauseCategory: string | null;
  documentFact: string;
  agentFact: string;
  inference: string;
  rule: string;
  evidence: ClauseDetection["evidence"][];
  uncertainty: string;
  limitations: string[];
  questions: string[];
  reviewer: Finding["suggestedProfessionalReviewer"];
}

const capabilityRules: Array<{
  capability: keyof AgentProfile;
  label: string;
  clauses: string[];
  category: FindingCategory;
  severity: Severity;
  reviewer: Finding["suggestedProfessionalReviewer"];
  question: string;
}> = [
  {
    capability: "canEnterContracts",
    label: "authority to enter contracts",
    clauses: ["authority_to_act", "contract_formation"],
    category: "authority_mismatch",
    severity: "high",
    reviewer: "legal_counsel",
    question:
      "Ask counsel whether the agreement should expressly address autonomous software entering or accepting contracts.",
  },
  {
    capability: "canAcceptTerms",
    label: "authority to accept terms",
    clauses: ["contract_formation", "electronic_transactions"],
    category: "authority_mismatch",
    severity: "high",
    reviewer: "legal_counsel",
    question:
      "Ask counsel whether machine acceptance of electronic terms is within the intended authority framework.",
  },
  {
    capability: "canMakeRepresentations",
    label: "authority to make external representations",
    clauses: ["representations_commitments", "authority_to_act"],
    category: "authority_mismatch",
    severity: "moderate",
    reviewer: "legal_counsel",
    question:
      "Ask counsel whether authorized representatives should expressly include or exclude autonomous software agents.",
  },
  {
    capability: "canDelegateToSubAgents",
    label: "sub-agent delegation",
    clauses: ["agency_and_delegation", "subcontractors"],
    category: "sub_agent_gap",
    severity: "high",
    reviewer: "legal_counsel",
    question:
      "Ask counsel whether delegation restrictions contemplate software-created or software-directed sub-agents.",
  },
  {
    capability: "canAccessPersonalData",
    label: "personal-data access",
    clauses: ["privacy_data_protection", "data_use"],
    category: "privacy_gap",
    severity: "moderate",
    reviewer: "security_or_privacy",
    question:
      "Ask privacy counsel whether agent access and processing purposes are expressly documented.",
  },
  {
    capability: "canAccessSensitivePersonalData",
    label: "sensitive personal-data access",
    clauses: ["privacy_data_protection", "security_obligations"],
    category: "privacy_gap",
    severity: "high",
    reviewer: "security_or_privacy",
    question:
      "Ask privacy counsel whether sensitive-data handling by autonomous systems is clearly authorized and controlled.",
  },
  {
    capability: "canAccessConfidentialBusinessData",
    label: "confidential business-data access",
    clauses: ["confidentiality", "security_obligations"],
    category: "confidentiality_gap",
    severity: "moderate",
    reviewer: "legal_counsel",
    question:
      "Ask counsel whether confidentiality duties address agent access, outputs, and downstream tools.",
  },
  {
    capability: "canAccessRegulatedData",
    label: "regulated-data access",
    clauses: ["privacy_data_protection", "security_obligations", "regulatory_cooperation"],
    category: "data_access_gap",
    severity: "high",
    reviewer: "security_or_privacy",
    question:
      "Ask qualified privacy and regulatory professionals whether agent processing is within documented controls.",
  },
  {
    capability: "canCreateIntellectualProperty",
    label: "creation of intellectual property",
    clauses: ["intellectual_property_ownership", "generated_content"],
    category: "intellectual_property_gap",
    severity: "moderate",
    reviewer: "legal_counsel",
    question:
      "Ask counsel how ownership, licensing, and infringement review apply to agent-generated material.",
  },
  {
    capability: "canCommunicateExternally",
    label: "external communication",
    clauses: ["recordkeeping", "human_oversight"],
    category: "recordkeeping_gap",
    severity: "low",
    reviewer: "legal_counsel",
    question:
      "Ask whether external agent communications require retention, approval, or disclosure controls.",
  },
];

function stableId(analysisId: string, key: string): string {
  return createHash("sha256").update(`${analysisId}:${key}`).digest("hex").slice(0, 32);
}

function buildFinding(
  organizationId: string,
  projectId: string,
  analysisId: string,
  draft: FindingDraft,
): Finding {
  const timestamp = new Date().toISOString();
  return {
    id: stableId(analysisId, draft.key),
    organizationId,
    analysisId,
    projectId,
    title: draft.title,
    category: draft.category,
    severity: draft.severity,
    confidence: draft.confidence,
    status: "open",
    affectedAgentCapability: draft.capability,
    affectedDocumentId: draft.document?.id ?? null,
    clauseCategory: draft.clauseCategory,
    documentFact: draft.documentFact,
    agentProfileFact: draft.agentFact,
    systemInference: draft.inference,
    reviewRule: draft.rule,
    factualBasis: `${draft.documentFact} ${draft.agentFact}`,
    analysisExplanation: draft.inference,
    evidence: draft.evidence,
    applicableUniversalRule: draft.rule,
    applicableJurisdictionRule: null,
    uncertainty: draft.uncertainty,
    limitations: draft.limitations,
    recommendedReviewQuestions: draft.questions,
    suggestedProfessionalReviewer: draft.reviewer,
    disclaimer: CANONICAL_DISCLAIMER,
    ruleVersion: UNIVERSAL_RULE_VERSION,
    createdAt: timestamp,
  };
}

export function analyzeGaps(input: {
  organizationId: string;
  projectId: string;
  analysisId: string;
  agent: AgentProfile;
  documents: DocumentRecord[];
  detections: Map<string, ClauseDetection[]>;
  packSelection: PackSelection;
}): Finding[] {
  const findings: Finding[] = [];
  const contractDocuments = input.documents.filter(
    (document) => !document.documentType.startsWith("insurance_"),
  );
  const insuranceDocuments = input.documents.filter((document) =>
    document.documentType.startsWith("insurance_"),
  );
  const allDetections = [...input.detections.values()].flat();
  const detectedCategories = new Set(allDetections.map((detection) => detection.category));

  if (input.documents.length === 0) {
    findings.push(
      buildFinding(input.organizationId, input.projectId, input.analysisId, {
        key: "missing-all-documents",
        title: "No documents were available for comparison",
        category: "missing_document",
        severity: "high",
        confidence: 1,
        capability: null,
        document: null,
        clauseCategory: null,
        documentFact: "No contract or insurance document was supplied.",
        agentFact: `The profile declares autonomy level ${input.agent.autonomyLevel}.`,
        inference:
          "A document-to-capability comparison cannot be completed without source documents.",
        rule: "GLOBAL.MISSING_DOCUMENTS",
        evidence: [],
        uncertainty: "Document content is unknown.",
        limitations: [
          "Absence of an uploaded document does not establish absence of relevant language elsewhere.",
        ],
        questions: [
          "Provide the complete contracts, schedules, policies, and endorsements relevant to the agent.",
        ],
        reviewer: "legal_counsel",
      }),
    );
  }

  for (const rule of capabilityRules) {
    if (input.agent[rule.capability] !== true) continue;
    const matching = allDetections.filter((detection) => rule.clauses.includes(detection.category));
    if (matching.length > 0) continue;
    findings.push(
      buildFinding(input.organizationId, input.projectId, input.analysisId, {
        key: `absent:${String(rule.capability)}`,
        title: `No responsive language located for ${rule.label}`,
        category: rule.category,
        severity: rule.severity,
        confidence: input.documents.length ? 0.78 : 0.45,
        capability: String(rule.capability),
        document: contractDocuments[0] ?? null,
        clauseCategory: rule.clauses[0] ?? null,
        documentFact: `No responsive ${rule.clauses.join(" or ")} language was located in the extracted documents.`,
        agentFact: `The customer declared that the agent has ${rule.label}.`,
        inference:
          "The declared capability may be broader than the authority or controls clearly described in the supplied documents.",
        rule: `GLOBAL.CAPABILITY_LANGUAGE.${String(rule.capability).toUpperCase()}`,
        evidence: [],
        uncertainty:
          "Relevant language may exist in documents not supplied, scanned material, or wording not recognized by deterministic patterns.",
        limitations: [
          "No quotation is provided because no responsive language was detected.",
          "This is not a conclusion about authority or enforceability.",
        ],
        questions: [rule.question],
        reviewer: rule.reviewer,
      }),
    );
  }

  if (
    input.agent.autonomyLevel >= 3 &&
    ["exception_only", "none"].includes(input.agent.humanOversightLevel)
  ) {
    const approvalEvidence = allDetections
      .filter((detection) => detection.category === "approval_requirements")
      .map((detection) => detection.evidence);
    findings.push(
      buildFinding(input.organizationId, input.projectId, input.analysisId, {
        key: "oversight-autonomy",
        title: "Material autonomy has limited declared human oversight",
        category: "autonomy_mismatch",
        severity: input.agent.autonomyLevel >= 4 ? "high" : "moderate",
        confidence: 0.9,
        capability: "autonomyLevel",
        document: null,
        clauseCategory: "human_oversight",
        documentFact: approvalEvidence.length
          ? "Approval-related language was detected in supplied material."
          : "No responsive human-oversight language was located.",
        agentFact: `Autonomy is ${input.agent.autonomyLevel}/5 and oversight is ${input.agent.humanOversightLevel}.`,
        inference:
          "Material agent actions may occur without a clearly aligned pre-action human control.",
        rule: "GLOBAL.AUTONOMY_OVERSIGHT_ALIGNMENT",
        evidence: approvalEvidence,
        uncertainty:
          "Operational controls outside the profile and supplied documents may affect this observation.",
        limitations: ["The autonomy model is an attention framework, not a legal classification."],
        questions: [
          "Ask operational and legal reviewers whether approval controls match every consequential agent action.",
        ],
        reviewer: "legal_counsel",
      }),
    );
  }

  if (input.agent.canSpendMoney && input.agent.perTransactionLimit !== undefined) {
    for (const document of contractDocuments) {
      const thresholdMatch = document.extractedText.match(/(?:USD|\$)\s*([\d,]+(?:\.\d{1,2})?)/i);
      if (!thresholdMatch?.[1]) continue;
      const documentedThreshold = Number(thresholdMatch[1].replaceAll(",", ""));
      if (
        !Number.isFinite(documentedThreshold) ||
        input.agent.perTransactionLimit <= documentedThreshold
      )
        continue;
      const approvalDetection = (input.detections.get(document.id) ?? []).find(
        (detection) => detection.category === "approval_requirements",
      );
      findings.push(
        buildFinding(input.organizationId, input.projectId, input.analysisId, {
          key: `transaction-limit:${document.id}`,
          title: "Configured spending authority exceeds a detected approval threshold",
          category: "transaction_limit_mismatch",
          severity: "high",
          confidence: approvalDetection ? 0.86 : 0.68,
          capability: "perTransactionLimit",
          document,
          clauseCategory: "approval_requirements",
          documentFact: `A potential approval threshold of ${thresholdMatch[0]} was detected in the supplied contract.`,
          agentFact: `The declared per-transaction limit is ${input.agent.currency ?? "currency unspecified"} ${input.agent.perTransactionLimit}.`,
          inference:
            "The configured transaction limit appears broader than the approval boundary described in this contract.",
          rule: "GLOBAL.TRANSACTION_LIMIT_ALIGNMENT",
          evidence: approvalDetection ? [approvalDetection.evidence] : [],
          uncertainty:
            "The detected amount may apply to a different condition; complete contextual professional review is required.",
          limitations: [
            "Numeric proximity is a deterministic attention signal, not a legal interpretation of the threshold.",
          ],
          questions: [
            "Ask counsel and the business owner whether the agent's technical spending limit must be reduced to align with the contractual approval threshold.",
          ],
          reviewer: "legal_counsel",
        }),
      );
    }
  }

  if (insuranceDocuments.length === 0) {
    findings.push(
      buildFinding(input.organizationId, input.projectId, input.analysisId, {
        key: "missing-insurance",
        title: "No insurance document was supplied",
        category: "missing_document",
        severity: "moderate",
        confidence: 1,
        capability: null,
        document: null,
        clauseCategory: "covered_acts_services",
        documentFact:
          "No uploaded document was classified by the customer as an insurance document.",
        agentFact: `The agent is configured at autonomy level ${input.agent.autonomyLevel}.`,
        inference:
          "Potential insurance-language ambiguities cannot be screened without complete policy material and endorsements.",
        rule: "GLOBAL.INSURANCE_DOCUMENT_REQUIRED",
        evidence: [],
        uncertainty: "The customer may have responsive insurance material that was not uploaded.",
        limitations: ["This does not imply that coverage exists or does not exist."],
        questions: [
          "Ask the broker or insurer which complete policies, schedules, and endorsements should be reviewed.",
        ],
        reviewer: "insurance_broker_or_insurer",
      }),
    );
  } else if (
    !detectedCategories.has("definitions_automation_ai") ||
    !detectedCategories.has("covered_acts_services")
  ) {
    for (const document of insuranceDocuments) {
      const relevant = (input.detections.get(document.id) ?? []).filter((detection) =>
        [
          "covered_acts_services",
          "professional_services",
          "technology_services",
          "definitions_automation_ai",
        ].includes(detection.category),
      );
      findings.push(
        buildFinding(input.organizationId, input.projectId, input.analysisId, {
          key: `insurance-definition:${document.id}`,
          title: "Potential coverage ambiguity detected",
          category: "insurance_definition_gap",
          severity: "high",
          confidence: 0.72,
          capability: "autonomyLevel",
          document,
          clauseCategory: "definitions_automation_ai",
          documentFact: relevant.length
            ? "Potentially responsive services language was detected, but autonomous-agent definition language was not clearly located."
            : "No responsive autonomous-agent or covered-services language was located.",
          agentFact: `The agent is configured at autonomy level ${input.agent.autonomyLevel}.`,
          inference:
            "The supplied insurance language may not clearly address software-performed or autonomous-agent activity.",
          rule: "GLOBAL.INSURANCE_ACTOR_AND_SERVICES_CLARITY",
          evidence: relevant.map((detection) => detection.evidence),
          uncertainty:
            "Coverage depends on complete policy language, endorsements, facts, governing law, and professional interpretation.",
          limitations: [
            "This is not a coverage determination.",
            "No standard policy wording is reproduced or assumed.",
          ],
          questions: [
            "Ask the broker or insurer whether agent-initiated activity falls within the described insured actors and services.",
          ],
          reviewer: "insurance_broker_or_insurer",
        }),
      );
    }
  }

  if (input.packSelection.status === "universal_only") {
    findings.push(
      buildFinding(input.organizationId, input.projectId, input.analysisId, {
        key: "jurisdiction-universal-only",
        title: "Selected jurisdiction has universal structural support only",
        category: "jurisdiction_support_limitation",
        severity: "informational",
        confidence: 1,
        capability: null,
        document: null,
        clauseCategory: null,
        documentFact: `No verified localized pack was applied for ${input.agent.primaryJurisdiction}.`,
        agentFact: `The profile identifies ${input.agent.primaryJurisdiction} as its primary jurisdiction.`,
        inference:
          "The analysis identifies structural gaps only and cannot apply localized legal or insurance rules.",
        rule: "GLOBAL.JURISDICTION_FALLBACK",
        evidence: [],
        uncertainty:
          "Localized rules and professional interpretation may materially change the review.",
        limitations: input.packSelection.warnings,
        questions: [
          "Ask qualified local counsel and licensed insurance professionals to review jurisdiction-specific implications.",
        ],
        reviewer: "legal_counsel",
      }),
    );
  }

  return findings;
}
