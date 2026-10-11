import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import { MemoryStore } from "../src/persistence/memory-store.js";
import { isTrunkActive, isTrunkEnabled } from "../src/governance/trunk.js";

// Trunk parked (TRUNK_ENABLED=0, the default on the live server): the Settings panel hides itself,
// the Trunk endpoints are gone, and a workspace on the grant list still has no Trunk.
describe("trunk parked", () => {
  let app: FastifyInstance;
  let token: string;
  let organizationId: string;
  const saved = { enabled: process.env.TRUNK_ENABLED, ids: process.env.TRUNK_ORGANIZATION_IDS };

  beforeAll(async () => {
    app = await buildApp({
      config: loadConfig({
        NODE_ENV: "test",
        JWT_SECRET: "test-secret-with-at-least-thirty-two-characters",
        LOG_LEVEL: "silent",
        PERSISTENCE_DRIVER: "memory",
      }),
      store: new MemoryStore(),
      logger: false,
    });
    const reg = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        email: "parked@example.com",
        name: "Owner",
        organizationName: "Parked Org",
        password: "Correct Horse Battery 123!",
      },
    });
    const body = JSON.parse(reg.payload) as {
      data: { accessToken: string; organization: { id: string } };
    };
    token = body.data.accessToken;
    organizationId = body.data.organization.id;
    process.env.TRUNK_ENABLED = "0";
    process.env.TRUNK_ORGANIZATION_IDS = organizationId;
  });
  afterAll(async () => {
    process.env.TRUNK_ENABLED = saved.enabled;
    process.env.TRUNK_ORGANIZATION_IDS = saved.ids;
    await app.close();
  });
  const call = (method: "GET" | "POST", url: string) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      payload: method === "POST" ? {} : undefined,
    });

  it("defaults: parked on the live server, on for local runs", () => {
    expect(isTrunkEnabled({ NODE_ENV: "production" })).toBe(false);
    expect(isTrunkEnabled({ NODE_ENV: "production", TRUNK_ENABLED: "1" })).toBe(true);
    expect(isTrunkEnabled({ NODE_ENV: "development" })).toBe(true);
    expect(isTrunkEnabled({ NODE_ENV: "development", TRUNK_ENABLED: "0" })).toBe(false);
  });

  it("a granted workspace has no Trunk while parked", () => {
    expect(isTrunkActive(organizationId)).toBe(false);
  });

  it("the panel data says parked, and the Trunk endpoints are gone", async () => {
    const panel = JSON.parse((await call("GET", "/api/v1/console/trunk")).payload) as {
      data: unknown;
    };
    expect(panel.data).toEqual({ enabled: false });
    expect((await call("POST", "/api/v1/console/trunk/interest")).statusCode).toBe(404);
    expect((await call("GET", "/api/v1/console/trunk/watch")).statusCode).toBe(402);
  });
});
