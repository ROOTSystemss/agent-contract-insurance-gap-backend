import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { CertificateSummary, CertificateVerifier } from "../src/authority/certificate.js";
import { loadConfig } from "../src/config/env.js";
import { MemoryStore } from "../src/persistence/memory-store.js";
import { canonicalJson, hashPack, verifyAssurancePack } from "../src/reports/assurance-pack.js";
import { agentInput } from "./helpers.js";

describe("canonicalJson / hashPack", () => {
  it("does not depend on key order", () => {
    expect(hashPack({ a: 1, b: { c: 2, d: [3, { e: 4, f: 5 }] } })).toBe(
      hashPack({ b: { d: [3, { f: 5, e: 4 }], c: 2 }, a: 1 }),
    );
  });

  it("changes when any value changes", () => {
    expect(hashPack({ a: 1 })).not.toBe(hashPack({ a: 2 }));
  });

  it("keeps array order significant", () => {
    expect(hashPack({ a: [1, 2] })).not.toBe(hashPack({ a: [2, 1] }));
  });

  it("treats undefined properties as absent", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it("verifies an untouched pack and rejects an altered one", () => {
    const pack = { severity: "high", count: 3 };
    const hash = hashPack(pack);
    expect(verifyAssurancePack(pack, hash).valid).toBe(true);
    expect(verifyAssurancePack(pack, hash.toUpperCase()).valid).toBe(true);
    expect(verifyAssurancePack({ severity: "low", count: 3 }, hash).valid).toBe(false);
  });
});

describe("assurance pack API", () => {
  let app: FastifyInstance;
  let uploadDirectory: string;
  let token: string;
  let otherToken: string;
  let analysisId: string;
  let projectId: string;
  let agentId: string;
  const summary: CertificateSummary = {
    agentId: "procure-bot",
    agentName: "ProcureBot",
    organization: "Fictional Acme Procurement Ltd",
    permissions: ["contracts:sign", "payments:send"],
    limits: { maxAmountUsd: 9000 },
    issuedAt: "2026-09-26T00:00:00.000Z",
    expiresAt: "2026-10-26T00:00:00.000Z",
  };
  let verifierAnswer: ReturnType<CertificateVerifier> = Promise.resolve({ ok: true, certificate: summary });
  const verifier: CertificateVerifier = () => verifierAnswer;

  const api = (method: "GET" | "POST", url: string, auth: string | null, payload?: object) =>
    app.inject({ method, url, headers: auth ? { authorization: `Bearer ${auth}` } : {}, payload });
  const body = <T>(response: { payload: string }): T => JSON.parse(response.payload) as T;

  beforeAll(async () => {
    uploadDirectory = await mkdtemp(path.join(tmpdir(), "gap-pack-"));
    app = await buildApp({
      config: loadConfig({ NODE_ENV: "test", JWT_SECRET: "test-secret-with-at-least-thirty-two-characters", UPLOAD_DIRECTORY: uploadDirectory, LOG_LEVEL: "silent", PERSISTENCE_DRIVER: "memory" }),
      store: new MemoryStore(),
      logger: false,
      certificateVerifier: verifier,
    });
    await app.ready();
    const register = async (email: string, org: string) =>
      body<{ data: { accessToken: string } }>(
        await api("POST", "/api/v1/auth/register", null, { email, name: "Pack Tester", organizationName: org, password: "Correct Horse Battery 123!" }),
      ).data.accessToken;
    token = await register("pack@example.test", "Pack Fictional Ltd");
    otherToken = await register("packother@example.test", "Other Pack Fictional Ltd");
    const project = body<{ data: { id: string } }>(
      await api("POST", "/api/v1/projects", token, { name: "Pack Project", description: "Fictional project", primaryCountryCode: "US", primarySubdivisionCode: "US-IL", affectedCountryCodes: ["CA"] }),
    );
    projectId = project.data.id;
    const agent = body<{ data: { id: string } }>(
      await api("POST", `/api/v1/projects/${projectId}/agents`, token, agentInput({ canEnterContracts: false, perTransactionLimit: 1000 })),
    );
    agentId = agent.data.id;
    const analysis = body<{ data: { id: string } }>(
      await api("POST", `/api/v1/projects/${projectId}/analyses`, token, { agentProfileId: agentId, documentIds: [] }),
    );
    analysisId = analysis.data.id;
  });

  afterAll(async () => {
    await app.close();
    await rm(uploadDirectory, { recursive: true, force: true });
  });

  it("refuses to build a pack before the analysis has completed (409)", async () => {
    const response = await api("POST", `/api/v1/analyses/${analysisId}/assurance-pack`, token, {});
    expect(response.statusCode).toBe(409);
  });

  it("builds a fingerprinted pack once the analysis has completed", async () => {
    const run = await api("POST", `/api/v1/analyses/${analysisId}/run`, token, {});
    expect(run.statusCode).toBe(200);
    const response = await api("POST", `/api/v1/analyses/${analysisId}/assurance-pack`, token, {});
    expect(response.statusCode).toBe(200);
    const built = body<{ data: { pack: { schema: string; agent: { name: string }; authorityCertificate: unknown; findings: { total: number } }; contentHash: string } }>(response).data;
    expect(built.pack.schema).toBe("rootsystems.agent-assurance-pack.v1");
    expect(built.pack.agent.name).toBe("ProcureBot");
    expect(built.pack.authorityCertificate).toBeNull();
    expect(built.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashPack(built.pack)).toBe(built.contentHash);
  });

  it("contains no contract text, evidence or explanations", async () => {
    const response = await api("POST", `/api/v1/analyses/${analysisId}/assurance-pack`, token, {});
    const built = body<{ data: { pack: { findings: { items: Array<Record<string, unknown>> } } } }>(response).data;
    for (const item of built.pack.findings.items) {
      for (const forbidden of ["documentFact", "agentProfileFact", "systemInference", "evidence", "analysisExplanation", "factualBasis", "recommendedReviewQuestions"]) {
        expect(item).not.toHaveProperty(forbidden);
      }
    }
    expect(response.payload).not.toContain("originalText");
  });

  it("adds the verified certificate reconciliation when one is supplied", async () => {
    verifierAnswer = Promise.resolve({ ok: true, certificate: summary });
    const response = await api("POST", `/api/v1/analyses/${analysisId}/assurance-pack`, token, { certificate: "x".repeat(40) });
    expect(response.statusCode).toBe(200);
    const built = body<{ data: { pack: { authorityCertificate: { verifiedWithAuthorityAtlas: boolean; profileCoversCertificate: boolean; differences: Array<{ capability: string | null }> } } } }>(response).data;
    expect(built.pack.authorityCertificate.verifiedWithAuthorityAtlas).toBe(true);
    expect((built.pack.authorityCertificate as unknown as { issuerOrganizationVerified: boolean }).issuerOrganizationVerified).toBe(false);
    expect(built.pack.authorityCertificate.profileCoversCertificate).toBe(false);
    expect(built.pack.authorityCertificate.differences.some((d) => d.capability === "canEnterContracts")).toBe(true);
  });

  it("will not build a pack around a certificate that could not be verified", async () => {
    verifierAnswer = Promise.resolve({ ok: false, reason: "revoked" });
    expect((await api("POST", `/api/v1/analyses/${analysisId}/assurance-pack`, token, { certificate: "x".repeat(40) })).statusCode).toBe(422);
    verifierAnswer = Promise.resolve({ ok: false, reason: "verifier_unavailable" });
    expect((await api("POST", `/api/v1/analyses/${analysisId}/assurance-pack`, token, { certificate: "x".repeat(40) })).statusCode).toBe(503);
  });

  it("requires sign-in and hides other organizations' analyses", async () => {
    expect((await api("POST", `/api/v1/analyses/${analysisId}/assurance-pack`, null, {})).statusCode).toBe(401);
    expect((await api("POST", `/api/v1/analyses/${analysisId}/assurance-pack`, otherToken, {})).statusCode).toBe(404);
  });

  it("verifies a pack it built and rejects a tampered one", async () => {
    const built = body<{ data: { pack: Record<string, unknown>; contentHash: string } }>(
      await api("POST", `/api/v1/analyses/${analysisId}/assurance-pack`, token, {}),
    ).data;
    const ok = await api("POST", "/api/v1/analyses/assurance-pack/verify", token, { pack: built.pack, contentHash: built.contentHash });
    expect(body<{ data: { valid: boolean } }>(ok).data.valid).toBe(true);
    const tampered = { ...built.pack, project: "A different project" };
    const bad = await api("POST", "/api/v1/analyses/assurance-pack/verify", token, { pack: tampered, contentHash: built.contentHash });
    expect(body<{ data: { valid: boolean } }>(bad).data.valid).toBe(false);
    const malformed = await api("POST", "/api/v1/analyses/assurance-pack/verify", token, { pack: built.pack, contentHash: "nothex" });
    expect(malformed.statusCode).toBe(400);
  });

  it("audits every pack it generates", async () => {
    const events = body<{ data: Array<{ action: string }> }>(await api("GET", `/api/v1/projects/${projectId}/audit-events`, token));
    expect(events.data.some((e) => e.action === "assurance_pack.generate")).toBe(true);
  });
});
