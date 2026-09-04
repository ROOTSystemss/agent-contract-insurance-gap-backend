import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { classifyInsuranceDocument, detectClauses } from "../src/analysis/clause-detector.js";
import { analyzeGaps } from "../src/analysis/gap-engine.js";
import { calculateAttentionScore } from "../src/analysis/scoring.js";
import type { AgentProfile, DocumentRecord } from "../src/domain/types.js";
import { segmentText } from "../src/documents/extraction.js";
import { selectJurisdictionPacks } from "../src/jurisdictions/packs.js";
import { agentInput } from "./helpers.js";

function agent(overrides = {}): AgentProfile {
  return {
    ...agentInput(),
    id: randomUUID(),
    organizationId: "org",
    projectId: "project",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

function document(
  text: string,
  documentType: DocumentRecord["documentType"] = "commercial_contract",
): DocumentRecord {
  const id = randomUUID();
  return {
    id,
    organizationId: "org",
    projectId: "project",
    uploaderId: "user",
    originalFilename: "fictional.txt",
    safeFilename: "fictional.txt",
    mimeType: "text/plain",
    size: Buffer.byteLength(text),
    checksum: "fictional-checksum",
    documentType,
    countryCode: "US",
    subdivisionCode: null,
    storageKey: "org/project/doc.txt",
    extractionStatus: "completed",
    extractionError: null,
    extractionWarnings: [],
    pageCount: null,
    extractedText: text,
    segments: segmentText("org", id, text),
    retentionStatus: "active",
    deleteAfter: null,
    deletedAt: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

describe("deterministic analysis", () => {
  it("returns exact source evidence and stable detections", () => {
    const source =
      "Authority to Act\n\nAuthorized users require prior written approval before making a commitment.";
    const record = document(source);
    const first = detectClauses(record);
    const second = detectClauses(record);
    expect(first).toEqual(second);
    expect(first.length).toBeGreaterThan(0);
    expect(first.every((item) => source.includes(item.evidence.excerpt))).toBe(true);
  });

  it("produces identical scores for identical inputs", () => {
    const profile = agent();
    const record = document(
      "Human approval and audit log records apply to professional services and personal data.",
    );
    const detections = detectClauses(record);
    const input = {
      agent: profile,
      documents: [record],
      detections,
      jurisdictionUniversalOnly: true,
    };
    expect(calculateAttentionScore(input)).toEqual(calculateAttentionScore(input));
  });

  it("raises autonomy attention and lowers oversight attention with stronger approval", () => {
    const base = { documents: [], detections: [], jurisdictionUniversalOnly: true };
    const low = calculateAttentionScore({ ...base, agent: agent({ autonomyLevel: 1 }) });
    const high = calculateAttentionScore({ ...base, agent: agent({ autonomyLevel: 5 }) });
    expect(
      high.contributions.find((item) => item.dimension === "autonomy")!.points,
    ).toBeGreaterThan(low.contributions.find((item) => item.dimension === "autonomy")!.points);
    const controlled = calculateAttentionScore({
      ...base,
      agent: agent({ humanOversightLevel: "pre_action_approval" }),
    });
    const uncontrolled = calculateAttentionScore({
      ...base,
      agent: agent({ humanOversightLevel: "none" }),
    });
    expect(
      controlled.contributions.find((item) => item.dimension === "human_oversight")!.points,
    ).toBeLessThan(
      uncontrolled.contributions.find((item) => item.dimension === "human_oversight")!.points,
    );
    expect(controlled.score).toBeLessThan(uncontrolled.score);
  });

  it("classifies insurance categories with supporting exact evidence", () => {
    const record = document(
      "Fictional Technology Errors and Omissions Policy. Technology services include procurement software support.",
      "insurance_policy",
    );
    const classification = classifyInsuranceDocument(record);
    expect(classification.category).toBe("technology_errors_and_omissions");
    expect(classification.evidence.length).toBeGreaterThan(0);
    expect(record.extractedText).toContain(classification.evidence[0]!.excerpt);
  });

  it("increases uncertainty for missing documents and unsupported jurisdictions", () => {
    const profile = agent({ primaryJurisdiction: "NZ" });
    const selection = selectJurisdictionPacks("NZ");
    const score = calculateAttentionScore({
      agent: profile,
      documents: [],
      detections: [],
      jurisdictionUniversalOnly: true,
    });
    expect(selection.status).toBe("universal_only");
    expect(selection.warnings[0]).toContain("universal structural");
    expect(score.confidence).toBeLessThan(55);
    expect(
      score.contributions.find((item) => item.dimension === "missing_documents")!.points,
    ).toBeGreaterThan(0);
  });

  it("separates facts, inference, rules, and review questions", () => {
    const profile = agent({ canEnterContracts: true, primaryJurisdiction: "US" });
    const record = document(
      "This fictional agreement describes ordinary services but contains no autonomous-agent terms.",
    );
    const detections = new Map([[record.id, detectClauses(record)]]);
    const findings = analyzeGaps({
      organizationId: "org",
      projectId: "project",
      analysisId: "analysis",
      agent: profile,
      documents: [record],
      detections,
      packSelection: selectJurisdictionPacks("US"),
    });
    const authority = findings.find((finding) => finding.category === "authority_mismatch");
    expect(authority?.documentFact).toBeTruthy();
    expect(authority?.agentProfileFact).toContain("declared");
    expect(authority?.systemInference).toBeTruthy();
    expect(authority?.reviewRule).toContain("GLOBAL");
    expect(authority?.recommendedReviewQuestions.length).toBeGreaterThan(0);
    expect(findings.every((finding) => finding.disclaimer.includes("not legal advice"))).toBe(true);
  });

  it("flags a declared transaction limit above detected human approval language", () => {
    const profile = agent({ canSpendMoney: true, perTransactionLimit: 5000, currency: "USD" });
    const record = document(
      "Approval Requirements\n\nHuman approval is required before any commitment above USD 1,000.",
    );
    const findings = analyzeGaps({
      organizationId: "org",
      projectId: "project",
      analysisId: "analysis",
      agent: profile,
      documents: [record],
      detections: new Map([[record.id, detectClauses(record)]]),
      packSelection: selectJurisdictionPacks("US"),
    });
    expect(findings.some((finding) => finding.category === "transaction_limit_mismatch")).toBe(
      true,
    );
  });
});
