import { randomBytes } from "node:crypto";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import bcrypt from "bcryptjs";
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import { createPqSigner } from "../src/crypto/pq-sign.js";
import { MemoryDocumentStorage } from "../src/documents/storage.js";
import { MemoryStore } from "../src/persistence/memory-store.js";
import { PrismaStore } from "../src/persistence/prisma-store.js";
import { EmailVault } from "../src/persistence/email-vault.js";
import type { Store } from "../src/persistence/store.js";
import { openTestDatabase } from "./helpers.js";

// AD-077 self-serve export (knock-out 2026-11-17): POST /api/v1/auth/export -> ZIP of the account + current workspace,
// secrets left out and listed, manifest signed and checkable on the public /verify, owner/admin only, 5 per hour,
// another workspace never appears; and on Postgres sealed fields come out readable and delete leaves zero rows.

const PASSWORD = "Correct Horse Battery 123!";
const signer = createPqSigner(Buffer.alloc(32, 61).toString("base64"))!;
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
let n = 0;
const from = () => ({ remoteAddress: "10.0.0.5", headers: { "x-forwarded-for": `198.51.100.${(n++ % 250) + 1}, 104.16.1.1, 10.1.2.3` } });

// Reads a stored (uncompressed) ZIP: central directory -> names, offsets, sizes.
function unzip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10), cdStart = buf.readUInt32LE(end + 16);
  let p = cdStart;
  for (let i = 0; i < count; i++) {
    const size = buf.readUInt32LE(p + 20), nameLen = buf.readUInt16LE(p + 28), extra = buf.readUInt16LE(p + 30), comment = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    const localName = buf.readUInt16LE(off + 26), localExtra = buf.readUInt16LE(off + 28);
    out.set(name, buf.subarray(off + 30 + localName + localExtra, off + 30 + localName + localExtra + size));
    p += 46 + nameLen + extra + comment;
  }
  return out;
}

async function harness(store: Store, storage: MemoryDocumentStorage, dir: string) {
  const app = await buildApp({
    config: loadConfig({ NODE_ENV: "test", JWT_SECRET: "test-secret-with-at-least-thirty-two-characters", UPLOAD_DIRECTORY: dir, LOG_LEVEL: "silent", EMAIL_VERIFICATION: "0", TRUST_PROXY_HOPS: "3" }),
    store, storage, logger: false, certificateVerifier: null, pqSigner: signer,
  });
  await app.ready();
  const post = (url: string, payload: unknown, token?: string) =>
    app.inject({ method: "POST", url, payload: payload as Record<string, unknown>, ...from(), headers: { ...from().headers, ...(token ? { authorization: "Bearer " + token } : {}) } });
  const register = async (email: string, org: string) => {
    const r = await post("/api/v1/auth/register", { email, name: "Exporter", organizationName: org, password: PASSWORD });
    expect(r.statusCode).toBe(201);
    return r.json().data as { accessToken: string; organization: { id: string }; user: { id: string } };
  };
  // Every kind of record, plus secrets that must never come out.
  const secrets = { twoFactor: "JBSWY3DP" + randomBytes(4).toString("hex").toUpperCase(), atlas: "atlas-secret-" + randomBytes(6).toString("hex"), tp: "tp-secret-" + randomBytes(6).toString("hex"), tpKey: "tpk_" + randomBytes(8).toString("hex"), cert: "eyJcert." + randomBytes(8).toString("hex") + ".sig", token: "tokhash-" + randomBytes(6).toString("hex") };
  const fill = async (orgId: string, userId: string) => {
    const project = await store.createProject(orgId, { name: "Exported project", description: "contracts in scope", primaryCountryCode: "US", primarySubdivisionCode: null, affectedCountryCodes: [] });
    const doc = await app.documentService.upload({ organizationId: orgId, projectId: project.id, uploaderId: userId, filename: "contract.txt", mimeType: "text/plain", buffer: Buffer.from("The agent may not pay invoices above USD 1,000."), documentType: "commercial_contract", countryCode: "US" });
    await store.saveTwoFactor({ userId, secret: secrets.twoFactor, enabledAt: new Date().toISOString(), lastStep: 5, recoveryHashes: ["rh1", "rh2"] });
    await store.saveAuthToken({ userId, purpose: "verify_email" as never, tokenHash: secrets.token + "-" + userId, expiresAt: new Date(Date.now() + 3600e3).toISOString() });
    await store.saveServiceLink({ organizationId: orgId, atlasEmail: "atlas@x.test", atlasSecret: secrets.atlas, trustProofEmail: "tp@x.test", trustProofSecret: secrets.tp, trustProofApiKey: secrets.tpKey });
    await store.addConsoleCertificate({ jti: "jti-" + randomBytes(4).toString("hex"), organizationId: orgId, agentId: "agent-1", certificate: secrets.cert, pqSignature: null });
    await store.saveConsoleRecord({ organizationId: orgId, kind: "incident", key: "inc-1", data: { summary: "Agent paid a duplicate invoice" } });
    return { project, doc };
  };
  return { app, post, register, fill, secrets };
}

describe("account export (memory store)", () => {
  let dir: string; let h: Awaited<ReturnType<typeof harness>>; let store: MemoryStore; let storage: MemoryDocumentStorage;
  beforeAll(async () => { dir = await mkdtemp(path.join(tmpdir(), "gap-export-")); store = new MemoryStore(); storage = new MemoryDocumentStorage(); h = await harness(store, storage, dir); });
  afterAll(async () => { await h.app.close(); await rm(dir, { recursive: true, force: true }); });

  it("owner downloads one ZIP: every kind of record, uploaded file, no secret, signed manifest that /verify checks", async () => {
    const a = await h.register("export-a@exp.test", "Alpha Export Ltd");
    await h.register("export-b@exp.test", "Bravo Secret Ltd");
    await h.fill(a.organization.id, a.user.id);
    const r = await h.post("/api/v1/auth/export", {}, a.accessToken);
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toContain("application/zip");
    const zip = unzip(r.rawPayload);
    const account = JSON.parse(zip.get("account.json")!.toString());
    expect(account.User[0].email).toBe("export-a@exp.test");
    expect(account.User[0].passwordHash).toBeUndefined();
    expect(account.UserTwoFactor[0].secret).toBeUndefined();
    expect(account.UserTwoFactor[0].recoveryHashes).toBeUndefined();
    expect(account.AuthToken[0].tokenHash).toBeUndefined();
    expect(account.twoFactorEnabled).toBe(true);
    for (const model of ["Organization", "OrganizationMember", "Project", "AgentProfile", "Document", "Analysis", "Finding", "AuditEvent", "ServiceLink", "ConsoleCertificate", "ConsoleSubscription", "ConsoleSigner", "EvidenceReceipt", "ConsoleRecord"])
      expect(Array.isArray(JSON.parse(zip.get(`workspace/${model}.json`)!.toString())), model).toBe(true);
    expect(JSON.parse(zip.get("workspace/Project.json")!.toString())[0].name).toBe("Exported project");
    const link = JSON.parse(zip.get("workspace/ServiceLink.json")!.toString())[0];
    expect(link.atlasEmail).toBe("atlas@x.test");
    expect(link.atlasSecret ?? link.trustProofSecret ?? link.trustProofApiKey).toBeUndefined();
    const cert = JSON.parse(zip.get("workspace/ConsoleCertificate.json")!.toString())[0];
    expect(cert.agentId).toBe("agent-1");
    expect(cert.certificate).toBeUndefined();
    expect(JSON.parse(zip.get("workspace/ConsoleRecord.json")!.toString())[0].data.summary).toBe("Agent paid a duplicate invoice");
    const file = [...zip.keys()].find((k) => k.startsWith("workspace/files/"));
    expect(file && zip.get(file)!.toString()).toBe("The agent may not pay invoices above USD 1,000.");
    const excluded = zip.get("secrets-excluded.json")!.toString();
    for (const w of ["passwordHash", "secret", "tokenHash", "atlasSecret", "trustProofApiKey", "certificate", "signing keys"]) expect(excluded).toContain(w);
    const all = r.rawPayload.toString("latin1");
    for (const s of Object.values(h.secrets)) expect(all.includes(s), "secret leaked: " + s.slice(0, 12)).toBe(false);
    expect(all.includes("Bravo Secret Ltd")).toBe(false);
    expect(all.includes("export-b@exp.test")).toBe(false);

    const signed = JSON.parse(zip.get("export-manifest.json")!.toString());
    for (const f of signed.pack.files) expect(sha256(zip.get(f.name)!), f.name).toBe(f.sha256);
    const ok = await h.app.inject({ method: "POST", url: "/api/v1/public/verify", payload: signed });
    expect(ok.json().data.verdict).toBe("PASS");
    expect(JSON.stringify(ok.json().data)).toContain("account-export");
    const edited = JSON.parse(JSON.stringify(signed)); edited.pack.files[0].sha256 = "0".repeat(64);
    const bad = await h.app.inject({ method: "POST", url: "/api/v1/public/verify", payload: edited });
    expect(bad.json().data.verdict).toBe("FAIL");
    const changed = Buffer.from(zip.get("workspace/Project.json")!); changed[5] = changed[5]! ^ 1;
    expect(sha256(changed)).not.toBe(signed.pack.files.find((f: { name: string }) => f.name === "workspace/Project.json")!.sha256);

    const receipts = await store.listReceipts(a.organization.id);
    const receipt = receipts.find((x) => (x.receipt as { type?: string }).type === "account-export");
    expect(receipt).toBeTruthy();
    const rv = await h.app.inject({ method: "POST", url: "/api/v1/public/verify", payload: { receipt: receipt!.receipt } });
    expect(rv.json().data.verdict).toBe("PASS");
    const audits = JSON.stringify(await (store as unknown as { auditEvents: Map<string, unknown> }).auditEvents ? [...(store as unknown as { auditEvents: Map<string, { action: string }> }).auditEvents.values()].map((e) => e.action) : []);
    expect(audits).toContain("account.data_exported");
  });

  it("members below admin are refused (403); 6th export in an hour is refused (429)", async () => {
    const a = await h.register("export-c@exp.test", "Charlie Ltd");
    await store.addMember(a.organization.id, { email: "analyst@exp.test", name: "Analyst", passwordHash: await bcrypt.hash(PASSWORD, 4), role: "analyst" });
    const login = await h.post("/api/v1/auth/login", { email: "analyst@exp.test", password: PASSWORD });
    const token = login.json().data.accessToken as string;
    expect((await h.post("/api/v1/auth/export", {}, token)).statusCode).toBe(403);
    expect((await h.post("/api/v1/auth/export", {})).statusCode).toBe(401);
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await h.post("/api/v1/auth/export", {}, a.accessToken)).statusCode);
    expect(codes.slice(0, 5).every((c) => c === 200)).toBe(true);
    expect(codes[5]).toBe(429);
  });
});

const databaseUrl = process.env.ACG_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)("account export + delete on Postgres (sealed fields readable; zero rows after delete)", () => {
  let client: PrismaClient; let store: PrismaStore; let dir: string; let h: Awaited<ReturnType<typeof harness>>;
  beforeAll(async () => {
    client = await openTestDatabase(databaseUrl!);
    store = new PrismaStore(client, new EmailVault(Buffer.alloc(32, 9)));
    await store.reset();
    dir = await mkdtemp(path.join(tmpdir(), "gap-export-pg-"));
    h = await harness(store, new MemoryDocumentStorage(), dir);
  });
  afterAll(async () => { await h.app.close(); await store.reset(); await client.$disconnect(); await rm(dir, { recursive: true, force: true }); });

  it("export opens sealed values; delete leaves zero rows in every workspace and user table; other tenant untouched", async () => {
    const a = await h.register("pg-export-a@exp.test", "PG Alpha Ltd");
    const b = await h.register("pg-export-b@exp.test", "PG Bravo Ltd");
    await h.fill(a.organization.id, a.user.id);
    await h.fill(b.organization.id, b.user.id);
    const raw = await client.project.findFirst({ where: { organizationId: a.organization.id } });
    expect(String(raw!.name).startsWith("enc:v1:")).toBe(true); // stored sealed...
    const r = await h.post("/api/v1/auth/export", {}, a.accessToken);
    expect(r.statusCode).toBe(200);
    const zip = unzip(r.rawPayload);
    expect(JSON.parse(zip.get("workspace/Project.json")!.toString())[0].name).toBe("Exported project"); // ...exported readable
    expect(JSON.parse(zip.get("workspace/Organization.json")!.toString())[0].name).toBe("PG Alpha Ltd");
    expect(JSON.parse(zip.get("account.json")!.toString()).User[0].email).toBe("pg-export-a@exp.test");
    expect(r.rawPayload.toString("latin1").includes("enc:v1:")).toBe(false);
    for (const s of Object.values(h.secrets)) expect(r.rawPayload.toString("latin1").includes(s)).toBe(false);

    const del = await h.post("/api/v1/auth/delete-account", { password: PASSWORD, code: undefined }, a.accessToken);
    // 2FA is on for A (planted), so the code is required first; turn it off directly to test completeness.
    if (del.statusCode !== 200) { await store.deleteTwoFactor(a.user.id); expect((await h.post("/api/v1/auth/delete-account", { password: PASSWORD }, a.accessToken)).statusCode).toBe(200); }
    const o = a.organization.id, u = a.user.id;
    const counts = await Promise.all([
      client.organization.count({ where: { id: o } }), client.organizationMember.count({ where: { organizationId: o } }), client.project.count({ where: { organizationId: o } }),
      client.agentProfile.count({ where: { organizationId: o } }), client.document.count({ where: { organizationId: o } }), client.documentSegment.count({ where: { organizationId: o } }),
      client.analysis.count({ where: { organizationId: o } }), client.finding.count({ where: { organizationId: o } }), client.auditEvent.count({ where: { organizationId: o } }),
      client.serviceLink.count({ where: { organizationId: o } }), client.consoleCertificate.count({ where: { organizationId: o } }), client.consoleSubscription.count({ where: { organizationId: o } }),
      client.consoleSigner.count({ where: { organizationId: o } }), client.evidenceReceipt.count({ where: { organizationId: o } }), client.consoleRecord.count({ where: { organizationId: o } }),
      client.user.count({ where: { id: u } }), client.userTwoFactor.count({ where: { userId: u } }), client.authToken.count({ where: { userId: u } }),
    ]);
    expect(counts).toEqual(new Array(counts.length).fill(0));
    expect(await client.organization.count({ where: { id: b.organization.id } })).toBe(1);
    expect(await client.consoleRecord.count({ where: { organizationId: b.organization.id } })).toBe(1);
    expect(await client.userTwoFactor.count({ where: { userId: b.user.id } })).toBe(1);
  });
});
