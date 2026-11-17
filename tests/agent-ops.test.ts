import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import { MemoryStore } from "../src/persistence/memory-store.js";
import { governanceFakes } from "./governance-fakes.js";
import { impactFor, patternMatches } from "../src/api/console-agent-ops-routes.js";
import { extractItems, proposeProfile } from "../src/governance/capability-import.js";

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

  describe("BM-41 approval inbox", () => {
    let secondAdminToken: string;
    let requestId: string;
    type Req = { requestId: string; state: string; status: string; decidedByName?: string; receiptSeq?: number | null };
    beforeAll(async () => {
      const added = data<{ temporaryPassword: string }>(await call("POST", "/team", ownerToken, { name: "Second Admin", email: "ops-second-admin@example.com", role: "admin" }));
      secondAdminToken = (JSON.parse((await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "ops-second-admin@example.com", password: added.temporaryPassword } })).payload) as { data: { accessToken: string } }).data.accessToken;
      requestId = data<Check>(await call("POST", "/gates/check", ownerToken, { agentId: "pay-bot", action: "invoices:pay", resource: "INV-77", amountUsd: 400 })).requestId!;
    });

    it("lists the pending request; the integration can poll it", async () => {
      const inbox = data<{ pending: number; requests: Req[] }>(await call("GET", "/action-approvals", ownerToken));
      expect(inbox.pending).toBeGreaterThanOrEqual(1);
      expect(inbox.requests.some((r) => r.requestId === requestId && r.state === "pending")).toBe(true);
      expect(data<Req>(await call("GET", `/action-approvals/${requestId}`, ownerToken)).state).toBe("pending");
    });

    it("the asker cannot approve its own request; viewers cannot decide; a note is required", async () => {
      expect((await call("POST", `/action-approvals/${requestId}/decide`, ownerToken, { decision: "approve", note: "self" })).statusCode).toBe(403);
      expect((await call("POST", `/action-approvals/${requestId}/decide`, viewerToken, { decision: "approve", note: "viewer" })).statusCode).toBe(403);
      expect((await call("POST", `/action-approvals/${requestId}/decide`, secondAdminToken, { decision: "approve", note: "" })).statusCode).toBe(400);
    });

    it("a named second admin approves: signed receipt with name and time; /verify passes, changed copy fails; once only", async () => {
      const res = await call("POST", `/action-approvals/${requestId}/decide`, secondAdminToken, { decision: "approve", note: "Checked INV-77 with the vendor by phone." });
      expect(res.statusCode).toBe(200);
      expect(data<Req>(res)).toMatchObject({ state: "approved", decidedByName: "Second Admin" });
      const signed = (await receiptsOf("action-approval")).at(-1)!;
      expect((signed.receipt.facts as Record<string, unknown>)).toMatchObject({ decision: "approved", approverName: "Second Admin", approverRole: "admin", action: "invoices:pay" });
      expect(JSON.stringify(signed.receipt)).not.toContain("Checked INV-77");
      expect((await publicVerify(signed.receipt)).verdict).toBe("PASS");
      expect((await publicVerify({ ...signed.receipt, facts: { ...(signed.receipt.facts as object), decision: "declined" } })).verdict).toBe("FAIL");
      expect((await call("POST", `/action-approvals/${requestId}/decide`, secondAdminToken, { decision: "decline", note: "again" })).statusCode).toBe(409);
      expect(data<Req>(await call("GET", `/action-approvals/${requestId}`, ownerToken)).state).toBe("approved");
    });

    it("an expired request can never be approved", async () => {
      const id = data<Check>(await call("POST", "/gates/check", ownerToken, { agentId: "pay-bot", action: "invoices:pay", amountUsd: 450 })).requestId!;
      const all = await call("GET", "/action-approvals", ownerToken);
      const req = data<{ requests: Array<Req & { expiresAt: string }> }>(all).requests.find((r) => r.requestId === id)!;
      expect(req.state).toBe("pending");
      // Age the request past its 24-hour window directly in the store.
      const owner = JSON.parse((await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { authorization: `Bearer ${ownerToken}` } })).payload) as { data: { organization?: { id: string }; organizations?: Array<{ id: string }> } };
      const workspaceId = owner.data.organization?.id ?? owner.data.organizations?.[0]?.id;
      const saved = await store.getConsoleRecord(workspaceId!, "approval-request", id);
      await store.saveConsoleRecord({ organizationId: workspaceId!, kind: "approval-request", key: id, data: { ...(saved!.data as object), expiresAt: new Date(Date.now() - 1000).toISOString() } });
      expect(data<Req>(await call("GET", `/action-approvals/${id}`, ownerToken)).state).toBe("expired");
      const late = await call("POST", `/action-approvals/${id}/decide`, secondAdminToken, { decision: "approve", note: "too late" });
      expect(late.statusCode).toBe(409);
    });

  });

  describe("BM-38 capability import (MCP, OpenAPI, IAM)", () => {
    type Imported = { proposal: { capabilities: Record<string, boolean>; otherCapabilities: string[] }; needsHumanReview: string[]; notes: string[]; inputSha256: string; receiptSeq: number | null };
    it("unit: MCP tools map to capabilities, extra groups and review", () => {
      const { items } = extractItems("mcp", JSON.stringify({ tools: [{ name: "send_customer_email", description: "Email customers about their order" }, { name: "refund_payment", description: "Refund a card payment" }, { name: "weather", description: "Look up the weather" }] }));
      const p = proposeProfile(items);
      expect(p.capabilities).toMatchObject({ canCommunicateExternally: true });
      expect(p.otherCapabilities.some((l) => /refund/.test(l))).toBe(true);
      expect(p.unmatched.some((l) => /weather/.test(l))).toBe(true);
    });

    it("unit: OpenAPI operations and IAM actions are read; wildcards are flagged", () => {
      const api = extractItems("openapi", JSON.stringify({ openapi: "3.0.0", paths: { "/invoices/{id}/pay": { post: { summary: "Pay an invoice" } }, "/records/{id}": { delete: { operationId: "deleteRecord" } } } }));
      expect(api.items).toHaveLength(2);
      expect(proposeProfile(api.items).otherCapabilities.length).toBeGreaterThanOrEqual(2);
      const iam = extractItems("iam", JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["s3:DeleteObject", "ec2:*"] }, { Effect: "Deny", Action: "iam:*" }] }));
      expect(iam.items.map((i) => i.split(":")[0])).toEqual(["s3", "ec2"]);
      expect(iam.notes.join(" ")).toMatch(/full administrative access/);
      expect(() => extractItems("openapi", "openapi: 3.0.0")).toThrow(/must be JSON/);
    });

    it("POST /agents/:id/capability-import proposes (nothing applied), signs a snapshot, keeps no raw input", async () => {
      const content = JSON.stringify({ tools: [{ name: "pay_invoice", description: "Pay supplier invoices" }, { name: "lookup", description: "Look something up secret-marker-xyz" }] });
      const res = await call("POST", "/agents/pay-bot/capability-import", ownerToken, { format: "mcp", content });
      expect(res.statusCode).toBe(201);
      const body = data<Imported>(res);
      expect(body.proposal.otherCapabilities.join(" ")).toMatch(/pay_invoice/);
      expect(body.needsHumanReview.join(" ")).toMatch(/lookup/);
      expect(body.notes.join(" ")).toMatch(/nothing was changed in the agent profile/);
      const signed = (await receiptsOf("capability-snapshot")).at(-1)!;
      expect((signed.receipt.facts as Record<string, unknown>).inputSha256).toBe(body.inputSha256);
      expect((await publicVerify(signed.receipt)).verdict).toBe("PASS");
      expect((await publicVerify({ ...signed.receipt, facts: { ...(signed.receipt.facts as object), matched: 99 } })).verdict).toBe("FAIL");
      const snaps = data<Array<Record<string, unknown>>>(await call("GET", "/agents/pay-bot/capability-snapshots", ownerToken));
      expect(snaps.length).toBe(1);
      expect(JSON.stringify(snaps)).not.toContain("secret-marker-xyz");
    });

    it("bad input is refused; viewers cannot import; other workspaces see nothing", async () => {
      expect((await call("POST", "/agents/pay-bot/capability-import", ownerToken, { format: "mcp", content: "not json" })).statusCode).toBe(400);
      expect((await call("POST", "/agents/pay-bot/capability-import", ownerToken, { format: "mcp", content: JSON.stringify({ tools: [] }) })).statusCode).toBe(400);
      expect((await call("POST", "/agents/pay-bot/capability-import", viewerToken, { format: "mcp", content: JSON.stringify({ tools: [{ name: "a" }] }) })).statusCode).toBe(403);
      expect(data<unknown[]>(await call("GET", "/agents/pay-bot/capability-snapshots", otherToken))).toEqual([]);
    });
  });

  describe("BM-41 approval inbox (isolation)", () => {
    it("another workspace cannot see or decide this workspace's requests", async () => {
      const requestId = data<{ requests: Array<{ requestId: string }> }>(await call("GET", "/action-approvals", ownerToken)).requests[0]!.requestId;
      expect((await call("GET", `/action-approvals/${requestId}`, otherToken)).statusCode).toBe(404);
      expect((await call("POST", `/action-approvals/${requestId}/decide`, otherToken, { decision: "decline", note: "not mine" })).statusCode).toBe(404);
      expect(data<{ requests: unknown[] }>(await call("GET", "/action-approvals", otherToken)).requests).toEqual([]);
    });
  });
});
