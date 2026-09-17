import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import { MemoryStore } from "../src/persistence/memory-store.js";

interface SuccessBody<T> {
  data: T;
  meta: Record<string, unknown>;
  requestId: string;
}

function parse<T>(payload: string): T {
  return JSON.parse(payload) as T;
}

const REDIRECT_URI = "http://localhost:3000/auth/atlas/callback";
const CLIENT_ID = "ai-compliance-readiness";
const CLIENT_SECRET = "test-oauth-secret-with-at-least-thirty-two-characters";

describe("Authority Atlas OAuth bridge", () => {
  let app: FastifyInstance;
  let uploadDirectory: string;
  const store = new MemoryStore();

  beforeAll(async () => {
    uploadDirectory = await mkdtemp(path.join(tmpdir(), "gap-oauth-"));
    const config = loadConfig({
      NODE_ENV: "test",
      JWT_SECRET: "test-secret-with-at-least-thirty-two-characters",
      UPLOAD_DIRECTORY: uploadDirectory,
      LOG_LEVEL: "silent",
      PERSISTENCE_DRIVER: "memory",
      ATLAS_OAUTH_CLIENT_ID: CLIENT_ID,
      ATLAS_OAUTH_CLIENT_SECRET: CLIENT_SECRET,
      ATLAS_OAUTH_REDIRECT_URIS: REDIRECT_URI,
      ATLAS_OAUTH_CODE_TTL_MS: "15000",
    });
    app = await buildApp({ config, store, logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await rm(uploadDirectory, { recursive: true, force: true });
  });

  async function register(email: string, organizationName: string): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        email,
        name: "Test User",
        organizationName,
        password: "Correct Horse Battery 123!",
      },
    });
    expect(response.statusCode).toBe(201);
    return parse<SuccessBody<{ accessToken: string }>>(response.body).data.accessToken;
  }

  async function authorize(token: string, state = "state-1") {
    return app.inject({
      method: "POST",
      url: "/api/v1/oauth/authorize",
      headers: { authorization: `Bearer ${token}` },
      payload: { clientId: CLIENT_ID, redirectUri: REDIRECT_URI, state, responseType: "code" },
    });
  }

  function extractCode(redirectTo: string): string {
    return new URL(redirectTo).searchParams.get("code")!;
  }

  it("rejects an unauthenticated authorize request", async () => {
    const response = await authorize("");
    expect(response.statusCode).toBe(401);
  });

  it("rejects an authorize request with an unlisted redirect_uri", async () => {
    const token = await register("mismatch@example.test", "Mismatch Fictional Ltd");
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/oauth/authorize",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        clientId: CLIENT_ID,
        redirectUri: "http://evil.example.test/callback",
        state: "s",
        responseType: "code",
      },
    });
    expect(response.statusCode).toBe(400);
    expect(parse<{ error: { code: string } }>(response.body).error.code).toBe(
      "INVALID_REDIRECT_URI",
    );
  });

  it("rejects a token exchange with the wrong client secret", async () => {
    const token = await register("wrongsecret@example.test", "Wrong Secret Fictional Ltd");
    const authorizeResponse = await authorize(token);
    const code = extractCode(
      parse<SuccessBody<{ redirectTo: string }>>(authorizeResponse.body).data.redirectTo,
    );
    const tokenResponse = await app.inject({
      method: "POST",
      url: "/api/v1/oauth/token",
      payload: {
        grantType: "authorization_code",
        code,
        redirectUri: REDIRECT_URI,
        clientId: CLIENT_ID,
        clientSecret: "not-the-right-secret",
      },
    });
    expect(tokenResponse.statusCode).toBe(401);
    expect(parse<{ error: { code: string } }>(tokenResponse.body).error.code).toBe(
      "INVALID_CLIENT",
    );
  });

  it("completes the full authorize -> token exchange and rejects code reuse", async () => {
    const token = await register("fullflow@example.test", "Full Flow Fictional Ltd");
    const authorizeResponse = await authorize(token, "the-state-value");
    expect(authorizeResponse.statusCode).toBe(200);
    const { redirectTo } = parse<SuccessBody<{ redirectTo: string }>>(authorizeResponse.body).data;
    const redirectUrl = new URL(redirectTo);
    expect(redirectUrl.searchParams.get("state")).toBe("the-state-value");
    const code = redirectUrl.searchParams.get("code")!;
    expect(code).toBeTruthy();

    const tokenResponse = await app.inject({
      method: "POST",
      url: "/api/v1/oauth/token",
      payload: {
        grantType: "authorization_code",
        code,
        redirectUri: REDIRECT_URI,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
      },
    });
    expect(tokenResponse.statusCode).toBe(200);
    const body = parse<
      SuccessBody<{
        subject: { atlasUserId: string; email: string; name: string };
        organization: { atlasOrganizationId: string; atlasOrganizationName: string };
        role: string;
      }>
    >(tokenResponse.body).data;
    expect(body.subject.email).toBe("fullflow@example.test");
    expect(body.organization.atlasOrganizationName).toBe("Full Flow Fictional Ltd");
    expect(body.role).toBe("owner");

    // Replaying the same code must fail - single-use.
    const replay = await app.inject({
      method: "POST",
      url: "/api/v1/oauth/token",
      payload: {
        grantType: "authorization_code",
        code,
        redirectUri: REDIRECT_URI,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
      },
    });
    expect(replay.statusCode).toBe(400);
    expect(parse<{ error: { code: string } }>(replay.body).error.code).toBe("INVALID_GRANT");
  });

  it("keeps two organizations' codes resolving only to their own identity", async () => {
    const tokenA = await register("org-a@example.test", "Org A Fictional Ltd");
    const tokenB = await register("org-b@example.test", "Org B Fictional Ltd");

    const authorizeA = await authorize(tokenA, "state-a");
    const authorizeB = await authorize(tokenB, "state-b");
    const codeA = extractCode(
      parse<SuccessBody<{ redirectTo: string }>>(authorizeA.body).data.redirectTo,
    );
    const codeB = extractCode(
      parse<SuccessBody<{ redirectTo: string }>>(authorizeB.body).data.redirectTo,
    );

    async function exchange(code: string) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/oauth/token",
        payload: {
          grantType: "authorization_code",
          code,
          redirectUri: REDIRECT_URI,
          clientId: CLIENT_ID,
          clientSecret: CLIENT_SECRET,
        },
      });
      expect(response.statusCode).toBe(200);
      return parse<SuccessBody<{ organization: { atlasOrganizationName: string } }>>(response.body)
        .data;
    }

    const resultA = await exchange(codeA);
    const resultB = await exchange(codeB);
    expect(resultA.organization.atlasOrganizationName).toBe("Org A Fictional Ltd");
    expect(resultB.organization.atlasOrganizationName).toBe("Org B Fictional Ltd");
  });

  it("rejects an expired code", async () => {
    const token = await register("expired@example.test", "Expired Fictional Ltd");
    const authorizeResponse = await authorize(token, "expiring-state");
    const code = extractCode(
      parse<SuccessBody<{ redirectTo: string }>>(authorizeResponse.body).data.redirectTo,
    );
    await new Promise((resolve) => setTimeout(resolve, 15_050));
    const tokenResponse = await app.inject({
      method: "POST",
      url: "/api/v1/oauth/token",
      payload: {
        grantType: "authorization_code",
        code,
        redirectUri: REDIRECT_URI,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
      },
    });
    expect(tokenResponse.statusCode).toBe(400);
    expect(parse<{ error: { code: string } }>(tokenResponse.body).error.code).toBe("INVALID_GRANT");
  }, 20_000);

  it("requires an admin role to export the governance summary", async () => {
    const token = await register("gov@example.test", "Gov Fictional Ltd");
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/governance/export",
      headers: { authorization: `Bearer ${token}` },
    });
    // The registering user is "owner", which outranks "admin" - should succeed.
    expect(response.statusCode).toBe(200);
    const body = parse<SuccessBody<{ truncated: boolean }>>(response.body).data;
    expect(body.truncated).toBe(false);
  });
});
