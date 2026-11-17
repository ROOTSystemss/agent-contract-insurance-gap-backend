import type { FastifyInstance } from "fastify";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import { MemoryStore } from "../src/persistence/memory-store.js";
import { governanceFakes } from "./governance-fakes.js";

// BM-40 runtime gate: workspace runtime keys (admin-made, shown once, stored hashed, revocable) that reach exactly the
// gate check and the approvals they opened; plus the SDK in sdk/runtime-gate driven against this app on 127.0.0.1.

type RuntimeGate = {
  check: (action: string, details?: object, options?: object) => Promise<{ allowed: boolean; decision: string; requestId: string | null; reasons: string[] }>;
};
const SDK_DIR = resolve(process.cwd(), "sdk", "runtime-gate"); // vitest runs from the repo root
const require = createRequire(join(SDK_DIR, "index.js"));
const { createRuntimeGate } = require("./index.js") as { createRuntimeGate: (o: object) => RuntimeGate };

describe("BM-40 runtime gate", () => {
  let app: FastifyInstance;
  let baseUrl: string;
  const store = new MemoryStore();
  const fakes = governanceFakes();
  let ownerToken: string;
  let viewerToken: string;
  let otherToken: string;
  let key: string;
  let keyId: string;
  let otherKey: string;

  beforeAll(async () => {
    const config = loadConfig({ NODE_ENV: "test", JWT_SECRET: "test-secret-with-at-least-thirty-two-characters", LOG_LEVEL: "silent", PERSISTENCE_DRIVER: "memory", PQ_SIGNING_SEED: Buffer.alloc(32, 23).toString("base64") });
    app = await buildApp({ config, store, logger: false, governance: { atlasUrl: "https://atlas.test", trustProofUrl: "https://tp.test", fetchImpl: fakes.fetchImpl } });
    const register = async (email: string) => {
      const response = await app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { email, name: "Gate Test", organizationName: "Gate Org", password: "Correct Horse Battery 123!" } });
      return JSON.parse(response.payload) as { data: { accessToken: string; user: { id: string }; organization: { id: string } } };
    };
    ownerToken = (await register("rg-owner@example.com")).data.accessToken;
    const viewer = await register("rg-viewer@example.com");
    store.setRoleForTesting(viewer.data.user.id, viewer.data.organization.id, "viewer");
    viewerToken = (JSON.parse((await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "rg-viewer@example.com", password: "Correct Horse Battery 123!" } })).payload) as { data: { accessToken: string } }).data.accessToken;
    otherToken = (await register("rg-other@example.com")).data.accessToken;
    baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  });
  afterAll(async () => { await app.close(); });

  const call = (method: "GET" | "POST" | "PUT", url: string, token: string, payload?: object) =>
    app.inject({ method, url: `/api/v1/console${url}`, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });
  const runtime = (method: "GET" | "POST", url: string, token: string, payload?: object) =>
    app.inject({ method, url: `/api/v1/runtime${url}`, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });
  const data = <T>(res: { payload: string }) => (JSON.parse(res.payload) as { data: T }).data;
  type Key = { id: string; key?: string; prefix: string; state: string; receiptSeq?: number | null };

  it("only admins create keys; the key is shown once and only its hash is kept", async () => {
    expect((await call("POST", "/runtime-keys", viewerToken, { name: "viewer key" })).statusCode).toBe(403);
    expect((await call("POST", "/runtime-keys", ownerToken, { name: "x" })).statusCode).toBe(400);
    const created = await call("POST", "/runtime-keys", ownerToken, { name: "Payments runtime" });
    expect(created.statusCode).toBe(201);
    const body = data<Key>(created);
    expect(body.key).toMatch(/^rgk_[0-9a-f-]{36}_[A-Za-z0-9_-]{43}$/);
    expect(body.receiptSeq).toBeGreaterThan(0);
    key = body.key!;
    keyId = body.id;
    const listed = data<{ keys: Array<Record<string, unknown>> }>(await call("GET", "/runtime-keys", ownerToken)).keys;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: keyId, name: "Payments runtime", state: "active" });
    expect(JSON.stringify(listed)).not.toContain(key.slice(-43));
    expect(listed[0]).not.toHaveProperty("keyHash");
    expect((await call("GET", "/runtime-keys", viewerToken)).statusCode).toBe(403);
    otherKey = data<Key>(await call("POST", "/runtime-keys", otherToken, { name: "Other workspace" })).key!;
  });

  it("a runtime key works on the gate routes only, and a missing or forged key is refused", async () => {
    expect((await runtime("POST", "/gate/check", "", { agentId: "pay-bot", action: "invoices:pay" })).statusCode).toBe(401);
    expect((await runtime("POST", "/gate/check", key.slice(0, -1) + (key.endsWith("A") ? "B" : "A"), { agentId: "pay-bot", action: "invoices:pay" })).statusCode).toBe(401);
    expect((await runtime("POST", "/gate/check", ownerToken, { agentId: "pay-bot", action: "invoices:pay" })).statusCode).toBe(401); // a person's token is not a runtime key
    expect((await call("GET", "/runtime-keys", key)).statusCode).toBe(401);
    expect((await call("GET", "/gates/decisions", key)).statusCode).toBe(401);
    expect((await call("POST", "/gates/check", key, { agentId: "pay-bot", action: "invoices:pay" })).statusCode).toBe(401);
  });

  it("same decisions as the console gate: needs-approval before activation, then allowed / blocked / high impact", async () => {
    const before = await runtime("POST", "/gate/check", key, { agentId: "pay-bot", action: "invoices:pay", amountUsd: 10 });
    expect(before.statusCode).toBe(202);
    expect(data<{ decision: string; certificateSource: string }>(before)).toMatchObject({ decision: "needs-approval", certificateSource: "not-activated" });
    expect((await call("POST", "/link", ownerToken)).statusCode).toBe(200);
    expect((await call("POST", "/certificates", ownerToken, { agentId: "pay-bot", agentName: "Pay bot", permissions: ["invoices:pay"], limits: { maxAmountUsd: 500 } })).statusCode).toBe(201);
    expect((await call("PUT", "/gates", ownerToken, { defaultImpact: "low", rules: [{ action: "invoices:*", impact: "medium", highAboveUsd: 200 }] })).statusCode).toBe(200);
    const ok = await runtime("POST", "/gate/check", key, { agentId: "pay-bot", action: "invoices:pay", resource: "INV-1", amountUsd: 100 });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["cache-control"]).toBe("no-store");
    expect(data<{ decision: string }>(ok).decision).toBe("allowed");
    expect((await runtime("POST", "/gate/check", key, { agentId: "pay-bot", action: "email:send" })).statusCode).toBe(403);
    expect((await runtime("POST", "/gate/check", key, { agentId: "pay-bot", action: "invoices:pay", extra: 1 })).statusCode).toBe(400);
    const high = await runtime("POST", "/gate/check", key, { agentId: "pay-bot", action: "invoices:pay", amountUsd: 300 });
    expect(high.statusCode).toBe(202);
    const decisions = data<Array<{ by?: string; decision: string }>>(await call("GET", "/gates/decisions", ownerToken));
    expect(decisions.some((d) => d.by === `runtime-key:${keyId}`)).toBe(true);
  });

  it("approvals: the key reads only requests it opened; a person decides them (the key is never the self-approver)", async () => {
    const requestId = data<{ requestId: string }>(await runtime("POST", "/gate/check", key, { agentId: "pay-bot", action: "invoices:pay", resource: "INV-9", amountUsd: 450 })).requestId;
    expect(data<{ state: string }>(await runtime("GET", `/approvals/${requestId}`, key)).state).toBe("pending");
    expect((await runtime("GET", `/approvals/${requestId}`, otherKey)).statusCode).toBe(404);
    const consoleRequestId = data<{ requestId: string }>(await call("POST", "/gates/check", ownerToken, { agentId: "pay-bot", action: "invoices:pay", amountUsd: 400 })).requestId;
    expect((await runtime("GET", `/approvals/${consoleRequestId}`, key)).statusCode).toBe(404);
    const decided = await call("POST", `/action-approvals/${requestId}/decide`, ownerToken, { decision: "approve", note: "Checked INV-9 with finance." });
    expect(decided.statusCode).toBe(200);
    const after = data<{ state: string; decidedByName: string; receiptSeq: number }>(await runtime("GET", `/approvals/${requestId}`, key));
    expect(after.state).toBe("approved");
    expect(after.decidedByName).toBe("Gate Test");
    expect(after).not.toHaveProperty("noteSha256");
  });

  it("workspace isolation: another workspace's key sees its own (not activated) workspace", async () => {
    const res = await runtime("POST", "/gate/check", otherKey, { agentId: "pay-bot", action: "invoices:pay", amountUsd: 10 });
    expect(data<{ certificateSource: string }>(res).certificateSource).toBe("not-activated");
    expect(data<unknown[]>(await call("GET", "/gates/decisions", otherToken)).length).toBe(1);
  });

  it("the SDK against this server: allowed, blocked, approval polled to approved, timeout when unreachable", async () => {
    const gate = createRuntimeGate({ consoleUrl: baseUrl, gateKey: key, agentId: "pay-bot", pollMs: 20, timeoutMs: 3000 });
    expect(await gate.check("invoices:pay", { resource: "INV-2", amountUsd: 20 })).toMatchObject({ allowed: true, decision: "allowed" });
    expect(await gate.check("email:send")).toMatchObject({ allowed: false, decision: "blocked" });
    const pending = await gate.check("invoices:pay", { amountUsd: 480 });
    expect(pending).toMatchObject({ allowed: false, decision: "needs-approval" });
    const waiting = (gate as unknown as { waitForApproval: (id: string, ms: number) => Promise<{ state: string }> }).waitForApproval(pending.requestId!, 5000);
    await call("POST", `/action-approvals/${pending.requestId}/decide`, ownerToken, { decision: "decline", note: "Not this month." });
    expect((await waiting).state).toBe("declined");
    const dead = createRuntimeGate({ consoleUrl: "http://127.0.0.1:9", gateKey: key, agentId: "pay-bot", timeoutMs: 300, retries: 0 });
    expect(await dead.check("invoices:pay")).toMatchObject({ allowed: false, decision: "unavailable" });
  });

  it("revoking a key stops it at once; revoke is admin-only, signed, and not repeatable", async () => {
    expect((await call("POST", `/runtime-keys/${keyId}/revoke`, viewerToken)).statusCode).toBe(403);
    const revoked = await call("POST", `/runtime-keys/${keyId}/revoke`, ownerToken);
    expect(revoked.statusCode).toBe(200);
    expect(data<Key>(revoked)).toMatchObject({ state: "revoked" });
    expect((await call("POST", `/runtime-keys/${keyId}/revoke`, ownerToken)).statusCode).toBe(409);
    expect((await runtime("POST", "/gate/check", key, { agentId: "pay-bot", action: "invoices:pay", amountUsd: 10 })).statusCode).toBe(401);
    const receipts = data<{ receipts: Array<{ type: string; receipt: unknown }> }>(await call("GET", "/receipts", ownerToken)).receipts;
    const signed = receipts.filter((r) => r.type === "runtime-key-created" || r.type === "runtime-key-revoked");
    expect(signed.map((r) => r.type).sort()).toEqual(["runtime-key-created", "runtime-key-revoked"]);
    for (const r of signed) expect(data<{ verdict: string }>(await app.inject({ method: "POST", url: "/api/v1/public/verify", payload: { receipt: r.receipt } })).verdict).toBe("PASS");
  });

  it("the account export lists the keys without their hash and names the left-out field", async () => {
    const exported = await app.inject({ method: "POST", url: "/api/v1/auth/export", headers: { authorization: `Bearer ${ownerToken}` }, payload: {} });
    expect(exported.statusCode).toBe(200);
    const text = exported.rawPayload.toString("latin1");
    expect(text).toContain("Payments runtime");
    expect(text).not.toContain('"keyHash":');
    expect(text).toContain("data.keyHash");
  });

  it("the SDK's own tests pass (fake servers on 127.0.0.1)", () => {
    const out = execFileSync(process.execPath, ["--test", "test.js"], { cwd: SDK_DIR, encoding: "utf8", timeout: 60_000 });
    expect(out).toMatch(/# fail 0|ℹ fail 0/);
  });
});
