import { createHmac, randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import { MemoryStore } from "../src/persistence/memory-store.js";

// Console billing: Dodo webhooks (Standard Webhooks signatures) set a workspace's plan. No network:
// signatures are made here with the same secret the server is configured with.
const secretBytes = randomBytes(24);
const WEBHOOK_KEY = `whsec_${secretBytes.toString("base64")}`;
const TEAM = "pdt_team_test";
const BUSINESS = "pdt_business_test";

function signed(payload: unknown, id = `msg_${randomBytes(6).toString("hex")}`, timestamp = Math.floor(Date.now() / 1000)) {
  const body = JSON.stringify(payload);
  const signature = createHmac("sha256", secretBytes).update(`${id}.${timestamp}.${body}`).digest("base64");
  return { body, headers: { "content-type": "application/json", "webhook-id": id, "webhook-timestamp": String(timestamp), "webhook-signature": `v1,${signature}` } };
}
function subscriptionEvent(organizationId: string, productId: string, status: string) {
  return {
    business_id: "biz_test",
    type: `subscription.${status === "active" ? "active" : status}`,
    timestamp: new Date().toISOString(),
    data: {
      payload_type: "Subscription",
      subscription_id: "sub_test",
      product_id: productId,
      status,
      next_billing_date: "2026-10-28T00:00:00Z",
      metadata: { organizationId },
      customer: { customer_id: "cus_test", email: "owner@example.com", name: "Owner" },
    },
  };
}

describe("console billing", () => {
  let app: FastifyInstance;
  const store = new MemoryStore();
  let token: string;
  let organizationId: string;

  beforeAll(async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      JWT_SECRET: "test-secret-with-at-least-thirty-two-characters",
      LOG_LEVEL: "silent",
      PERSISTENCE_DRIVER: "memory",
      DODO_PAYMENTS_API_KEY: "test_key_not_used_for_network",
      DODO_PAYMENTS_WEBHOOK_KEY: WEBHOOK_KEY,
      DODO_PRODUCT_ID_TEAM: TEAM,
      DODO_PRODUCT_ID_BUSINESS: BUSINESS,
    });
    app = await buildApp({ config, store, logger: false });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email: "owner@example.com", name: "Owner", organizationName: "Billing Org", password: "Correct Horse Battery 123!" },
    });
    const body = JSON.parse(response.payload) as { data: { accessToken: string; organization: { id: string } } };
    token = body.data.accessToken;
    organizationId = body.data.organization.id;
  });

  afterAll(async () => {
    await app.close();
  });

  const plan = async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/console/billing", headers: { authorization: `Bearer ${token}` } });
    return (JSON.parse(response.payload) as { data: { plan: { id: string; activeCertificates: number }; status: string } }).data;
  };
  const post = (payload: { body: string; headers: Record<string, string> }) =>
    app.inject({ method: "POST", url: "/api/v1/billing/webhook", payload: payload.body, headers: payload.headers });

  it("starts on the free trial plan with 2 active certificates", async () => {
    const current = await plan();
    expect(current.plan.id).toBe("free");
    expect(current.plan.activeCertificates).toBe(2);
  });

  it("rejects a webhook with a bad signature", async () => {
    const event = signed(subscriptionEvent(organizationId, TEAM, "active"));
    event.headers["webhook-signature"] = "v1,AAAA";
    expect((await post(event)).statusCode).toBe(400);
    expect((await plan()).plan.id).toBe("free");
  });

  it("upgrades the workspace when Dodo reports an active Team subscription", async () => {
    const response = await post(signed(subscriptionEvent(organizationId, TEAM, "active")));
    expect(response.statusCode).toBe(200);
    const current = await plan();
    expect(current.plan.id).toBe("team");
    expect(current.plan.activeCertificates).toBe(10);
  });

  it("ignores a redelivered event", async () => {
    const event = signed(subscriptionEvent(organizationId, BUSINESS, "active"), "msg_fixed_id");
    expect((await post(event)).statusCode).toBe(200);
    expect((await plan()).plan.id).toBe("business");
    // Same id again, now claiming cancellation: must be ignored.
    const replay = signed(subscriptionEvent(organizationId, BUSINESS, "cancelled"), "msg_fixed_id");
    expect(JSON.parse((await post(replay)).payload)).toMatchObject({ handled: true });
    expect((await plan()).plan.id).toBe("business");
  });

  it("does not let an older event overwrite a newer one", async () => {
    const old = signed(subscriptionEvent(organizationId, BUSINESS, "cancelled"), undefined, Math.floor(Date.now() / 1000) - 3600);
    await post(old);
    expect((await plan()).plan.id).toBe("business");
  });

  it("drops to free when the subscription is cancelled", async () => {
    await post(signed(subscriptionEvent(organizationId, BUSINESS, "cancelled"), undefined, Math.floor(Date.now() / 1000) + 5));
    expect((await plan()).plan.id).toBe("free");
  });

  it("ignores products that are not Agent Governance plans", async () => {
    const response = await post(signed(subscriptionEvent(organizationId, "pdt_other_product", "active"), undefined, Math.floor(Date.now() / 1000) + 10));
    expect(JSON.parse(response.payload)).toMatchObject({ handled: false });
    expect((await plan()).plan.id).toBe("free");
  });

  it("rejects an unknown plan at checkout", async () => {
    const response = await app.inject({ method: "POST", url: "/api/v1/console/billing/checkout", headers: { authorization: `Bearer ${token}` }, payload: { plan: "gold" } });
    expect(response.statusCode).toBe(400);
  });
});
