import type { FastifyInstance } from "fastify";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import { MemoryStore } from "../src/persistence/memory-store.js";
import { governanceFakes } from "./governance-fakes.js";
import { agentInput } from "./helpers.js";

// N-AT-06 one connected flow: each step's state is read from its real source (three states), never from a click; the
// only stored thing is a small progress record (agent followed + step to resume at).

type Step = { id: string; state: "observed" | "not-observed" | "unavailable"; detail: string; observedAt: string | null };
type Flow = { agentId: string | null; steps: Step[]; observed: number; total: number; complete: boolean; nextStep: string | null; resumeAt: string; progress: Record<string, unknown> | null; snippet: { consoleUrl: string; agentId: string; node: string; env: string; curl: string } };

describe("N-AT-06 one connected flow", () => {
  let app: FastifyInstance;
  const store = new MemoryStore();
  const fakes = governanceFakes();
  let ownerToken: string;
  let viewerToken: string;
  let otherToken: string;
  let orgId: string;

  beforeAll(async () => {
    const config = loadConfig({ NODE_ENV: "test", JWT_SECRET: "test-secret-with-at-least-thirty-two-characters", LOG_LEVEL: "silent", PERSISTENCE_DRIVER: "memory", PQ_SIGNING_SEED: Buffer.alloc(32, 24).toString("base64"), PUBLIC_BASE_URL: "https://console.example.test/some/path" });
    app = await buildApp({ config, store, logger: false, governance: { atlasUrl: "https://atlas.test", trustProofUrl: "https://tp.test", fetchImpl: fakes.fetchImpl } });
    const register = async (email: string) => {
      const response = await app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { email, name: "Flow Test", organizationName: "Flow Org", password: "Correct Horse Battery 123!" } });
      return JSON.parse(response.payload) as { data: { accessToken: string; user: { id: string }; organization: { id: string } } };
    };
    const owner = await register("flow-owner@example.com");
    ownerToken = owner.data.accessToken;
    orgId = owner.data.organization.id;
    const viewer = await register("flow-viewer@example.com");
    store.setRoleForTesting(viewer.data.user.id, viewer.data.organization.id, "viewer");
    viewerToken = (JSON.parse((await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "flow-viewer@example.com", password: "Correct Horse Battery 123!" } })).payload) as { data: { accessToken: string } }).data.accessToken;
    otherToken = (await register("flow-other@example.com")).data.accessToken;
  });
  afterAll(async () => { await app.close(); });

  const call = (method: "GET" | "POST" | "PUT", url: string, token: string, payload?: object) =>
    app.inject({ method, url: `/api/v1/console${url}`, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });
  const data = <T>(res: { payload: string }) => (JSON.parse(res.payload) as { data: T }).data;
  const flow = async (token = ownerToken) => data<Flow>(await call("GET", "/connected-flow", token));
  const stateOf = async (id: string) => (await flow()).steps.find((s) => s.id === id)!;

  it("a new workspace: six steps, all Not verified, nothing claimed; the snippet carries no key", async () => {
    const f = await flow();
    expect(f.steps.map((s) => s.id)).toEqual(["describe", "certificate", "gate-policy", "runtime-gate", "ledger", "statement"]);
    expect(f.steps.every((s) => s.state === "not-observed")).toBe(true);
    expect(f).toMatchObject({ observed: 0, total: 6, complete: false, nextStep: "describe", resumeAt: "describe", progress: null, agentId: null });
    expect(f.snippet.consoleUrl).toBe("https://console.example.test");
    expect(f.snippet.node).toContain('agentId: "your-agent-id"');
    expect(f.snippet.node).toContain("process.env.RUNTIME_GATE_KEY");
    expect(JSON.stringify(f)).not.toMatch(/rgk_[0-9a-f]/);
  });

  it("step 1 is observed only when an agent profile exists (the wizard's output)", async () => {
    const project = data<{ id: string }>(await app.inject({ method: "POST", url: "/api/v1/projects", headers: { authorization: `Bearer ${ownerToken}` }, payload: { name: "Flow project", description: "Fictional", primaryCountryCode: "US", primarySubdivisionCode: "US-IL", affectedCountryCodes: [] } }));
    await store.createAgent(orgId, project.id, agentInput());
    const s = await stateOf("describe");
    expect(s.state).toBe("observed");
    expect(s.detail).toMatch(/1 agent profile described/);
  });

  it("progress is resumable: the agent followed and the step are saved; viewers read but cannot change; bad input refused", async () => {
    expect((await call("PUT", "/connected-flow", viewerToken, { currentStep: "ledger" })).statusCode).toBe(403);
    expect((await call("PUT", "/connected-flow", ownerToken, { currentStep: "done" })).statusCode).toBe(400);
    expect((await call("PUT", "/connected-flow", ownerToken, { agentId: "bad id" })).statusCode).toBe(400);
    expect((await call("PUT", "/connected-flow", ownerToken, { completed: true })).statusCode).toBe(400);
    const saved = data<Flow>(await call("PUT", "/connected-flow", ownerToken, { agentId: "pay-bot", currentStep: "certificate" }));
    expect(saved).toMatchObject({ agentId: "pay-bot", resumeAt: "certificate" });
    expect(saved.snippet.node).toContain('agentId: "pay-bot"');
    const again = await flow();
    expect(again.resumeAt).toBe("certificate");
    expect(again.progress).toMatchObject({ agentId: "pay-bot", currentStep: "certificate" });
    // Changing only the step keeps the agent.
    expect(data<Flow>(await call("PUT", "/connected-flow", ownerToken, { currentStep: "gate-policy" })).agentId).toBe("pay-bot");
    expect((await call("GET", "/connected-flow", viewerToken)).statusCode).toBe(200);
  });

  it("step 2 reads Agent Certificates live: another agent's certificate does not count; unreadable is 'unavailable'", async () => {
    expect((await call("POST", "/link", ownerToken)).statusCode).toBe(200);
    expect((await call("POST", "/certificates", ownerToken, { agentId: "other-bot", agentName: "Other", permissions: ["email:send"] })).statusCode).toBe(201);
    expect((await stateOf("certificate")).state).toBe("not-observed");
    expect((await call("POST", "/certificates", ownerToken, { agentId: "pay-bot", agentName: "Pay bot", permissions: ["invoices:pay"], limits: { maxAmountUsd: 500 } })).statusCode).toBe(201);
    const ok = await stateOf("certificate");
    expect(ok.state).toBe("observed");
    expect(ok.observedAt).toBeTruthy();
    fakes.state.atlasDown = true;
    try {
      const down = await stateOf("certificate");
      expect(down.state).toBe("unavailable");
      expect(down.detail).toMatch(/not claimed/);
    } finally { fakes.state.atlasDown = false; }
  });

  it("step 3 is observed once an admin saves a gate policy", async () => {
    expect((await stateOf("gate-policy")).state).toBe("not-observed");
    expect((await call("PUT", "/gates", ownerToken, { defaultImpact: "low", rules: [{ action: "invoices:*", impact: "medium", highAboveUsd: 200 }] })).statusCode).toBe(200);
    const s = await stateOf("gate-policy");
    expect(s.state).toBe("observed");
    expect(s.detail).toMatch(/1 rule/);
  });

  it("step 4 needs a real gate check from a runtime key for this agent; a key alone or a person's check is not enough", async () => {
    const key = data<{ key: string }>(await call("POST", "/runtime-keys", ownerToken, { name: "Flow runtime" })).key;
    let s = await stateOf("runtime-gate");
    expect(s.state).toBe("not-observed");
    expect(s.detail).toMatch(/1 active runtime key; waiting/);
    await call("POST", "/gates/check", ownerToken, { agentId: "pay-bot", action: "invoices:pay", amountUsd: 10 });
    const runtime = (agentId: string) => app.inject({ method: "POST", url: "/api/v1/runtime/gate/check", headers: { authorization: `Bearer ${key}` }, payload: { agentId, action: "invoices:pay", amountUsd: 10 } });
    await runtime("other-bot");
    expect((await stateOf("runtime-gate")).state).toBe("not-observed");
    expect((await runtime("pay-bot")).statusCode).toBe(200);
    s = await stateOf("runtime-gate");
    expect(s.state).toBe("observed");
    expect(s.detail).toMatch(/1 gate check from your runtime for pay-bot/);
  });

  it("step 5 reads the Trust Proof ledger for this agent; a ledger that does not answer is 'unavailable'", async () => {
    expect((await stateOf("ledger")).state).toBe("not-observed");
    fakes.addAction("other-bot", "within_authority", new Date().toISOString());
    expect((await stateOf("ledger")).state).toBe("not-observed");
    fakes.state.ledgerDown = true;
    try { expect((await stateOf("ledger")).state).toBe("unavailable"); } finally { fakes.state.ledgerDown = false; }
    fakes.addAction("pay-bot", "within_authority", new Date().toISOString(), 25);
    const s = await stateOf("ledger");
    expect(s.state).toBe("observed");
    expect(s.detail).toMatch(/1 action recorded for pay-bot/);
  });

  it("step 6: a signed monthly statement completes the flow", async () => {
    expect((await stateOf("statement")).state).toBe("not-observed");
    const month = new Date().toISOString().slice(0, 7);
    expect((await call("POST", "/statements", ownerToken, { month })).statusCode).toBe(201);
    const f = await flow();
    expect(f.steps.find((s) => s.id === "statement")!.state).toBe("observed");
    expect(f).toMatchObject({ observed: 6, complete: true, nextStep: null });
  });

  it("workspace isolation, and the progress record is in the account export", async () => {
    const other = await flow(otherToken);
    expect(other.progress).toBeNull();
    expect(other.steps.every((s) => s.state === "not-observed")).toBe(true);
    const exported = await app.inject({ method: "POST", url: "/api/v1/auth/export", headers: { authorization: `Bearer ${ownerToken}` }, payload: {} });
    expect(exported.statusCode).toBe(200);
    const text = exported.rawPayload.toString("latin1");
    expect(text).toContain("flow-progress");
    expect(text).toContain("connected-flow");
  });

  it("the console page: a Get started view that shows the three states and never builds HTML from server text", () => {
    const js = readFileSync(path.join(__dirname, "..", "public", "console.js"), "utf8");
    const view = js.slice(js.indexOf("// ----- N-AT-06 one connected flow"), js.indexOf("// ----- approvals: named people sign"));
    expect(view).toContain("function viewStart(");
    expect(js).toContain('{ id: "start", label: "Get started"');
    expect(js).toContain("start: viewStart");
    for (const label of ["Observed", "Not verified", "Could not check"]) expect(view).toContain(label);
    expect(view).toContain("/console/connected-flow");
    expect(view).toContain("/console/runtime-keys");
    expect(view).toContain("data-flow-step");
    expect(view).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML/);
    expect(view).not.toMatch(/localStorage|sessionStorage/); // the one-time key is never stored
  });
});
