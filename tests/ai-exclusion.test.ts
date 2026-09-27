import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { detectClauses } from "../src/analysis/clause-detector.js";
import { analyzeGaps, findAiExclusions } from "../src/analysis/gap-engine.js";
import type { AgentProfile, DocumentRecord } from "../src/domain/types.js";
import { segmentText } from "../src/documents/extraction.js";
import { selectJurisdictionPacks } from "../src/jurisdictions/packs.js";
import { agentInput } from "./helpers.js";

const agent: AgentProfile = {
  ...agentInput(),
  id: randomUUID(),
  organizationId: "org",
  projectId: "project",
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};

function doc(text: string, documentType: DocumentRecord["documentType"] = "insurance_policy"): DocumentRecord {
  const id = randomUUID();
  return {
    id, organizationId: "org", projectId: "project", uploaderId: "user", originalFilename: "fictional.txt", safeFilename: "fictional.txt",
    mimeType: "text/plain", size: Buffer.byteLength(text), checksum: "fictional-checksum", documentType, countryCode: "US", subdivisionCode: null,
    storageKey: "org/project/doc.txt", extractionStatus: "completed", extractionError: null, extractionWarnings: [], pageCount: null,
    extractedText: text, segments: segmentText("org", id, text), retentionStatus: "active", deleteAfter: null, deletedAt: null,
    createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
  };
}

function aiExclusionFindings(...documents: DocumentRecord[]) {
  return analyzeGaps({
    organizationId: "org", projectId: "project", analysisId: "analysis", agent, documents,
    detections: new Map(documents.map((d) => [d.id, detectClauses(d)])),
    packSelection: selectJurisdictionPacks("US"),
  }).filter((f) => f.reviewRule === "GLOBAL.INSURANCE_AI_EXCLUSION_PRESENT");
}

const POLICY_WITH_FORM =
  "Commercial General Liability Coverage Part\n\nForms and endorsements attached: CG 00 01 04 13; CG 40 47 01 26 Exclusion - Generative Artificial Intelligence; IL 00 17.";

describe("AI exclusion endorsements in insurance documents", () => {
  it("flags a policy that lists ISO form CG 40 47, citing the exact text", () => {
    const policy = doc(POLICY_WITH_FORM);
    const [finding] = aiExclusionFindings(policy);
    expect(finding).toBeDefined();
    expect(finding!.title).toContain("CG 40 47");
    expect(finding!.severity).toBe("high");
    expect(finding!.category).toBe("potential_exclusion_relevance");
    expect(finding!.evidence.length).toBeGreaterThan(0);
    for (const evidence of finding!.evidence) expect(policy.extractedText).toContain(evidence.excerpt);
    expect(finding!.evidence.some((e) => e.excerpt.includes("CG 40 47"))).toBe(true);
    expect(finding!.recommendedReviewQuestions.join(" ")).toMatch(/buy-back|sublimit/);
  });

  it("recognizes the form numbers written without spaces and all three forms", () => {
    expect(findAiExclusions(doc("Endorsements: CG4048 and CG 35 08 apply.")).forms).toEqual(["CG 40 48", "CG 35 08"]);
  });

  it("flags a carrier's own AI exclusion wording without a form number", () => {
    const [finding] = aiExclusionFindings(doc("Exclusion - Artificial Intelligence. This insurance does not apply to bodily injury arising out of AI output."));
    expect(finding).toBeDefined();
    expect(finding!.title).toBe("Insurance document contains artificial-intelligence exclusion wording");
    expect(finding!.confidence).toBeLessThan(0.9);
  });

  it("does not flag a policy that mentions AI without excluding it", () => {
    expect(aiExclusionFindings(doc("Covered services include artificial intelligence consulting provided by the insured."))).toHaveLength(0);
  });

  it("does not join an exclusion and an unrelated AI mention across sentences", () => {
    expect(aiExclusionFindings(doc("Standard exclusions apply. The insured develops artificial intelligence software."))).toHaveLength(0);
  });

  it("does not treat longer numbers as the form", () => {
    expect(findAiExclusions(doc("Policy reference CG 40 471 and CG 40 4712.")).forms).toEqual([]);
  });

  it("only inspects insurance documents, not contracts", () => {
    expect(aiExclusionFindings(doc(POLICY_WITH_FORM, "commercial_contract"))).toHaveLength(0);
  });

  it("is deterministic (same finding id and evidence for the same input)", () => {
    const policy = doc(POLICY_WITH_FORM);
    const stable = (f: ReturnType<typeof aiExclusionFindings>[number]) => ({ id: f.id, title: f.title, evidence: f.evidence });
    expect(aiExclusionFindings(policy).map(stable)).toEqual(aiExclusionFindings(policy).map(stable));
  });
});
