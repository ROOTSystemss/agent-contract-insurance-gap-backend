import bcrypt from "bcryptjs";
import type { FastifyPluginAsync } from "fastify";
import { AppError, unauthorized } from "../shared/errors.js";
import { actor, audit, success } from "./helpers.js";
import { loginSchema, registerSchema } from "./schemas.js";

function safeUser(user: {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  createdAt: string;
  updatedAt: string;
}) {
  const { passwordHash: _passwordHash, ...safe } = user;
  return safe;
}

export const authRoutes: FastifyPluginAsync = async (app) => {
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
            "An account with this email already exists.",
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
      await audit(app.store, request, "user", registration.user.id, "user.registration", {
        organizationId: registration.organization.id,
      });
      return reply.code(201).send(
        success(request, {
          accessToken,
          tokenType: "Bearer",
          user: safeUser(registration.user),
          organization: registration.organization,
          role: registration.membership.role,
        }),
      );
    },
  );

  app.post(
    "/login",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const input = loginSchema.parse(request.body);
      const user = await app.store.findUserByEmail(input.email);
      if (!user || !(await bcrypt.compare(input.password, user.passwordHash))) throw unauthorized();
      const membership = await app.store.getMembership(user.id);
      if (!membership) throw unauthorized();
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
      return success(request, { accessToken, tokenType: "Bearer" });
    },
  );

  app.get("/me", { preHandler: app.authenticate }, async (request) => {
    const authenticated = actor(request);
    const user = await app.store.getUser(authenticated.userId);
    const organization = await app.store.getOrganization(authenticated.organizationId);
    if (!user || !organization) throw unauthorized();
    const { passwordHash: _passwordHash, ...safe } = user;
    return success(request, { user: safe, organization, role: authenticated.role });
  });
};
