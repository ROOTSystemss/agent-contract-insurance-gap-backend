import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import type { AgentProfile, Analysis, Finding, Project } from "../src/domain/types.js";
import { MemoryStore } from "../src/persistence/memory-store.js";
import { agentInput } from "./helpers.js";

interface SuccessBody<T> {
  data: T;
  meta: Record<string, unknown>;
  requestId: string;
}

interface RegistrationData {
  accessToken: string;
  user: { id: string; email: string };
  organization: { id: string };
  role: string;
}

function parse<T>(payload: string): T {
  return JSON.parse(payload) as T;
}

describe("API integration", () => {
  let app: FastifyInstance;
  let uploadDirectory: string;
  const store = new MemoryStore();
  let owner: RegistrationData;
  let other: RegistrationData;

  beforeAll(async () => {
    uploadDirectory = await mkdtemp(path.join(tmpdir(), "gap-api-"));
    const config = loadConfig({
      NODE_ENV: "test",
      JWT_SECRET: "test-secret-with-at-least-thirty-two-characters",
      UPLOAD_DIRECTORY: uploadDirectory,
      LOG_LEVEL: "silent",
      PERSISTENCE_DRIVER: "memory",
    });
    app = await buildApp({ config, store, logger: false });
    await app.ready();
    owner = await register("owner@example.test", "Owner Person", "Owner Fictional Ltd");
    other = await register("other@example.test", "Other Person", "Other Fictional Ltd");
  });

  afterAll(async () => {
    await app.close();
    await rm(uploadDirectory, { recursive: true, force: true });
  });

  async function register(
    email: string,
    name: string,
    organizationName: string,
  ): Promise<RegistrationData> {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email, name, organizationName, password: "Correct Horse Battery 123!" },
    });
    expect(response.statusCode).toBe(201);
    return parse<SuccessBody<RegistrationData>>(response.body).data;
  }

  async function createProject(token: string, name = "Procurement Agent Review"): Promise<Project> {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name,
        description: "Fictional project",
        primaryCountryCode: "US",
        primarySubdivisionCode: "US-IL",
        affectedCountryCodes: ["CA"],
      },
    });
    expect(response.statusCode).toBe(201);
    return parse<SuccessBody<Project>>(response.body).data;
  }

  it("serves the product UI, health, readiness, metadata, OpenAPI, and Swagger", async () => {
    const productUi = await app.inject({ method: "GET", url: "/" });
    expect(productUi.statusCode).toBe(200);
    expect(productUi.headers["content-type"]).toContain("text/html");
    expect(productUi.body).toContain("AI Agent Trust");
    expect(productUi.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(productUi.headers["x-content-type-options"]).toBe("nosniff");
    expect((await app.inject({ method: "GET", url: "/styles.css" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/app.js" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/ready" })).statusCode).toBe(200);
    const meta = await app.inject({ method: "GET", url: "/api/v1/meta" });
    expect(meta.statusCode).toBe(200);
    expect(meta.body).toContain("not legal advice");
    expect((await app.inject({ method: "GET", url: "/api/v1/openapi.json" })).statusCode).toBe(200);
    expect([200, 302]).toContain((await app.inject({ method: "GET", url: "/docs" })).statusCode);
  });

  it("supports login, rejects invalid credentials, and protects endpoints", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "owner@example.test", password: "Correct Horse Battery 123!" },
    });
    expect(login.statusCode).toBe(200);
    expect(parse<SuccessBody<{ accessToken: string }>>(login.body).data.accessToken).toBeTruthy();
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/auth/login",
          payload: { email: "owner@example.test", password: "wrong" },
        })
      ).statusCode,
    ).toBe(401);
    const protectedResponse = await app.inject({ method: "GET", url: "/api/v1/auth/me" });
    expect(protectedResponse.statusCode).toBe(401);
    expect(
      parse<{ error: { code: string; requestId: string } }>(protectedResponse.body).error.code,
    ).toBe("UNAUTHORIZED");
  });

  it("allows the bundled frontend origin and rejects unrelated origins", async () => {
    const sameOrigin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      headers: { host: "127.0.0.1:4400", origin: "http://127.0.0.1:4400" },
      payload: {
        email: "same-origin@example.test",
        name: "Same Origin",
        organizationName: "Same Origin Fictional Ltd",
        password: "Correct Horse Battery 123!",
      },
    });
    expect(sameOrigin.statusCode).toBe(201);
    expect(sameOrigin.headers["access-control-allow-origin"]).toBe("http://127.0.0.1:4400");

    // A read from an unrelated origin is answered but carries no permission for that site to read
    // it; a state-changing request from it is rejected.
    const unrelatedOrigin = await app.inject({
      method: "GET",
      url: "/health",
      headers: { host: "127.0.0.1:4400", origin: "https://untrusted.example" },
    });
    expect(unrelatedOrigin.statusCode).not.toBe(403);
    expect(unrelatedOrigin.headers["access-control-allow-origin"]).toBeUndefined();
    const unrelatedWrite = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      headers: { host: "127.0.0.1:4400", origin: "https://untrusted.example" },
      payload: {
        email: "unrelated@example.test",
        name: "Unrelated",
        organizationName: "Unrelated Fictional Ltd",
        password: "Correct Horse Battery 123!",
      },
    });
    expect(unrelatedWrite.statusCode).toBe(403);
  });

  it("enforces role restrictions", async () => {
    const viewer = await register("viewer@example.test", "Viewer Person", "Viewer Fictional Ltd");
    store.setRoleForTesting(viewer.user.id, viewer.organization.id, "viewer");
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "viewer@example.test", password: "Correct Horse Battery 123!" },
    });
    const viewerToken = parse<SuccessBody<{ accessToken: string }>>(login.body).data.accessToken;
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { authorization: `Bearer ${viewerToken}` },
      payload: { name: "Forbidden project", primaryCountryCode: "US" },
    });
    expect(response.statusCode).toBe(403);
  });

  it("supports project CRUD and blocks cross-tenant identifier guessing", async () => {
    const project = await createProject(owner.accessToken, "Isolation Review");
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/v1/projects/${project.id}`,
          headers: { authorization: `Bearer ${owner.accessToken}` },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/v1/projects/${project.id}`,
          headers: { authorization: `Bearer ${other.accessToken}` },
        })
      ).statusCode,
    ).toBe(404);
    const update = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${project.id}`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: "Updated Isolation Review" },
    });
    expect(parse<SuccessBody<Project>>(update.body).data.name).toBe("Updated Isolation Review");
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/v1/projects/${project.id}`,
          headers: { authorization: `Bearer ${owner.accessToken}` },
        })
      ).statusCode,
    ).toBe(204);
  });

  it("validates agent profiles and runs a traceable analysis", async () => {
    const project = await createProject(owner.accessToken);
    const invalid = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/agents`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: "Incomplete" },
    });
    expect(invalid.statusCode).toBe(400);

    const createAgent = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/agents`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: agentInput({ canEnterContracts: true }),
    });
    expect(createAgent.statusCode).toBe(201);
    const agent = parse<SuccessBody<AgentProfile>>(createAgent.body).data;

    const document = await app.documentService.upload({
      organizationId: owner.organization.id,
      projectId: project.id,
      uploaderId: owner.user.id,
      filename: "fictional-contract.txt",
      mimeType: "text/plain",
      buffer: Buffer.from(
        "Approval Requirements\n\nSoftware tools may prepare purchase orders. Human approval is required before any commitment above USD 1,000. Confidential information must be protected and audit log records retained.",
      ),
      documentType: "commercial_contract",
      countryCode: "US",
      subdivisionCode: "US-IL",
    });

    const createAnalysis = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/analyses`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { agentProfileId: agent.id, documentIds: [document.id] },
    });
    expect(createAnalysis.statusCode).toBe(201);
    const analysis = parse<SuccessBody<Analysis>>(createAnalysis.body).data;
    const run = await app.inject({
      method: "POST",
      url: `/api/v1/analyses/${analysis.id}/run`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(run.statusCode).toBe(200);
    const result = parse<SuccessBody<{ analysis: Analysis; findings: Finding[] }>>(run.body).data;
    expect(result.analysis.state).toBe("completed_with_warnings");
    expect(result.analysis.attentionScore?.score).toBeGreaterThan(0);
    expect(result.findings.length).toBeGreaterThan(0);
    expect(
      result.findings.every((finding) => finding.disclaimer.includes("not legal advice")),
    ).toBe(true);
    for (const finding of result.findings) {
      for (const evidence of finding.evidence)
        expect(document.extractedText).toContain(evidence.excerpt);
    }

    const rerun = await app.inject({
      method: "POST",
      url: `/api/v1/analyses/${analysis.id}/rerun`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    const rerunResult = parse<SuccessBody<{ findings: Finding[] }>>(rerun.body).data;
    expect(rerunResult.findings.map((finding) => finding.id)).toEqual(
      result.findings.map((finding) => finding.id),
    );

    const report = await app.inject({
      method: "GET",
      url: `/api/v1/analyses/${analysis.id}/report`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(report.statusCode).toBe(200);
    expect(report.body).toContain("coverage opinion");
    expect(report.body).toContain("scoreContributions");

    const pdfReport = await app.inject({
      method: "GET",
      url: `/api/v1/analyses/${analysis.id}/report.pdf`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(pdfReport.statusCode).toBe(200);
    expect(pdfReport.headers["content-type"]).toContain("application/pdf");
    expect(pdfReport.rawPayload.subarray(0, 4).toString()).toBe("%PDF");

    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/v1/documents/${document.id}`,
          headers: { authorization: `Bearer ${other.accessToken}` },
        })
      ).statusCode,
    ).toBe(404);
  });

  it("purges expired document metadata and stored content", async () => {
    const project = await createProject(owner.accessToken, "Retention Review");
    const document = await app.documentService.upload({
      organizationId: owner.organization.id,
      projectId: project.id,
      uploaderId: owner.user.id,
      filename: "expired.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Fictional contract content for retention testing."),
      documentType: "commercial_contract",
      countryCode: "US",
    });
    await store.updateDocument({
      ...document,
      deleteAfter: new Date(0).toISOString(),
    });

    const sweep = await app.documentService.purgeExpired();
    expect(sweep).toEqual({ deleted: 1, failed: 0 });
    expect(await store.getDocument(owner.organization.id, document.id)).toBeNull();
    await expect(access(path.join(uploadDirectory, document.storageKey))).rejects.toThrow();
  });
});
