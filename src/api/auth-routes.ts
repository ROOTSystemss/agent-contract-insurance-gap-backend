import bcrypt from "bcryptjs";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { User } from "../domain/types.js";
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
      void reply.header("Set-Cookie", app.knownDevices.cookieFor(request.headers.cookie, email, secureCookies));
      request.actor = {
        userId: user.id,
        organizationId: membership.organizationId,
        role: membership.role,
      };
      const accessToken = await reply.jwtSign({
        sub: user.id,
        organizationId: membership.organizationId,
        role: membership.role,
      });
      await audit(app.store, request, "user", user.id, "auth.login_success");
      return success(request, { accessToken, tokenType: "Bearer", ...verification(user) });
    },
  );

  app.get("/me", { preHandler: app.authenticate }, async (request) => {
    const authenticated = actor(request);
    const user = await app.store.getUser(authenticated.userId);
    const organization = await app.store.getOrganization(authenticated.organizationId);
    if (!user || !organization) throw unauthorized();
    return success(request, { user: safeUser(user), organization, role: authenticated.role, ...verification(user) });
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
