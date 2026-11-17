import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import { MemoryStore } from "../src/persistence/memory-store.js";
import { governanceFakes } from "./governance-fakes.js";
import { impactFor, patternMatches } from "../src/api/console-agent-ops-routes.js";

// Agent operations (knock-out Phase 5 medium items): AD-057 approval gates, BM-41 approval inbox, BM-38 capability
// import, N-AT-09 agent retirement. Fake Authority Atlas / Trust Proof (tests/governance-fakes.ts).

describe("agent operations on the console", () => {
  let app: FastifyInstance;
  const store = new MemoryStore();
  const fakes = governanceFakes();
  let ownerToken: string;
  let viewerToken: string;
  let otherToken: string;

  beforeAll(async () => {
    const config = loadConfig({ NODE_ENV: "test", JWT_SECRET: "test-secret-with-at-least-thirty-two-characters", LOG_LEVEL: "silent", PERSISTENCE_DRIVER: "memory", PQ_SIGNING_SEED: Buffer.alloc(32, 22).toString("base64") });
    app = await buildApp({ config, store, logger: false, governance: { atlasUrl: "https://atlas.test", trustProofUrl: "https://tp.test", fetchImpl: fakes.fetchImpl } });
    const register = async (email: string) => {
      const response = await app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { email, name: "Ops Test", organizationName: "Ops Org", password: "Correct Horse Battery 123!" } });
      return JSON.parse(response.payload) as { data: { accessToken: string; user: { id: string }; organization: { id: string } } };
    };
    ownerToken = (await register("ops-owner@example.com")).data.accessToken;
    const viewer = await register("ops-viewer@example.com");
    store.setRoleForTesting(viewer.data.user.id, viewer.data.organization.id, "viewer");
    viewerToken = (JSON.parse((await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "ops-viewer@example.com", password: "Correct Horse Battery 123!" } })).payload) as { data: { accessToken: string } }).data.accessToken;
    otherToken = (await register("ops-other@example.com")).data.accessToken;
  });
  afterAll(async () => { await app.close(); });

  const call = (method: "GET" | "POST" | "PUT", url: string, token: string, payload?: object) =>
    app.inject({ method, url: `/api/v1/console${url}`, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });
  const data = <T>(res: { payload: string }) => (JSON.parse(res.payload) as { data: T }).data;
  const receiptsOf = async (type: string) => data<{ receipts: Array<{ type: string; receipt: Record<string, unknown> }> }>(await call("GET", "/receipts", ownerToken)).receipts.filter((r) => r.type === type);
  const publicVerify = async (receipt: unknown) => data<{ verdict: string }>(await app.inject({ method: "POST", url: "/api/v1/public/verify", payload: { receipt } }));
  type Check = { decision: string; impact: string; reasons: string[]; requestId: string | null; certificateSource: string; receiptSeq: number | null };

  describe("AD-057 approval gates by impact level", () => {
    it("unit: patterns and impact rules", () => {
      expect(patternMatches("invoices:*", "invoices:pay")).toBe(true);
      expect(patternMatches("invoices:*", "invoicesx:pay")).toBe(false);
      expect(patternMatches("*", "anything")).toBe(true);
      const policy = { defaultImpact: "low" as const, rules: [{ action: "invoices:*", impact: "medium" as const, highAboveUsd: 200 }, { action: "email:send", agentId: "bot-a", impact: "high" as const }] };
      expect(impactFor(policy, { agentId: "x", action: "invoices:pay", amountUsd: 100 }).impact).toBe("medium");
      expect(impactFor(policy, { agentId: "x", action: "invoices:pay", amountUsd: 300 }).impact).toBe("high");
      expect(impactFor(policy, { agentId: "bot-a", action: "email:send" }).impact).toBe("high");
      expect(impactFor(policy, { agentId: "bot-b", action: "email:send" }).impact).toBe("low");
    });

    it("before activation: never allowed, a person must approve (not verified)", async () => {
      const res = await call("POST", "/gates/check", ownerToken, { agentId: "pay-bot", action: "invoices:pay", amountUsd: 10 });
      expect(res.statusCode).toBe(202);
      const body = data<Check>(res);
      expect(body).toMatchObject({ decision: "needs-approval", certificateSource: "not-activated" });
      expect(body.requestId).toBeTruthy();
    });

    it("after activation: allowed within permissions; blocked outside them, over the limit, or without a certificate", async () => {
      expect((await call("POST", "/link", ownerToken)).statusCode).toBe(200);
      expect((await call("POST", "/certificates", ownerToken, { agentId: "pay-bot", agentName: "Pay bot", permissions: ["invoices:pay"], limits: { maxAmountUsd: 500 } })).statusCode).toBe(201);
      const ok = await call("POST", "/gates/check", ownerToken, { agentId: "pay-bot", action: "invoices:pay", resource: "INV-1", amountUsd: 100 });
      expect(ok.statusCode).toBe(200);
      expect(data<Check>(ok)).toMatchObject({ decision: "allowed", impact: "medium", receiptSeq: null });
      const outside = await call("POST", "/gates/check", ownerToken, { agentId: "pay-bot", action: "email:send" });
      expect(outside.statusCode).toBe(403);
      expect(data<Check>(outside).reasons.join(" ")).toMatch(/outside the agent's certificate permissions/);
      const over = await call("POST", "/gates/check", ownerToken, { agentId: "pay-bot", action: "invoices:pay", amountUsd: 900 });
      expect(data<Check>(over).decision).toBe("blocked");
      expect(data<Check>(await call("POST", "/gates/check", ownerToken, { agentId: "ghost-bot", action: "invoices:pay" })).decision).toBe("blocked");
    });

    it("a high-impact rule opens an approval request; only admins set the policy; bad patterns refused", async () => {
      expect((await call("PUT", "/gates", viewerToken, { defaultImpact: "low", rules: [] })).statusCode).toBe(403);
      expect((await call("PUT", "/gates", ownerToken, { defaultImpact: "low", rules: [{ action: "inv oices", impact: "high" }] })).statusCode).toBe(400);
      const set = await call("PUT", "/gates", ownerToken, { defaultImpact: "low", rules: [{ action: "invoices:*", impact: "medium", highAboveUsd: 200 }] });
      expect(set.statusCode).toBe(200);
      expect(data<{ receiptSeq: number }>(set).receiptSeq).toBeGreaterThan(0);
      const high = await call("POST", "/gates/check", ownerToken, { agentId: "pay-bot", action: "invoices:pay", amountUsd: 300 });
      expect(high.statusCode).toBe(202);
      expect(data<Check>(high)).toMatchObject({ decision: "needs-approval", impact: "high" });
      expect(data<Check>(await call("POST", "/gates/check", ownerToken, { agentId: "pay-bot", action: "invoices:pay", amountUsd: 150 })).decision).toBe("allowed");
      expect((await call("POST", "/gates/check", viewerToken, { agentId: "pay-bot", action: "invoices:pay" })).statusCode).toBe(403);
    });

    it("blocked and needs-approval decisions are signed; /verify passes them and fails a changed copy", async () => {
      const signed = await receiptsOf("gate-decision");
      expect(signed.length).toBeGreaterThanOrEqual(4);
      const first = signed[0]!;
      expect((await publicVerify(first.receipt)).verdict).toBe("PASS");
      expect((await publicVerify({ ...first.receipt, facts: { ...(first.receipt.facts as object), decision: "allowed" } })).verdict).toBe("FAIL");
      expect((await receiptsOf("gate-policy-set")).length).toBe(1);
    });

    it("decisions are listed for this workspace only, and are in the account export", async () => {
      expect(data<unknown[]>(await call("GET", "/gates/decisions", ownerToken)).length).toBeGreaterThanOrEqual(6);
      expect(data<unknown[]>(await call("GET", "/gates/decisions", otherToken))).toEqual([]);
      const exported = await app.inject({ method: "POST", url: "/api/v1/auth/export", headers: { authorization: `Bearer ${ownerToken}` }, payload: {} });
      expect(exported.statusCode).toBe(200);
      const text = exported.rawPayload.toString("latin1");
      expect(text).toContain("approval-request");
      expect(text).toContain("gate-decision");
    });
  });
});
