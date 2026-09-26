import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import {
  createAtlasVerifier,
  deriveAuthority,
  escalationPatch,
  reconcile,
  type CertificateSummary,
  type CertificateVerifier,
} from "../src/authority/certificate.js";
import { loadConfig } from "../src/config/env.js";
import type { AgentProfile } from "../src/domain/types.js";
import { MemoryStore } from "../src/persistence/memory-store.js";
import { agentInput } from "./helpers.js";

function cert(permissions: string[], limits: CertificateSummary["limits"] = {}): CertificateSummary {
  return {
    agentId: "procure-bot",
    agentName: "ProcureBot",
    organization: "Fictional Acme Procurement Ltd",
    permissions,
    limits,
    issuedAt: "2026-09-26T00:00:00.000Z",
    expiresAt: "2026-10-26T00:00:00.000Z",
  };
}

function profile(overrides: Partial<ReturnType<typeof agentInput>> = {}): AgentProfile {
  return {
    ...agentInput(overrides),
    id: "00000000-0000-4000-8000-000000000001",
    organizationId: "org",
    projectId: "project",
    createdAt: "2026-09-26T00:00:00.000Z",
    updatedAt: "2026-09-26T00:00:00.000Z",
  };
}

describe("deriveAuthority", () => {
  it("maps payment permissions to spending capabilities", () => {
    const d = deriveAuthority(cert(["invoices:pay"]));
    expect(d.capabilities).toEqual(expect.arrayContaining(["canSpendMoney", "canExecuteTransactions"]));
  });

  it("treats read-only permissions as granting no capability and not as unmapped", () => {
    const d = deriveAuthority(cert(["loads:read", "invoices:list"]));
    expect(d.capabilities).toEqual([]);
    expect(d.unmappedPermissions).toEqual([]);
  });

  it("reports permissions it cannot classify instead of dropping them", () => {
    const d = deriveAuthority(cert(["telepathy:enable"]));
    expect(d.unmappedPermissions).toEqual(["telepathy:enable"]);
  });

  it("treats the * permission as every capability and flags broad authority", () => {
    const d = deriveAuthority(cert(["*"]));
    expect(d.broadAuthority).toBe(true);
    expect(d.capabilities.length).toBeGreaterThanOrEqual(20);
  });

  it("maps health data to sensitive and regulated data access", () => {
    const d = deriveAuthority(cert(["phi:read"]));
    expect(d.capabilities).toEqual(
      expect.arrayContaining(["canAccessSensitivePersonalData", "canAccessRegulatedData", "canAccessPersonalData"]),
    );
  });

  it("is case-insensitive", () => {
    expect(deriveAuthority(cert(["EMAIL:Send"])).capabilities).toContain("canCommunicateExternally");
  });

  it("carries the certificate's money limit", () => {
    expect(deriveAuthority(cert(["payments:send"], { maxAmountUsd: 750 })).perTransactionLimitUsd).toBe(750);
  });
});

describe("reconcile", () => {
  it("flags a profile that understates what the certificate authorizes as high severity", () => {
    const p = profile({ canEnterContracts: false });
    const r = reconcile(p, cert(["contracts:sign"]));
    const finding = r.differences.find((d) => d.capability === "canEnterContracts");
    expect(finding?.kind).toBe("profile_understates_certificate");
    expect(finding?.severity).toBe("high");
    expect(r.profileCoversCertificate).toBe(false);
  });

  it("flags a declared capability that no certificate permission covers as moderate", () => {
    const p = profile({ canSpendMoney: true });
    const r = reconcile(p, cert(["loads:read"]));
    const finding = r.differences.find((d) => d.capability === "canSpendMoney");
    expect(finding?.kind).toBe("profile_not_covered_by_certificate");
    expect(finding?.severity).toBe("moderate");
    // Over-declaring is the cautious direction, so it does not fail coverage.
    expect(r.profileCoversCertificate).toBe(true);
  });

  it("flags a profile limit below the certificate's as high severity", () => {
    const p = profile({ perTransactionLimit: 1_000 });
    const r = reconcile(p, cert(["payments:send"], { maxAmountUsd: 9_000 }));
    expect(r.differences.some((d) => d.kind === "profile_limit_below_certificate" && d.severity === "high")).toBe(true);
    expect(r.profileCoversCertificate).toBe(false);
  });

  it("flags a profile limit above the certificate's as moderate", () => {
    const p = profile({ perTransactionLimit: 9_000 });
    const r = reconcile(p, cert(["payments:send"], { maxAmountUsd: 1_000 }));
    expect(r.differences.some((d) => d.kind === "profile_limit_above_certificate" && d.severity === "moderate")).toBe(true);
  });

  it("does not compare limits across currencies", () => {
    const p = profile({ currency: "EUR", perTransactionLimit: 1_000 });
    const r = reconcile(p, cert(["payments:send"], { maxAmountUsd: 9_000 }));
    expect(r.differences.some((d) => d.kind === "limit_not_comparable")).toBe(true);
    expect(r.differences.some((d) => d.kind === "profile_limit_below_certificate")).toBe(false);
  });

  it("reports no differences when the profile matches the certificate", () => {
    const p = profile({
      canCommunicateExternally: true,
      canMakeRepresentations: false,
      canExecuteTransactions: true,
      canSpendMoney: true,
      perTransactionLimit: 5_000,
      canAccessPersonalData: false,
      canAccessConfidentialBusinessData: false,
      canApproveOrRejectVendors: false,
    });
    const r = reconcile(p, cert(["email:send", "payments:send"], { maxAmountUsd: 5_000 }));
    const fatal = r.differences.filter((d) => d.severity === "high");
    expect(fatal).toEqual([]);
  });
});

describe("escalationPatch", () => {
  it("only ever turns capabilities on and raises limits", () => {
    const p = profile({ canEnterContracts: false, perTransactionLimit: 1_000 });
    const result = escalationPatch(p, cert(["contracts:sign", "payments:send"], { maxAmountUsd: 9_000 }));
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.patch.canEnterContracts).toBe(true);
    expect(result.patch.perTransactionLimit).toBe(9_000);
    // Nothing is switched off and nothing lowered.
    expect(Object.values(result.patch).includes(false)).toBe(false);
  });

  it("never lowers an existing higher limit", () => {
    const p = profile({ perTransactionLimit: 20_000 });
    const result = escalationPatch(p, cert(["payments:send"], { maxAmountUsd: 9_000 }));
    if ("error" in result) throw new Error(result.error);
    expect(result.patch.perTransactionLimit).toBeUndefined();
  });

  it("refuses to add spending with no limit to go with it", () => {
    const p = profile({ canSpendMoney: false, perTransactionLimit: undefined, aggregateSpendingLimit: undefined, currency: undefined });
    const result = escalationPatch(p, cert(["payments:send"]));
    expect("error" in result).toBe(true);
  });

  it("refuses to mix a USD certificate limit with a non-USD profile", () => {
    const p = profile({ currency: "EUR" });
    const result = escalationPatch(p, cert(["payments:send"], { maxAmountUsd: 9_000 }));
    expect("error" in result).toBe(true);
  });

  it("reports nothing to change when the profile already covers the certificate", () => {
    const p = profile();
    const result = escalationPatch(p, cert(["loads:read"]));
    if ("error" in result) throw new Error(result.error);
    expect(result.changed).toEqual([]);
  });
});

describe("createAtlasVerifier", () => {
  const fakeFetch = (status: number, body: unknown): typeof fetch =>
    async () => new Response(JSON.stringify(body), { status });

  it("accepts a valid certificate", async () => {
    const v = createAtlasVerifier("https://atlas.example", fakeFetch(200, { valid: true, certificate: cert(["loads:read"]) }));
    expect((await v("x".repeat(30))).ok).toBe(true);
  });

  it("passes Atlas's rejection reason through", async () => {
    const v = createAtlasVerifier("https://atlas.example", fakeFetch(200, { valid: false, reason: "revoked" }));
    expect(await v("x".repeat(30))).toEqual({ ok: false, reason: "revoked" });
  });

  it("fails closed when Atlas answers with an error status", async () => {
    const v = createAtlasVerifier("https://atlas.example", fakeFetch(500, {}));
    expect(await v("x".repeat(30))).toEqual({ ok: false, reason: "verifier_unavailable" });
  });

  it("fails closed when Atlas cannot be reached", async () => {
    const v = createAtlasVerifier("https://atlas.example", async () => {
      throw new Error("network down");
    });
    expect(await v("x".repeat(30))).toEqual({ ok: false, reason: "verifier_unavailable" });
  });

  it("fails closed on a malformed valid=true answer", async () => {
    const v = createAtlasVerifier("https://atlas.example", fakeFetch(200, { valid: true }));
    expect(await v("x".repeat(30))).toEqual({ ok: false, reason: "invalid_certificate" });
  });
});

describe("certificate routes", () => {
  let app: FastifyInstance;
  let uploadDirectory: string;
  let token: string;
  let agentId: string;
  let outsider: string;
  let current: ReturnType<CertificateVerifier>;
  const verifier: CertificateVerifier = () => current;

  beforeAll(async () => {
    uploadDirectory = await mkdtemp(path.join(tmpdir(), "gap-cert-"));
    const config = loadConfig({
      NODE_ENV: "test",
      JWT_SECRET: "test-secret-with-at-least-thirty-two-characters",
      UPLOAD_DIRECTORY: uploadDirectory,
      LOG_LEVEL: "silent",
      PERSISTENCE_DRIVER: "memory",
    });
    app = await buildApp({ config, store: new MemoryStore(), logger: false, certificateVerifier: verifier });
    await app.ready();

    const register = async (email: string, org: string): Promise<string> => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/auth/register",
        payload: { email, name: "Tester", organizationName: org, password: "Correct Horse Battery 123!" },
      });
      return (JSON.parse(response.payload) as { data: { accessToken: string } }).data.accessToken;
    };
    token = await register("cert@example.test", "Cert Org");
    outsider = await register("other@example.test", "Other Org");
    const headers = { authorization: `Bearer ${token}` };
    const project = JSON.parse(
      (await app.inject({ method: "POST", url: "/api/v1/projects", headers, payload: { name: "Certs", description: "x", primaryCountryCode: "US", primarySubdivisionCode: "US-IL", affectedCountryCodes: ["CA"] } })).payload,
    ) as { data: { id: string } };
    const agent = JSON.parse(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/projects/${project.data.id}/agents`,
          headers,
          payload: agentInput({ canEnterContracts: false, canSpendMoney: false, perTransactionLimit: undefined, aggregateSpendingLimit: undefined, currency: undefined }),
        })
      ).payload,
    ) as { data: { id: string } };
    agentId = agent.data.id;
  });

  afterAll(async () => {
    await app.close();
    await rm(uploadDirectory, { recursive: true, force: true });
  });

  const post = (url: string, auth: string, body: unknown) =>
    app.inject({ method: "POST", url, headers: { authorization: `Bearer ${auth}` }, payload: body as object });
  const certBody = { certificate: "x".repeat(40) };

  it("requires sign-in", async () => {
    const response = await app.inject({ method: "POST", url: `/api/v1/agents/${agentId}/certificate-check`, payload: certBody });
    expect(response.statusCode).toBe(401);
  });

  it("does not reveal another organization's agent", async () => {
    current = Promise.resolve({ ok: true, certificate: cert(["contracts:sign"]) });
    const response = await post(`/api/v1/agents/${agentId}/certificate-check`, outsider, certBody);
    expect(response.statusCode).toBe(404);
  });

  it("reports differences for a valid certificate without changing the profile", async () => {
    current = Promise.resolve({ ok: true, certificate: cert(["contracts:sign"]) });
    const response = await post(`/api/v1/agents/${agentId}/certificate-check`, token, certBody);
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload) as { data: { profileCoversCertificate: boolean; differences: Array<{ capability?: string }> } };
    expect(body.data.profileCoversCertificate).toBe(false);
    expect(body.data.differences.some((d) => d.capability === "canEnterContracts")).toBe(true);
    const after = JSON.parse((await app.inject({ method: "GET", url: `/api/v1/agents/${agentId}`, headers: { authorization: `Bearer ${token}` } })).payload) as { data: { canEnterContracts: boolean } };
    expect(after.data.canEnterContracts).toBe(false);
  });

  it("rejects a revoked certificate with 422", async () => {
    current = Promise.resolve({ ok: false, reason: "revoked" });
    const response = await post(`/api/v1/agents/${agentId}/certificate-check`, token, certBody);
    expect(response.statusCode).toBe(422);
  });

  it("answers 503 when Atlas is unavailable, and never adopts on an unverified certificate", async () => {
    current = Promise.resolve({ ok: false, reason: "verifier_unavailable" });
    expect((await post(`/api/v1/agents/${agentId}/certificate-check`, token, certBody)).statusCode).toBe(503);
    expect((await post(`/api/v1/agents/${agentId}/adopt-certificate`, token, certBody)).statusCode).toBe(503);
  });

  it("rejects a malformed body with 400", async () => {
    current = Promise.resolve({ ok: true, certificate: cert([]) });
    expect((await post(`/api/v1/agents/${agentId}/certificate-check`, token, { certificate: "short" })).statusCode).toBe(400);
  });

  it("adopts a certificate, turning capabilities on and recording an audit event", async () => {
    current = Promise.resolve({ ok: true, certificate: cert(["contracts:sign"]) });
    const response = await post(`/api/v1/agents/${agentId}/adopt-certificate`, token, certBody);
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload) as { data: { changed: string[]; agent: { canEnterContracts: boolean; canAcceptTerms: boolean } } };
    expect(body.data.changed).toEqual(expect.arrayContaining(["canEnterContracts"]));
    expect(body.data.agent.canEnterContracts).toBe(true);
  });

  it("is idempotent: adopting the same certificate again changes nothing", async () => {
    current = Promise.resolve({ ok: true, certificate: cert(["contracts:sign"]) });
    const response = await post(`/api/v1/agents/${agentId}/adopt-certificate`, token, certBody);
    const body = JSON.parse(response.payload) as { data: { changed: string[] } };
    expect(body.data.changed).toEqual([]);
  });

  it("refuses to adopt spending authority that has no limit", async () => {
    current = Promise.resolve({ ok: true, certificate: cert(["payments:send"]) });
    const response = await post(`/api/v1/agents/${agentId}/adopt-certificate`, token, certBody);
    expect(response.statusCode).toBe(422);
  });
});

describe("certificate routes without a configured verifier", () => {
  it("answers 503 rather than trusting the certificate", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "gap-cert2-"));
    const app = await buildApp({
      config: loadConfig({ NODE_ENV: "test", JWT_SECRET: "test-secret-with-at-least-thirty-two-characters", UPLOAD_DIRECTORY: directory, LOG_LEVEL: "silent", PERSISTENCE_DRIVER: "memory" }),
      store: new MemoryStore(),
      logger: false,
    });
    await app.ready();
    const reg = JSON.parse(
      (await app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { email: "unconfigured@example.test", name: "Unconfigured Tester", organizationName: "Unconfigured Fictional Ltd", password: "Correct Horse Battery 123!" } })).payload,
    ) as { data: { accessToken: string } };
    const headers = { authorization: `Bearer ${reg.data.accessToken}` };
    const project = JSON.parse((await app.inject({ method: "POST", url: "/api/v1/projects", headers, payload: { name: "Unconfigured Project", description: "Fictional project", primaryCountryCode: "US", primarySubdivisionCode: "US-IL", affectedCountryCodes: ["CA"] } })).payload) as { data: { id: string } };
    const agent = JSON.parse((await app.inject({ method: "POST", url: `/api/v1/projects/${project.data.id}/agents`, headers, payload: agentInput() })).payload) as { data: { id: string } };
    const response = await app.inject({ method: "POST", url: `/api/v1/agents/${agent.data.id}/certificate-check`, headers, payload: { certificate: "x".repeat(40) } });
    expect(response.statusCode).toBe(503);
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
});
