import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import type { Analysis, DocumentRecord, Finding } from "../src/domain/types.js";
import { MemoryDocumentStorage } from "../src/documents/storage.js";
import { MemoryStore } from "../src/persistence/memory-store.js";
import { PrismaStore } from "../src/persistence/prisma-store.js";
import { EmailVault } from "../src/persistence/email-vault.js";
import { deleteAccount } from "../src/security/account-deletion.js";
import { codeAt, stepAt } from "../src/security/two-factor.js";
import { agentInput, openTestDatabase } from "./helpers.js";

// S-14 delete on request (knock-out 2026-11-17): POST /api/v1/auth/delete-account.

const PASSWORD = "Correct Horse Battery 123!";
let n = 0;
const from = () => ({ remoteAddress: "10.0.0.5", headers: { "x-forwarded-for": `198.51.100.${(n++ % 250) + 1}, 104.16.1.1, 10.1.2.3` } });

describe("account deletion (console API)", () => {
  let app: FastifyInstance;
  let store: MemoryStore;
  let storage: MemoryDocumentStorage;
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "gap-delete-"));
    store = new MemoryStore();
    storage = new MemoryDocumentStorage();
    app = await buildApp({
      config: loadConfig({ NODE_ENV: "test", JWT_SECRET: "test-secret-with-at-least-thirty-two-characters", UPLOAD_DIRECTORY: dir, LOG_LEVEL: "silent", EMAIL_VERIFICATION: "0", TRUST_PROXY_HOPS: "3" }),
      store, storage, logger: false, certificateVerifier: null, pqSigner: null,
    });
    await app.ready();
  });
  afterAll(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });

  const post = (url: string, payload: unknown, token?: string) =>
    app.inject({ method: "POST", url, payload: payload as Record<string, unknown>, ...from(), headers: { ...from().headers, ...(token ? { authorization: "Bearer " + token } : {}) } });
  const get = (url: string, token: string) => app.inject({ method: "GET", url, ...from(), headers: { ...from().headers, authorization: "Bearer " + token } });
  const register = async (email: string, org = "Delete Test Ltd") => {
    const r = await post("/api/v1/auth/register", { email, name: "Del", organizationName: org, password: PASSWORD });
    expect(r.statusCode).toBe(201);
    return r.json().data as { accessToken: string; organization: { id: string }; user: { id: string } };
  };
  const project = async (organizationId: string) => (await store.createProject(organizationId, { name: "P", description: "x", primaryCountryCode: "US", primarySubdivisionCode: null, affectedCountryCodes: [] })).id;
  const upload = (organizationId: string, projectId: string, uploaderId: string) =>
    app.documentService.upload({ organizationId, projectId, uploaderId, filename: "contract.txt", mimeType: "text/plain", buffer: Buffer.from("The agent may not pay invoices above USD 1,000."), documentType: "commercial_contract", countryCode: "US" });
  const login = (email: string) => post("/api/v1/auth/login", { email, password: PASSWORD });

  it("wrong password: 403 and nothing deleted", async () => {
    const a = await register("wrongpw@del.test");
    const r = await post("/api/v1/auth/delete-account", { password: "not the password" }, a.accessToken);
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe("WRONG_PASSWORD");
    expect(await store.getOrganization(a.organization.id)).not.toBeNull();
    expect((await get("/api/v1/auth/me", a.accessToken)).statusCode).toBe(200);
  });

  it("needs a session (401 without a token)", async () => {
    expect((await post("/api/v1/auth/delete-account", { password: PASSWORD })).statusCode).toBe(401);
  });

  it("sole owner: two-factor code required when on; workspace, data and files deleted; other tenant untouched; sessions end", async () => {
    const a = await register("sole@del.test", "Sole Owner Ltd");
    const b = await register("other-tenant@del.test", "Other Tenant Ltd");
    const pa = await project(a.organization.id), pb = await project(b.organization.id);
    const docA = await upload(a.organization.id, pa, a.user.id);
    const docB = await upload(b.organization.id, pb, b.user.id);
    await store.createAgent(a.organization.id, pa, agentInput());
    await store.addConsoleCertificate({ jti: randomUUID(), organizationId: a.organization.id, agentId: "agent-1", certificate: "h.c.s", pqSignature: null });

    const start = (await post("/api/v1/auth/two-factor/start", {}, a.accessToken)).json().data as { secret: string };
    const s = stepAt();
    expect((await post("/api/v1/auth/two-factor/enable", { code: codeAt(start.secret, s) }, a.accessToken)).statusCode).toBe(200);

    const noCode = await post("/api/v1/auth/delete-account", { password: PASSWORD }, a.accessToken);
    expect(noCode.statusCode).toBe(400);
    expect(noCode.json().error.code).toBe("CODE_REQUIRED");
    const badCode = await post("/api/v1/auth/delete-account", { password: PASSWORD, code: "000000" === codeAt(start.secret, s + 1) ? "111111" : "000000" }, a.accessToken);
    expect(badCode.statusCode).toBe(400);
    expect(await store.getOrganization(a.organization.id)).not.toBeNull();

    const ok = await post("/api/v1/auth/delete-account", { password: PASSWORD, code: codeAt(start.secret, s + 1) }, a.accessToken);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data).toMatchObject({ deleted: true, workspacesDeleted: 1, workspacesLeft: 0, filesDeleted: 1, filesNotDeleted: 0, userRecord: "deleted", otherMembersRemoved: 0 });

    expect(await store.getOrganization(a.organization.id)).toBeNull();
    expect(await store.getProject(a.organization.id, pa)).toBeNull();
    expect(await store.getDocument(a.organization.id, docA.id)).toBeNull();
    expect(await store.listAgents(a.organization.id, pa)).toEqual([]);
    expect(await store.listConsoleCertificateIds(a.organization.id)).toEqual([]);
    await expect(storage.get(docA.storageKey)).rejects.toThrow();
    expect(await store.getUser(a.user.id)).toBeNull();
    expect(await store.getTwoFactor(a.user.id)).toBeNull();
    expect((await get("/api/v1/auth/me", a.accessToken)).statusCode).toBe(401); // old session refused
    expect((await login("sole@del.test")).statusCode).toBe(401);

    expect(await store.getDocument(b.organization.id, docB.id)).not.toBeNull();
    expect((await storage.get(docB.storageKey)).length).toBeGreaterThan(0);
    expect((await get("/api/v1/auth/me", b.accessToken)).statusCode).toBe(200);
  });

  it("co-owner: the workspace stays, the person leaves, their row becomes a tombstone, an audit line is written", async () => {
    const c = await register("owner-c@del.test", "Shared Ltd");
    const pc = await project(c.organization.id);
    const d = await store.addMember(c.organization.id, { email: "coowner-d@del.test", name: "Dee Coowner", passwordHash: await bcrypt.hash(PASSWORD, 4), role: "owner" });
    const dLogin = await login("coowner-d@del.test");
    expect(dLogin.statusCode).toBe(200);
    const dToken = dLogin.json().data.accessToken as string;
    const docD = await upload(c.organization.id, pc, d.userId); // a document the leaving person uploaded stays with the workspace

    const r = await post("/api/v1/auth/delete-account", { password: PASSWORD }, dToken);
    expect(r.statusCode).toBe(200);
    expect(r.json().data).toMatchObject({ workspacesDeleted: 0, workspacesLeft: 1, filesDeleted: 0, userRecord: "anonymised" });

    expect(await store.getOrganization(c.organization.id)).not.toBeNull();
    expect(await store.getDocument(c.organization.id, docD.id)).not.toBeNull();
    expect((await storage.get(docD.storageKey)).length).toBeGreaterThan(0);
    const members = await store.listMembers(c.organization.id);
    expect(members.map((m) => m.userId)).toEqual([c.user.id]);
    const tomb = await store.getUser(d.userId);
    expect(tomb).toMatchObject({ name: "Deleted user", emailVerifiedAt: null });
    expect(tomb!.email).toMatch(/^deleted-[0-9a-f-]+@deleted\.invalid$/);
    expect(JSON.stringify(tomb)).not.toContain("coowner-d");
    expect(await store.findUserByEmail("coowner-d@del.test")).toBeNull();
    expect((await login("coowner-d@del.test")).statusCode).toBe(401);
    expect((await get("/api/v1/auth/me", dToken)).statusCode).toBe(401);
    const events = await store.listAuditEvents(c.organization.id, "", { page: 1, pageSize: 100 }).catch(() => null);
    const all = [...(store as unknown as { auditEvents: Map<string, { organizationId: string; action: string; actorId: string; metadata: unknown }> }).auditEvents.values()];
    const line = all.find((e) => e.organizationId === c.organization.id && e.action === "user.account_deleted");
    expect(line).toBeTruthy();
    expect(JSON.stringify(line)).not.toContain("coowner-d@");
    void events;
    expect((await get("/api/v1/auth/me", c.accessToken)).statusCode).toBe(200);
  });

  it("sole owner with other members: the workspace goes for everyone and the count is reported", async () => {
    const e = await register("owner-e@del.test", "Team Ltd");
    await store.addMember(e.organization.id, { email: "viewer-f@del.test", name: "Viewer F", passwordHash: await bcrypt.hash(PASSWORD, 4), role: "viewer" });
    const r = await post("/api/v1/auth/delete-account", { password: PASSWORD }, e.accessToken);
    expect(r.statusCode).toBe(200);
    expect(r.json().data).toMatchObject({ workspacesDeleted: 1, otherMembersRemoved: 1 });
    expect(await store.getOrganization(e.organization.id)).toBeNull();
    expect((await login("viewer-f@del.test")).statusCode).not.toBe(200);
  });

  it("a linked workspace: certificates it cannot revoke and remote data are reported, never hidden", async () => {
    const g = await register("linked@del.test", "Linked Ltd");
    await store.saveServiceLink({ organizationId: g.organization.id, atlasEmail: "a@console.test", atlasSecret: "plain:a", trustProofEmail: "t@console.test", trustProofSecret: "plain:b", trustProofApiKey: "plain:c" });
    await store.addConsoleCertificate({ jti: randomUUID(), organizationId: g.organization.id, agentId: "agent-1", certificate: "h.c.s", pqSignature: null });
    const r = await post("/api/v1/auth/delete-account", { password: PASSWORD }, g.accessToken);
    expect(r.statusCode).toBe(200);
    const data = r.json().data;
    expect(data.certificatesNotRevoked).toBe(1); // governance is not configured in this test
    expect(data.remoteNotDeleted.map((x: { service: string }) => x.service).sort()).toEqual(["Authority Atlas", "Trust Proof"]);
    expect(await store.getServiceLink(g.organization.id)).toBeNull();
  });

  it("the account page offers the delete flow with the warning", async () => {
    const page = await app.inject({ method: "GET", url: "/account.js" });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("/auth/delete-account");
    expect(page.body).toContain("stay checkable on /verify");
    expect(page.body).toContain("Type DELETE");
  });
});

function findingFor(ids: { organizationId: string; analysisId: string; projectId: string; documentId: string }): Finding {
  return {
    id: randomUUID(), ...ids, title: "t", category: "transaction_limit_mismatch", severity: "high", confidence: 0.8, status: "open",
    affectedAgentCapability: "canSpendMoney", affectedDocumentId: ids.documentId, clauseCategory: "payment_terms", documentFact: "d",
    agentProfileFact: "a", systemInference: "s", reviewRule: "r", factualBasis: "f", analysisExplanation: "e",
    evidence: [{ segmentId: randomUUID(), documentId: ids.documentId, pageNumber: 1, excerpt: "x", characterStart: 0, characterEnd: 1 }],
    applicableUniversalRule: "u", applicableJurisdictionRule: null, uncertainty: "Low.", limitations: [], recommendedReviewQuestions: [],
    suggestedProfessionalReviewer: "legal_counsel", disclaimer: "Not legal advice.", ruleVersion: "1.0.0",
  } as unknown as Finding;
}

// Set ACG_TEST_DATABASE_URL to a disposable local database that has had `prisma migrate deploy` run.
const databaseUrl = process.env.ACG_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)("account deletion on Postgres (every workspace table, RESTRICT order)", () => {
  let client: PrismaClient;
  let store: PrismaStore;
  beforeAll(async () => {
    client = await openTestDatabase(databaseUrl!);
    store = new PrismaStore(client, new EmailVault(Buffer.alloc(32, 9)));
    await store.reset();
  });
  afterAll(async () => { await store.reset(); await client.$disconnect(); });

  async function fill(email: string, org: string) {
    const reg = await store.createRegistration({ email, name: "PG", passwordHash: "hash", organizationName: org });
    const organizationId = reg.organization.id, userId = reg.user.id;
    const project = await store.createProject(organizationId, { name: "P", description: null, primaryCountryCode: "US", primarySubdivisionCode: null, affectedCountryCodes: [] });
    const agent = await store.createAgent(organizationId, project.id, agentInput());
    const documentId = randomUUID(), now = new Date().toISOString();
    const document: DocumentRecord = {
      id: documentId, organizationId, projectId: project.id, uploaderId: userId, originalFilename: "c.pdf", safeFilename: "c.pdf",
      mimeType: "application/pdf", size: 10, checksum: "b".repeat(64), documentType: "master_services_agreement", countryCode: "US", subdivisionCode: null,
      storageKey: `${organizationId}/${project.id}/${documentId}.pdf`, extractionStatus: "completed", extractionError: null, extractionWarnings: [], pageCount: 1,
      extractedText: "text", segments: [{ id: randomUUID(), organizationId, documentId, pageNumber: 1, sectionHeading: null, paragraphNumber: 1, characterStart: 0, characterEnd: 4, normalizedText: "text", originalText: "text", extractionConfidence: 1 }],
      retentionStatus: "active", deleteAfter: null, deletedAt: null, createdAt: now, updatedAt: now,
    } as unknown as DocumentRecord;
    await store.createDocument(document);
    const analysis = {
      id: randomUUID(), organizationId, projectId: project.id, agentProfileId: agent.id, documentIds: [documentId], state: "completed",
      engineVersion: "gap-engine@1.2.0", rulesetVersions: [], jurisdictionPackIds: [], attentionScore: null, warnings: [], errors: [], failureReason: null,
      createdAt: now, updatedAt: now, completedAt: now,
    } as unknown as Analysis;
    await store.createAnalysis(analysis);
    await store.replaceFindings(organizationId, analysis.id, [findingFor({ organizationId, analysisId: analysis.id, projectId: project.id, documentId })]);
    await store.addAuditEvent({ id: randomUUID(), organizationId, actorId: userId, resourceType: "project", resourceId: project.id, action: "project.created", requestId: "r", metadata: {}, createdAt: now });
    await store.saveServiceLink({ organizationId, atlasEmail: "a@x.test", atlasSecret: "plain:a", trustProofEmail: "t@x.test", trustProofSecret: "plain:b", trustProofApiKey: "plain:c" });
    await store.addConsoleCertificate({ jti: randomUUID(), organizationId, agentId: "agent-1", certificate: "h.c.s", pqSignature: null });
    await store.saveConsoleSubscription({ organizationId, plan: "pro", status: "active", dodoCustomerId: null, dodoSubscriptionId: null, renewsAt: null, lastEventAt: null });
    await store.addConsoleSigner({ organizationId, userId, trustProofEmail: "s@x.test" } as never);
    await store.addReceipt({ organizationId, seq: 1, receipt: { r: 1 } as never, anchorHash: "c".repeat(64), otsProof: null, otsStatus: "not-submitted" } as never);
    return { organizationId, userId, storageKey: document.storageKey };
  }
  const counts = async (organizationId: string) => ({
    org: await client.organization.count({ where: { id: organizationId } }),
    rows: (await Promise.all([
      client.project.count({ where: { organizationId } }), client.agentProfile.count({ where: { organizationId } }), client.document.count({ where: { organizationId } }),
      client.documentSegment.count({ where: { organizationId } }), client.analysis.count({ where: { organizationId } }), client.finding.count({ where: { organizationId } }),
      client.auditEvent.count({ where: { organizationId } }), client.serviceLink.count({ where: { organizationId } }), client.consoleCertificate.count({ where: { organizationId } }),
      client.consoleSubscription.count({ where: { organizationId } }), client.consoleSigner.count({ where: { organizationId } }), client.evidenceReceipt.count({ where: { organizationId } }),
      client.organizationMember.count({ where: { organizationId } }),
    ])).reduce((a, b) => a + b, 0),
  });

  it("deletes every row of a sole-owner workspace (RESTRICT chains included), keeps another tenant, deletes the user", async () => {
    const a = await fill("pg-del-a@del.test", "PG A");
    const b = await fill("pg-del-b@del.test", "PG B");
    expect((await counts(a.organizationId)).rows).toBeGreaterThan(10);
    const deleted: string[] = [];
    const storage = { put: async () => {}, get: async () => Buffer.alloc(0), delete: async (k: string) => { deleted.push(k); } };
    const result = await deleteAccount({ store, storage, governance: null }, a.userId, "req-test");
    expect(result).toMatchObject({ workspacesDeleted: 1, filesDeleted: 1, userRecord: "deleted" });
    expect(deleted).toEqual([a.storageKey]);
    expect(await counts(a.organizationId)).toEqual({ org: 0, rows: 0 });
    expect(await client.user.count({ where: { id: a.userId } })).toBe(0);
    expect(await client.analysisDocument.count({ where: { analysis: { organizationId: a.organizationId } } })).toBe(0);
    const bc = await counts(b.organizationId);
    expect(bc.org).toBe(1);
    expect(bc.rows).toBeGreaterThan(10);
  });

  it("co-owner on Postgres: the workspace stays, the user row becomes a tombstone with a sealed tombstone email", async () => {
    const c = await fill("pg-del-c@del.test", "PG C");
    const d = await store.addMember(c.organizationId, { email: "pg-del-d@del.test", name: "Dee", passwordHash: "hash", role: "owner" });
    await store.addAuditEvent({ id: randomUUID(), organizationId: c.organizationId, actorId: d.userId, resourceType: "project", resourceId: "x", action: "project.viewed", requestId: "r", metadata: {}, createdAt: new Date().toISOString() });
    const result = await deleteAccount({ store, storage: { put: async () => {}, get: async () => Buffer.alloc(0), delete: async () => {} }, governance: null }, d.userId, "req-test");
    expect(result).toMatchObject({ workspacesDeleted: 0, workspacesLeft: 1, userRecord: "anonymised" });
    expect((await counts(c.organizationId)).org).toBe(1);
    expect(await client.organizationMember.count({ where: { userId: d.userId } })).toBe(0);
    const row = await client.user.findUniqueOrThrow({ where: { id: d.userId } });
    expect(row.email).not.toContain("pg-del-d");
    expect(await store.findUserByEmail("pg-del-d@del.test")).toBeNull();
    expect((await store.getUser(d.userId))!.name).toBe("Deleted user");
    expect(await client.auditEvent.count({ where: { organizationId: c.organizationId, action: "user.account_deleted" } })).toBe(1);
  });
});
