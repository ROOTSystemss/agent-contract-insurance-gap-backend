import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import { hashToken } from "../src/security/account-security.js";
import { isPrivateAddress, trustProxyHops } from "../src/security/client-ip.js";
import { createResendMailer, isReservedEmailDomain, OutboxMailer } from "../src/security/mailer.js";
import { MemoryStore } from "../src/persistence/memory-store.js";
import { agentInput } from "./helpers.js";

// QA 2026-11-14 H2 (rate limits keyed on a client-chosen address, no per-email cap) and H3 (no email
// verification, no password reset). Verification is switched on here (EMAIL_VERIFICATION=1), as in production.

const PASSWORD = "Correct Horse Battery 123!";
const DIAG = "d".repeat(40);
const RENDER_SOCKET = "10.0.0.5"; // the connection from Render's proxy, as measured live

interface Ctx { app: FastifyInstance; dir: string; outbox: OutboxMailer; store: MemoryStore }

async function makeApp(overrides: Record<string, string> = {}): Promise<Ctx> {
  const dir = await mkdtemp(path.join(tmpdir(), "gap-account-"));
  const outbox = new OutboxMailer();
  const store = new MemoryStore();
  const app = await buildApp({
    config: loadConfig({ NODE_ENV: "test", JWT_SECRET: "test-secret-with-at-least-thirty-two-characters", UPLOAD_DIRECTORY: dir, LOG_LEVEL: "silent", EMAIL_VERIFICATION: "1", TRUST_PROXY_HOPS: "3", IP_DIAGNOSTICS_TOKEN: DIAG, PUBLIC_BASE_URL: "https://agent-contract-gap.example", ...overrides }),
    store, logger: false, certificateVerifier: null, pqSigner: null, mailer: outbox,
  });
  await app.ready();
  return { app, dir, outbox, store };
}

// A request as it reaches the app on Render: client -> Cloudflare edge -> Render proxy -> app.
const viaRender = (client: string, forged?: string) => ({
  remoteAddress: RENDER_SOCKET,
  headers: { "x-forwarded-for": [forged, client, "104.16.1.1", "10.1.2.3"].filter(Boolean).join(", ") },
});

function linkToken(outbox: OutboxMailer, to: string, kind: "verify" | "reset"): string {
  const message = outbox.last(to);
  const match = message?.text.match(new RegExp(`/account#${kind}=([A-Za-z0-9_-]{43})`));
  if (!match) throw new Error(`no ${kind} link was emailed to ${to}`);
  return match[1]!;
}

const body = <T>(r: { body: string }) => JSON.parse(r.body) as T;
const data = <T>(r: { body: string }) => body<{ data: T }>(r).data;

async function register(ctx: Ctx, email: string, client = "198.51.100.10") {
  const r = await ctx.app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { email, name: "Account Tester", organizationName: "Fictional Account Ltd", password: PASSWORD }, ...viaRender(client) });
  expect(r.statusCode).toBe(201);
  return data<{ accessToken: string; emailVerified: boolean; verificationRequired: boolean; verificationEmailSent: boolean }>(r);
}
function login(ctx: Ctx, email: string, password: string, client = "198.51.100.10", extra: { cookie?: string; forged?: string } = {}) {
  const request = viaRender(client, extra.forged);
  return ctx.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password }, remoteAddress: request.remoteAddress, headers: { ...request.headers, ...(extra.cookie ? { cookie: extra.cookie } : {}) } });
}
const authed = (ctx: Ctx, method: "GET" | "POST", url: string, token: string, payload?: object) =>
  ctx.app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload, ...{ remoteAddress: RENDER_SOCKET } });

describe("client address behind Render (TRUST_PROXY_HOPS=3)", () => {
  let ctx: Ctx;
  beforeAll(async () => { ctx = await makeApp(); });
  afterAll(async () => { await ctx.app.close(); await rm(ctx.dir, { recursive: true, force: true }); });
  const derived = async (init: { remoteAddress: string; headers: Record<string, string> }) =>
    body<{ derivedIp: string }>(await ctx.app.inject({ method: "GET", url: "/health/ip", remoteAddress: init.remoteAddress, headers: { ...init.headers, "x-diagnostics-token": DIAG } })).derivedIp;

  it("is the real client, whatever the client prepends to X-Forwarded-For", async () => {
    expect(await derived(viaRender("203.0.113.9"))).toBe("203.0.113.9");
    expect(await derived(viaRender("203.0.113.9", "1.2.3.4"))).toBe("203.0.113.9");
    expect(await derived(viaRender("203.0.113.9", "1.2.3.4, 5.6.7.8"))).toBe("203.0.113.9");
  });

  it("is the connection itself when the connection is not from a private (proxy) address", async () => {
    expect(await derived({ remoteAddress: "203.0.113.50", headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8, 9.9.9.9" } })).toBe("203.0.113.50");
  });

  it("the diagnostic is hidden without its token", async () => {
    expect((await ctx.app.inject({ method: "GET", url: "/health/ip" })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: "GET", url: "/health/ip", headers: { "x-diagnostics-token": "x".repeat(40) } })).statusCode).toBe(404);
  });

  it("trust rules", () => {
    const trust = trustProxyHops(3);
    expect(trust("10.0.0.5", 0)).toBe(true);
    expect(trust("203.0.113.50", 0)).toBe(false);
    expect(trust("104.16.1.1", 2)).toBe(true);
    expect(trust("203.0.113.9", 3)).toBe(false);
    for (const ip of ["10.1.2.3", "172.20.0.1", "192.168.1.1", "127.0.0.1", "::1", "::ffff:10.0.0.1", "fd00::1", "100.64.0.1"]) expect(isPrivateAddress(ip)).toBe(true);
    for (const ip of ["203.0.113.9", "104.16.1.1", "8.8.8.8", "2001:db8::1", "not-an-ip"]) expect(isPrivateAddress(ip)).toBe(false);
  });

  it("production refuses TRUST_PROXY=true without a hop count", () => {
    const production = { NODE_ENV: "production", PERSISTENCE_DRIVER: "postgres", DATABASE_URL: "postgresql://u:p@db:5432/acg", JWT_SECRET: "a".repeat(40), DOCUMENT_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"), ATLAS_OAUTH_CLIENT_SECRET: "b".repeat(40), ATLAS_OAUTH_REDIRECT_URIS: "https://readiness.example/cb" };
    expect(() => loadConfig({ ...production, TRUST_PROXY: "true" })).toThrow(/TRUST_PROXY_HOPS/);
    expect(() => loadConfig({ ...production, TRUST_PROXY: "true", TRUST_PROXY_HOPS: "3" })).not.toThrow();
    expect(() => loadConfig({ ...production, TRUST_PROXY_HOPS: "3" })).not.toThrow();
  });
});

describe("sign-in limits (the Vendor Risk / HIPAA rules)", () => {
  let ctx: Ctx;
  beforeAll(async () => { ctx = await makeApp(); });
  afterAll(async () => { await ctx.app.close(); await rm(ctx.dir, { recursive: true, force: true }); });

  it("8 wrong passwords from one address, then that address waits even with the right password", async () => {
    await register(ctx, "limit-one@example.test", "198.51.100.20");
    for (let i = 0; i < 8; i++) expect((await login(ctx, "limit-one@example.test", "wrong password", "198.51.100.21")).statusCode).toBe(401);
    const blocked = await login(ctx, "limit-one@example.test", PASSWORD, "198.51.100.21");
    expect(blocked.statusCode).toBe(429);
    expect(body<{ error: { code: string } }>(blocked).error.code).toBe("TOO_MANY_ATTEMPTS");
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(800);
    // Another address is not held back by these failures.
    expect((await login(ctx, "limit-one@example.test", PASSWORD, "198.51.100.22")).statusCode).toBe(200);
  });

  it("a forged X-Forwarded-For that changes on every try does not reset the count", async () => {
    await register(ctx, "limit-forged@example.test", "198.51.100.30");
    for (let i = 0; i < 8; i++) expect((await login(ctx, "limit-forged@example.test", "wrong", "198.51.100.31", { forged: `9.9.9.${i}` })).statusCode).toBe(401);
    expect((await login(ctx, "limit-forged@example.test", "wrong", "198.51.100.31", { forged: "9.9.9.200" })).statusCode).toBe(429);
  });

  it("10 wrong passwords sent at the same moment: exactly 8 are checked (counted before the password check)", async () => {
    await register(ctx, "limit-parallel@example.test", "198.51.100.40");
    const results = await Promise.all(Array.from({ length: 10 }, () => login(ctx, "limit-parallel@example.test", "wrong", "198.51.100.41")));
    expect(results.filter((r) => r.statusCode === 401)).toHaveLength(8);
    expect(results.filter((r) => r.statusCode === 429).map((r) => body<{ error: { code: string } }>(r).error.code)).toEqual(["TOO_MANY_ATTEMPTS", "TOO_MANY_ATTEMPTS"]);
  });

  it("20 at the same moment: no more than 8 are checked", async () => {
    // @fastify/rate-limit's in-memory store shares one counter object between same-tick requests, so a burst
    // over the route's 10/minute is refused whole; either way no more than 8 passwords are tried.
    await register(ctx, "limit-burst@example.test", "198.51.100.42");
    const results = await Promise.all(Array.from({ length: 20 }, () => login(ctx, "limit-burst@example.test", "wrong", "198.51.100.43")));
    expect(results.filter((r) => r.statusCode === 401).length).toBeLessThanOrEqual(8);
    expect(results.every((r) => r.statusCode === 401 || r.statusCode === 429)).toBe(true);
  });

  it("30 failures for one account from 30 addresses stop new devices, but not the owner's own browser", { timeout: 60_000 }, async () => {
    await register(ctx, "limit-spray@example.test", "198.51.100.50");
    const owner = await login(ctx, "limit-spray@example.test", PASSWORD, "198.51.100.51");
    expect(owner.statusCode).toBe(200);
    const cookie = String(owner.headers["set-cookie"]).split(";")[0]!;
    expect(cookie).toMatch(/^rootsystems\.acg\.dev=/);
    for (let i = 0; i < 30; i++) expect((await login(ctx, "limit-spray@example.test", "wrong", `192.0.2.${i + 1}`)).statusCode).toBe(401);
    expect((await login(ctx, "limit-spray@example.test", PASSWORD, "192.0.2.200")).statusCode).toBe(429);
    expect((await login(ctx, "limit-spray@example.test", PASSWORD, "192.0.2.201", { cookie })).statusCode).toBe(200);
    // A made-up cookie is not a known device.
    expect((await login(ctx, "limit-spray@example.test", PASSWORD, "192.0.2.202", { cookie: "rootsystems.acg.dev=AAAAAAAAAAAAAAAAAAAAAA" })).statusCode).toBe(429);
  });

  it("an unknown email is counted the same way and answers like a wrong password", async () => {
    const r = await login(ctx, "nobody-here@example.test", "whatever", "198.51.100.60");
    expect(r.statusCode).toBe(401);
    expect(body<{ error: { code: string } }>(r).error.code).toBe("UNAUTHORIZED");
  });
});

describe("email verification", () => {
  let ctx: Ctx;
  beforeAll(async () => { ctx = await makeApp(); });
  afterAll(async () => { await ctx.app.close(); await rm(ctx.dir, { recursive: true, force: true }); });

  it("registration emails a one-time link; until it is opened, signed and third-party features are refused", async () => {
    const reg = await register(ctx, "verify-me@example.test");
    expect(reg).toMatchObject({ emailVerified: false, verificationRequired: true, verificationEmailSent: true });
    const message = ctx.outbox.last("verify-me@example.test")!;
    expect(message.subject).toBe("Confirm your email for AI Agent Trust");
    expect(message.text).toMatch(/^Confirm your email for AI Agent Trust:\nhttps:\/\/agent-contract-gap\.example\/account#verify=[A-Za-z0-9_-]{43}\n/);
    const token = reg.accessToken;
    expect(data<{ emailVerified: boolean }>(await authed(ctx, "GET", "/api/v1/auth/me", token))).toMatchObject({ emailVerified: false });

    // Private work is allowed.
    const projectId = data<{ id: string }>(await authed(ctx, "POST", "/api/v1/projects", token, { name: "Private", description: "x", primaryCountryCode: "US", primarySubdivisionCode: "US-IL", affectedCountryCodes: [] })).id;
    const agentId = data<{ id: string }>(await authed(ctx, "POST", `/api/v1/projects/${projectId}/agents`, token, agentInput({}))).id;
    const analysisId = data<{ id: string }>(await authed(ctx, "POST", `/api/v1/projects/${projectId}/analyses`, token, { agentProfileId: agentId, documentIds: [] })).id;
    expect((await authed(ctx, "POST", `/api/v1/analyses/${analysisId}/run`, token, {})).statusCode).toBe(200);
    expect((await authed(ctx, "GET", "/api/v1/console/status", token)).statusCode).toBe(200);
    expect((await authed(ctx, "GET", "/api/v1/console/billing", token)).statusCode).toBe(200);

    // Signed or third-party-facing work is refused.
    for (const [method, url, payload] of [
      ["POST", `/api/v1/analyses/${analysisId}/assurance-pack`, {}],
      ["POST", "/api/v1/console/link", {}],
      ["GET", "/api/v1/console/overview", undefined],
      ["POST", "/api/v1/console/certificates", { agentId: "bot", agentName: "Bot", permissions: ["x:read"] }],
      ["POST", "/api/v1/console/team", { name: "Teammate", email: "mate@example.test", role: "viewer" }],
      ["POST", "/api/v1/oauth/authorize", { clientId: "ai-compliance-readiness", redirectUri: "http://localhost:4605/auth/atlas/callback", state: "s" }],
    ] as const) {
      const r = await authed(ctx, method, url, token, payload);
      expect([url, r.statusCode, body<{ error: { code: string } }>(r).error.code]).toEqual([url, 403, "EMAIL_NOT_VERIFIED"]);
    }

    // Opening the link verifies the address, once.
    const raw = linkToken(ctx.outbox, "verify-me@example.test", "verify");
    expect((await ctx.app.inject({ method: "POST", url: "/api/v1/auth/verify-email", payload: { token: raw } })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: "POST", url: "/api/v1/auth/verify-email", payload: { token: raw } })).statusCode).toBe(400);
    expect(data<{ emailVerified: boolean }>(await authed(ctx, "GET", "/api/v1/auth/me", token)).emailVerified).toBe(true);
    expect((await authed(ctx, "POST", `/api/v1/analyses/${analysisId}/assurance-pack`, token, {})).statusCode).toBe(200);
  });

  it("only the token's hash is stored, and a wrong, altered or expired token does nothing", async () => {
    await register(ctx, "verify-two@example.test");
    const raw = linkToken(ctx.outbox, "verify-two@example.test", "verify");
    const tokens = (ctx.store as unknown as { authTokens: Map<string, { userId: string; expiresAt: string }> }).authTokens;
    expect(tokens.has(raw)).toBe(false);
    expect(tokens.has(hashToken(raw))).toBe(true);
    const altered = (raw[0] === "A" ? "B" : "A") + raw.slice(1);
    for (const token of ["", "short", altered, raw + "x"]) expect((await ctx.app.inject({ method: "POST", url: "/api/v1/auth/verify-email", payload: { token } })).statusCode).toBe(400);
    tokens.get(hashToken(raw))!.expiresAt = new Date(Date.now() - 1000).toISOString();
    expect((await ctx.app.inject({ method: "POST", url: "/api/v1/auth/verify-email", payload: { token: raw } })).statusCode).toBe(400);
  });

  it("a new link replaces the old one; at most 3 emails an hour", async () => {
    const reg = await register(ctx, "verify-resend@example.test");
    const first = linkToken(ctx.outbox, "verify-resend@example.test", "verify");
    expect(data<{ sent: boolean }>(await authed(ctx, "POST", "/api/v1/auth/resend-verification", reg.accessToken)).sent).toBe(true);
    const second = linkToken(ctx.outbox, "verify-resend@example.test", "verify");
    expect(second).not.toBe(first);
    expect((await ctx.app.inject({ method: "POST", url: "/api/v1/auth/verify-email", payload: { token: first } })).statusCode).toBe(400);
    expect((await authed(ctx, "POST", "/api/v1/auth/resend-verification", reg.accessToken)).statusCode).toBe(200);
    const throttled = await authed(ctx, "POST", "/api/v1/auth/resend-verification", reg.accessToken);
    expect(throttled.statusCode).toBe(429);
    expect(body<{ error: { code: string } }>(throttled).error.code).toBe("TOO_MANY_EMAILS");
  });

  it("with verification off (the development default) nothing is refused", async () => {
    const off = await makeApp({ EMAIL_VERIFICATION: "0" });
    try {
      const reg = await register(off, "no-verify@example.test");
      expect(reg).toMatchObject({ emailVerified: false, verificationRequired: false, verificationEmailSent: false });
      expect(off.outbox.messages).toHaveLength(0);
      const projectId = data<{ id: string }>(await authed(off, "POST", "/api/v1/projects", reg.accessToken, { name: "Project P", description: "x", primaryCountryCode: "US", primarySubdivisionCode: "US-IL", affectedCountryCodes: [] })).id;
      const agentId = data<{ id: string }>(await authed(off, "POST", `/api/v1/projects/${projectId}/agents`, reg.accessToken, agentInput({}))).id;
      const analysisId = data<{ id: string }>(await authed(off, "POST", `/api/v1/projects/${projectId}/analyses`, reg.accessToken, { agentProfileId: agentId, documentIds: [] })).id;
      await authed(off, "POST", `/api/v1/analyses/${analysisId}/run`, reg.accessToken, {});
      expect((await authed(off, "POST", `/api/v1/analyses/${analysisId}/assurance-pack`, reg.accessToken, {})).statusCode).toBe(200);
    } finally {
      await off.app.close();
      await rm(off.dir, { recursive: true, force: true });
    }
  });
});

describe("password reset and change", () => {
  let ctx: Ctx;
  beforeAll(async () => { ctx = await makeApp(); });
  afterAll(async () => { await ctx.app.close(); await rm(ctx.dir, { recursive: true, force: true }); });

  it("answers the same for a known and an unknown address, and emails only the known one", async () => {
    await register(ctx, "reset-known@example.test");
    const before = ctx.outbox.messages.length;
    const unknown = await ctx.app.inject({ method: "POST", url: "/api/v1/auth/forgot-password", payload: { email: "reset-nobody@example.test" } });
    const known = await ctx.app.inject({ method: "POST", url: "/api/v1/auth/forgot-password", payload: { email: "Reset-Known@example.test" } });
    expect(unknown.statusCode).toBe(202);
    expect(known.statusCode).toBe(202);
    expect(data(unknown)).toEqual(data(known));
    expect(ctx.outbox.messages.length).toBe(before + 1);
    expect(ctx.outbox.last()!.to).toBe("reset-known@example.test");
    expect(ctx.outbox.last()!.subject).toBe("Reset your AI Agent Trust password");
  });

  it("the link sets a new password once, verifies the address and ends every older session", async () => {
    const reg = await register(ctx, "reset-flow@example.test");
    const oldSession = reg.accessToken;
    expect((await authed(ctx, "GET", "/api/v1/auth/me", oldSession)).statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 1100)); // tokens carry whole seconds
    await ctx.app.inject({ method: "POST", url: "/api/v1/auth/forgot-password", payload: { email: "reset-flow@example.test" } });
    const raw = linkToken(ctx.outbox, "reset-flow@example.test", "reset");
    expect((await ctx.app.inject({ method: "POST", url: "/api/v1/auth/reset-password", payload: { token: raw, password: "too short" } })).statusCode).toBe(400);
    const done = await ctx.app.inject({ method: "POST", url: "/api/v1/auth/reset-password", payload: { token: raw, password: "A brand new passphrase 456" } });
    expect(done.statusCode).toBe(200);
    expect((await ctx.app.inject({ method: "POST", url: "/api/v1/auth/reset-password", payload: { token: raw, password: "Another passphrase 789!" } })).statusCode).toBe(400);
    expect((await authed(ctx, "GET", "/api/v1/auth/me", oldSession)).statusCode).toBe(401);
    expect((await login(ctx, "reset-flow@example.test", PASSWORD)).statusCode).toBe(401);
    const fresh = await login(ctx, "reset-flow@example.test", "A brand new passphrase 456");
    expect(fresh.statusCode).toBe(200);
    expect(data<{ emailVerified: boolean }>(fresh).emailVerified).toBe(true);
  });

  it("a reset clears the sign-in lockout for that account", async () => {
    await register(ctx, "reset-lockout@example.test");
    for (let i = 0; i < 8; i++) await login(ctx, "reset-lockout@example.test", "wrong", "198.51.100.70");
    expect((await login(ctx, "reset-lockout@example.test", PASSWORD, "198.51.100.70")).statusCode).toBe(429);
    await ctx.app.inject({ method: "POST", url: "/api/v1/auth/forgot-password", payload: { email: "reset-lockout@example.test" } });
    await ctx.app.inject({ method: "POST", url: "/api/v1/auth/reset-password", payload: { token: linkToken(ctx.outbox, "reset-lockout@example.test", "reset"), password: "Fresh start passphrase 1" } });
    expect((await login(ctx, "reset-lockout@example.test", "Fresh start passphrase 1", "198.51.100.70")).statusCode).toBe(200);
  });

  it("change password: needs the current one, keeps the new session and ends the old ones", async () => {
    const reg = await register(ctx, "change-flow@example.test");
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const wrong = await authed(ctx, "POST", "/api/v1/auth/change-password", reg.accessToken, { currentPassword: "nope", newPassword: "Changed passphrase 2026" });
    expect(wrong.statusCode).toBe(403);
    const changed = await authed(ctx, "POST", "/api/v1/auth/change-password", reg.accessToken, { currentPassword: PASSWORD, newPassword: "Changed passphrase 2026" });
    expect(changed.statusCode).toBe(200);
    const next = data<{ accessToken: string }>(changed).accessToken;
    expect((await authed(ctx, "GET", "/api/v1/auth/me", next)).statusCode).toBe(200);
    expect((await authed(ctx, "GET", "/api/v1/auth/me", reg.accessToken)).statusCode).toBe(401);
    expect((await login(ctx, "change-flow@example.test", "Changed passphrase 2026")).statusCode).toBe(200);
  });
});

describe("mailer", () => {
  it("never hands reserved or test domains to the provider", async () => {
    const calls: Array<{ url: string; body: string; auth: string }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: init.body as string, auth: (init.headers as Record<string, string>).Authorization! });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const mailer = createResendMailer({ apiKey: "re_test_key", from: "AI Agent Trust <noreply@rootsystems.app>", replyTo: "hello@rootsystems.app", fetchImpl, log: () => undefined });
    for (const to of ["a@example.test", "a@x.example", "a@foo.invalid", "a@localhost", "a@example.com", "a@mail.example.org", "a@example.net"]) {
      expect(isReservedEmailDomain(to)).toBe(true);
      expect(await mailer.send({ to, subject: "s", text: "t", html: "h" })).toEqual({ sent: false, reason: "reserved-domain" });
    }
    expect(calls).toHaveLength(0);
    expect(await mailer.send({ to: "owner@company.co", subject: "s", text: "t", html: "h" })).toEqual({ sent: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.resend.com/emails");
    expect(calls[0]!.auth).toBe("Bearer re_test_key");
    expect(JSON.parse(calls[0]!.body)).toMatchObject({ to: "owner@company.co", reply_to: "hello@rootsystems.app" });
  });

  it("a provider failure is reported, not thrown", async () => {
    const answers500: typeof fetch = async () => new Response("no", { status: 500 });
    const unreachable: typeof fetch = async () => { throw new Error("down"); };
    const failing = createResendMailer({ apiKey: "k", from: "f", replyTo: "r@x.co", fetchImpl: answers500, log: () => undefined });
    expect(await failing.send({ to: "owner@company.co", subject: "s", text: "t", html: "h" })).toEqual({ sent: false, reason: "delivery-failed" });
    const down = createResendMailer({ apiKey: "k", from: "f", replyTo: "r@x.co", fetchImpl: unreachable, log: () => undefined });
    expect(await down.send({ to: "owner@company.co", subject: "s", text: "t", html: "h" })).toEqual({ sent: false, reason: "delivery-failed" });
  });
});
