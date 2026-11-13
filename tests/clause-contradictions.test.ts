import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { findContradictions, findRestrictions, RESTRICTION_PATTERNS } from "../src/analysis/clause-library.js";
import { detectClauses } from "../src/analysis/clause-detector.js";
import { analyzeGaps } from "../src/analysis/gap-engine.js";
import type { AgentProfile, DocumentRecord } from "../src/domain/types.js";
import { segmentText } from "../src/documents/extraction.js";
import { selectJurisdictionPacks } from "../src/jurisdictions/packs.js";
import { agentInput } from "./helpers.js";

// Fictional test case: Lemon Industries and its Invoice Bot.
function doc(text: string, documentType: DocumentRecord["documentType"]): DocumentRecord {
  const id = randomUUID();
  return {
    id, organizationId: "org", projectId: "project", uploaderId: "user", originalFilename: "fictional.txt", safeFilename: "fictional.txt",
    mimeType: "text/plain", size: Buffer.byteLength(text), checksum: "fictional-checksum", documentType, countryCode: "US", subdivisionCode: null,
    storageKey: "org/project/doc.txt", extractionStatus: "completed", extractionError: null, extractionWarnings: [], pageCount: null,
    extractedText: text, segments: segmentText("org", id, text), retentionStatus: "active", deleteAfter: null, deletedAt: null,
    createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
  };
}

const LEMON_CONTRACT = [
  "Master Services Agreement between Lemon Industries and Client.",
  "4.2 Credits. Any credit or refund issued to the Client requires finance approval before it is applied to an invoice.",
  "6.1 Statements. Only authorized personnel of Lemon Industries may make pricing statements or commitments to the Client.",
  "9.3 Personal data. Lemon Industries shall keep a record of every access to the Client's personal data.",
].join("\n\n");

const LEMON_POLICY = [
  "Technology Errors and Omissions Policy issued to Lemon Industries.",
  "Exclusions. This policy excludes loss arising from automated systems acting without prior human approval.",
].join("\n\n");

const invoiceBot = (over: Partial<AgentProfile> = {}): AgentProfile => ({
  ...agentInput({
    name: "Invoice Bot",
    businessPurpose: "Answers invoice questions and issues small refunds and credits",
    operatorOrganization: "Lemon Industries (fictional)",
    autonomyLevel: 3,
    humanOversightLevel: "threshold_approval",
    canCommunicateExternally: true,
    canMakeRepresentations: true,
    canIssueRefundsOrCredits: true,
    canSpendMoney: false,
    canExecuteTransactions: true,
    perTransactionLimit: 500,
    currency: "USD",
    canAccessPersonalData: true,
    loggingLevel: "basic",
    approvalThresholds: ["Refunds and credits up to USD 500 without approval"],
  }),
  id: randomUUID(), organizationId: "org", projectId: "project", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
  ...over,
});

function run(agent: AgentProfile, documents: DocumentRecord[]) {
  return analyzeGaps({
    organizationId: "org", projectId: "project", analysisId: "analysis", agent, documents,
    detections: new Map(documents.map((d) => [d.id, detectClauses(d)])), packSelection: selectJurisdictionPacks("US"),
  }).filter((f) => f.reviewRule.startsWith("BM.CONTRADICTION."));
}

describe("BM clause library: restriction patterns", () => {
  const cases: Array<[string, string]> = [
    ["approval_required", "Every refund must be approved by the controller."],
    ["written_approval", "No subcontractor may be used without prior written approval of the Client."],
    ["authorized_personnel_only", "Only authorized personnel may sign purchase orders."],
    ["prohibition", "The Supplier is prohibited from offering discounts to resellers."],
    ["spending_limit", "Purchases above $1,000 need two signatures."],
    ["access_record", "The processor shall keep a log of each access to personal data."],
  ];
  for (const [kind, text] of cases) {
    it(`matches ${kind}`, () => {
      expect(findRestrictions(doc(text, "commercial_contract")).map((r) => r.kind)).toContain(kind);
    });
  }
  it("matches an automated-systems exclusion only in insurance documents", () => {
    const text = "This insurance excludes claims arising from software or automated systems.";
    expect(findRestrictions(doc(text, "insurance_policy")).map((r) => r.kind)).toContain("automation_exclusion");
    expect(findRestrictions(doc(text, "commercial_contract")).map((r) => r.kind)).not.toContain("automation_exclusion");
  });
  it("covers every requested pattern family", () => {
    expect(RESTRICTION_PATTERNS.map((p) => p.kind).sort()).toEqual(["access_record", "approval_required", "authorized_personnel_only", "automation_exclusion", "prohibition", "spending_limit", "written_approval"]);
  });
});

describe("Lemon Industries / Invoice Bot contradictions", () => {
  const contract = doc(LEMON_CONTRACT, "master_services_agreement");
  const policy = doc(LEMON_POLICY, "insurance_policy");
  const findings = run(invoiceBot(), [contract, policy]);

  it("raises at least 4 contradiction findings", () => {
    expect(findings.length).toBeGreaterThanOrEqual(4);
  });

  it("flags the credit/approval contradiction, quoting the clause and the capability", () => {
    const f = findings.find((x) => x.affectedAgentCapability === "canIssueRefundsOrCredits" && x.reviewRule === "BM.CONTRADICTION.APPROVAL_REQUIRED");
    expect(f).toBeDefined();
    expect(f!.documentFact).toContain("requires finance approval");
    expect(f!.agentProfileFact).toContain("issues refunds or credits");
    expect(f!.agentProfileFact).toContain("500");
    expect(f!.severity).toBe("high");
    expect(contract.extractedText).toContain(f!.evidence[0]!.excerpt);
  });

  it("flags pricing statements reserved for authorized personnel", () => {
    const f = findings.find((x) => x.affectedAgentCapability === "canMakeRepresentations" && x.reviewRule === "BM.CONTRADICTION.AUTHORIZED_PERSONNEL_ONLY");
    expect(f?.documentFact).toContain("Only authorized personnel");
  });

  it("flags every-access recording vs basic logging", () => {
    const f = findings.find((x) => x.reviewRule === "BM.CONTRADICTION.ACCESS_RECORD");
    expect(f?.documentFact).toContain("record of every access");
    expect(f?.agentProfileFact).toContain('"basic"');
  });

  it("flags the insurance exclusion of automated systems without prior human approval", () => {
    const f = findings.find((x) => x.reviewRule === "BM.CONTRADICTION.AUTOMATION_EXCLUSION");
    expect(f).toBeDefined();
    expect(f!.title).toContain("without prior human approval");
    expect(f!.affectedDocumentId).toBe(policy.id);
    expect(f!.suggestedProfessionalReviewer).toBe("insurance_broker_or_insurer");
  });

  it("every finding quotes text that is really in its document", () => {
    for (const f of findings) {
      const source = [contract, policy].find((d) => d.id === f.affectedDocumentId)!;
      for (const e of f.evidence) expect(source.extractedText).toContain(e.excerpt);
    }
  });

  it("is deterministic", () => {
    expect(run(invoiceBot(), [contract, policy]).map((f) => f.id)).toEqual(findings.map((f) => f.id));
  });
});

describe("no contradiction where the profile already complies", () => {
  it("pre-action approval clears the approval and insurance findings, but not the authorized-personnel one", () => {
    const f = run(invoiceBot({ humanOversightLevel: "pre_action_approval" }), [doc(LEMON_CONTRACT, "master_services_agreement"), doc(LEMON_POLICY, "insurance_policy")]);
    expect(f.find((x) => x.reviewRule === "BM.CONTRADICTION.APPROVAL_REQUIRED")).toBeUndefined();
    expect(f.find((x) => x.reviewRule === "BM.CONTRADICTION.AUTOMATION_EXCLUSION")).toBeUndefined();
    expect(f.find((x) => x.reviewRule === "BM.CONTRADICTION.AUTHORIZED_PERSONNEL_ONLY")).toBeDefined();
  });
  it("detailed logging clears the every-access finding", () => {
    expect(run(invoiceBot({ loggingLevel: "tamper_evident" }), [doc(LEMON_CONTRACT, "master_services_agreement")]).find((x) => x.reviewRule === "BM.CONTRADICTION.ACCESS_RECORD")).toBeUndefined();
  });
  it("an agent without the capability gets no finding for it", () => {
    const f = run(invoiceBot({ canIssueRefundsOrCredits: false, canMakeRepresentations: false }), [doc(LEMON_CONTRACT, "master_services_agreement")]);
    expect(f.filter((x) => ["canIssueRefundsOrCredits", "canMakeRepresentations"].includes(x.affectedAgentCapability ?? ""))).toHaveLength(0);
  });
  it("a spending limit above the agent's limit is not a contradiction; below it is", () => {
    const high = run(invoiceBot(), [doc("Refunds up to $1,000 may be issued by support.", "commercial_contract")]);
    expect(high.find((x) => x.reviewRule === "BM.CONTRADICTION.SPENDING_LIMIT")).toBeUndefined();
    const low = run(invoiceBot(), [doc("Refunds over $100 need a manager's sign-off.", "commercial_contract")]);
    expect(low.find((x) => x.reviewRule === "BM.CONTRADICTION.SPENDING_LIMIT")).toBeDefined();
  });
});

describe("findContradictions is pure", () => {
  it("returns drafts without touching the inputs", () => {
    const d = doc(LEMON_CONTRACT, "master_services_agreement");
    const before = JSON.stringify(d);
    findContradictions(invoiceBot(), [d]);
    expect(JSON.stringify(d)).toBe(before);
  });
});
