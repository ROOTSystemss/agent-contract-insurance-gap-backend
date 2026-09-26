import { createHash } from "node:crypto";
import type { Analysis, AgentProfile, DocumentRecord, Finding, Severity } from "../domain/types.js";
import { ALL_CAPABILITIES, type Reconciliation } from "../authority/certificate.js";
import { CANONICAL_DISCLAIMER } from "../shared/disclaimer.js";

// The Agent Assurance Pack: one fingerprinted summary of "what this agent is authorized to do,
// what the contracts and insurance say about it, and where the gaps are", for handing to a
// broker, auditor, customer or lawyer.
//
// Data minimization: the pack holds metadata only. It never contains contract text, evidence
// excerpts or the findings' explanations; documents appear only as their filename-free SHA-256
// checksum, so a reader can confirm WHICH document versions were analyzed without seeing them.
//
// The pack has a contentHash (SHA-256 of its canonical JSON). Anchor it by submitting that hash
// as a decision to Trust Proof (POST /api/v1/decisions), where named people sign it and it joins
// a tamper-evident chain. This module only builds and checks the fingerprint.

export const ASSURANCE_PACK_SCHEMA = "rootsystems.agent-assurance-pack.v1";

const SEVERITIES: Severity[] = ["critical", "high", "moderate", "low", "informational"];

// Deterministic JSON: object keys sorted recursively, so key order can never change the hash.
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function hashPack(pack: unknown): string {
  return createHash("sha256").update(canonicalJson(pack), "utf8").digest("hex");
}

export interface AssurancePackInput {
  organizationName: string;
  projectName: string;
  agent: AgentProfile;
  analysis: Analysis;
  findings: Finding[];
  documents: DocumentRecord[];
  certificate?: Reconciliation | null;
  now?: Date;
}

export function buildAssurancePack(input: AssurancePackInput) {
  const { agent, analysis, findings } = input;
  const counts: Record<string, number> = {};
  for (const severity of SEVERITIES) counts[severity] = findings.filter((f) => f.severity === severity).length;

  const pack = {
    schema: ASSURANCE_PACK_SCHEMA,
    generatedAt: (input.now ?? new Date()).toISOString(),
    organization: input.organizationName,
    project: input.projectName,
    agent: {
      id: agent.id,
      name: agent.name,
      deploymentStatus: agent.deploymentStatus,
      autonomyLevel: agent.autonomyLevel,
      humanOversightLevel: agent.humanOversightLevel,
      loggingLevel: agent.loggingLevel,
      reversibility: agent.reversibility,
      capabilities: ALL_CAPABILITIES.filter((key) => agent[key] === true),
      perTransactionLimit: agent.perTransactionLimit ?? null,
      aggregateSpendingLimit: agent.aggregateSpendingLimit ?? null,
      currency: agent.currency ?? null,
      emergencyStopMechanismDeclared: Boolean(agent.emergencyStopMechanism),
      incidentResponseOwnerDeclared: Boolean(agent.incidentResponseOwner),
    },
    analysis: {
      id: analysis.id,
      state: analysis.state,
      engineVersion: analysis.engineVersion,
      rulesetVersions: analysis.rulesetVersions,
      jurisdictionPackIds: analysis.jurisdictionPackIds,
      attentionScore: analysis.attentionScore
        ? {
            score: analysis.attentionScore.score,
            label: analysis.attentionScore.label,
            confidence: analysis.attentionScore.confidence,
          }
        : null,
      completedAt: analysis.completedAt,
      warnings: analysis.warnings,
    },
    documents: input.documents
      .map((d) => ({ documentType: d.documentType, countryCode: d.countryCode, checksumSha256: d.checksum }))
      .sort((a, b) => (a.checksumSha256 < b.checksumSha256 ? -1 : 1)),
    findings: {
      total: findings.length,
      bySeverity: counts,
      items: findings.map((f) => ({
        id: f.id,
        title: f.title,
        category: f.category,
        severity: f.severity,
        status: f.status,
        confidence: f.confidence,
        affectedAgentCapability: f.affectedAgentCapability,
        clauseCategory: f.clauseCategory,
        suggestedProfessionalReviewer: f.suggestedProfessionalReviewer,
        ruleVersion: f.ruleVersion,
      })),
      unresolvedHighOrCritical: findings.filter(
        (f) => (f.severity === "high" || f.severity === "critical") && (f.status === "open" || f.status === "under_review"),
      ).length,
    },
    authorityCertificate: input.certificate
      ? {
          verifiedWithAuthorityAtlas: true,
          agentId: input.certificate.certificate.agentId,
          issuedBy: input.certificate.certificate.organization,
          issuerOrganizationVerified: input.certificate.certificate.organizationVerified === true,
          permissions: input.certificate.certificate.permissions,
          limits: input.certificate.certificate.limits,
          issuedAt: input.certificate.certificate.issuedAt,
          expiresAt: input.certificate.certificate.expiresAt,
          profileCoversCertificate: input.certificate.profileCoversCertificate,
          differences: input.certificate.differences.map((d) => ({
            kind: d.kind,
            severity: d.severity,
            capability: d.capability ?? null,
          })),
          unmappedPermissions: input.certificate.derived.unmappedPermissions,
        }
      : null,
    limitations: [
      "Automated informational review; not legal advice, insurance advice or a coverage opinion.",
      "Contains metadata only: no contract text, evidence excerpts or findings explanations.",
      "The agent profile and any amounts are declared by the organization, not independently observed.",
      "An authority certificate proves that the holder of an Authority Atlas account claiming the named organization authorized the agent; the organization name is not independently verified.",
    ],
    disclaimer: CANONICAL_DISCLAIMER,
  };

  return {
    pack,
    contentHash: hashPack(pack),
    hashAlgorithm: "sha256",
    canonicalization: "JSON with object keys sorted recursively; UTF-8; no whitespace",
  };
}

// Recomputes the fingerprint of a pack a person is holding and compares it to the hash they were
// given. This proves the pack is unchanged since it was built, not that its contents are true.
export function verifyAssurancePack(pack: unknown, contentHash: string): { valid: boolean; computedHash: string } {
  const computedHash = hashPack(pack);
  return { valid: computedHash === contentHash.toLowerCase(), computedHash };
}
