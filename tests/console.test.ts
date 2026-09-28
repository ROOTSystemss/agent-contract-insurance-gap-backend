import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import { SecretBox } from "../src/governance/secret-box.js";
import { MemoryStore } from "../src/persistence/memory-store.js";

// Unit-level checks for the Agent Governance console. The full chain against the real Atlas and
// Trust Proof servers is scripts/console-e2e.mjs.

describe("SecretBox", () => {
  const box = new SecretBox(randomBytes(32));

  it("round-trips a value and never stores it in the clear", () => {
    const sealed = box.seal("rs_live_secret_value");
    expect(sealed.startsWith("enc:v1:")).toBe(true);
    expect(sealed).not.toContain("rs_live_secret_value");
    expect(box.open(sealed)).toBe("rs_live_secret_value");
  });

  it("uses a fresh IV each time", () => {
    expect(box.seal("same")).not.toBe(box.seal("same"));
  });

  it("rejects a tampered value", () => {
    const sealed = box.seal("value");
    const parts = sealed.split(".");
    const body = Buffer.from(parts[2]!, "base64");
    body[0] = (body[0] ?? 0) ^ 1;
    parts[2] = body.toString("base64");
    expect(() => box.open(parts.join("."))).toThrow();
  });

  it("rejects a value sealed under another key", () => {
    expect(() => new SecretBox(randomBytes(32)).open(box.seal("value"))).toThrow();
  });

  it("marks values plainly when no key is configured, and cannot read sealed ones", () => {
    const plain = new SecretBox(null);
    expect(plain.seal("x")).toBe("plain:x");
    expect(plain.open("plain:x")).toBe("x");
    expect(() => plain.open(box.seal("x"))).toThrow();
  });
});

describe("console API", () => {
  let app: FastifyInstance;
  const store = new MemoryStore();
  let ownerToken: string;
  let viewerToken: string;

  beforeAll(async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      JWT_SECRET: "test-secret-with-at-least-thirty-two-characters",
      LOG_LEVEL: "silent",
      PERSISTENCE_DRIVER: "memory",
    });
    // No AUTHORITY_ATLAS_URL / TRUST_PROOF_URL: the console is not configured here.
    app = await buildApp({ config, store, logger: false });
    const register = async (email: string) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/auth/register",
        payload: { email, name: "Console Test", organizationName: "Console Org", password: "Correct Horse Battery 123!" },
      });
      return JSON.parse(response.payload) as { data: { accessToken: string; user: { id: string }; organization: { id: string } } };
    };
    ownerToken = (await register("owner@example.com")).data.accessToken;
    const viewer = await register("viewer@example.com");
    store.setRoleForTesting(viewer.data.user.id, viewer.data.organization.id, "viewer");
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "viewer@example.com", password: "Correct Horse Battery 123!" },
    });
    viewerToken = (JSON.parse(login.payload) as { data: { accessToken: string } }).data.accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  it("requires sign-in", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/console/status" });
    expect(response.statusCode).toBe(401);
  });

  it("reports when Atlas and Trust Proof are not configured", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/console/status", headers: { authorization: `Bearer ${ownerToken}` } });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload) as { data: { configured: { atlas: boolean; trustProof: boolean }; linked: boolean } };
    expect(body.data.configured).toEqual({ atlas: false, trustProof: false });
    expect(body.data.linked).toBe(false);
  });

  it("answers 503 instead of failing when the console is not configured", async () => {
    const response = await app.inject({ method: "POST", url: "/api/v1/console/link", headers: { authorization: `Bearer ${ownerToken}` } });
    expect(response.statusCode).toBe(503);
    expect(response.payload).toContain("CONSOLE_NOT_CONFIGURED");
  });

  it("does not let a viewer revoke certificates or see the agent key", async () => {
    const revoke = await app.inject({
      method: "POST",
      url: `/api/v1/console/certificates/${"0".repeat(8)}-0000-4000-8000-${"0".repeat(12)}/revoke`,
      headers: { authorization: `Bearer ${viewerToken}` },
    });
    expect(revoke.statusCode).toBe(403);
    const connection = await app.inject({ method: "GET", url: "/api/v1/console/connection", headers: { authorization: `Bearer ${viewerToken}` } });
    expect(connection.statusCode).toBe(403);
  });

  it("validates certificate input before calling Atlas", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/console/certificates",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { agentId: "bad id!", agentName: "", permissions: [] },
    });
    expect(response.statusCode).toBe(400);
  });
});
