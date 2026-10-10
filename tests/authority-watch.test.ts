import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import { MemoryStore } from "../src/persistence/memory-store.js";
import {
  checkWorkspace,
  computeAuthorityWatch,
  runAll,
  summarise,
} from "../src/governance/authority-watch.js";
import type { AtlasCertificate, LedgerAction } from "../src/governance/gateway.js";
import { TRUNK_FEATURES } from "../src/governance/trunk.js";

// RootSystems Trunk: continuous authority checks in the console.
const NOW = new Date("2026-10-10T12:00:00Z");
const cert = (over: Partial<AtlasCertificate>): AtlasCertificate => ({
  jti: "00000000-0000-4000-8000-000000000001",
  agentId: "billing-bot",
  agentName: "Billing Bot",
  permissions: ["invoices:read"],
  limits: null,
  organization: "Fictional Ltd",
  issuedAt: "2026-09-01T00:00:00Z",
  expiresAt: "2026-12-01T00:00:00Z",
  revokedAt: null,
  status: "active",
  registryBinding: "x",
  ...over,
});
const action = (over: Partial<LedgerAction>): LedgerAction => ({
  id: 1,
  certificateJti: "00000000-0000-4000-8000-000000000001",
  agentId: "billing-bot",
  action: "invoices:read",
  verdict: "within_authority",
  reasons: [],
  occurredAt: "2026-10-09T10:00:00Z",
  ...over,
});
const keys = (r: { items: { key: string }[] }) => r.items.map((i) => i.key);

describe("authority watch rules", () => {
  it("a healthy agent has nothing to report", () => {
    expect(
      computeAuthorityWatch(
        { certificates: [cert({})], actions: [action({})], chainValid: true },
        NOW,
      ).items,
    ).toEqual([]);
  });

  it("flags a certificate expiring within 14 days, but not when a newer one outlives it", () => {
    const soon = cert({ expiresAt: "2026-10-20T00:00:00Z" });
    expect(
      keys(computeAuthorityWatch({ certificates: [soon], actions: [], chainValid: null }, NOW)),
    ).toEqual([`cert:${soon.jti}:expiring`]);
    const renewed = cert({
      jti: "00000000-0000-4000-8000-000000000002",
      expiresAt: "2027-01-01T00:00:00Z",
    });
    expect(
      computeAuthorityWatch({ certificates: [soon, renewed], actions: [], chainValid: null }, NOW)
        .items,
    ).toEqual([]);
  });

  it("flags an agent still acting with no valid certificate", () => {
    const revoked = cert({ status: "revoked", revokedAt: "2026-10-01T00:00:00Z" });
    const r = computeAuthorityWatch(
      {
        certificates: [revoked],
        actions: [
          action({ occurredAt: "2026-09-20T00:00:00Z" }),
          action({ id: 2, occurredAt: "2026-10-05T00:00:00Z" }),
        ],
        chainValid: null,
      },
      NOW,
    );
    expect(keys(r)).toContain("agent:billing-bot:uncovered");
    expect(keys(r)).toContain("action:2:after_revocation");
    expect(keys(r)).not.toContain("action:1:after_revocation");
    expect(r.items[0]!.severity).toBe("critical");
  });

  it("flags an agent over its daily action limit and outside-authority actions from the last 7 days", () => {
    const limited = cert({ limits: { maxActionsPerDay: 2 } });
    const acts = [1, 2, 3].map((id) => action({ id, occurredAt: `2026-10-09T0${id}:00:00Z` }));
    acts.push(
      action({
        id: 9,
        verdict: "outside_authority",
        reasons: ["permission email:send not granted"],
        occurredAt: "2026-10-08T00:00:00Z",
      }),
    );
    acts.push(action({ id: 10, verdict: "outside_authority", occurredAt: "2026-09-01T00:00:00Z" }));
    const r = computeAuthorityWatch(
      { certificates: [limited], actions: acts, chainValid: true },
      NOW,
    );
    expect(keys(r)).toContain(`cert:${limited.jti}:over_daily_limit:2026-10-09`);
    expect(keys(r)).toContain("action:9:outside_authority");
    expect(keys(r)).not.toContain("action:10:outside_authority");
    expect(r.items.find((i) => i.key === "action:9:outside_authority")!.why).toContain(
      "email:send not granted",
    );
  });

  it("a ledger chain that does not verify is critical and first", () => {
    const r = computeAuthorityWatch(
      {
        certificates: [cert({ expiresAt: "2026-10-15T00:00:00Z" })],
        actions: [],
        chainValid: false,
      },
      NOW,
    );
    expect(r.items[0]).toMatchObject({ key: "ledger:chain:broken", severity: "critical" });
  });

  it("the email summary is counts by kind, with no agent names", () => {
    const r = computeAuthorityWatch(
      {
        certificates: [cert({ status: "revoked", revokedAt: "2026-10-01T00:00:00Z" })],
        actions: [action({ occurredAt: "2026-10-05T00:00:00Z" })],
        chainValid: false,
      },
      NOW,
    );
    const lines = summarise(r.items);
    expect(lines.join(" ")).not.toMatch(/Billing|billing-bot/);
    expect(lines.length).toBe(3);
  });

  it("the Trunk panel lists continuous checks as live, and nothing in the console is 'coming'", () => {
    expect(TRUNK_FEATURES.find((f) => f.id === "continuous")?.status).toBe("live");
    expect(TRUNK_FEATURES.some((f) => f.status === "coming")).toBe(false);
  });
});

describe("authority watch in the console", () => {
  let app: FastifyInstance;
  const store = new MemoryStore();
  let token: string;
  let organizationId: string;
  let certificates: AtlasCertificate[] = [cert({ expiresAt: "2099-01-01T00:00:00Z" })];
  let actions: LedgerAction[] = [];
  const saved = process.env.TRUNK_ORGANIZATION_IDS;

  beforeAll(async () => {
    app = await buildApp({
      config: loadConfig({
        NODE_ENV: "test",
        JWT_SECRET: "test-secret-with-at-least-thirty-two-characters",
        LOG_LEVEL: "silent",
        PERSISTENCE_DRIVER: "memory",
      }),
      store,
      logger: false,
    });
    const gateway = app.governance as unknown as Record<string, unknown>;
    gateway.listCertificates = async () => certificates;
    gateway.ledger = async () => ({ count: actions.length, actions });
    gateway.verifyLedger = async () => ({ valid: true });
    const reg = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        email: "watch@example.com",
        name: "Owner",
        organizationName: "Watch Org",
        password: "Correct Horse Battery 123!",
      },
    });
    const body = JSON.parse(reg.payload) as {
      data: { accessToken: string; organization: { id: string } };
    };
    token = body.data.accessToken;
    organizationId = body.data.organization.id;
  });
  afterAll(async () => {
    process.env.TRUNK_ORGANIZATION_IDS = saved;
    await app.close();
  });
  const call = (method: "GET" | "POST", url: string) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      payload: method === "POST" ? {} : undefined,
    });

  it("without Trunk the checks are refused", async () => {
    process.env.TRUNK_ORGANIZATION_IDS = "";
    expect((await call("GET", "/api/v1/console/trunk/watch")).statusCode).toBe(402);
    expect((await call("POST", "/api/v1/console/trunk/watch")).statusCode).toBe(402);
  });

  it("with Trunk: all clear, then a revoked certificate still in use shows up as new, then nothing new", async () => {
    process.env.TRUNK_ORGANIZATION_IDS = organizationId;
    const clear = JSON.parse((await call("GET", "/api/v1/console/trunk/watch")).payload) as {
      data: { items: unknown[]; checkedAt: string | null };
    };
    expect(clear.data.items).toEqual([]);
    expect(clear.data.checkedAt).toBeNull();

    certificates = [
      cert({ status: "revoked", revokedAt: new Date(Date.now() - 3 * 86_400_000).toISOString() }),
    ];
    actions = [action({ id: 7, occurredAt: new Date(Date.now() - 86_400_000).toISOString() })];
    const first = JSON.parse((await call("POST", "/api/v1/console/trunk/watch")).payload) as {
      data: { newKeys: string[]; alerted: boolean };
    };
    expect(first.data.newKeys.sort()).toEqual([
      "action:7:after_revocation",
      "agent:billing-bot:uncovered",
    ]);
    expect(first.data.alerted).toBe(false); // no mail provider in tests
    const second = JSON.parse((await call("POST", "/api/v1/console/trunk/watch")).payload) as {
      data: { newKeys: string[] };
    };
    expect(second.data.newKeys).toEqual([]);

    const state = await store.getTrunkWatchState(organizationId);
    expect(state?.keys.sort()).toEqual([
      "action:7:after_revocation",
      "agent:billing-bot:uncovered",
    ]);
    expect(JSON.stringify(state)).not.toMatch(/Billing Bot|invoices/);
    const view = JSON.parse((await call("GET", "/api/v1/console/trunk/watch")).payload) as {
      data: { items: { isNew: boolean }[]; checkedAt: string };
    };
    expect(view.data.checkedAt).toBeTruthy();
    expect(view.data.items.every((i) => i.isNew === false)).toBe(true);
  });

  it("a new item emails the owners with counts only; the daily run checks linked Trunk workspaces only", async () => {
    process.env.TRUNK_ORGANIZATION_IDS = organizationId;
    actions = [
      ...actions,
      action({
        id: 8,
        verdict: "outside_authority",
        reasons: ["over maxAmountUsd"],
        occurredAt: new Date().toISOString(),
      }),
    ];
    const sent: { to: string[]; lines: string[]; url: string }[] = [];
    const mailer = async (to: string[], _ws: string, lines: string[], url: string) => (
      sent.push({ to, lines, url }),
      { sent: true }
    );
    const organization = (await store.getOrganization(organizationId))!;
    const run = await checkWorkspace(organization, {
      store,
      gateway: app.governance,
      mailer,
      appUrl: "https://console.example",
    });
    expect(run.newItems.map((i) => i.key)).toEqual([
      "action:8:after_revocation",
      "action:8:outside_authority",
    ]);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toEqual(["watch@example.com"]);
    expect(sent[0]!.url).toBe("https://console.example/console#settings");
    expect(sent[0]!.lines.join(" ")).not.toMatch(/Billing|maxAmount/);
    expect((await store.getTrunkWatchState(organizationId))?.alertedAt).toBeTruthy();

    // Not linked to Atlas/Trust Proof yet: the daily run skips it rather than failing.
    expect(
      (
        await runAll(
          { store, gateway: app.governance, mailer },
          { TRUNK_ORGANIZATION_IDS: organizationId },
        )
      ).checked,
    ).toBe(0);
    await store.saveServiceLink({
      organizationId,
      atlasEmail: "a@x",
      atlasSecret: "s",
      trustProofEmail: "t@x",
      trustProofSecret: "s",
      trustProofApiKey: "k",
    });
    expect(
      (
        await runAll(
          { store, gateway: app.governance, mailer },
          { TRUNK_ORGANIZATION_IDS: organizationId },
        )
      ).checked,
    ).toBe(1);
    expect(
      (await runAll({ store, gateway: app.governance, mailer }, { TRUNK_ORGANIZATION_IDS: "" }))
        .checked,
    ).toBe(0);
  });
});
