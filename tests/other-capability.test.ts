// N-AT-05 (knock-out 2026-11-17): capabilities typed under "Other capability" are checked by the gap engine with fixed
// keyword rules. A recognised line is checked like a ticked box; an unrecognised line becomes an explicit
// "Unclassified capability - needs human review" finding instead of passing silently. Engine 1.2.0, recorded on runs.
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentProfileSchema } from "../src/api/schemas.js";
import { buildApp } from "../src/app.js";
import { detectClauses } from "../src/analysis/clause-detector.js";
import { analyzeGaps, classifyOtherCapability, ENGINE_VERSION } from "../src/analysis/gap-engine.js";
import { loadConfig } from "../src/config/env.js";
import { segmentText } from "../src/documents/extraction.js";
import type { AgentProfile, DocumentRecord } from "../src/domain/types.js";
import { selectJurisdictionPacks } from "../src/jurisdictions/packs.js";
import { MemoryStore } from "../src/persistence/memory-store.js";
import { agentInput } from "./helpers.js";

const base = (over: Partial<AgentProfile> = {}): AgentProfile => ({
  ...agentInput(), id: randomUUID(), organizationId: "org", projectId: "project",
  createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), ...over,
});
function doc(text: string): DocumentRecord {
  const id = randomUUID();
  return {
    id, organizationId: "org", projectId: "project", uploaderId: "user", originalFilename: "fictional.txt", safeFilename: "fictional.txt",
    mimeType: "text/plain", size: Buffer.byteLength(text), checksum: "fictional-checksum", documentType: "commercial_contract", countryCode: "US", subdivisionCode: null,
    storageKey: "org/project/doc.txt", extractionStatus: "completed", extractionError: null, extractionWarnings: [], pageCount: null,
    extractedText: text, segments: segmentText("org", id, text), retentionStatus: "active", deleteAfter: null, deletedAt: null,
    createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
  };
}
const run = (agent: AgentProfile, documents: DocumentRecord[] = []) => analyzeGaps({
  organizationId: "org", projectId: "project", analysisId: "analysis", agent, documents,
  detections: new Map(documents.map((d) => [d.id, detectClauses(d)])), packSelection: selectJurisdictionPacks("US"),
});
const otherFindings = (agent: AgentProfile, documents: DocumentRecord[] = []) => run(agent, documents).filter((f) => f.reviewRule.startsWith("GLOBAL.OTHER_CAPABILITY."));

describe("classifyOtherCapability (fixed keyword rules)", () => {
  it.each([
    ["Pays supplier invoices up to USD 500", "MONEY"],
    ["Issues refunds to customers", "MONEY"],
    ["Signs NDAs with new vendors", "canEnterContracts"],
    ["Reads patient medical records", "canAccessSensitivePersonalData"],
    ["Deletes old database tables", "SYSTEMS"],
    ["Screens job applicants", "PEOPLE"],
    ["Posts updates to our social media", "PUBLISHING"],
    ["Hands off tasks to other AI agents", "canDelegateToSubAgents"],
  ])("%s -> %s", (text, key) => {
    expect(classifyOtherCapability(text).map((r) => r.key)).toContain(key);
  });
  it("unknown wording maps to nothing (no guessing)", () => {
    expect(classifyOtherCapability("Books travel for staff")).toEqual([]);
    expect(classifyOtherCapability("Waters the office plants")).toEqual([]);
  });
  it("is deterministic", () => {
    expect(classifyOtherCapability("Pays invoices").map((r) => r.key)).toEqual(classifyOtherCapability("Pays invoices").map((r) => r.key));
  });
});

describe("gap engine with other capabilities", () => {
  it("engine version is 1.2.0", () => expect(ENGINE_VERSION).toBe("gap-engine@1.2.0"));

  it("an unrecognised line is flagged for human review, never a silent pass", () => {
    const [f, ...rest] = otherFindings(base({ otherCapabilities: ["Books travel for staff"] }));
    expect(rest).toHaveLength(0);
    expect(f!.title).toBe("Unclassified capability - needs human review");
    expect(f!.category).toBe("professional_review_required");
    expect(f!.reviewRule).toBe("GLOBAL.OTHER_CAPABILITY.UNCLASSIFIED");
    expect(f!.affectedAgentCapability).toBe("otherCapabilities[0]");
    expect(f!.agentProfileFact).toContain("Books travel for staff");
    expect(f!.systemInference).toMatch(/not treated as covered/);
  });

  it("a recognised line with no responsive language yields the matching finding", () => {
    const fs = otherFindings(base({ canSpendMoney: false, perTransactionLimit: undefined, aggregateSpendingLimit: undefined, currency: undefined, otherCapabilities: ["Pays supplier invoices"] }));
    const money = fs.find((f) => f.reviewRule === "GLOBAL.OTHER_CAPABILITY.MONEY");
    expect(money).toBeDefined();
    expect(money!.category).toBe("transaction_limit_mismatch");
    expect(money!.severity).toBe("high");
    expect(money!.title).toMatch(/moving money/);
  });

  it("responsive language in the documents clears it (same test as a ticked box)", () => {
    const contract = doc("Payments\n\nAny payment above USD 1,000 requires approval by the finance lead (approval threshold). The vendor may not act on behalf of the customer without prior written approval.");
    expect(detectClauses(contract).some((d) => d.category === "approval_requirements")).toBe(true);
    const fs = otherFindings(base({ otherCapabilities: ["Pays supplier invoices"] }), [contract]);
    expect(fs.find((f) => f.reviewRule === "GLOBAL.OTHER_CAPABILITY.MONEY")).toBeUndefined();
  });

  it("a line for a capability that is already ticked adds no duplicate", () => {
    const fs = otherFindings(base({ canEnterContracts: true, otherCapabilities: ["Signs contracts with suppliers"] }));
    expect(fs.find((f) => f.reviewRule === "GLOBAL.OTHER_CAPABILITY.CANENTERCONTRACTS")).toBeUndefined();
    expect(run(base({ canEnterContracts: true })).some((f) => f.reviewRule === "GLOBAL.CAPABILITY_LANGUAGE.CANENTERCONTRACTS")).toBe(true);
  });

  it("profiles without other capabilities get exactly the findings they got before", () => {
    const plain = run(base());
    const empty = run(base({ otherCapabilities: [] }));
    expect(empty.map((f) => f.id)).toEqual(plain.map((f) => f.id));
    expect(plain.some((f) => f.reviewRule.startsWith("GLOBAL.OTHER_CAPABILITY."))).toBe(false);
  });

  it("finding ids are stable per line", () => {
    const a = base({ otherCapabilities: ["Books travel for staff", "Pays invoices"] });
    expect(run(a).map((f) => f.id)).toEqual(run(a).map((f) => f.id));
  });

  it("the schema accepts up to 20 lines of 300 characters and keeps older profiles valid", () => {
    const input = agentInput();
    expect(agentProfileSchema.safeParse(input).success).toBe(true);
    expect(agentProfileSchema.safeParse({ ...input, otherCapabilities: ["Books travel"] }).success).toBe(true);
    expect(agentProfileSchema.safeParse({ ...input, otherCapabilities: Array(21).fill("x") }).success).toBe(false);
    expect(agentProfileSchema.safeParse({ ...input, otherCapabilities: ["x".repeat(301)] }).success).toBe(false);
  });
});

describe("over the API: saved, analysed, version recorded", () => {
  let dir = "";
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "acg-other-"));
    app = await buildApp({
      config: loadConfig({ NODE_ENV: "test", JWT_SECRET: "test-secret-with-at-least-thirty-two-characters", UPLOAD_DIRECTORY: dir, LOG_LEVEL: "silent", PERSISTENCE_DRIVER: "memory" }),
      store: new MemoryStore(), logger: false, certificateVerifier: null, pqSigner: null,
    });
    await app.ready();
  });
  afterAll(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  it("an analysis records gap-engine@1.2.0 and the needs-review finding", async () => {
    const reg = (await app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { email: `other-${Date.now()}@example.test`, name: "Other Tester", organizationName: "Fictional Other Ltd", password: "Correct Horse Battery 123!" } })).json<{ data: { accessToken: string } }>().data;
    const h = { authorization: `Bearer ${reg.accessToken}` };
    const project = (await app.inject({ method: "POST", url: "/api/v1/projects", headers: h, payload: { name: "Other capability", description: "Fictional", primaryCountryCode: "US", primarySubdivisionCode: "US-IL", affectedCountryCodes: [] } })).json<{ data: { id: string } }>().data;
    const created = await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/agents`, headers: h, payload: { ...agentInput(), otherCapabilities: ["Books travel for staff"] } });
    expect(created.statusCode).toBe(201);
    const agent = created.json<{ data: { id: string; otherCapabilities?: string[] } }>().data;
    expect(agent.otherCapabilities).toEqual(["Books travel for staff"]);
    const analysis = (await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/analyses`, headers: h, payload: { agentProfileId: agent.id, documentIds: [] } })).json<{ data: { id: string } }>().data;
    const result = (await app.inject({ method: "POST", url: `/api/v1/analyses/${analysis.id}/run`, headers: h })).json<{ data: { analysis: { engineVersion: string }; findings: { reviewRule: string }[] } }>().data;
    expect(result.analysis.engineVersion).toBe("gap-engine@1.2.0");
    expect(result.findings.some((f) => f.reviewRule === "GLOBAL.OTHER_CAPABILITY.UNCLASSIFIED")).toBe(true);
  });
});
