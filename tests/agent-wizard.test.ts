// N-AT-04 (knock-out 2026-11-17): the plain-English step-by-step wizard writes exactly the profile the classic form
// writes (same builder, same server-side zod schema), asks for every field the form asks for, and its step checks
// catch the mistakes the server would refuse. The classic form stays available.
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentProfileSchema } from "../src/api/schemas.js";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import { MemoryStore } from "../src/persistence/memory-store.js";

type Answers = Record<string, string | boolean>;
type Step = { id: string; title: string; help: string; fields: [string, string, string][] };
type AgentProfileApi = {
  capabilityFields: [string, string][];
  buildAgentPayload: (values: Answers) => Record<string, unknown>;
  WIZARD_STEPS: Step[];
  wizardCheck: (index: number, values: Answers) => string | null;
};

const publicDir = join(process.cwd(), "public");
const sandbox: { AgentProfile?: AgentProfileApi } = {};
vm.runInNewContext(readFileSync(join(publicDir, "agent-profile.js"), "utf8"), sandbox);
const AP = sandbox.AgentProfile as AgentProfileApi;
const appJs = readFileSync(join(publicDir, "app.js"), "utf8");

// What a person types into the classic form (the "Fill example profile" values).
const formValues: Answers = {
  name: "Procurement Agent", deploymentStatus: "pilot", businessPurpose: "Prepare vendor recommendations and execute purchases after approval.",
  operatorOrganization: "Fictional Buyer Ltd", developerProvider: "Internal AI team", agentType: "Transaction agent",
  primaryJurisdiction: "us", deploymentCountries: "us, gb", affectedCountries: "", autonomyLevel: "4", humanOversightLevel: "threshold_approval",
  reversibility: "partially_reversible", loggingLevel: "detailed", perTransactionLimit: "5000", aggregateSpendingLimit: "25000", currency: "usd",
  approvalThresholds: "Human approval above USD 1,000", thirdPartyToolsUsed: "Procurement portal", systemsAccessed: "Vendor database, purchasing system",
  emergencyStopMechanism: "Operator kill switch", incidentResponseOwner: "Security Operations", knownLimitations: "Cannot independently verify vendor identity\nNo access to bank portals",
  notes: "",
};
const ticked = ["canCommunicateExternally", "canMakeRepresentations", "canAcceptTerms", "canExecuteTransactions", "canSpendMoney", "canEnterContracts", "canApproveOrRejectVendors", "canAccessPersonalData", "canAccessConfidentialBusinessData"];
const withCapabilities = (v: Answers): Answers => {
  const out: Answers = { ...v };
  AP.capabilityFields.forEach(([name]) => { out[name] = ticked.includes(name); });
  return out;
};

// The wizard: the person answers one step at a time; only the fields a step shows are filled from that step.
function walkWizard(source: Answers): Answers {
  const answers: Answers = {};
  AP.WIZARD_STEPS.forEach((step, index) => {
    step.fields.forEach(([name]) => { answers[name] = source[name] ?? ""; });
    expect(AP.wizardCheck(index, answers), step.id).toBeNull();
  });
  return answers;
}

describe("agent profile wizard (N-AT-04)", () => {
  it("asks for every field the classic form asks for", () => {
    const formHtml = appJs.slice(appJs.indexOf("function renderAgent()"), appJs.indexOf("function wizardDefaults"));
    const formFields = new Set([...formHtml.matchAll(/name="([A-Za-z]+)"/g)].map((m) => m[1] as string).filter((n) => n !== "${name}"));
    AP.capabilityFields.forEach(([name]) => formFields.add(name));
    const wizardFields = new Set(AP.WIZARD_STEPS.flatMap((s) => s.fields.map((f) => f[0])));
    const missing = [...formFields].filter((n) => !wizardFields.has(n));
    expect(missing).toEqual([]);
    expect(formFields.size).toBeGreaterThan(40);
  });

  it("writes exactly the profile the form writes, and the server schema accepts it", () => {
    const fromForm = AP.buildAgentPayload(withCapabilities(formValues));
    const fromWizard = AP.buildAgentPayload(walkWizard(withCapabilities(formValues)));
    expect(fromWizard).toEqual(fromForm);
    const parsed = agentProfileSchema.safeParse(fromWizard);
    expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(true);
    expect(fromWizard).toMatchObject({ primaryJurisdiction: "US", deploymentCountries: ["US", "GB"], currency: "USD", perTransactionLimit: 5000, canSpendMoney: true, canDeployCode: false, knownLimitations: ["Cannot independently verify vendor identity", "No access to bank portals"] });
  });

  it("an agent that cannot spend money sends no limits (same rule as the form)", () => {
    const v = withCapabilities({ ...formValues, perTransactionLimit: "", aggregateSpendingLimit: "" });
    v.canSpendMoney = false;
    const p = AP.buildAgentPayload(walkWizard(v));
    expect(p).not.toHaveProperty("perTransactionLimit");
    expect(p).not.toHaveProperty("currency");
    expect(agentProfileSchema.safeParse(p).success).toBe(true);
  });

  it("step checks catch what the server would refuse, in plain English", () => {
    const idx = (id: string) => AP.WIZARD_STEPS.findIndex((s) => s.id === id);
    expect(AP.wizardCheck(idx("what"), { name: "X", businessPurpose: "ok purpose", agentType: "bot" })).toMatch(/name/);
    expect(AP.wizardCheck(idx("where"), { operatorOrganization: "Acme", primaryJurisdiction: "USA", deploymentCountries: "US" })).toMatch(/two-letter/);
    expect(AP.wizardCheck(idx("where"), { operatorOrganization: "Acme", primaryJurisdiction: "US", deploymentCountries: "US, Germany" })).toMatch(/two-letter/);
    expect(AP.wizardCheck(idx("money"), { canSpendMoney: true, perTransactionLimit: "", currency: "USD" })).toMatch(/per-action limit/);
    expect(AP.wizardCheck(idx("money"), { canSpendMoney: false, perTransactionLimit: "500" })).toMatch(/Spend money/);
    // The server refuses the same mistakes even if a step check were skipped.
    const bad = AP.buildAgentPayload(withCapabilities({ ...formValues, currency: "", perTransactionLimit: "" }));
    expect(agentProfileSchema.safeParse(bad).success).toBe(false);
  });

  it("wording is decision support only", () => {
    const text = AP.WIZARD_STEPS.map((s) => [s.title, s.help, ...s.fields.map((f) => f[1])].join(" ")).join(" ") + appJs.slice(appJs.indexOf("function renderAgentWizardReview"), appJs.indexOf("function fillExampleAgent"));
    expect(text).not.toMatch(/\binsured\b|compliant|certified|legal advice is|guarantee/i);
    expect(text).toMatch(/not legal or insurance advice/);
  });

  it("the classic form stays, both paths use the shared builder", () => {
    expect(appJs).toContain('id="agent-form"');
    expect(appJs).toContain("data-agent-wizard");
    expect((appJs.match(/window\.AgentProfile\.buildAgentPayload\(/g) || []).length).toBe(2);
  });
});

describe("agent-profile.js is served before app.js", () => {
  let dir = "";
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "acg-wizard-"));
    app = await buildApp({
      config: loadConfig({ NODE_ENV: "test", JWT_SECRET: "test-secret-with-at-least-thirty-two-characters", UPLOAD_DIRECTORY: dir, LOG_LEVEL: "silent", PERSISTENCE_DRIVER: "memory" }),
      store: new MemoryStore(), logger: false, certificateVerifier: null, pqSigner: null,
    });
    await app.ready();
  });
  afterAll(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  it("GET /agent-profile.js and the page loads it first", async () => {
    const js = await app.inject({ method: "GET", url: "/agent-profile.js" });
    expect(js.statusCode).toBe(200);
    expect(js.headers["content-type"]).toMatch(/javascript/);
    expect(js.body).toContain("WIZARD_STEPS");
    const page = (await app.inject({ method: "GET", url: "/" })).body;
    expect(page.indexOf("/agent-profile.js")).toBeGreaterThan(-1);
    expect(page.indexOf("/agent-profile.js")).toBeLessThan(page.indexOf("/app.js"));
  });
});
