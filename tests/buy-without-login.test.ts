import { readFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import { MemoryStore } from "../src/persistence/memory-store.js";

// Buying from the website's price buttons before having an account: /buy/:plan opens Dodo checkout,
// Dodo returns the buyer to /console?subscription_id=..., and the console claims it for their
// workspace. Dodo's API is answered locally (no network).
const TEAM = "pdt_team_test";
const BUSINESS = "pdt_business_test";

const dodoCalls: { method: string; path: string; body: unknown }[] = [];
const subscriptions: Record<string, Record<string, unknown>> = {
  sub_paid_team: { subscription_id: "sub_paid_team", status: "active", product_id: TEAM, next_billing_date: "2026-11-16T00:00:00Z", metadata: { source: "website" }, customer: { customer_id: "cus_buyer", email: "buyer@example.com", name: "Buyer" } },
};
const realFetch = globalThis.fetch;
function fakeDodo(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  if (!url.hostname.endsWith("dodopayments.com")) return realFetch(input, init);
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : null;
  dodoCalls.push({ method, path: url.pathname, body });
  const json = (data: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }));
  if (url.pathname.endsWith("/checkouts")) return json({ session_id: "cks_test", checkout_url: "https://checkout.example.test/session" });
  const id = /\/subscriptions\/([^/]+)$/.exec(url.pathname)?.[1];
  if (id && subscriptions[id]) {
    if (method === "PATCH") subscriptions[id] = { ...subscriptions[id], ...(body as Record<string, unknown>) };
    return json(subscriptions[id]);
  }
  return json({ code: "NOT_FOUND", message: "not found" }, 404);
}

describe("buying on the website before having an account", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    vi.stubGlobal("fetch", fakeDodo);
    const config = loadConfig({
      NODE_ENV: "test",
      JWT_SECRET: "test-secret-with-at-least-thirty-two-characters",
      LOG_LEVEL: "silent",
      PERSISTENCE_DRIVER: "memory",
      DODO_PAYMENTS_API_KEY: "test_key_not_used_for_network",
      DODO_PRODUCT_ID_TEAM: TEAM,
      DODO_PRODUCT_ID_BUSINESS: BUSINESS,
    });
    app = await buildApp({ config, store: new MemoryStore(), logger: false });
  });

  afterAll(async () => {
    await app.close();
    vi.unstubAllGlobals();
  });

  async function workspace(email: string) {
    const response = await app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { email, name: "Buyer", organizationName: "Buyer Co", password: "Correct Horse Battery 123!" } });
    return (JSON.parse(response.payload) as { data: { accessToken: string } }).data.accessToken;
  }
  const claim = (token: string, subscriptionId: string) =>
    app.inject({ method: "POST", url: "/api/v1/console/billing/claim", headers: { authorization: `Bearer ${token}` }, payload: { subscriptionId } });
  const currentPlan = async (token: string) =>
    (JSON.parse((await app.inject({ method: "GET", url: "/api/v1/console/billing", headers: { authorization: `Bearer ${token}` } })).payload) as { data: { plan: { id: string } } }).data.plan.id;

  it("opens Dodo checkout from a price button, with no account, returning to the console", async () => {
    const response = await app.inject({ method: "GET", url: "/buy/team" });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("https://checkout.example.test/session");
    const created = dodoCalls.find((c) => c.path.endsWith("/checkouts"))!.body as { product_cart: { product_id: string }[]; customer?: unknown; return_url: string };
    expect(created.product_cart[0]!.product_id).toBe(TEAM);
    expect(created.customer).toBeUndefined();
    expect(created.return_url).toMatch(/\/console$/);
    expect((await app.inject({ method: "GET", url: "/buy/gold" })).headers.location).toBe("/console");
  });

  it("claims the purchase for the buyer's new workspace, and tags it for later renewals", async () => {
    const token = await workspace("buyer.account@example.com");
    expect(await currentPlan(token)).toBe("free");
    const response = await claim(token, "sub_paid_team");
    expect(response.statusCode).toBe(200);
    expect(await currentPlan(token)).toBe("team");
    const update = dodoCalls.find((c) => c.method === "PATCH" && c.path.endsWith("/subscriptions/sub_paid_team"));
    expect((update!.body as { metadata: { organizationId: string } }).metadata.organizationId).toBeTruthy();
  });

  it("refuses to move a claimed purchase to another workspace, or an unknown one", async () => {
    const other = await workspace("someone.else@example.com");
    expect((await claim(other, "sub_paid_team")).statusCode).toBe(409);
    expect(await currentPlan(other)).toBe("free");
    expect((await claim(other, "sub_nope")).statusCode).toBe(404);
  });

  it("the console page keeps Dodo's return id and claims it after sign-in", async () => {
    const js = await readFile(path.join(__dirname, "..", "public", "console.js"), "utf8");
    expect(js).toContain('get("subscription_id")');
    expect(js).toContain("/console/billing/claim");
    expect(js).toMatch(/render\(\);\s*claimWebsitePurchase\(\);/);
  });
});
