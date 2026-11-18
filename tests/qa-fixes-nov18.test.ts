import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import { recordReceipt } from "../src/evidence/receipts.js";
import { MemoryStore } from "../src/persistence/memory-store.js";
import { OutboxMailer } from "../src/security/mailer.js";
import { governanceFakes } from "./governance-fakes.js";
import { agentInput } from "./helpers.js";

// QA 2026-11-18 (AI Agent Trust console; F21 issuer link is in issuer-link.test.ts): F24 public verify with pack + receipt, F25 agent PATCH,
// F27 who may issue certificates, F33 teammate confirmation email + own password first, F34 API docs in
// production, and the two items QA could not test: agent register edit (AD-056) and agent retirement (N-AT-09).

const SEED = Buffer.alloc(32, 31).toString("base64");
const PASSWORD = "Correct Horse Battery 123!";
type Res = { statusCode: number; payload: string };
const data = <T>(res: Res) => (JSON.parse(res.payload) as { data: T }).data;

describe("QA 2026-11-18 console fixes", () => {
  let app: FastifyInstance;
  let dir: string;
  const store = new MemoryStore();
  const outbox = new OutboxMailer();
  const fakes = governanceFakes();
  let ownerToken: string;
  let orgId: string;
  let otherToken: string;

  const call = (method: string, url: string, token: string | null, payload?: unknown) =>
    app.inject({ method: method as "GET", url, headers: token ? { authorization: `Bearer ${token}` } : {}, ...(payload === undefined ? {} : { payload: payload as object }) });
  const verifyEmail = async (to: string) => {
    const token = outbox.last(to)?.text.match(/\/account#verify=([A-Za-z0-9_-]{43})/)?.[1];
    expect(token, "a confirmation link was emailed to " + to).toBeTruthy();
    expect((await call("POST", "/api/v1/auth/verify-email", null, { token })).statusCode).toBe(200);
  };
  const register = async (email: string) => {
    const res = await call("POST", "/api/v1/auth/register", null, { email, name: "QA Fix", organizationName: "QA Fix Org " + email, password: PASSWORD });
    const body = data<{ accessToken: string; organization: { id: string } }>(res);
    await verifyEmail(email);
    return body;
  };
  const login = async (email: string, password: string) => data<{ accessToken: string; mustChangePassword?: boolean }>(await call("POST", "/api/v1/auth/login", null, { email, password }));

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "qa-1118-"));
    const config = loadConfig({ NODE_ENV: "test", JWT_SECRET: "test-secret-with-at-least-thirty-two-characters", UPLOAD_DIRECTORY: dir, LOG_LEVEL: "silent", PERSISTENCE_DRIVER: "memory", EMAIL_VERIFICATION: "1", PQ_SIGNING_SEED: SEED });
    app = await buildApp({ config, store, logger: false, mailer: outbox, governance: { atlasUrl: "https://atlas.test", trustProofUrl: "https://tp.test", fetchImpl: fakes.fetchImpl } });
    await app.ready();
    const owner = await register("qa1118-owner@example.com");
    ownerToken = owner.accessToken;
    orgId = owner.organization.id;
    otherToken = (await register("qa1118-other@example.com")).accessToken;
  });
  afterAll(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  describe("F27: issuing a certificate needs admin, like revoking", () => {
    let analystToken: string;
    beforeAll(async () => {
      await store.addMember(orgId, { email: "qa1118-analyst@example.com", name: "Analyst", passwordHash: await bcrypt.hash(PASSWORD, 4), role: "analyst" });
      const user = await store.findUserByEmail("qa1118-analyst@example.com");
      await store.setEmailVerified(user!.id, new Date().toISOString());
      analystToken = (await login("qa1118-analyst@example.com", PASSWORD)).accessToken;
    });
    const cert = { agentId: "pay-bot", agentName: "Pay Bot", permissions: ["invoices:pay"], limits: { maxAmountUsd: 900000 }, expiresInDays: 30 };
    it("an analyst gets 403 and nothing is issued", async () => {
      const before = fakes.certs.length;
      const res = await call("POST", "/api/v1/console/certificates", analystToken, cert);
      expect(res.statusCode).toBe(403);
      expect(fakes.certs.length).toBe(before);
    });
    it("an admin (the owner) issues it", async () => {
      expect((await call("POST", "/api/v1/console/certificates", ownerToken, cert)).statusCode).toBe(201);
    });
  });

  describe("F33: a teammate added by the owner", () => {
    let temporaryPassword: string;
    it("gets a confirmation email (never the password) and must choose their own password first", async () => {
      const res = await call("POST", "/api/v1/console/team", ownerToken, { name: "New Mate", email: "qa1118-mate@example.com", role: "admin" });
      expect(res.statusCode).toBe(201);
      const body = data<{ temporaryPassword: string; confirmationEmailSent: boolean; mustChangePassword: boolean }>(res);
      temporaryPassword = body.temporaryPassword;
      expect(body.confirmationEmailSent).toBe(true);
      expect(body.mustChangePassword).toBe(true);
      const mail = outbox.last("qa1118-mate@example.com");
      expect(mail?.text).toMatch(/\/account#verify=/);
      expect(mail?.text).not.toContain(temporaryPassword);
    });
    it("with the one-time password only choosing a password (and /me) works", async () => {
      await verifyEmail("qa1118-mate@example.com");
      const first = await login("qa1118-mate@example.com", temporaryPassword);
      expect(first.mustChangePassword).toBe(true);
      const blocked = await call("GET", "/api/v1/console/status", first.accessToken);
      expect(blocked.statusCode).toBe(403);
      expect((JSON.parse(blocked.payload) as { error: { code: string } }).error.code).toBe("PASSWORD_CHANGE_REQUIRED");
      expect((await call("GET", "/api/v1/projects", first.accessToken)).statusCode).toBe(403);
      const me = await call("GET", "/api/v1/auth/me", first.accessToken);
      expect(me.statusCode).toBe(200);
      expect(data<{ mustChangePassword?: boolean }>(me).mustChangePassword).toBe(true);
      const changed = await call("POST", "/api/v1/auth/change-password", first.accessToken, { currentPassword: temporaryPassword, newPassword: "Mate Own Passphrase 77!" });
      expect(changed.statusCode).toBe(200);
      const own = data<{ accessToken: string }>(changed).accessToken;
      expect((await call("GET", "/api/v1/console/status", own)).statusCode).toBe(200);
      expect((await call("POST", "/api/v1/auth/login", null, { email: "qa1118-mate@example.com", password: temporaryPassword })).statusCode).toBe(401);
      const again = await login("qa1118-mate@example.com", "Mate Own Passphrase 77!");
      expect(again.mustChangePassword).toBeUndefined();
    });
    it("people who register themselves are never asked to change their password", async () => {
      const res = await call("GET", "/api/v1/console/status", ownerToken);
      expect(res.statusCode).toBe(200);
    });
  });

  describe("F25: editing an agent profile through the API", () => {
    let agentId: string;
    beforeAll(async () => {
      const project = data<{ id: string }>(await call("POST", "/api/v1/projects", ownerToken, { name: "QA 1118", description: "Fictional", primaryCountryCode: "US", primarySubdivisionCode: "US-IL", affectedCountryCodes: [] }));
      agentId = data<{ id: string }>(await call("POST", `/api/v1/projects/${project.id}/agents`, ownerToken, agentInput({}))).id;
    });
    it("PATCH with a new name works (was 500)", async () => {
      const res = await call("PATCH", `/api/v1/agents/${agentId}`, ownerToken, { name: "New name" });
      expect(res.statusCode).toBe(200);
      expect(data<{ name: string }>(res).name).toBe("New name");
    });
    it("another workspace gets 404, not 500, and nothing changes", async () => {
      const res = await call("PATCH", `/api/v1/agents/${agentId}`, otherToken, { name: "Hijack" });
      expect(res.statusCode).toBe(404);
      expect(data<{ name: string }>(await call("GET", `/api/v1/agents/${agentId}`, ownerToken)).name).toBe("New name");
    });
    it("the spending rule still holds on the profile after the change", async () => {
      // agentInput() is a spending agent (USD 5,000 per transaction). Switching spending off while its limits stay
      // would break the rule "limits require canSpendMoney", checked on the merged profile.
      const off = await call("PATCH", `/api/v1/agents/${agentId}`, ownerToken, { canSpendMoney: false });
      expect(off.statusCode).toBe(400);
      expect(off.payload).toContain("Spending limits require canSpendMoney=true");
      expect(data<{ canSpendMoney: boolean }>(await call("GET", `/api/v1/agents/${agentId}`, ownerToken)).canSpendMoney).toBe(true);
      const ok = await call("PATCH", `/api/v1/agents/${agentId}`, ownerToken, { perTransactionLimit: 50 });
      expect(ok.statusCode).toBe(200);
      expect(data<{ perTransactionLimit: number }>(ok).perTransactionLimit).toBe(50);
      expect((await call("PATCH", `/api/v1/agents/${agentId}`, ownerToken, { name: "x" })).statusCode).toBe(400);
      expect((await call("PATCH", `/api/v1/agents/${agentId}`, ownerToken, { autonomyLevel: 9 })).statusCode).toBe(400);
    });
  });

  describe("F24: public check of a downloaded pack file that carries its receipt", () => {
    let file: { pack: Record<string, unknown>; contentHash: string; signature: unknown };
    let receipt: Record<string, unknown>;
    const verify = async (body: unknown) => data<{ kind: string; verdict: string; reason: string | null; receipt?: string }>(await call("POST", "/api/v1/public/verify", null, body));
    beforeAll(async () => {
      file = JSON.parse((await call("GET", "/sample/assurance-pack.json", null)).payload) as typeof file;
      const saved = await recordReceipt(store, app.pqSigner, { orgId, type: "assurance-pack", subject: { kind: "analysis", id: "qa-1118" }, facts: { contentHash: file.contentHash } });
      receipt = saved!.receipt;
    });
    it("genuine pack + its receipt: PASS", async () => {
      const r = await verify({ ...file, receipt });
      expect(r.verdict).toBe("PASS");
      expect(r.kind).toBe("assurance-pack");
      expect(r.receipt).toBe("PASS");
    });
    it("edited pack + genuine receipt: FAIL (was PASS on the receipt alone)", async () => {
      for (const pack of [{ ...file.pack, organization: "Someone Else Ltd" }, { ...file.pack, findings: [] }]) {
        const r = await verify({ ...file, pack, receipt });
        expect(r.verdict).toBe("FAIL");
        expect(r.kind).toBe("assurance-pack");
      }
      expect((await verify({ ...file, signature: undefined, pack: { ...file.pack, organization: "X" }, receipt })).verdict).toBe("FAIL");
    });
    it("genuine pack + a changed receipt, or another pack's receipt: FAIL", async () => {
      expect((await verify({ ...file, receipt: { ...receipt, facts: { contentHash: "0".repeat(64) } } })).verdict).toBe("FAIL");
      const other = await recordReceipt(store, app.pqSigner, { orgId, type: "assurance-pack", subject: { kind: "analysis", id: "qa-1118-b" }, facts: { contentHash: "a".repeat(64) } });
      const r = await verify({ ...file, receipt: other!.receipt });
      expect(r.verdict).toBe("FAIL");
      expect(r.reason).toMatch(/different pack/);
    });
    it("a receipt on its own is still checked as a receipt", async () => {
      expect((await verify({ receipt })).verdict).toBe("PASS");
    });
  });

  describe("AD-056 agent register: edit an entry (QA could not test it)", () => {
    it("registering, then editing, changes the inventory and the CSV; another workspace sees nothing", async () => {
      expect((await call("PUT", "/api/v1/console/agents/ledger-bot", ownerToken, { name: "Ledger bot", owner: "Finance lead", vendor: "Acme AI", purpose: "Books invoices", dataAccess: ["ERP"] })).statusCode).toBe(200);
      const edited = await call("PUT", "/api/v1/console/agents/ledger-bot", ownerToken, { name: "Ledger bot v2", owner: "Controller", vendor: "Acme AI", purpose: "Books and pays invoices", dataAccess: ["ERP", "Bank portal"] });
      expect(edited.statusCode).toBe(200);
      const list = data<{ agents: Array<{ agentId: string; name: string; owner: string; dataAccess: string[] }> }>(await call("GET", "/api/v1/console/agents", ownerToken));
      const row = list.agents.find((a) => a.agentId === "ledger-bot");
      expect(row).toMatchObject({ name: "Ledger bot v2", owner: "Controller", dataAccess: ["ERP", "Bank portal"] });
      expect(list.agents.filter((a) => a.agentId === "ledger-bot")).toHaveLength(1);
      const csv = (await call("GET", "/api/v1/console/agents.csv", ownerToken)).payload;
      expect(csv).toContain("Ledger bot v2");
      expect(csv).not.toContain("Finance lead");
      const other = data<{ agents: Array<{ agentId: string }> }>(await call("GET", "/api/v1/console/agents", otherToken));
      expect(other.agents.some((a) => a.agentId === "ledger-bot")).toBe(false);
      // the request shape is strict: an unknown field is refused, which is what QA's attempts hit
      expect((await call("PUT", "/api/v1/console/agents/ledger-bot", ownerToken, { name: "x", owner: "IT", agentId: "ledger-bot" })).statusCode).toBe(400);
    });
  });

  describe("N-AT-09 agent retirement (QA could not test it)", () => {
    it("refused while a certificate is active; after revoking, retired with a signed receipt, once only", async () => {
      const issued = data<{ jti: string }>(await call("POST", "/api/v1/console/certificates", ownerToken, { agentId: "retire-bot", agentName: "Retire Bot", permissions: ["loads:read"], expiresInDays: 30 }));
      const still = await call("POST", "/api/v1/console/agents/retire-bot/retire", ownerToken, { reason: "Replaced by a new agent" });
      expect(still.statusCode).toBe(409);
      expect((await call("POST", `/api/v1/console/certificates/${issued.jti}/revoke`, ownerToken, {})).statusCode).toBe(200);
      const done = await call("POST", "/api/v1/console/agents/retire-bot/retire", ownerToken, { reason: "Replaced by a new agent" });
      expect(done.statusCode).toBe(201);
      const body = data<{ receiptSeq: number; certificates: { active: number; revoked: string[] } }>(done);
      expect(body.certificates.active).toBe(0);
      expect(body.certificates.revoked).toContain(issued.jti);
      expect(typeof body.receiptSeq).toBe("number");
      expect((await call("POST", "/api/v1/console/agents/retire-bot/retire", ownerToken, { reason: "Again please" })).statusCode).toBe(409);
      expect((await call("GET", "/api/v1/console/agents/retire-bot/retirement", otherToken)).statusCode).toBe(404);
    });
  });
});

// The Postgres store: the F33 flag survives a round trip and is cleared by a password change; F21 backfill listing.
const databaseUrl = process.env.ACG_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)("QA 2026-11-18 on Postgres", () => {
  it("mustChangePassword is stored for a console teammate only, and cleared by setPassword; service links are listed", async () => {
    const { openTestDatabase } = await import("./helpers.js");
    const { PrismaStore } = await import("../src/persistence/prisma-store.js");
    const { EmailVault } = await import("../src/persistence/email-vault.js");
    const client = await openTestDatabase(databaseUrl!);
    const pg = new PrismaStore(client, new EmailVault(Buffer.alloc(32, 9)));
    try {
      const reg = await pg.createRegistration({ email: "pg-1118-owner@example.com", name: "Owner", passwordHash: "hash", organizationName: "PG 1118" });
      expect((await pg.getUser(reg.user.id))?.mustChangePassword).toBe(false);
      await pg.addMember(reg.organization.id, { email: "pg-1118-mate@example.com", name: "Mate", passwordHash: "hash", role: "analyst", mustChangePassword: true });
      await pg.addMember(reg.organization.id, { email: "pg-1118-seed@example.com", name: "Seed", passwordHash: "hash", role: "viewer" });
      const mate = await pg.findUserByEmail("pg-1118-mate@example.com");
      expect(mate?.mustChangePassword).toBe(true);
      expect((await pg.findUserByEmail("pg-1118-seed@example.com"))?.mustChangePassword).toBe(false);
      await pg.setPassword(mate!.id, "hash2", new Date().toISOString());
      expect((await pg.getUser(mate!.id))?.mustChangePassword).toBe(false);
      expect(await pg.listServiceLinkOrganizationIds()).not.toContain(reg.organization.id);
      await pg.saveServiceLink({ organizationId: reg.organization.id, atlasEmail: "a@x.test", atlasSecret: "s", trustProofEmail: "t@x.test", trustProofSecret: "s", trustProofApiKey: "k" });
      expect(await pg.listServiceLinkOrganizationIds()).toContain(reg.organization.id);
      await pg.deleteOrganization(reg.organization.id);
    } finally {
      await client.$disconnect();
    }
  });
});

describe("F34: API documentation in production", () => {
  const base = { JWT_SECRET: "test-secret-with-at-least-thirty-two-characters", LOG_LEVEL: "silent", PERSISTENCE_DRIVER: "memory" } as const;
  const build = async (over: Record<string, string>) => {
    const config = { ...loadConfig({ NODE_ENV: "test", ...base, ...over }), NODE_ENV: "production" as const };
    const app = await buildApp({ config, store: new MemoryStore(), logger: false, certificateVerifier: null, pqSigner: null, mailer: new OutboxMailer() });
    await app.ready();
    return app;
  };
  it("is not served by default", async () => {
    const app = await build({});
    try {
      for (const url of ["/docs", "/docs/json", "/docs/", "/api/v1/openapi.json"]) expect((await app.inject({ method: "GET", url })).statusCode, url).toBe(404);
    } finally {
      await app.close();
    }
  });
  it("is served when API_DOCS_PUBLIC=1", async () => {
    const app = await build({ API_DOCS_PUBLIC: "1" });
    try {
      expect((await app.inject({ method: "GET", url: "/api/v1/openapi.json" })).statusCode).toBe(200);
      expect([200, 302]).toContain((await app.inject({ method: "GET", url: "/docs" })).statusCode);
    } finally {
      await app.close();
    }
  });
});
