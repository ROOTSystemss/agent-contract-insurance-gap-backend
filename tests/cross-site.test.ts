import { createHmac, randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyRequest } from "fastify";
import { buildApp, isAllowedOrigin } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import { MemoryStore } from "../src/persistence/memory-store.js";

// Cross-site handling in the console: page loads and reads from other sites are never refused;
// state-changing requests from a foreign Origin are; our own origin comes from PUBLIC_BASE_URL, not
// the Host header; the Dodo webhook is exempt from the browser check but verifies its signature.
const OURS = "https://console.rootsystems.test";
const SECRET = randomBytes(24);

describe("cross-site handling", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({
      config: loadConfig({
        NODE_ENV: "test",
        JWT_SECRET: "test-secret-with-at-least-thirty-two-characters",
        LOG_LEVEL: "silent",
        PERSISTENCE_DRIVER: "memory",
        PUBLIC_BASE_URL: OURS,
        CORS_ORIGINS: OURS,
        DOCUMENT_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
        DODO_PAYMENTS_API_KEY: "test-key-not-real",
        DODO_PAYMENTS_WEBHOOK_KEY: "whsec_" + SECRET.toString("base64"),
        DODO_ENVIRONMENT: "test_mode",
        DODO_PRODUCT_ID_TEAM: "pdt_test_team",
        DODO_PRODUCT_ID_BUSINESS: "pdt_test_business",
      }),
      store: new MemoryStore(),
      logger: false,
    });
  });
  afterAll(async () => {
    await app.close();
  });

  const fromInstagram = { origin: "https://l.instagram.com", referer: "https://l.instagram.com/" };

  it("GET pages arriving from Instagram or Facebook are not refused", async () => {
    for (const referer of ["https://l.instagram.com/", "https://www.facebook.com/"]) {
      const res = await app.inject({
        method: "GET",
        url: "/console",
        headers: { referer, "sec-fetch-site": "cross-site" },
      });
      expect(res.statusCode).toBe(200);
    }
  });

  it("a GET with a foreign Origin is answered, but without permission for that site to read it", async () => {
    const res = await app.inject({ method: "GET", url: "/console", headers: fromInstagram });
    expect(res.statusCode).not.toBe(403);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("a POST with a foreign Origin is rejected", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: "https://evil.example" },
      payload: { email: "a@example.com", password: "x" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("on the live server a forged Host header never makes a foreign Origin acceptable", () => {
    const req = (origin: string, host: string) =>
      ({ headers: { origin, host }, protocol: "https" }) as unknown as FastifyRequest;
    expect(isAllowedOrigin(req("https://evil.example", "evil.example"), [OURS], OURS, true)).toBe(
      false,
    );
    expect(isAllowedOrigin(req(OURS, "evil.example"), [], OURS, true)).toBe(true);
    expect(isAllowedOrigin(req("https://evil.example", "evil.example"), [], OURS, false)).toBe(
      true,
    ); // local dev only
  });

  it("a POST from our own origin passes the check (wrong password -> 401, not 403)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: OURS },
      payload: { email: "a@example.com", password: "Wrong Password 123!" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("a POST with no Origin passes the check (API clients; requests are authorized by bearer token, not cookies)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "a@example.com", password: "Wrong Password 123!" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("the Dodo webhook rejects an unsigned request and accepts a correctly signed one", async () => {
    const body = JSON.stringify({
      business_id: "bus_test",
      type: "payment.succeeded",
      timestamp: new Date().toISOString(),
      data: { payload_type: "Payment", payment_id: "pay_test" },
    });
    const unsigned = await app.inject({
      method: "POST",
      url: "/api/v1/billing/webhook",
      headers: { "content-type": "application/json" },
      payload: body,
    });
    expect(unsigned.statusCode).toBe(400);
    const id = "msg_" + randomBytes(8).toString("hex");
    const ts = String(Math.floor(Date.now() / 1000));
    const signature =
      "v1," + createHmac("sha256", SECRET).update(`${id}.${ts}.${body}`).digest("base64");
    const signed = await app.inject({
      method: "POST",
      url: "/api/v1/billing/webhook",
      headers: {
        "content-type": "application/json",
        "webhook-id": id,
        "webhook-timestamp": ts,
        "webhook-signature": signature,
        origin: "https://dodopayments.com",
      },
      payload: body,
    });
    expect(signed.statusCode, signed.payload).toBe(200);
  });
});
