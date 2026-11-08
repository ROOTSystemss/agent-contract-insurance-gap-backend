import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GovernanceGateway } from "../src/governance/gateway.js";
import { SecretBox } from "../src/governance/secret-box.js";
import { MemoryStore } from "../src/persistence/memory-store.js";
import type { Organization } from "../src/domain/types.js";

// Live QA 2026-11-02 D1: activating a workspace failed with 429 RATE_LIMITED and no visible error. The
// linked free-plan services answer 429/503 (or Render's wake-up page) while they wake up. The gateway now
// waits and retries within a budget (~60 s); a service that stays busy still ends in a clear error.

const ATLAS = "https://atlas.test";
const TP = "https://tp.test";
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const wakePage = () => new Response("<html><body>Service waking up. Render</body></html>", { status: 503, headers: { "content-type": "text/html" } });

function gateway(script: (url: string, method: string) => Response | Promise<Response>, budget = 60_000) {
  const sleeps: number[] = [];
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push((init?.method ?? "GET") + " " + url);
    return script(url, init?.method ?? "GET");
  }) as typeof fetch;
  const gw = new GovernanceGateway(new MemoryStore(), new SecretBox(randomBytes(32)), {
    atlasUrl: ATLAS, trustProofUrl: TP, fetchImpl, serviceToken: "s".repeat(40), retryBudgetMs: budget,
    sleep: async (ms) => { sleeps.push(ms); },
  });
  return { gw, sleeps, calls };
}
const org = { id: "11111111-2222-3333-4444-555555555555", name: "Lemon QA" } as unknown as Organization;

describe("gateway wake-up retry (D1)", () => {
  it("links a workspace when Atlas shows Render's wake-up page and Trust Proof answers 429 first", async () => {
    let atlasTries = 0, tpTries = 0;
    const { gw, sleeps } = gateway((url) => {
      if (url === ATLAS + "/register") return ++atlasTries <= 2 ? wakePage() : json(201, { ok: true });
      if (url === TP + "/auth/signup") return ++tpTries <= 2 ? json(429, { error: "rate_limited" }, { "retry-after": "3" }) : json(201, { ok: true }, { "set-cookie": "sid=abc; Path=/" });
      if (url === TP + "/api-keys") return json(201, { key: "tp_live_key" });
      return json(404, {});
    });
    const link = await gw.ensureLink(org);
    expect(link.organizationId).toBe(org.id);
    expect(atlasTries).toBe(3);
    expect(tpTries).toBe(3);
    expect(sleeps).toContain(3_000); // Retry-After honoured
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(60_000);
  });

  it("a service that stays busy past the budget ends in a clear RATE_LIMITED error naming it", async () => {
    const { gw, sleeps } = gateway((url) => (url === ATLAS + "/register" ? json(201, {}) : json(429, { error: "rate_limited" })), 20_000);
    await expect(gw.ensureLink(org)).rejects.toMatchObject({ statusCode: 429, code: "RATE_LIMITED", message: expect.stringContaining("Trust Proof is busy") });
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(20_000);
  });

  it("an unreachable service is retried, then UPSTREAM_UNAVAILABLE", async () => {
    const { gw, calls } = gateway(() => { throw new TypeError("fetch failed"); }, 10_000);
    await expect(gw.ensureLink(org)).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
    expect(calls.length).toBeGreaterThan(1);
  });

  it("a real validation error is not retried", async () => {
    const { gw, calls } = gateway((url) => (url === ATLAS + "/register" ? json(400, { error: "bad email" }) : json(201, {})));
    await expect(gw.ensureLink(org)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(calls.filter((c) => c.endsWith("/register")).length).toBe(1);
  });
});
