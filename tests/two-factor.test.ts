import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import { MemoryStore } from "../src/persistence/memory-store.js";
import { PrismaStore } from "../src/persistence/prisma-store.js";
import { EmailVault } from "../src/persistence/email-vault.js";
import { checkCode, codeAt, hashRecovery, matchStep, pendingTickets, stepAt } from "../src/security/two-factor.js";
import { openTestDatabase } from "./helpers.js";

// Knock-out 2026-11-16 (S-11): two-factor sign-in for the AI Agent Trust console, the same rules as Offboarding
// Proof, Vendor Risk, HIPAA and Standards Readiness.

const PASSWORD = "Correct Horse Battery 123!";
let n = 0;
const from = () => ({ remoteAddress: "10.0.0.5", headers: { "x-forwarded-for": `203.0.113.${(n++ % 250) + 1}, 104.16.1.1, 10.1.2.3` } });

describe("two-factor sign-in (console)", () => {
  let app: FastifyInstance;
  let store: MemoryStore;
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "gap-2fa-"));
    store = new MemoryStore();
    app = await buildApp({
      config: loadConfig({ NODE_ENV: "test", JWT_SECRET: "test-secret-with-at-least-thirty-two-characters", UPLOAD_DIRECTORY: dir, LOG_LEVEL: "silent", EMAIL_VERIFICATION: "0", TRUST_PROXY_HOPS: "3" }),
      store, logger: false, certificateVerifier: null, pqSigner: null,
    });
    await app.ready();
  });
  afterAll(async () => { vi.useRealTimers(); await app.close(); await rm(dir, { recursive: true, force: true }); });

  const post = (url: string, payload: unknown, token?: string) =>
    app.inject({ method: "POST", url, payload: payload as Record<string, unknown>, ...from(), headers: { ...from().headers, ...(token ? { authorization: "Bearer " + token } : {}) } });
  const get = (url: string, token: string) => app.inject({ method: "GET", url, ...from(), headers: { ...from().headers, authorization: "Bearer " + token } });
  const register = async (email: string) => {
    const r = await post("/api/v1/auth/register", { email, name: "Two Factor", organizationName: "2FA Test Ltd", password: PASSWORD });
    expect(r.statusCode).toBe(201);
    return r.json().data as { accessToken: string; organization: { id: string } };
  };
  const login = (email: string, password = PASSWORD) => post("/api/v1/auth/login", { email, password });
  async function enable(token: string) {
    const start = (await post("/api/v1/auth/two-factor/start", {}, token)).json().data as { secret: string; otpauthUri: string };
    const step = stepAt();
    const on = await post("/api/v1/auth/two-factor/enable", { code: codeAt(start.secret, step) }, token);
    expect(on.statusCode).toBe(200);
    return { secret: start.secret, step, recoveryCodes: on.json().data.recoveryCodes as string[], otpauthUri: start.otpauthUri };
  }

  it("unit: TOTP matches RFC 6238 test vector and refuses replays", () => {
    // RFC 6238 SHA-1 secret "12345678901234567890" (base32 GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ), T=59s -> 94287082 (6 digits: 287082)
    expect(codeAt("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 1)).toBe("287082");
    const s = stepAt();
    const secret = "JBSWY3DPEHPK3PXP";
    expect(matchStep(secret, codeAt(secret, s))).toBe(s);
    expect(matchStep(secret, codeAt(secret, s), { lastStep: s })).toBeNull();
    const rec = checkCode({ secret, lastStep: null, recoveryHashes: [hashRecovery("abcde-12345")] }, "ABCDE 12345");
    expect(rec).toMatchObject({ ok: true, method: "recovery", remaining: [] });
  });

  it("unit: pending tickets are signed, single use and expire", () => {
    let t = 1_000_000;
    const tickets = pendingTickets("x".repeat(40), { ttlMs: 1000, now: () => t });
    const ticket = tickets.issue("u1", "o1", "owner");
    const read = tickets.read(ticket);
    expect(read).toMatchObject({ userId: "u1", organizationId: "o1", role: "owner" });
    expect(tickets.read(ticket.slice(0, -2) + "xx")).toBeNull();
    expect(pendingTickets("y".repeat(40)).read(ticket)).toBeNull();
    tickets.spend(read!.nonce);
    expect(tickets.read(ticket)).toBeNull();
    const second = tickets.issue("u1", "o1", "owner");
    t += 2000;
    expect(tickets.read(second)).toBeNull();
  });

  it("accounts without two-factor sign in exactly as before; owners are prompted, analysts are not", async () => {
    const owner = await register("owner-plain@2fa.test");
    const r = await login("owner-plain@2fa.test");
    expect(r.statusCode).toBe(200);
    expect(r.json().data.accessToken).toBeTruthy();
    expect(r.json().data.twoFactorRequired).toBeUndefined();
    const me = (await get("/api/v1/auth/me", owner.accessToken)).json().data;
    expect(me).toMatchObject({ twoFactorEnabled: false, twoFactorPrompt: true });
    await store.addMember(owner.organization.id, { email: "analyst@2fa.test", name: "Analyst", passwordHash: await bcrypt.hash(PASSWORD, 4), role: "analyst" });
    const a = (await login("analyst@2fa.test")).json().data.accessToken as string;
    expect((await get("/api/v1/auth/me", a)).json().data).toMatchObject({ twoFactorEnabled: false, twoFactorPrompt: false });
    expect((await get("/api/v1/auth/two-factor", a)).json().data).toMatchObject({ enabled: false, prompt: false });
  });

  it("setup: a wrong code does not turn it on; a right one does, recovery codes shown once, secret never shown again", async () => {
    const { accessToken } = await register("setup@2fa.test");
    const start = (await post("/api/v1/auth/two-factor/start", {}, accessToken)).json().data;
    expect(start.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(start.otpauthUri).toMatch(/^otpauth:\/\/totp\/AI%20Agent%20Trust%3Asetup%402fa\.test\?secret=/);
    const wrong = codeAt(start.secret, stepAt()) === "000000" ? "111111" : "000000";
    expect((await post("/api/v1/auth/two-factor/enable", { code: wrong }, accessToken)).statusCode).toBe(400);
    expect((await get("/api/v1/auth/two-factor", accessToken)).json().data.enabled).toBe(false);
    const on = await post("/api/v1/auth/two-factor/enable", { code: codeAt(start.secret, stepAt()) }, accessToken);
    expect(on.statusCode).toBe(200);
    expect(on.json().data.recoveryCodes).toHaveLength(8);
    const status = (await get("/api/v1/auth/two-factor", accessToken)).json().data;
    expect(status).toMatchObject({ enabled: true, recoveryCodesLeft: 8, prompt: false });
    expect(JSON.stringify(status)).not.toContain(start.secret);
    expect((await post("/api/v1/auth/two-factor/start", {}, accessToken)).statusCode).toBe(409);
    const kept = await store.getTwoFactor((await get("/api/v1/auth/me", accessToken)).json().data.user.id);
    expect(kept!.recoveryHashes.join(",")).not.toContain(on.json().data.recoveryCodes[0]);
  });

  it("sign-in: password alone gives only a ticket; the ticket is not an access token; the code signs in once", async () => {
    const { accessToken } = await register("signin@2fa.test");
    const { secret, step, recoveryCodes } = await enable(accessToken);
    const first = await login("signin@2fa.test");
    expect(first.statusCode).toBe(200);
    const pending = first.json().data;
    expect(pending.twoFactorRequired).toBe(true);
    expect(pending.accessToken).toBeUndefined();
    expect((await get("/api/v1/auth/me", pending.pendingToken)).statusCode).toBe(401);
    // The code used at setup is refused (replay).
    expect((await post("/api/v1/auth/login/2fa", { pendingToken: pending.pendingToken, code: codeAt(secret, step) })).statusCode).toBe(400);
    const ok = await post("/api/v1/auth/login/2fa", { pendingToken: pending.pendingToken, code: codeAt(secret, step + 1) });
    expect(ok.statusCode).toBe(200);
    expect((await get("/api/v1/auth/me", ok.json().data.accessToken)).statusCode).toBe(200);
    expect(String(ok.headers["set-cookie"])).toContain("rootsystems.acg.dev=");
    // The same ticket cannot be used twice.
    expect((await post("/api/v1/auth/login/2fa", { pendingToken: pending.pendingToken, code: codeAt(secret, step + 1) })).statusCode).toBe(401);
    // A forged ticket.
    expect((await post("/api/v1/auth/login/2fa", { pendingToken: "eyJ1IjoieCJ9.forged-signature-value", code: "123456" })).statusCode).toBe(401);
    // A recovery code works once.
    const p2 = (await login("signin@2fa.test")).json().data.pendingToken;
    const rc = await post("/api/v1/auth/login/2fa", { pendingToken: p2, code: recoveryCodes[0] });
    expect(rc.statusCode).toBe(200);
    expect((await get("/api/v1/auth/two-factor", rc.json().data.accessToken)).json().data.recoveryCodesLeft).toBe(7);
    const p3 = (await login("signin@2fa.test")).json().data.pendingToken;
    expect((await post("/api/v1/auth/login/2fa", { pendingToken: p3, code: recoveryCodes[0] })).statusCode).toBe(400);
    // A wrong password still fails before any code is asked for.
    expect((await login("signin@2fa.test", "Wrong Password 999!")).statusCode).toBe(401);
  });

  it("wrong codes are limited per account: 8 per 15 minutes, then 429 even for a right code", async () => {
    const { accessToken } = await register("limit@2fa.test");
    const { secret, step } = await enable(accessToken);
    const pendingToken = (await login("limit@2fa.test")).json().data.pendingToken;
    const wrong = codeAt(secret, step + 1) === "000000" ? "111111" : "000000";
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) codes.push((await post("/api/v1/auth/login/2fa", { pendingToken, code: wrong })).statusCode);
    expect(codes.every((c) => c === 400)).toBe(true);
    const ninth = await post("/api/v1/auth/login/2fa", { pendingToken, code: codeAt(secret, step + 1) });
    expect(ninth.statusCode).toBe(429);
    expect(ninth.headers["retry-after"]).toBeTruthy();
  });

  it("turning it off needs the password AND a current code; afterwards sign-in is password only again", async () => {
    const { accessToken } = await register("off@2fa.test");
    const { secret } = await enable(accessToken);
    expect((await post("/api/v1/auth/two-factor/disable", { password: "Wrong Password 999!", code: "123456" }, accessToken)).statusCode).toBe(403);
    expect((await post("/api/v1/auth/two-factor/disable", { password: PASSWORD, code: "000000" === codeAt(secret, stepAt()) ? "111111" : "000000" }, accessToken)).statusCode).toBe(400);
    expect((await get("/api/v1/auth/two-factor", accessToken)).json().data.enabled).toBe(true);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 90_000); // a fresh, unused step
    const off = await post("/api/v1/auth/two-factor/disable", { password: PASSWORD, code: codeAt(secret, stepAt()) }, accessToken);
    vi.useRealTimers();
    expect(off.statusCode).toBe(200);
    expect(off.json().data.enabled).toBe(false);
    const again = await login("off@2fa.test");
    expect(again.json().data.accessToken).toBeTruthy();
    expect(again.json().data.twoFactorRequired).toBeUndefined();
  });

  it("UI: the code step is served and every sign-in page uses it; the account page sets it up", async () => {
    const js = await app.inject({ method: "GET", url: "/two-factor.js" });
    expect(js.statusCode).toBe(200);
    expect(js.headers["content-type"]).toContain("javascript");
    expect(js.body).toContain("rsTwoFactorStep");
    expect(js.body).toContain("/api/v1/auth/login/2fa");
    for (const page of ["/console", "/", "/oauth/authorize", "/account"]) {
      const html = (await app.inject({ method: "GET", url: page })).body;
      expect(html, page).toContain('<script src="/two-factor.js" defer></script>');
    }
    for (const script of ["/console.js", "/app.js", "/authorize.js"]) {
      expect((await app.inject({ method: "GET", url: script })).body, script).toMatch(/twoFactorRequired[\s\S]*rsTwoFactorStep/);
    }
    const account = (await app.inject({ method: "GET", url: "/account.js" })).body;
    expect(account).toContain('kind === "2fa"');
    expect(account).toContain("/auth/two-factor/enable");
    expect(account).toContain('id="recovery-codes"');
    expect((await app.inject({ method: "GET", url: "/console.js" })).body).toContain('id: "twofa-prompt"');
  });
  it("two-factor routes need a signed-in user", async () => {
    expect((await app.inject({ method: "GET", url: "/api/v1/auth/two-factor" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/v1/auth/two-factor/start", payload: {} })).statusCode).toBe(401);
  });
});

// Set ACG_TEST_DATABASE_URL to a disposable local database that has had `prisma migrate deploy` run.
const databaseUrl = process.env.ACG_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)("two-factor state on Postgres (secret sealed at rest)", () => {
  let client: PrismaClient;
  let store: PrismaStore;
  beforeAll(async () => {
    client = await openTestDatabase(databaseUrl!);
    store = new PrismaStore(client, new EmailVault(Buffer.alloc(32, 7)));
    await store.reset();
  });
  afterAll(async () => { await store.reset(); await client.$disconnect(); });

  it("stores the secret sealed, round-trips, deletes, and is removed with the user", async () => {
    const reg = await store.createRegistration({ email: "pg2fa@2fa.test", name: "PG", passwordHash: "hash", organizationName: "PG 2FA Ltd" });
    const userId = reg.user.id;
    expect(await store.getTwoFactor(userId)).toBeNull();
    await store.saveTwoFactor({ userId, secret: "JBSWY3DPEHPK3PXP", enabledAt: "2026-11-16T00:00:00.000Z", lastStep: 59_000_000, recoveryHashes: ["a", "b"] });
    const raw = await client.$queryRaw<Array<{ secret: string; lastStep: bigint }>>`SELECT "secret", "lastStep" FROM "UserTwoFactor" WHERE "userId" = ${userId}::uuid`;
    expect(raw[0]!.secret.startsWith("enc:v1:")).toBe(true);
    expect(raw[0]!.secret).not.toContain("JBSWY3DPEHPK3PXP");
    expect(await store.getTwoFactor(userId)).toEqual({ userId, secret: "JBSWY3DPEHPK3PXP", enabledAt: "2026-11-16T00:00:00.000Z", lastStep: 59_000_000, recoveryHashes: ["a", "b"] });
    await store.saveTwoFactor({ userId, secret: "JBSWY3DPEHPK3PXP", enabledAt: "2026-11-16T00:00:00.000Z", lastStep: 59_000_001, recoveryHashes: ["b"] });
    expect((await store.getTwoFactor(userId))!.lastStep).toBe(59_000_001);
    await store.deleteTwoFactor(userId);
    expect(await store.getTwoFactor(userId)).toBeNull();
    await store.saveTwoFactor({ userId, secret: "JBSWY3DPEHPK3PXP", enabledAt: null, lastStep: null, recoveryHashes: [] });
    await client.$executeRaw`DELETE FROM "OrganizationMember" WHERE "userId" = ${userId}::uuid`;
    await client.$executeRaw`DELETE FROM "AuditEvent" WHERE "actorUserId" = ${userId}::uuid`.catch(() => 0);
    await client.$executeRaw`DELETE FROM "User" WHERE "id" = ${userId}::uuid`;
    expect(await store.getTwoFactor(userId)).toBeNull();
  });
});
