import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import { MemoryStore } from "../src/persistence/memory-store.js";
import { governanceFakes } from "./governance-fakes.js";
import type { PrismaClient } from "@prisma/client";
import { PrismaStore } from "../src/persistence/prisma-store.js";
import { EmailVault } from "../src/persistence/email-vault.js";
import { openTestDatabase } from "./helpers.js";

// Set ACG_TEST_DATABASE_URL to a disposable local database that has had `prisma migrate deploy` run.
const databaseUrl = process.env.ACG_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)("console records on Postgres", () => {
  let client: PrismaClient;
  let store: PrismaStore;
  beforeAll(async () => {
    client = await openTestDatabase(databaseUrl!);
    store = new PrismaStore(client, new EmailVault(Buffer.alloc(32, 7)));
    await store.reset();
  });
  afterAll(async () => { await store.reset(); await client.$disconnect(); });

  it("stores data sealed at rest, upserts by (workspace, kind, key), and goes with the workspace", async () => {
    const reg = await store.createRegistration({ email: "pg-records@example.com", name: "PG", passwordHash: "hash", organizationName: "PG Org" });
    const orgId = reg.organization.id;
    await store.saveConsoleRecord({ organizationId: orgId, kind: "agent", key: "bot-1", data: { owner: "Finance lead secret-marker" } });
    await store.saveConsoleRecord({ organizationId: orgId, kind: "agent", key: "bot-1", data: { owner: "Finance lead v2" } });
    await store.saveConsoleRecord({ organizationId: orgId, kind: "incident", key: "i-1", data: { what: "x" } });
    const raw = await client.$queryRawUnsafe<Array<{ data: unknown }>>(`SELECT data FROM "ConsoleRecord" WHERE "organizationId" = '${orgId}'::uuid`);
    expect(JSON.stringify(raw)).not.toContain("Finance lead");
    expect(JSON.stringify(raw)).toContain("enc:v1:");
    expect((await store.getConsoleRecord(orgId, "agent", "bot-1"))?.data).toEqual({ owner: "Finance lead v2" });
    expect(await store.listConsoleRecords(orgId, "agent")).toHaveLength(1);
    expect(await store.deleteConsoleRecord(orgId, "incident", "i-1")).toBe(true);
    expect(await store.deleteConsoleRecord(orgId, "incident", "i-1")).toBe(false);
    await store.deleteOrganization(orgId);
    expect(await client.consoleRecord.count({ where: { organizationId: orgId } })).toBe(0);
  });
});

// Console governance records (knock-out Phase 5): agent inventory (AD-056) and the items built on it.
// A fake Authority Atlas and Trust Proof stand in for the real services (tests/governance-fakes.ts).

describe("console governance records", () => {
  let app: FastifyInstance;
  const store = new MemoryStore();
  const fakes = governanceFakes();
  let ownerToken: string;
  let viewerToken: string;
  let otherToken: string;
  let orgId: string;

  beforeAll(async () => {
    const config = loadConfig({ NODE_ENV: "test", JWT_SECRET: "test-secret-with-at-least-thirty-two-characters", LOG_LEVEL: "silent", PERSISTENCE_DRIVER: "memory", PQ_SIGNING_SEED: Buffer.alloc(32, 21).toString("base64") });
    app = await buildApp({ config, store, logger: false, governance: { atlasUrl: "https://atlas.test", trustProofUrl: "https://tp.test", fetchImpl: fakes.fetchImpl } });
    const register = async (email: string) => {
      const response = await app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { email, name: "Records Test", organizationName: "Records Org", password: "Correct Horse Battery 123!" } });
      return JSON.parse(response.payload) as { data: { accessToken: string; user: { id: string }; organization: { id: string } } };
    };
    const owner = await register("records-owner@example.com");
    ownerToken = owner.data.accessToken;
    orgId = owner.data.organization.id;
    const viewer = await register("records-viewer@example.com");
    store.setRoleForTesting(viewer.data.user.id, viewer.data.organization.id, "viewer");
    viewerToken = (JSON.parse((await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "records-viewer@example.com", password: "Correct Horse Battery 123!" } })).payload) as { data: { accessToken: string } }).data.accessToken;
    otherToken = (await register("records-other@example.com")).data.accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  const call = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, token: string, payload?: object) =>
    app.inject({ method, url: `/api/v1/console${url}`, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });
  const data = <T>(res: { payload: string }) => (JSON.parse(res.payload) as { data: T }).data;
  const receipts = async () => data<{ chain: { intact: boolean }; receipts: Array<{ seq: number; type: string; receipt: Record<string, unknown> }> }>(await call("GET", "/receipts", ownerToken));
  const publicVerify = async (receipt: unknown) => data<{ verdict: string; type?: string; facts?: Record<string, unknown> }>(await app.inject({ method: "POST", url: "/api/v1/public/verify", payload: { receipt } }));
  const tamper = (receipt: Record<string, unknown>) => ({ ...receipt, facts: { ...(receipt.facts as object), tampered: true } });

  describe("AD-056 agent inventory", () => {
    it("before activation every status is 'not verified', never 'no certificate'", async () => {
      await call("PUT", "/agents/invoice-bot", ownerToken, { name: "Invoice bot", owner: "Finance operations lead", vendor: "Acme AI", purpose: "Pays approved invoices", dataAccess: ["ERP invoices", "vendor bank details"] });
      const res = await call("GET", "/agents", ownerToken);
      expect(res.statusCode).toBe(200);
      const body = data<{ certificateSource: string; agents: Array<{ agentId: string; status: string; owner: string }> }>(res);
      expect(body.certificateSource).toBe("not-activated");
      expect(body.agents).toEqual([expect.objectContaining({ agentId: "invoice-bot", status: "not verified", owner: "Finance operations lead" })]);
    });

    it("after activation, merges entered details with live certificate status from Atlas", async () => {
      expect((await call("POST", "/link", ownerToken)).statusCode).toBe(200);
      const issued = await call("POST", "/certificates", ownerToken, { agentId: "invoice-bot", agentName: "Invoice bot", permissions: ["invoices:pay"], limits: { maxAmountUsd: 500 } });
      expect(issued.statusCode).toBe(201);
      await call("POST", "/certificates", ownerToken, { agentId: "email-bot", agentName: "Email bot", permissions: ["email:send"] });
      const body = data<{ certificateSource: string; agents: Array<{ agentId: string; status: string; registered: boolean; certificates: { active: number } }> }>(await call("GET", "/agents", ownerToken));
      expect(body.certificateSource).toBe("authority-atlas");
      const invoice = body.agents.find((a) => a.agentId === "invoice-bot")!;
      const email = body.agents.find((a) => a.agentId === "email-bot")!;
      expect(invoice).toMatchObject({ status: "active", registered: true, certificates: expect.objectContaining({ active: 1 }) });
      expect(email).toMatchObject({ status: "active", registered: false });
    });

    it("when Atlas cannot be read, statuses read 'not verified' (three-state)", async () => {
      fakes.state.atlasDown = true;
      let body: { certificateSource: string; agents: Array<{ status: string; certificates: unknown }> };
      try { body = data(await call("GET", "/agents", ownerToken)); } finally { fakes.state.atlasDown = false; }
      expect(body.certificateSource).toBe("not-verified");
      expect(body.agents.every((a) => a.status === "not verified" && a.certificates === null)).toBe(true);
    });

    it("exports a CSV that neutralises spreadsheet formulas", async () => {
      await call("PUT", "/agents/formula-bot", ownerToken, { name: "=HYPERLINK(\"x\")", owner: "IT", dataAccess: [] });
      const res = await call("GET", "/agents.csv", ownerToken);
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("text/csv");
      expect(res.payload.split("\n")[0]).toContain("agent_id,name,owner");
      expect(res.payload).toContain("'=HYPERLINK");
    });

    it("validates input and roles", async () => {
      expect((await call("PUT", "/agents/bad id!", ownerToken, { name: "x", owner: "IT" })).statusCode).toBe(400);
      expect((await call("PUT", "/agents/x", ownerToken, { name: "x", owner: "IT", extra: 1 })).statusCode).toBe(400);
      expect((await call("PUT", "/agents/x", viewerToken, { name: "x", owner: "IT" })).statusCode).toBe(403);
      expect((await call("DELETE", "/agents/formula-bot", ownerToken)).statusCode).toBe(200);
      expect((await call("DELETE", "/agents/formula-bot", ownerToken)).statusCode).toBe(404);
    });

    it("another workspace sees none of it", async () => {
      const body = data<{ agents: unknown[] }>(await call("GET", "/agents", otherToken));
      expect(body.agents).toEqual([]);
      expect(await store.listConsoleRecords(orgId, "agent")).toHaveLength(1);
    });
  });

  describe("AD-058 periodic re-certification", () => {
    it("lists agents with a due date from the first certificate (default 90 days)", async () => {
      const body = data<{ cadenceDays: number; agents: Array<{ agentId: string; state: string; dueAt: string | null; lastRecertifiedAt: string | null }> }>(await call("GET", "/recertification", ownerToken));
      expect(body.cadenceDays).toBe(90);
      const invoice = body.agents.find((a) => a.agentId === "invoice-bot")!;
      expect(invoice.lastRecertifiedAt).toBeNull();
      expect(invoice.state).toBe("not yet re-certified");
      expect(Date.parse(invoice.dueAt!) - Date.now()).toBeGreaterThan(88 * 864e5);
    });

    it("an admin re-certifies: decision recorded, next due date, signed receipt that /verify passes", async () => {
      const res = await call("POST", "/agents/invoice-bot/recertify", ownerToken, { decision: "keep", note: "Permissions still match the payables process." });
      expect(res.statusCode).toBe(201);
      const out = data<{ nextDueAt: string; receiptSeq: number }>(res);
      expect(out.receiptSeq).toBeGreaterThan(0);
      const r = (await receipts()).receipts.find((x) => x.type === "agent-recertified")!;
      expect(r.receipt.facts).toMatchObject({ decision: "keep", cadenceDays: 90 });
      expect(JSON.stringify(r.receipt)).not.toContain("payables process");
      expect((await publicVerify(r.receipt)).verdict).toBe("PASS");
      expect((await publicVerify(tamper(r.receipt))).verdict).toBe("FAIL");
      const after = data<{ agents: Array<{ agentId: string; state: string; lastDecision: string }> }>(await call("GET", "/recertification", ownerToken));
      expect(after.agents.find((a) => a.agentId === "invoice-bot")).toMatchObject({ state: "current", lastDecision: "keep" });
    });

    it("cadence is configurable (30-365) by admins only; viewers and unknown agents refused", async () => {
      expect((await call("PUT", "/recertification/settings", ownerToken, { cadenceDays: 20 })).statusCode).toBe(400);
      expect((await call("PUT", "/recertification/settings", viewerToken, { cadenceDays: 60 })).statusCode).toBe(403);
      expect((await call("PUT", "/recertification/settings", ownerToken, { cadenceDays: 60 })).statusCode).toBe(200);
      expect(data<{ cadenceDays: number }>(await call("GET", "/recertification", ownerToken)).cadenceDays).toBe(60);
      expect((await call("POST", "/agents/invoice-bot/recertify", viewerToken, { decision: "keep", note: "x x x" })).statusCode).toBe(403);
      expect((await call("POST", "/agents/no-such-bot/recertify", ownerToken, { decision: "keep", note: "x x x" })).statusCode).toBe(404);
      const revoke = data<{ next?: string }>(await call("POST", "/agents/email-bot/recertify", ownerToken, { decision: "revoke-requested", note: "No longer needed." }));
      expect(revoke.next).toMatch(/kill switch/);
    });
  });

  describe("account deletion removes the records", () => {
    it("deleting the sole owner's account deletes the workspace's console records", async () => {
      const res = await app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { email: "records-del@example.com", name: "Del", organizationName: "Del Org", password: "Correct Horse Battery 123!" } });
      const reg = JSON.parse(res.payload) as { data: { accessToken: string; organization: { id: string } } };
      await call("PUT", "/agents/temp-bot", reg.data.accessToken, { name: "Temp", owner: "IT" });
      expect(await store.listConsoleRecords(reg.data.organization.id, "agent")).toHaveLength(1);
      const del = await app.inject({ method: "POST", url: "/api/v1/auth/delete-account", headers: { authorization: `Bearer ${reg.data.accessToken}` }, payload: { password: "Correct Horse Battery 123!" } });
      expect(del.statusCode).toBe(200);
      expect(await store.listConsoleRecords(reg.data.organization.id, "agent")).toHaveLength(0);
    });
  });
});
