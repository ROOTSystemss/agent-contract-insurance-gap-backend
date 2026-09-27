import { createHash, generateKeyPairSync, createPublicKey, verify as nodeVerify } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import { createPqSigner, verifyWithPublicKey } from "../src/crypto/pq-sign.js";
import { MemoryStore } from "../src/persistence/memory-store.js";
import { canonicalJson } from "../src/reports/assurance-pack.js";
import { agentInput } from "./helpers.js";

const SEED = Buffer.alloc(32, 71).toString("base64");
const OTHER_SEED = Buffer.alloc(32, 72).toString("base64");
const baseConfig = (dir: string) => ({ NODE_ENV: "test", JWT_SECRET: "test-secret-with-at-least-thirty-two-characters", UPLOAD_DIRECTORY: dir, LOG_LEVEL: "silent", PERSISTENCE_DRIVER: "memory" });

interface Built {
  pack: Record<string, unknown>;
  contentHash: string;
  contentHashSha512: string;
  signature: { status: string; algorithm: string; keyId?: string; publicKey?: string; value?: string };
}

async function appWithFinishedAnalysis(dir: string, pqSigner: ReturnType<typeof createPqSigner>) {
  const app = await buildApp({ config: loadConfig(baseConfig(dir)), store: new MemoryStore(), logger: false, certificateVerifier: null, pqSigner });
  await app.ready();
  const api = (method: "GET" | "POST", url: string, auth: string | null, payload?: object) =>
    app.inject({ method, url, headers: auth ? { authorization: `Bearer ${auth}` } : {}, payload });
  const json = <T>(r: { payload: string }) => JSON.parse(r.payload) as T;
  const token = json<{ data: { accessToken: string } }>(
    await api("POST", "/api/v1/auth/register", null, { email: `pq${Math.random()}@example.test`, name: "PQ Tester", organizationName: "PQ Fictional Ltd", password: "Correct Horse Battery 123!" }),
  ).data.accessToken;
  const projectId = json<{ data: { id: string } }>(
    await api("POST", "/api/v1/projects", token, { name: "PQ Project", description: "Fictional", primaryCountryCode: "US", primarySubdivisionCode: "US-IL", affectedCountryCodes: ["CA"] }),
  ).data.id;
  const agentId = json<{ data: { id: string } }>(await api("POST", `/api/v1/projects/${projectId}/agents`, token, agentInput({}))).data.id;
  const analysisId = json<{ data: { id: string } }>(await api("POST", `/api/v1/projects/${projectId}/analyses`, token, { agentProfileId: agentId, documentIds: [] })).data.id;
  await api("POST", `/api/v1/analyses/${analysisId}/run`, token, {});
  const built = json<{ data: Built }>(await api("POST", `/api/v1/analyses/${analysisId}/assurance-pack`, token, {})).data;
  return { app, api, json, token, built };
}

describe("post-quantum signed Assurance Packs", () => {
  let dir: string;
  let ctx: Awaited<ReturnType<typeof appWithFinishedAnalysis>>;
  const signer = createPqSigner(SEED);

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "gap-pq-"));
    ctx = await appWithFinishedAnalysis(dir, signer);
  });
  afterAll(async () => {
    await ctx.app.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("signs the pack with ML-DSA-65 and adds a SHA-512 fingerprint of the same bytes", () => {
    const { built } = ctx;
    expect(built.signature.status).toBe("signed");
    expect(built.signature.algorithm).toBe("ML-DSA-65");
    expect(Buffer.from(built.signature.value!, "base64").length).toBe(3309);
    const bytes = Buffer.from(canonicalJson(built.pack), "utf8");
    expect(built.contentHashSha512).toBe(createHash("sha512").update(bytes).digest("hex"));
    expect(built.contentHash).toBe(createHash("sha256").update(bytes).digest("hex"));
  });

  it("publishes the signing key without sign-in, matching the key in the pack", async () => {
    const response = await ctx.api("GET", "/.well-known/rootsystems-signing-key.json", null);
    expect(response.statusCode).toBe(200);
    const key = ctx.json<{ configured: boolean; publicKey: string; keyId: string; publicKeyPem: string }>(response);
    expect(key.configured).toBe(true);
    expect(key.publicKey).toBe(ctx.built.signature.publicKey);
    expect(key.keyId).toBe(ctx.built.signature.keyId);
    expect(key.publicKeyPem).toMatch(/^-----BEGIN PUBLIC KEY-----/);
  });

  it("verifies offline with only the published key", () => {
    const bytes = Buffer.from(canonicalJson(ctx.built.pack), "utf8");
    expect(verifyWithPublicKey(bytes, ctx.built.signature.value!, signer!.publicKey)).toBe(true);
    expect(verifyWithPublicKey(Buffer.concat([bytes, Buffer.from(" ")]), ctx.built.signature.value!, signer!.publicKey)).toBe(false);
  });

  it("the verify endpoint accepts the untouched pack and signature", async () => {
    const { built } = ctx;
    const result = ctx.json<{ data: { valid: boolean; signature: { status: string } } }>(
      await ctx.api("POST", "/api/v1/analyses/assurance-pack/verify", ctx.token, { pack: built.pack, contentHash: built.contentHash, signature: built.signature }),
    ).data;
    expect(result.valid).toBe(true);
    expect(result.signature.status).toBe("valid");
  });

  it("rejects an edited pack even when the attacker recomputes the SHA-256", async () => {
    const edited = { ...ctx.built.pack, project: "Someone else's project" };
    const recomputed = createHash("sha256").update(canonicalJson(edited), "utf8").digest("hex");
    const result = ctx.json<{ data: { valid: boolean; signature: { status: string } } }>(
      await ctx.api("POST", "/api/v1/analyses/assurance-pack/verify", ctx.token, { pack: edited, contentHash: recomputed, signature: ctx.built.signature }),
    ).data;
    expect(result.valid).toBe(false);
    expect(result.signature.status).toBe("invalid");
  });

  it("a pack re-signed with someone else's key is not accepted as this service's", async () => {
    const edited = { ...ctx.built.pack, project: "Forged" };
    const bytes = Buffer.from(canonicalJson(edited), "utf8");
    const forger = createPqSigner(OTHER_SEED)!;
    const result = ctx.json<{ data: { valid: boolean; signature: { status: string } } }>(
      await ctx.api("POST", "/api/v1/analyses/assurance-pack/verify", ctx.token, {
        pack: edited,
        contentHash: createHash("sha256").update(bytes).digest("hex"),
        signature: { value: forger.sign(bytes), publicKey: forger.publicKey },
      }),
    ).data;
    expect(result.valid).toBe(false);
    expect(result.signature.status).toBe("not_this_service");
  });

  it("OpenSSL (Node 24+) independently verifies the pack signature from the published PEM", () => {
    let native = false;
    try {
      generateKeyPairSync("ml-dsa-65" as never);
      native = true;
    } catch {
      native = false;
    }
    if (!native) return; // older Node: covered by the noble checks above
    const key = createPublicKey(signer!.publicKeyPem);
    const bytes = Buffer.from(canonicalJson(ctx.built.pack), "utf8");
    expect(nodeVerify(null, bytes, key, Buffer.from(ctx.built.signature.value!, "base64"))).toBe(true);
  });

  it("without a key, packs say not_configured and the key endpoint says so", async () => {
    const unsignedDir = await mkdtemp(path.join(tmpdir(), "gap-pq-none-"));
    const unsigned = await appWithFinishedAnalysis(unsignedDir, null);
    try {
      expect(unsigned.built.signature.status).toBe("not_configured");
      expect(unsigned.built.signature.value).toBeUndefined();
      const key = unsigned.json<{ configured: boolean }>(await unsigned.api("GET", "/.well-known/rootsystems-signing-key.json", null));
      expect(key.configured).toBe(false);
      const result = unsigned.json<{ data: { valid: boolean; signature: { status: string } } }>(
        await unsigned.api("POST", "/api/v1/analyses/assurance-pack/verify", unsigned.token, { pack: ctx.built.pack, contentHash: ctx.built.contentHash, signature: ctx.built.signature }),
      ).data;
      expect(result.valid).toBe(false);
    } finally {
      await unsigned.app.close();
      await rm(unsignedDir, { recursive: true, force: true });
    }
  });

  it("refuses a PQ_SIGNING_SEED that is not 32 bytes", () => {
    expect(() => loadConfig({ ...baseConfig(tmpdir()), PQ_SIGNING_SEED: Buffer.alloc(16).toString("base64") })).toThrow();
    expect(() => loadConfig({ ...baseConfig(tmpdir()), PQ_SIGNING_SEED: SEED })).not.toThrow();
  });
});
