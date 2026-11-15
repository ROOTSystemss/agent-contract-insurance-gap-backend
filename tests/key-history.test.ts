import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import { assertKeyHistory, endorsementMessage, keyHistory, keyHistoryProblem, KEYRING_FORMAT } from "../src/crypto/key-history.js";
import { createPqSigner, sha512Hex, type PqSigner } from "../src/crypto/pq-sign.js";
import { MemoryStore } from "../src/persistence/memory-store.js";
import { buildAssurancePack } from "../src/reports/assurance-pack.js";
import { seal } from "../src/evidence/receipts.js";
import { agentInput } from "./helpers.js";

const signer = createPqSigner(Buffer.alloc(32, 7).toString("base64"))!;
const older = createPqSigner(Buffer.alloc(32, 8).toString("base64"))!;

// A rotation exactly as rootsystems-core rotate() writes it: the old key retired at `at`, the new key
// active and endorsed (v2) by the old one.
function rotatedRing(from: PqSigner, to: PqSigner, at: string) {
  return {
    format: KEYRING_FORMAT,
    product: "ai-agent-trust",
    keys: [
      { keyId: from.keyId, algorithm: "ML-DSA-65", publicKey: from.publicKey, status: "retired", validFrom: "2026-09-01T00:00:00.000Z", validUntil: at },
      { keyId: to.keyId, algorithm: "ML-DSA-65", publicKey: to.publicKey, status: "active", validFrom: at, validUntil: null, endorsedBy: { keyId: from.keyId, format: "v2", signature: from.sign(endorsementMessage(to.keyId, to.publicKey, "ML-DSA-65")) } },
    ],
  };
}

describe("signing key history", () => {
  it("publishes the current key as active when there is no history", () => {
    const h = keyHistory("ai-agent-trust", signer, undefined)!;
    expect(h.format).toBe(KEYRING_FORMAT);
    expect(h.keys).toHaveLength(1);
    expect(h.keys[0]).toMatchObject({ keyId: signer.keyId, publicKey: signer.publicKey, status: "active" });
  });

  it("publishes a rotated history (endorsed, retired key with validUntil) and keeps the endorsement", () => {
    const ring = rotatedRing(older, signer, "2026-10-01T00:00:00.000Z");
    expect(keyHistoryProblem(signer, JSON.stringify(ring))).toBeNull();
    const h = keyHistory("ai-agent-trust", signer, JSON.stringify(ring))!;
    expect(h.keys.map((k) => k.status)).toEqual(["retired", "active"]);
    expect(h.keys[1]).toMatchObject({ endorsedBy: ring.keys[1]!.endorsedBy });
    expect("endorsedBy" in h.keys[0]!).toBe(false);
  });

  it("accepts a v1 endorsement too (keyrings written before v2)", () => {
    const ring = rotatedRing(older, signer, "2026-10-01T00:00:00.000Z");
    ring.keys[1]!.endorsedBy = { keyId: older.keyId, format: undefined as unknown as string, signature: older.sign(endorsementMessage(signer.keyId, signer.publicKey)) };
    expect(keyHistoryProblem(signer, JSON.stringify(ring))).toBeNull();
  });

  // QA 2026-11-14: each of these used to be ignored with a warning, silently dropping the old key.
  describe("names what is wrong with an unusable history", () => {
    const good = () => rotatedRing(older, signer, "2026-10-01T00:00:00.000Z");
    const cases: Array<[string, () => unknown, RegExp]> = [
      ["not JSON", () => "{not json", /not valid JSON/],
      ["wrong format", () => ({ ...good(), format: "something/v9" }), /format is not rootsystems\.keyring\/v1/],
      ["no keys", () => ({ ...good(), keys: [] }), /lists no keys/],
      ["key id that is not the key's fingerprint", () => { const r = good(); r.keys[0]!.keyId = "0".repeat(32); return r; }, /key 1: keyId 0+ is not the fingerprint/],
      ["retired key without validUntil", () => { const r = good(); r.keys[0]!.validUntil = null; return r; }, /key 1 is retired but has no validUntil/],
      ["missing endorsement", () => { const r = good(); delete (r.keys[1] as { endorsedBy?: unknown }).endorsedBy; return r; }, /key 2 is not endorsed by the key before it/],
      ["endorsement by the wrong key", () => { const r = good(); r.keys[1]!.endorsedBy!.keyId = signer.keyId; return r; }, /key 2 is not endorsed by the key before it/],
      ["forged endorsement", () => { const r = good(); const s = r.keys[1]!.endorsedBy!.signature; r.keys[1]!.endorsedBy!.signature = (s[0] === "A" ? "B" : "A") + s.slice(1); return r; }, /key 2: the endorsement by the key before it does not verify/],
      ["two active keys", () => { const r = good(); r.keys[0]!.status = "active"; r.keys[0]!.validUntil = null; return r; }, /2 active keys/],
      ["active key is not the configured signing key", () => rotatedRing(signer, older, "2026-10-01T00:00:00.000Z"), /active key .* is not the key PQ_SIGNING_SEED produces/],
      ["another algorithm", () => { const r = good(); r.keys[0]!.algorithm = "SLH-DSA-SHA2-128s"; return r; }, /uses SLH-DSA-SHA2-128s/],
      ["unknown status", () => { const r = good(); (r.keys[0] as { status: string }).status = "compromised"; return r; }, /status "compromised"/],
    ];
    for (const [name, make, expected] of cases) {
      it(name, () => {
        const value = make();
        const raw = typeof value === "string" ? value : JSON.stringify(value);
        expect(keyHistoryProblem(signer, raw)).toMatch(expected);
        expect(() => assertKeyHistory(signer, raw)).toThrow(/PQ_KEY_HISTORY_JSON cannot be used/);
        // At publish time it still fails closed: only the current key is published.
        const h = keyHistory("ai-agent-trust", signer, raw)!;
        expect(h.keys).toHaveLength(1);
        expect(h.keys[0]!.publicKey).toBe(signer.publicKey);
      });
    }
    it("a history without a signing key", () => {
      expect(() => assertKeyHistory(null, JSON.stringify(good()))).toThrow(/PQ_SIGNING_SEED is not set/);
    });
  });

  it("publishes nothing when no signing key is configured", () => {
    expect(keyHistory("ai-agent-trust", null, undefined)).toBeNull();
  });

  it("the service refuses to start with an unusable history", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "gap-keyring-start-"));
    const saved = process.env.PQ_KEY_HISTORY_JSON;
    process.env.PQ_KEY_HISTORY_JSON = JSON.stringify({ format: KEYRING_FORMAT, keys: [{ keyId: sha512Hex(Buffer.from(older.publicKey, "base64")).slice(0, 32), publicKey: older.publicKey, status: "active" }] });
    try {
      await expect(buildApp({ config: loadConfig({ NODE_ENV: "test", JWT_SECRET: "test-secret-with-at-least-thirty-two-characters", UPLOAD_DIRECTORY: dir, LOG_LEVEL: "silent" }), store: new MemoryStore(), logger: false, pqSigner: signer }))
        .rejects.toThrow(/PQ_KEY_HISTORY_JSON cannot be used: its active key/);
    } finally {
      if (saved === undefined) delete process.env.PQ_KEY_HISTORY_JSON;
      else process.env.PQ_KEY_HISTORY_JSON = saved;
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// Rehearsal: documents signed before a rotation still verify after it; the retired key cannot sign new ones.
describe("key rotation rehearsal (Assurance Packs and Evidence Notary receipts)", () => {
  const keyA = createPqSigner(Buffer.alloc(32, 31).toString("base64"))!;
  const keyB = createPqSigner(Buffer.alloc(32, 32).toString("base64"))!;
  const config = (dir: string) => loadConfig({ NODE_ENV: "test", JWT_SECRET: "test-secret-with-at-least-thirty-two-characters", UPLOAD_DIRECTORY: dir, LOG_LEVEL: "silent" });
  let dirs: string[] = [];
  let before: { pack: Record<string, unknown>; contentHash: string; signature: { value: string; publicKey: string }; receipt: Record<string, unknown> };
  let rotatedAt: string;
  let afterRotation: Awaited<ReturnType<typeof buildApp>>;
  const saved = process.env.PQ_KEY_HISTORY_JSON;

  beforeAll(async () => {
    // 1. Before the rotation: key A signs an Assurance Pack and its receipt.
    const dirA = await mkdtemp(path.join(tmpdir(), "gap-rotation-a-"));
    dirs.push(dirA);
    const appA = await buildApp({ config: config(dirA), store: new MemoryStore(), logger: false, certificateVerifier: null, pqSigner: keyA });
    await appA.ready();
    const api = (url: string, token: string | null, payload?: object) => appA.inject({ method: "POST", url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload });
    const data = <T>(r: { body: string }) => (JSON.parse(r.body) as { data: T }).data;
    const token = data<{ accessToken: string }>(await api("/api/v1/auth/register", null, { email: "rotation@example.test", name: "Rotation Tester", organizationName: "Fictional Rotation Ltd", password: "Correct Horse Battery 123!" })).accessToken;
    const projectId = data<{ id: string }>(await api("/api/v1/projects", token, { name: "Rotation", description: "Fictional", primaryCountryCode: "US", primarySubdivisionCode: "US-IL", affectedCountryCodes: [] })).id;
    const agentId = data<{ id: string }>(await api(`/api/v1/projects/${projectId}/agents`, token, agentInput({}))).id;
    const analysisId = data<{ id: string }>(await api(`/api/v1/projects/${projectId}/analyses`, token, { agentProfileId: agentId, documentIds: [] })).id;
    await api(`/api/v1/analyses/${analysisId}/run`, token, {});
    before = data(await api(`/api/v1/analyses/${analysisId}/assurance-pack`, token, {}));
    expect(before.signature.publicKey).toBe(keyA.publicKey);
    expect(before.receipt).toBeTruthy();
    await appA.close();

    // 2. Rotate: B becomes the signing key; A is retired one second later than everything it signed.
    rotatedAt = new Date(Date.now() + 1000).toISOString();
    process.env.PQ_KEY_HISTORY_JSON = JSON.stringify(rotatedRing(keyA, keyB, rotatedAt));
    const dirB = await mkdtemp(path.join(tmpdir(), "gap-rotation-b-"));
    dirs.push(dirB);
    afterRotation = await buildApp({ config: config(dirB), store: new MemoryStore(), logger: false, certificateVerifier: null, pqSigner: keyB });
    await afterRotation.ready();
  });
  afterAll(async () => {
    await afterRotation.close();
    if (saved === undefined) delete process.env.PQ_KEY_HISTORY_JSON;
    else process.env.PQ_KEY_HISTORY_JSON = saved;
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
    dirs = [];
  });

  const check = async (body: object) => (JSON.parse((await afterRotation.inject({ method: "POST", url: "/api/v1/public/verify", payload: body })).body) as { data: { verdict: string; reason: string | null; signature?: string; keyId?: string } }).data;

  it("publishes A (retired) and B (active) with A's endorsement of B", async () => {
    const ring = JSON.parse((await afterRotation.inject({ method: "GET", url: "/.well-known/rootsystems-signing-keys.json" })).body) as { keys: Array<{ keyId: string; status: string; validUntil: string | null }> };
    expect(ring.keys.map((k) => [k.keyId, k.status])).toEqual([[keyA.keyId, "retired"], [keyB.keyId, "active"]]);
    expect(ring.keys[0]!.validUntil).toBe(rotatedAt);
  });

  it("the Assurance Pack signed with A before the rotation still says PASS", async () => {
    const result = await check({ pack: before.pack, contentHash: before.contentHash, signature: before.signature });
    expect(result).toMatchObject({ verdict: "PASS", signature: "valid" });
  });

  it("the Evidence Notary receipt signed with A before the rotation still says PASS", async () => {
    expect(await check({ receipt: before.receipt })).toMatchObject({ verdict: "PASS", keyId: keyA.keyId });
  });

  it("one character changed in the old pack or receipt says FAIL", async () => {
    const project = String(before.pack.project);
    expect((await check({ pack: { ...before.pack, project: (project[0] === "X" ? "Y" : "X") + project.slice(1) }, contentHash: before.contentHash, signature: before.signature })).verdict).toBe("FAIL");
    const facts = before.receipt.facts as Record<string, unknown>;
    expect((await check({ receipt: { ...before.receipt, facts: { ...facts, withCertificate: !facts.withCertificate } } })).verdict).toBe("FAIL");
  });

  it("a pack signed with retired key A after its retirement says FAIL", async () => {
    const late = buildAssurancePack(
      { organizationName: "Fictional Rotation Ltd", projectName: "Forged", agent: { ...agentInput({}), id: "a", organizationId: "o", projectId: "p", createdAt: rotatedAt, updatedAt: rotatedAt },
        analysis: { id: "x", organizationId: "o", projectId: "p", agentProfileId: "a", documentIds: [], state: "completed", engineVersion: "e", rulesetVersions: [], jurisdictionPackIds: [], attentionScore: null, warnings: [], errors: [], failureReason: null, createdAt: rotatedAt, updatedAt: rotatedAt, completedAt: rotatedAt },
        findings: [], documents: [], now: new Date(Date.parse(rotatedAt) + 3_600_000) },
      keyA,
    );
    const result = await check({ pack: late.pack, contentHash: late.contentHash, signature: late.signature });
    expect(result.verdict).toBe("FAIL");
    expect(result.signature).toBe("signed_after_key_retired");
    expect(result.reason).toContain("retired");
  });

  it("a receipt signed with retired key A after its retirement says FAIL", async () => {
    const { signature: _signature, ...unsigned } = before.receipt;
    const forged = seal({ ...unsigned, issuedAt: new Date(Date.parse(rotatedAt) + 3_600_000).toISOString() }, keyA);
    const result = await check({ receipt: forged });
    expect(result.verdict).toBe("FAIL");
    expect(result.reason).toContain("after that key was retired");
  });

  it("new packs are signed with B and verify", async () => {
    const fresh = buildAssurancePack(
      { organizationName: "Fictional Rotation Ltd", projectName: "Fresh", agent: { ...agentInput({}), id: "a", organizationId: "o", projectId: "p", createdAt: rotatedAt, updatedAt: rotatedAt },
        analysis: { id: "y", organizationId: "o", projectId: "p", agentProfileId: "a", documentIds: [], state: "completed", engineVersion: "e", rulesetVersions: [], jurisdictionPackIds: [], attentionScore: null, warnings: [], errors: [], failureReason: null, createdAt: rotatedAt, updatedAt: rotatedAt, completedAt: rotatedAt },
        findings: [], documents: [] },
      keyB,
    );
    expect(await check({ pack: fresh.pack, contentHash: fresh.contentHash, signature: fresh.signature })).toMatchObject({ verdict: "PASS", signature: "valid" });
  });
});
