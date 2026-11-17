import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Role, User } from "../domain/types.js";
import { checkCode, hashRecovery, matchStep, newRecoveryCodes, newSecret, otpauthUri } from "../security/two-factor.js";
import { AppError, unauthorized } from "../shared/errors.js";
import { actor, audit, success } from "./helpers.js";
import { loginSchema, registerSchema } from "./schemas.js";

function safeUser(user: User) {
  const { passwordHash: _passwordHash, passwordChangedAt: _passwordChangedAt, ...safe } = user;
  return safe;
}

const newPassword = z.string().min(12).max(128);
const tokenBody = z.object({ token: z.string().min(1).max(200) });
const resetBody = z.object({ token: z.string().min(1).max(200), password: newPassword });
const forgotBody = z.object({ email: z.email().max(254) });
const changeBody = z.object({ currentPassword: z.string().min(1).max(128), newPassword });
const codeField = z.string().trim().min(6).max(20);
const twoFactorLoginBody = z.object({ pendingToken: z.string().min(10).max(1000), code: codeField });
const codeBody = z.object({ code: codeField });
const disableBody = z.object({ password: z.string().min(1).max(128), code: codeField });
const privileged = (role: Role) => role === "owner" || role === "admin";

// Same work whether or not the email exists, so response time does not reveal registered addresses.
const DUMMY_HASH = bcrypt.hashSync("no-such-account-timing-decoy", 12);

export const authRoutes: FastifyPluginAsync = async (app) => {
  const secureCookies = process.env.NODE_ENV === "production";
  const verification = (user: User) => ({ emailVerified: app.accountSecurity.isVerified(user), verificationRequired: app.accountSecurity.required });

  app.post(
    "/register",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const input = registerSchema.parse(request.body);
      const passwordHash = await bcrypt.hash(input.password, 12);
      let registration;
      try {
        registration = await app.store.createRegistration({
          ...input,
          email: input.email.toLowerCase(),
          passwordHash,
        });
      } catch (error) {
        if (error instanceof Error && error.message === "EMAIL_EXISTS") {
          throw new AppError(
            409,
            "EMAIL_ALREADY_REGISTERED",
            "An account with this email already exists. Sign in, or reset the password if it is yours.",
          );
        }
        throw error;
      }
      request.actor = {
        userId: registration.user.id,
        organizationId: registration.organization.id,
        role: registration.membership.role,
      };
      const accessToken = await reply.jwtSign({
        sub: registration.user.id,
        organizationId: registration.organization.id,
        role: registration.membership.role,
      });
      const mail = app.accountSecurity.required ? await app.accountSecurity.sendVerification(registration.user) : null;
      await audit(app.store, request, "user", registration.user.id, "user.registration", {
        organizationId: registration.organization.id,
        verificationEmail: mail ? (mail.sent ? "sent" : mail.reason) : "not_required",
      });
      return reply.code(201).send(
        success(request, {
          accessToken,
          tokenType: "Bearer",
          user: safeUser(registration.user),
          organization: registration.organization,
          role: registration.membership.role,
          ...verification(registration.user),
          verificationEmailSent: mail ? mail.sent : false,
        }),
      );
    },
  );

  app.post(
    "/login",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const input = loginSchema.parse(request.body);
      const email = input.email.trim().toLowerCase();
      const knownDevice = app.knownDevices.isKnown(request.headers.cookie, email);
      // Counted before the password check, so parallel attempts cannot slip past the limit.
      if (!app.loginAttempts.attempt(request.ip, email, { knownDevice })) {
        void reply.header("Retry-After", String(app.loginAttempts.retryAfter(request.ip, email, { knownDevice })));
        throw new AppError(429, "TOO_MANY_ATTEMPTS", "Too many failed sign-ins for this account. Wait 15 minutes and try again, or reset your password.");
      }
      const user = await app.store.findUserByEmail(email);
      if (!user) {
        await bcrypt.compare(input.password, DUMMY_HASH);
        throw unauthorized();
      }
      if (!(await bcrypt.compare(input.password, user.passwordHash))) throw unauthorized();
      const membership = await app.store.getMembership(user.id);
      if (!membership) throw unauthorized();
      app.loginAttempts.succeeded(request.ip, email);
      // Two-factor on: the password alone issues no token, only a short single-use ticket for POST /login/2fa.
      const twoFactor = await app.store.getTwoFactor(user.id);
      if (twoFactor && twoFactor.enabledAt) {
        const pendingToken = app.twoFactorTickets.issue(user.id, membership.organizationId, membership.role);
        await auditAs(request, user.id, membership.organizationId, "auth.login_code_required");
        return success(request, { twoFactorRequired: true, pendingToken });
      }
      return issueSession(request, reply, user, membership, {});
    },
  );

  // Audit rows for steps before a session exists (request.actor stays unset: nothing here is signed in).
  async function auditAs(request: FastifyRequest, userId: string, organizationId: string, action: string) {
    await app.store.addAuditEvent({ id: randomUUID(), organizationId, actorId: userId, resourceType: "user", resourceId: userId, action, requestId: request.id, metadata: {}, createdAt: new Date().toISOString() });
  }

  async function issueSession(
    request: FastifyRequest,
    reply: FastifyReply,
    user: User,
    membership: { organizationId: string; role: Role },
    details: Record<string, string | number | boolean | null>,
  ) {
    void reply.header("Set-Cookie", app.knownDevices.cookieFor(request.headers.cookie, user.email, secureCookies));
    request.actor = { userId: user.id, organizationId: membership.organizationId, role: membership.role };
    const accessToken = await reply.jwtSign({ sub: user.id, organizationId: membership.organizationId, role: membership.role });
    await audit(app.store, request, "user", user.id, "auth.login_success", details);
    return success(request, { accessToken, tokenType: "Bearer", ...verification(user) });
  }

  // Second step of a sign-in with two-factor on: the ticket from /login plus a current code or a recovery code.
  app.post("/login/2fa", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (request, reply) => {
    const input = twoFactorLoginBody.parse(request.body);
    const ticket = app.twoFactorTickets.read(input.pendingToken);
    if (!ticket) throw new AppError(401, "SIGN_IN_EXPIRED", "This sign-in has expired. Enter your email and password again.");
    const key = "2fa:" + ticket.userId;
    if (!app.twoFactorAttempts.attempt("account", key)) {
      void reply.header("Retry-After", String(app.twoFactorAttempts.retryAfter("account", key)));
      throw new AppError(429, "TOO_MANY_CODES", "Too many wrong codes. Wait 15 minutes and sign in again.");
    }
    const [user, record, membership] = await Promise.all([
      app.store.getUser(ticket.userId),
      app.store.getTwoFactor(ticket.userId),
      app.store.getMembership(ticket.userId, ticket.organizationId),
    ]);
    if (!user || !membership || !record || !record.enabledAt) throw unauthorized();
    const result = checkCode(record, input.code);
    if (!result.ok) {
      await auditAs(request, user.id, membership.organizationId, "auth.login_code_wrong");
      throw new AppError(400, "INVALID_CODE", "That code is not right, or was already used. Enter the current 6-digit code from your authenticator app, or a recovery code.");
    }
    app.twoFactorTickets.spend(ticket.nonce);
    await app.store.saveTwoFactor(result.method === "app" ? { ...record, lastStep: result.step } : { ...record, recoveryHashes: result.remaining });
    app.twoFactorAttempts.succeeded("account", key);
    return issueSession(request, reply, user, membership, result.method === "recovery" ? { twoFactor: "recovery", recoveryCodesLeft: result.remaining.length } : { twoFactor: "app" });
  });

  // ----- Two-factor setup (signed in) -----
  app.get("/two-factor", { preHandler: app.authenticate }, async (request) => {
    const authenticated = actor(request);
    const record = await app.store.getTwoFactor(authenticated.userId);
    const enabled = Boolean(record && record.enabledAt);
    return success(request, { enabled, enabledAt: record?.enabledAt ?? null, recoveryCodesLeft: enabled && record ? record.recoveryHashes.length : 0, prompt: !enabled && privileged(authenticated.role) });
  });

  app.post("/two-factor/start", { preHandler: app.authenticate, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request) => {
    const authenticated = actor(request);
    const user = await app.store.getUser(authenticated.userId);
    if (!user) throw unauthorized();
    const existing = await app.store.getTwoFactor(user.id);
    if (existing && existing.enabledAt) throw new AppError(409, "TWO_FACTOR_ALREADY_ON", "Two-factor sign-in is already on. Turn it off first to set up a new app.");
    const secret = newSecret();
    await app.store.saveTwoFactor({ userId: user.id, secret, enabledAt: null, lastStep: null, recoveryHashes: [] });
    return success(request, { secret, otpauthUri: otpauthUri(user.email, secret) });
  });

  app.post("/two-factor/enable", { preHandler: app.authenticate, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request) => {
    const { code } = codeBody.parse(request.body);
    const authenticated = actor(request);
    const record = await app.store.getTwoFactor(authenticated.userId);
    if (!record) throw new AppError(400, "TWO_FACTOR_NOT_STARTED", "Start the setup first.");
    if (record.enabledAt) throw new AppError(409, "TWO_FACTOR_ALREADY_ON", "Two-factor sign-in is already on.");
    const step = matchStep(record.secret, code);
    if (step === null) throw new AppError(400, "INVALID_CODE", "That code is not right. Enter the current 6-digit code your authenticator app shows for AI Agent Trust.");
    const recoveryCodes = newRecoveryCodes();
    await app.store.saveTwoFactor({ ...record, enabledAt: new Date().toISOString(), lastStep: step, recoveryHashes: recoveryCodes.map(hashRecovery) });
    await audit(app.store, request, "user", authenticated.userId, "auth.two_factor_enabled");
    return success(request, { enabled: true, recoveryCodes });
  });

  app.post("/two-factor/disable", { preHandler: app.authenticate, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request, reply) => {
    const input = disableBody.parse(request.body);
    const authenticated = actor(request);
    const user = await app.store.getUser(authenticated.userId);
    if (!user) throw unauthorized();
    if (!app.loginAttempts.attempt(request.ip, user.email)) {
      void reply.header("Retry-After", String(app.loginAttempts.retryAfter(request.ip, user.email)));
      throw new AppError(429, "TOO_MANY_ATTEMPTS", "Too many wrong passwords. Wait 15 minutes and try again.");
    }
    if (!(await bcrypt.compare(input.password, user.passwordHash))) throw new AppError(403, "WRONG_PASSWORD", "The password is not correct.");
    app.loginAttempts.succeeded(request.ip, user.email);
    const record = await app.store.getTwoFactor(user.id);
    if (!record || !record.enabledAt) throw new AppError(409, "TWO_FACTOR_NOT_ON", "Two-factor sign-in is not on.");
    const key = "2fa:" + user.id;
    if (!app.twoFactorAttempts.attempt("account", key)) throw new AppError(429, "TOO_MANY_CODES", "Too many wrong codes. Wait 15 minutes and try again.");
    const result = checkCode(record, input.code);
    if (!result.ok) throw new AppError(400, "INVALID_CODE", "That code is not right, or was already used.");
    app.twoFactorAttempts.succeeded("account", key);
    await app.store.deleteTwoFactor(user.id);
    await audit(app.store, request, "user", user.id, "auth.two_factor_disabled");
    return success(request, { enabled: false });
  });

  app.get("/me", { preHandler: app.authenticate }, async (request) => {
    const authenticated = actor(request);
    const user = await app.store.getUser(authenticated.userId);
    const organization = await app.store.getOrganization(authenticated.organizationId);
    if (!user || !organization) throw unauthorized();
    const twoFactor = await app.store.getTwoFactor(user.id);
    const twoFactorEnabled = Boolean(twoFactor && twoFactor.enabledAt);
    return success(request, { user: safeUser(user), organization, role: authenticated.role, ...verification(user), twoFactorEnabled, twoFactorPrompt: !twoFactorEnabled && privileged(authenticated.role) });
  });

  // Opened from the emailed link (/account#verify=...). Proves the person receives mail at the address.
  app.post("/verify-email", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (request) => {
    const { token } = tokenBody.parse(request.body);
    const userId = await app.accountSecurity.consume(token, "verify_email");
    if (!userId) throw new AppError(400, "INVALID_OR_EXPIRED_LINK", "This confirmation link is not valid any more. Sign in and send yourself a new one.");
    await app.store.setEmailVerified(userId, new Date().toISOString());
    return success(request, { emailVerified: true });
  });

  app.post(
    "/resend-verification",
    { preHandler: app.authenticate, config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (request) => {
      const user = await app.store.getUser(actor(request).userId);
      if (!user) throw unauthorized();
      if (app.accountSecurity.isVerified(user)) return success(request, { emailVerified: true, sent: false });
      const mail = await app.accountSecurity.sendVerification(user);
      if (!mail.sent && mail.reason === "throttled") {
        throw new AppError(429, "TOO_MANY_EMAILS", "A confirmation link was sent several times in the last hour. Check your inbox and spam folder, or try again later.");
      }
      await audit(app.store, request, "user", user.id, "auth.verification_resent", { result: mail.sent ? "sent" : mail.reason });
      return success(request, { emailVerified: false, sent: mail.sent });
    },
  );

  // Always the same answer, whether or not the address has an account.
  app.post("/forgot-password", { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (request, reply) => {
    const { email } = forgotBody.parse(request.body);
    const user = await app.store.findUserByEmail(email.trim().toLowerCase());
    if (user) await app.accountSecurity.sendReset(user);
    return reply.code(202).send(success(request, { message: "If an account uses this address, we have emailed it a link to choose a new password. The link works once, for 60 minutes." }));
  });

  app.post("/reset-password", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request) => {
    const input = resetBody.parse(request.body);
    const userId = await app.accountSecurity.consume(input.token, "reset_password");
    if (!userId) throw new AppError(400, "INVALID_OR_EXPIRED_LINK", "This reset link is not valid any more. Ask for a new one.");
    const user = await app.store.getUser(userId);
    if (!user) throw new AppError(400, "INVALID_OR_EXPIRED_LINK", "This reset link is not valid any more. Ask for a new one.");
    const now = new Date().toISOString();
    await app.store.setPassword(userId, await bcrypt.hash(input.password, 12), now);
    // Opening the emailed link proves the address too.
    await app.store.setEmailVerified(userId, now);
    app.loginAttempts.forget(user.email);
    return success(request, { passwordReset: true, message: "Your password was changed and every earlier session was signed out. Sign in with the new password." });
  });

  app.post(
    "/change-password",
    { preHandler: app.authenticate, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply: FastifyReply) => changePassword(request, reply),
  );

  async function changePassword(request: FastifyRequest, reply: FastifyReply) {
    const input = changeBody.parse(request.body);
    const authenticated = actor(request);
    const user = await app.store.getUser(authenticated.userId);
    if (!user) throw unauthorized();
    if (!app.loginAttempts.attempt(request.ip, user.email)) {
      void reply.header("Retry-After", String(app.loginAttempts.retryAfter(request.ip, user.email)));
      throw new AppError(429, "TOO_MANY_ATTEMPTS", "Too many wrong passwords. Wait 15 minutes and try again.");
    }
    if (!(await bcrypt.compare(input.currentPassword, user.passwordHash))) {
      throw new AppError(403, "WRONG_PASSWORD", "The current password is not correct.");
    }
    app.loginAttempts.succeeded(request.ip, user.email);
    // Rounded down to the second (token "iat" has one-second resolution), so the token issued below stays valid.
    const changedAt = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
    await app.store.setPassword(user.id, await bcrypt.hash(input.newPassword, 12), changedAt);
    await audit(app.store, request, "user", user.id, "auth.password_changed");
    const accessToken = await reply.jwtSign({ sub: user.id, organizationId: authenticated.organizationId, role: authenticated.role });
    return success(request, { passwordChanged: true, accessToken, tokenType: "Bearer" });
  }
};
