import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import { createPqSigner } from "../src/crypto/pq-sign.js";
import { MemoryStore } from "../src/persistence/memory-store.js";

// Knock-out 2026-11-16 (O-24): the public SAMPLE Agent Assurance Pack. No account; built by the real engine and
// pack builder in memory; sample: true inside the hashed and signed content; /verify passes it and says SAMPLE;
// any change (including removing the SAMPLE flag) fails; nothing is stored.
const signer = createPqSigner(Buffer.alloc(32, 77).toString("base64"))!;
type Body = { pack: Record<string, unknown> & { sample?: boolean; sampleNotice?: string; organization?: string; findings?: { total: number } }; contentHash: string; signature: { value: string; publicKey: string } };
type Result = { data: { verdict: string; kind: string; sample?: boolean; sampleNotice?: string; reason?: string | null } };

describe("public SAMPLE Agent Assurance Pack", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let dir: string;
  let store: MemoryStore;
  const verify = async (payload: unknown) => JSON.parse((await app.inject({ method: "POST", url: "/api/v1/public/verify", payload: payload as object })).payload) as Result;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "acg-sample-"));
    store = new MemoryStore();
    app = await buildApp({ config: loadConfig({ NODE_ENV: "test", JWT_SECRET: "test-secret-with-at-least-thirty-two-characters", UPLOAD_DIRECTORY: dir, LOG_LEVEL: "silent", PERSISTENCE_DRIVER: "memory" }), store, logger: false, certificateVerifier: null, pqSigner: signer });
    await app.ready();
  });
  afterAll(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });

  it("is public, built by the real engine, marked SAMPLE inside the signed content", async () => {
    const r = await app.inject({ method: "GET", url: "/sample/assurance-pack.json" });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-disposition"]).toMatch(/SAMPLE-agent-assurance-pack\.json/);
    const body = JSON.parse(r.payload) as Body;
    expect(body.pack.sample).toBe(true);
    expect(body.pack.sampleNotice).toMatch(/^SAMPLE\./);
    expect(body.pack.organization).toMatch(/SAMPLE Co/);
    expect(body.pack.schema).toBe("rootsystems.agent-assurance-pack.v1");
    expect(body.pack.findings!.total).toBeGreaterThan(0);
    expect(body.signature.publicKey).toBe(signer.publicKey);
    expect(JSON.stringify(body.pack)).not.toMatch(/\b(insured|compliant|certified)\b/i);
    const again = JSON.parse((await app.inject({ method: "GET", url: "/sample/assurance-pack.json" })).payload) as Body;
    expect(again.contentHash).toBe(body.contentHash);
  });

  it("verifies PASS on /verify and is reported as SAMPLE", async () => {
    const body = JSON.parse((await app.inject({ method: "GET", url: "/sample/assurance-pack.json" })).payload) as Body;
    const ok = await verify({ pack: body.pack, contentHash: body.contentHash, signature: { value: body.signature.value, publicKey: body.signature.publicKey } });
    expect(ok.data).toMatchObject({ kind: "assurance-pack", verdict: "PASS", sample: true });
    expect(ok.data.sampleNotice).toMatch(/SAMPLE/);
  });

  it("fails after one changed character, or with the SAMPLE flag removed or changed", async () => {
    const body = JSON.parse((await app.inject({ method: "GET", url: "/sample/assurance-pack.json" })).payload) as Body;
    const sig = { value: body.signature.value, publicKey: body.signature.publicKey };
    const edited = await verify({ pack: { ...body.pack, organization: String(body.pack.organization).replace("SAMPLE", "SAMPLF") }, contentHash: body.contentHash, signature: sig });
    expect(edited.data.verdict).toBe("FAIL");
    expect(edited.data.sample).toBeUndefined();
    const { sample: _drop, ...noFlag } = body.pack;
    const removed = await verify({ pack: noFlag, contentHash: body.contentHash, signature: sig });
    expect(removed.data.verdict).toBe("FAIL");
    const flipped = await verify({ pack: { ...body.pack, sample: false }, contentHash: body.contentHash, signature: sig });
    expect(flipped.data.verdict).toBe("FAIL");
    // Even with a recomputed hash, a pack without the flag fails the signature (it cannot pass as a real pack).
    const { hashPack } = await import("../src/reports/assurance-pack.js");
    const rehashed = await verify({ pack: noFlag, contentHash: hashPack(noFlag), signature: sig });
    expect(rehashed.data.verdict).toBe("FAIL");
  });

  it("has a public page that says SAMPLE, and /verify links it", async () => {
    const page = await app.inject({ method: "GET", url: "/sample" });
    expect(page.statusCode).toBe(200);
    expect(page.payload).toMatch(/id="sample-notice"[^>]*>SAMPLE\./);
    expect(page.payload).toMatch(/href="\/sample\/assurance-pack\.json"/);
    expect(page.payload).toMatch(/href="\/verify"/);
    expect(page.payload).not.toMatch(/\b(insured|compliant|certified)\b/i);
    const verifyPage = await app.inject({ method: "GET", url: "/verify" });
    expect(verifyPage.payload).toMatch(/id="sample-link"[\s\S]*href="\/sample"/);
    expect(verifyPage.payload).toMatch(/id=\\?"verify-sample\\?"|verify-sample/);
  });

  it("stores nothing: no organization, receipt or file appears", async () => {
    await app.inject({ method: "GET", url: "/sample/assurance-pack.json" });
    const s = store as unknown as Record<string, unknown>;
    const sizes = Object.values(s).filter((v): v is Map<unknown, unknown> => v instanceof Map).map((m) => m.size);
    expect(sizes.length).toBeGreaterThan(3);
    expect(sizes.every((n) => n === 0)).toBe(true);
    expect(await readdir(dir)).toEqual([]);
  });

  it("is unavailable (503), not unsigned, when no signing key is configured", async () => {
    const d2 = await mkdtemp(path.join(tmpdir(), "acg-sample-nokey-"));
    const a2 = await buildApp({ config: loadConfig({ NODE_ENV: "test", JWT_SECRET: "test-secret-with-at-least-thirty-two-characters", UPLOAD_DIRECTORY: d2, LOG_LEVEL: "silent", PERSISTENCE_DRIVER: "memory" }), store: new MemoryStore(), logger: false, certificateVerifier: null, pqSigner: null });
    await a2.ready();
    expect((await a2.inject({ method: "GET", url: "/sample/assurance-pack.json" })).statusCode).toBe(503);
    await a2.close(); await rm(d2, { recursive: true, force: true });
  });
});
