import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import { createPqSigner, verifyWithPublicKey } from "../src/crypto/pq-sign.js";
import { checkChain, genesis, issueReceipt, RECEIPT_SYSTEM, verifyOne } from "../src/evidence/receipts.js";
import { anchorNow, sweepReceiptTimestamps, useOtsClientForTesting } from "../src/evidence/timestamps.js";
import { MemoryStore } from "../src/persistence/memory-store.js";
import { canonicalJson } from "../src/reports/assurance-pack.js";
import { agentInput } from "./helpers.js";

const SEED = Buffer.alloc(32, 81).toString("base64");
const ORG = "11111111-2222-4333-8444-555555555555";
const signer = createPqSigner(SEED)!;
const keys = [{ keyId: signer.keyId, publicKey: signer.publicKey }];
type Doc = Record<string, unknown>;
const sha512 = (s: string) => createHash("sha512").update(s, "utf8").digest("hex");

describe("Evidence Notary receipts (same format as the other RootSystems products)", () => {
  it("chains receipts per workspace from the shared genesis and signs them with ML-DSA-65", async () => {
    const store = new MemoryStore();
    const a = await issueReceipt(store, signer, { orgId: ORG, type: "assurance-pack", subject: { kind: "analysis", id: "an-1" }, facts: { contentHash: "ab".repeat(32) } });
    const b = await issueReceipt(store, signer, { orgId: ORG, type: "certificate-revoked", subject: { kind: "certificate", id: "c-1" }, facts: { revoked: true } });
    expect(a.receipt).toMatchObject({ receiptVersion: 1, system: RECEIPT_SYSTEM, orgId: ORG, seq: 1, previousReceiptHash: genesis(ORG) });
    expect(genesis(ORG)).toBe(sha512(`rootsystems-receipts/genesis:AI Agent Trust:${ORG}`));
    expect(b.receipt.previousReceiptHash).toBe((a.receipt.signature as { sha512: string }).sha512);
    const { signature, ...rest } = a.receipt as Doc & { signature: { sha512: string; value: string } };
    expect(signature.sha512).toBe(sha512(canonicalJson(rest)));
    expect(verifyWithPublicKey(Buffer.from(canonicalJson(rest), "utf8"), signature.value, signer.publicKey)).toBe(true);
    expect(a.anchorHash).toBe(createHash("sha256").update(canonicalJson(rest), "utf8").digest("hex"));
    expect(checkChain(ORG, (await store.listReceipts(ORG)).map((r) => r.receipt))).toMatchObject({ intact: true, receipts: 2 });
  });

  it("catches an edited, removed or reordered receipt", async () => {
    const store = new MemoryStore();
    for (let i = 0; i < 3; i++) await issueReceipt(store, signer, { orgId: ORG, type: "t", facts: { i } });
    const list = (await store.listReceipts(ORG)).map((r) => r.receipt);
    expect(checkChain(ORG, [list[0]!, { ...list[1]!, facts: { i: 99 } }, list[2]!])).toMatchObject({ intact: false, brokenAt: 2 });
    expect(checkChain(ORG, [list[0]!, list[2]!])).toMatchObject({ intact: false });
    expect(checkChain(ORG, [list[1]!, list[0]!, list[2]!])).toMatchObject({ intact: false, brokenAt: 1 });
  });

  it("never forks the chain when receipts are issued at the same moment", async () => {
    const store = new MemoryStore();
    await Promise.all(Array.from({ length: 5 }, (_, i) => issueReceipt(store, signer, { orgId: ORG, type: "t", facts: { i } })));
    const list = await store.listReceipts(ORG);
    expect(list.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(checkChain(ORG, list.map((r) => r.receipt))).toMatchObject({ intact: true, receipts: 5 });
  });

  it("verifies one receipt against the published keys only", async () => {
    const store = new MemoryStore();
    const { receipt } = await issueReceipt(store, signer, { orgId: ORG, type: "t", facts: { ok: true } });
    expect(verifyOne(receipt, keys, verifyWithPublicKey)).toMatchObject({ valid: true, keyId: signer.keyId, seq: 1 });
    const edited = verifyOne({ ...receipt, facts: { ok: false } }, keys, verifyWithPublicKey);
    expect(edited.valid).toBe(false);
    expect(edited.valid ? "" : edited.reason).toMatch(/changed/);
    const stranger = createPqSigner(Buffer.alloc(32, 9).toString("base64"))!;
    const forged = await issueReceipt(new MemoryStore(), stranger, { orgId: ORG, type: "t" });
    const foreign = verifyOne(forged.receipt, keys, verifyWithPublicKey);
    expect(foreign.valid ? "" : foreign.reason).toMatch(/not published/);
    expect(verifyOne({ ...receipt, system: "HIPAA" }, keys, verifyWithPublicKey)).toMatchObject({ valid: false });
  });

  it("anchors each receipt with OpenTimestamps and the hourly sweep confirms it", async () => {
    const store = new MemoryStore();
    let failNext = true;
    useOtsClientForTesting({
      submit: async (hash) => { if (failNext) { failNext = false; throw new Error("calendar down"); } return "proof-for-" + hash.slice(0, 8); },
      upgrade: async (proof) => ({ proofBase64: proof + "+up", confirmation: { height: 900123 } }),
    });
    try {
      const first = await issueReceipt(store, signer, { orgId: ORG, type: "t" });
      await anchorNow(store, first); // calendar down: stays not-submitted
      expect((await store.getReceipt(ORG, 1))!.otsStatus).toBe("not-submitted");
      const second = await issueReceipt(store, signer, { orgId: ORG, type: "t" });
      await anchorNow(store, second);
      expect((await store.getReceipt(ORG, 2))!.otsStatus).toBe("pending");
      const tally = await sweepReceiptTimestamps(store, () => new Date("2026-10-19T12:00:00Z"));
      expect(tally).toMatchObject({ submitted: 1, confirmed: 1 });
      expect((await store.getReceipt(ORG, 1))!.otsStatus).toBe("pending");
      expect(await store.getReceipt(ORG, 2)).toMatchObject({ otsStatus: "confirmed", otsBlockHeight: 900123 });
      await sweepReceiptTimestamps(store);
      expect((await store.getReceipt(ORG, 1))!.otsStatus).toBe("confirmed");
    } finally {
      useOtsClientForTesting(null);
    }
  });
});

describe("AI Agent Trust: receipts in the product and the public /verify page", () => {
  let dir: string;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let token: string;
  let built: { pack: Doc; contentHash: string; signature: { value: string; publicKey: string }; receipt: Doc };
  const api = (method: "GET" | "POST", url: string, auth: string | null, payload?: object) =>
    app.inject({ method, url, headers: auth ? { authorization: `Bearer ${auth}` } : {}, payload });
  const json = <T>(r: { payload: string }) => JSON.parse(r.payload) as T;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "gap-receipts-"));
    app = await buildApp({ config: loadConfig({ NODE_ENV: "test", JWT_SECRET: "test-secret-with-at-least-thirty-two-characters", UPLOAD_DIRECTORY: dir, LOG_LEVEL: "silent", PERSISTENCE_DRIVER: "memory" }), store: new MemoryStore(), logger: false, certificateVerifier: null, pqSigner: signer });
    await app.ready();
    token = json<{ data: { accessToken: string } }>(await api("POST", "/api/v1/auth/register", null, { email: `rcpt${Math.random()}@example.test`, name: "Receipt Tester", organizationName: "Receipt Fictional Ltd", password: "Correct Horse Battery 123!" })).data.accessToken;
    const projectId = json<{ data: { id: string } }>(await api("POST", "/api/v1/projects", token, { name: "Receipt Project", description: "Fictional", primaryCountryCode: "US", primarySubdivisionCode: "US-IL", affectedCountryCodes: ["CA"] })).data.id;
    const agentId = json<{ data: { id: string } }>(await api("POST", `/api/v1/projects/${projectId}/agents`, token, agentInput({}))).data.id;
    const analysisId = json<{ data: { id: string } }>(await api("POST", `/api/v1/projects/${projectId}/analyses`, token, { agentProfileId: agentId, documentIds: [] })).data.id;
    await api("POST", `/api/v1/analyses/${analysisId}/run`, token, {});
    built = json<{ data: typeof built }>(await api("POST", `/api/v1/analyses/${analysisId}/assurance-pack`, token, {})).data;
  });
  afterAll(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("an assurance pack comes with its signed Evidence Notary receipt", () => {
    expect(built.receipt).toMatchObject({ system: "AI Agent Trust", type: "assurance-pack", seq: 1, facts: { contentHash: built.contentHash } });
  });

  it("the console lists the workspace's receipts with the chain check", async () => {
    const r = json<{ data: { chain: { intact: boolean; receipts: number }; receipts: { seq: number; type: string; timestamp: string }[] } }>(await api("GET", "/api/v1/console/receipts", token));
    expect(r.data.chain).toMatchObject({ intact: true, receipts: 1 });
    expect(r.data.receipts[0]).toMatchObject({ seq: 1, type: "assurance-pack", timestamp: "not-submitted" });
    expect((await api("GET", "/api/v1/console/receipts", null)).statusCode).toBe(401);
  });

  it("serves a public /verify page without an account", async () => {
    const page = await api("GET", "/verify", null);
    expect(page.statusCode).toBe(200);
    expect(page.payload).toContain("Check an AI Agent Trust record");
  });

  it("the public check passes a genuine receipt and fails an edited one", async () => {
    const ok = json<{ data: { verdict: string; kind: string; type: string; timestamp: { status: string } } }>(await api("POST", "/api/v1/public/verify", null, { receipt: built.receipt }));
    expect(ok.data).toMatchObject({ verdict: "PASS", kind: "receipt", type: "assurance-pack", timestamp: { status: "not-submitted" } });
    const bad = json<{ data: { verdict: string; reason: string } }>(await api("POST", "/api/v1/public/verify", null, { receipt: { ...built.receipt, facts: { contentHash: "00".repeat(32) } } }));
    expect(bad.data.verdict).toBe("FAIL");
    expect(bad.data.reason).toMatch(/changed/);
  });

  it("the public check passes a genuine assurance pack and fails an edited one", async () => {
    const ok = json<{ data: { verdict: string; signature: string } }>(await api("POST", "/api/v1/public/verify", null, { pack: built.pack, contentHash: built.contentHash, signature: { value: built.signature.value, publicKey: built.signature.publicKey } }));
    expect(ok.data).toMatchObject({ verdict: "PASS", signature: "valid" });
    const bad = json<{ data: { verdict: string; reason: string } }>(await api("POST", "/api/v1/public/verify", null, { pack: { ...built.pack, organization: "Someone Else" }, contentHash: built.contentHash }));
    expect(bad.data.verdict).toBe("FAIL");
    expect(bad.data.reason).toMatch(/changed/);
  });
});

// The Postgres store, when a local test database is configured (same rule as the other DB suites).
describe.runIf(Boolean(process.env.ACG_TEST_DATABASE_URL))("Evidence Notary receipts on Postgres", () => {
  it("stores, chains, refuses a taken sequence number and tracks timestamps", async () => {
    const { openTestDatabase } = await import("./helpers.js");
    const { PrismaStore } = await import("../src/persistence/prisma-store.js");
    const client = await openTestDatabase(process.env.ACG_TEST_DATABASE_URL!);
    try {
      const org = await client.organization.create({ data: { name: "Receipt DB Ltd" } });
      const store = new PrismaStore(client);
      const a = await issueReceipt(store, signer, { orgId: org.id, type: "t", facts: { n: 1 } });
      await issueReceipt(store, signer, { orgId: org.id, type: "t", facts: { n: 2 } });
      await expect(store.addReceipt({ organizationId: org.id, seq: 1, receipt: a.receipt, anchorHash: a.anchorHash, otsProof: null, otsStatus: "not-submitted" })).rejects.toMatchObject({ code: "SEQ_TAKEN" });
      const list = await store.listReceipts(org.id);
      expect(checkChain(org.id, list.map((r) => r.receipt))).toMatchObject({ intact: true, receipts: 2 });
      await store.updateReceiptTimestamp(org.id, 1, { otsProof: "p", otsStatus: "confirmed", otsConfirmedAt: "2026-10-19T12:00:00.000Z", otsBlockHeight: 900001 });
      expect(await store.getReceipt(org.id, 1)).toMatchObject({ otsStatus: "confirmed", otsBlockHeight: 900001 });
      expect((await store.listUnanchoredReceipts(10)).every((r) => r.otsStatus !== "confirmed")).toBe(true);
      await client.organization.delete({ where: { id: org.id } });
    } finally {
      await client.$disconnect();
    }
  });
});
describe("public /verify: agent authority certificates (checked live with Authority Atlas)", () => {
  const CERT = "eyJhbGciOiJFZERTQSJ9.certificate-for-tests.signature";
  async function appWith(verifier: Parameters<typeof buildApp>[0] extends infer O ? O extends { certificateVerifier?: infer V } ? V : never : never) {
    const dir = await mkdtemp(path.join(tmpdir(), "gap-cert-"));
    const app = await buildApp({ config: loadConfig({ NODE_ENV: "test", JWT_SECRET: "test-secret-with-at-least-thirty-two-characters", UPLOAD_DIRECTORY: dir, LOG_LEVEL: "silent", PERSISTENCE_DRIVER: "memory" }), store: new MemoryStore(), logger: false, certificateVerifier: verifier, pqSigner: signer });
    await app.ready();
    const check = async (certificate: string) => (JSON.parse((await app.inject({ method: "POST", url: "/api/v1/public/verify", payload: { certificate } })).payload) as { data: { verdict: string; reason?: string; agentId?: string; permissions?: string[] } }).data;
    return { app, dir, check };
  }

  it("passes a certificate Atlas confirms, with what the agent may do", async () => {
    const { app, dir, check } = await appWith(async (c) => (c === CERT ? { ok: true, certificate: { agentId: "procure-bot", agentName: "ProcureBot", organization: "Fictional Ltd", permissions: ["invoices:read"], limits: {}, issuedAt: "2026-10-01T00:00:00Z", expiresAt: "2026-11-01T00:00:00Z" } } : { ok: false, reason: "invalid_signature" }));
    try {
      expect(await check(CERT)).toMatchObject({ verdict: "PASS", agentId: "procure-bot", permissions: ["invoices:read"] });
      const forged = await check(CERT + "x");
      expect(forged.verdict).toBe("FAIL");
      expect(forged.reason).toMatch(/invalid signature/);
    } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
  });

  it("fails closed when Atlas cannot be reached or no checker is configured", async () => {
    const down = await appWith(async () => ({ ok: false, reason: "verifier_unavailable" }));
    try {
      const r = await down.check(CERT);
      expect(r.verdict).toBe("FAIL");
      expect(r.reason).toMatch(/could not be checked right now/);
    } finally { await down.app.close(); await rm(down.dir, { recursive: true, force: true }); }
    const none = await appWith(null);
    try {
      expect((await none.check(CERT)).verdict).toBe("FAIL");
    } finally { await none.app.close(); await rm(none.dir, { recursive: true, force: true }); }
  });

  it("the page offers the certificate check", async () => {
    const { app, dir } = await appWith(null);
    try {
      expect((await app.inject({ method: "GET", url: "/verify" })).payload).toContain('id="cert"');
    } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
  });
});