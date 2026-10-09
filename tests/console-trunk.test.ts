import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import type { AuditEvent } from "../src/domain/types.js";
import { MemoryStore } from "../src/persistence/memory-store.js";
import { isTrunkActive, keyHistory, TRUNK_FEATURES } from "../src/governance/trunk.js";

// RootSystems Trunk in the console: the panel data, the "talk to us" audit signal, the per-workspace
// grant, and the published signing key history.
describe("console trunk", () => {
  let app: FastifyInstance;
  const store = new MemoryStore();
  const audited: AuditEvent[] = [];
  const addAuditEvent = store.addAuditEvent.bind(store);
  store.addAuditEvent = async (event: AuditEvent) => {
    audited.push(event);
    return addAuditEvent(event);
  };
  let token: string;
  let organizationId: string;

  beforeAll(async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      JWT_SECRET: "test-secret-with-at-least-thirty-two-characters",
      LOG_LEVEL: "silent",
      PERSISTENCE_DRIVER: "memory",
      PQ_SIGNING_SEED: randomBytes(32).toString("base64"),
    });
    app = await buildApp({ config, store, logger: false });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        email: "trunk@example.com",
        name: "Owner",
        organizationName: "Trunk Org",
        password: "Correct Horse Battery 123!",
      },
    });
    const body = JSON.parse(response.payload) as {
      data: { accessToken: string; organization: { id: string } };
    };
    token = body.data.accessToken;
    organizationId = body.data.organization.id;
  });

  afterAll(async () => {
    delete process.env.TRUNK_ORGANIZATION_IDS;
    await app.close();
  });

  const get = (url: string) =>
    app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });

  it("needs a signed-in workspace", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/console/trunk" });
    expect(response.statusCode).toBe(401);
  });

  it("lists every feature with its honest status and is off by default", async () => {
    const response = await get("/api/v1/console/trunk");
    expect(response.statusCode).toBe(200);
    const data = (
      JSON.parse(response.payload) as {
        data: {
          active: boolean;
          features: Array<{ status: string; statusLabel: string }>;
          contactUrl: string;
        };
      }
    ).data;
    expect(data.active).toBe(false);
    expect(data.features).toHaveLength(TRUNK_FEATURES.length);
    expect(data.features.find((f) => f.status === "live")?.statusLabel).toBe("Live");
    expect(data.contactUrl).toMatch(/^https:\/\/rootsystems\.app\/contact\?topic=/);
  });

  it("records 'talk to us' in the workspace audit log and returns the contact form", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/console/trunk/interest",
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect((JSON.parse(response.payload) as { data: { url: string } }).data.url).toMatch(
      /rootsystems\.app\/contact/,
    );
    expect(
      audited.some(
        (event) =>
          event.action === "console.trunk_interest" && event.organizationId === organizationId,
      ),
    ).toBe(true);
  });

  it("is switched on only for workspaces in TRUNK_ORGANIZATION_IDS", async () => {
    process.env.TRUNK_ORGANIZATION_IDS = `other-org, ${organizationId}`;
    const data = (
      JSON.parse((await get("/api/v1/console/trunk")).payload) as { data: { active: boolean } }
    ).data;
    expect(data.active).toBe(true);
    expect(isTrunkActive("someone-else", { TRUNK_ORGANIZATION_IDS: organizationId })).toBe(false);
  });

  it("publishes the key history, holding exactly the key signing now", async () => {
    const history = JSON.parse(
      (await app.inject({ method: "GET", url: "/.well-known/rootsystems-signing-keys.json" }))
        .payload,
    ) as {
      format: string;
      product: string;
      keys: Array<{ keyId: string; publicKey: string; status: string }>;
    };
    const single = JSON.parse(
      (await app.inject({ method: "GET", url: "/.well-known/rootsystems-signing-key.json" }))
        .payload,
    ) as { keyId: string; publicKey: string };
    expect(history.format).toBe("rootsystems.keyring/v1");
    expect(history.product).toBe("agent-governance");
    expect(history.keys).toEqual([
      expect.objectContaining({
        keyId: single.keyId,
        publicKey: single.publicKey,
        status: "active",
      }),
    ]);
  });

  it("serves a rotated key history only when its active key is the one signing now", () => {
    const info = {
      configured: true,
      algorithm: "ML-DSA-65",
      keyId: "a".repeat(32),
      publicKey: "QUJD",
    };
    const ring = {
      format: "rootsystems.keyring/v1",
      product: "agent-governance",
      keys: [
        { status: "retired", publicKey: "OLD" },
        { status: "active", publicKey: "QUJD" },
      ],
    };
    expect(keyHistory(info, { PQ_KEY_HISTORY_JSON: JSON.stringify(ring) })).toEqual(ring);
    const stale = { ...ring, keys: [{ status: "active", publicKey: "SOMETHING-ELSE" }] };
    expect(keyHistory(info, { PQ_KEY_HISTORY_JSON: JSON.stringify(stale) })?.keys).toHaveLength(1);
    expect(keyHistory({ configured: false, algorithm: "ML-DSA-65" })).toBeNull();
  });
});
