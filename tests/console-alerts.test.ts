import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import { MemoryStore } from "../src/persistence/memory-store.js";

// Console alerts are a thin pass-through to Trust Proof's webhook API. A fake Atlas and Trust
// Proof stand in for the real services so the whole route -> gateway -> upstream path runs.

interface FakeHook {
  id: number;
  url: string;
  events: string[];
  createdAt: string;
}

function fakeServices() {
  const hooks: FakeHook[] = [];
  const seenKeys: string[] = [];
  let nextId = 1;
  const json = (status: number, body?: unknown, headers: Record<string, string> = {}) =>
    new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

  const fetchImpl = (async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const method = init?.method ?? "GET";
    const auth = new Headers(init?.headers).get("authorization");
    if (url.host === "atlas.test" && url.pathname === "/register") return json(201, { ok: true });
    if (url.host !== "tp.test") return json(404, { error: "unexpected" });
    if (url.pathname === "/auth/signup") return json(201, { ok: true }, { "set-cookie": "sid=abc; Path=/; HttpOnly" });
    if (url.pathname === "/api-keys") return json(201, { key: "rs_test_key" });
    if (auth) seenKeys.push(auth);
    const match = url.pathname.match(/^\/api\/v1\/webhooks(?:\/(\d+))?(\/test)?$/);
    if (!match) return json(404, { error: "not_found" });
    const id = match[1] ? Number(match[1]) : null;
    if (id === null && method === "GET") return json(200, { webhooks: hooks });
    if (id === null && method === "POST") {
      const body = JSON.parse(init?.body as string) as { url: string };
      if (!body.url.startsWith("https://")) {
        return json(400, { error: "invalid_webhook_url", message: "The webhook address must use https." });
      }
      if (hooks.length >= 5) return json(409, { error: "webhook_limit_reached", message: "At most 5 webhooks. Delete one first." });
      const hook = { id: nextId++, url: body.url, events: ["agent_action.outside_authority"], createdAt: new Date().toISOString() };
      hooks.push(hook);
      return json(201, { webhook: hook, secret: "whsec_once", note: "Store this secret now." });
    }
    const index = hooks.findIndex((hook) => hook.id === id);
    if (index < 0) return json(404, { error: "not_found", message: "No such webhook in your organization." });
    if (match[2] && method === "POST") return json(200, { delivered: true, status: 200, error: null });
    if (method === "DELETE") {
      hooks.splice(index, 1);
      return new Response(null, { status: 204 });
    }
    return json(405, { error: "method" });
  }) as typeof fetch;

  return { fetchImpl, hooks, seenKeys };
}

describe("console alerts (Trust Proof webhooks)", () => {
  let app: FastifyInstance;
  const store = new MemoryStore();
  const services = fakeServices();
  let ownerToken: string;
  let viewerToken: string;

  beforeAll(async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      JWT_SECRET: "test-secret-with-at-least-thirty-two-characters",
      LOG_LEVEL: "silent",
      PERSISTENCE_DRIVER: "memory",
    });
    app = await buildApp({
      config,
      store,
      logger: false,
      governance: { atlasUrl: "https://atlas.test", trustProofUrl: "https://tp.test", fetchImpl: services.fetchImpl },
    });
    const register = async (email: string) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/auth/register",
        payload: { email, name: "Alerts Test", organizationName: "Alerts Org", password: "Correct Horse Battery 123!" },
      });
      return JSON.parse(response.payload) as { data: { accessToken: string; user: { id: string }; organization: { id: string } } };
    };
    ownerToken = (await register("alerts-owner@example.com")).data.accessToken;
    const viewer = await register("alerts-viewer@example.com");
    store.setRoleForTesting(viewer.data.user.id, viewer.data.organization.id, "viewer");
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "alerts-viewer@example.com", password: "Correct Horse Battery 123!" },
    });
    viewerToken = (JSON.parse(login.payload) as { data: { accessToken: string } }).data.accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  const call = (method: "GET" | "POST" | "DELETE", url: string, token: string, payload?: object) =>
    app.inject({ method, url: `/api/v1/console${url}`, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });

  it("adds an alert, returns the secret once, and lists it without the secret", async () => {
    const created = await call("POST", "/alerts", ownerToken, { url: "https://hooks.example.com/rs" });
    expect(created.statusCode).toBe(201);
    expect(created.headers["cache-control"]).toBe("no-store");
    const body = JSON.parse(created.payload) as { data: { webhook: FakeHook; secret: string } };
    expect(body.data.secret).toBe("whsec_once");
    expect(services.seenKeys.every((key) => key === "Bearer rs_test_key")).toBe(true);

    const listed = await call("GET", "/alerts", ownerToken);
    expect(listed.statusCode).toBe(200);
    expect(listed.payload).not.toContain("whsec_once");
    expect((JSON.parse(listed.payload) as { data: FakeHook[] }).data.map((hook) => hook.url)).toEqual(["https://hooks.example.com/rs"]);
  });

  it("passes Trust Proof's readable message through when an address is refused", async () => {
    const refused = await call("POST", "/alerts", ownerToken, { url: "http://insecure.example.com/x" });
    expect(refused.statusCode).toBe(400);
    expect(refused.payload).toContain("The webhook address must use https.");
  });

  it("sends a test delivery and deletes an alert", async () => {
    const id = services.hooks[0]!.id;
    const tested = await call("POST", `/alerts/${id}/test`, ownerToken);
    expect(tested.statusCode).toBe(200);
    expect((JSON.parse(tested.payload) as { data: { delivered: boolean } }).data.delivered).toBe(true);

    const deleted = await call("DELETE", `/alerts/${id}`, ownerToken);
    expect(deleted.statusCode).toBe(200);
    expect(services.hooks).toHaveLength(0);

    const missing = await call("DELETE", `/alerts/${id}`, ownerToken);
    expect(missing.statusCode).toBe(404);
  });

  it("lets a viewer see alerts but not add, test or delete them", async () => {
    expect((await call("GET", "/alerts", viewerToken)).statusCode).toBe(200);
    expect((await call("POST", "/alerts", viewerToken, { url: "https://hooks.example.com/v" })).statusCode).toBe(403);
    expect((await call("POST", "/alerts/1/test", viewerToken)).statusCode).toBe(403);
    expect((await call("DELETE", "/alerts/1", viewerToken)).statusCode).toBe(403);
  });

  it("rejects a non-numeric alert id before calling Trust Proof", async () => {
    expect((await call("DELETE", "/alerts/abc", ownerToken)).statusCode).toBe(400);
  });
});
