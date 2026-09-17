import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import type { AppConfig } from "../config/env.js";
import { AppError, unauthorized } from "../shared/errors.js";
import { actor, audit, success } from "./helpers.js";
import { oauthAuthorizeSchema, oauthTokenSchema } from "./schemas.js";

// Minimal single-client OAuth2-authorization-code-style identity provider so AI
// Compliance Readiness can offer "Sign in with Authority Atlas". Readiness is the
// only registered client (no dynamic client registration) — trust is a static
// pre-shared secret configured identically on both sides, the same
// operator-controlled model already used for Readiness's ATLAS_URL setting. This
// never forwards a password in either direction: Readiness gets a one-time code,
// then exchanges it server-to-server for a small identity payload.

function secretsMatch(expected: string, provided: string): boolean {
  // Hash both sides first so a length mismatch can't make timingSafeEqual throw
  // (which would itself leak length information via a different code path).
  const expectedHash = createHash("sha256").update(expected).digest();
  const providedHash = createHash("sha256").update(provided).digest();
  return timingSafeEqual(expectedHash, providedHash);
}

export const oauthRoutes: FastifyPluginAsync<{ config: AppConfig }> = async (app, opts) => {
  const { config } = opts;

  app.post(
    "/authorize",
    {
      preHandler: app.authenticate,
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (request) => {
      const input = oauthAuthorizeSchema.parse(request.body);
      if (input.clientId !== config.ATLAS_OAUTH_CLIENT_ID) {
        throw new AppError(400, "INVALID_CLIENT", "Unknown OAuth client.");
      }
      // redirect_uri is never trusted from the caller — only an exact configured
      // match is accepted, mirroring the exact-match CORS-origin allowlist in app.ts.
      if (!config.atlasOAuthRedirectUris.includes(input.redirectUri)) {
        throw new AppError(
          400,
          "INVALID_REDIRECT_URI",
          "The redirect URI is not allowlisted for this client.",
        );
      }
      const authenticated = actor(request);
      const code = app.oauthCodes.issue({
        userId: authenticated.userId,
        organizationId: authenticated.organizationId,
        clientId: input.clientId,
        redirectUri: input.redirectUri,
      });
      await audit(app.store, request, "user", authenticated.userId, "oauth.authorize_issued", {
        clientId: input.clientId,
        redirectUriHost: new URL(input.redirectUri).host,
      });
      const redirectTo = `${input.redirectUri}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(input.state)}`;
      return success(request, { redirectTo });
    },
  );

  app.post(
    "/token",
    // No app.authenticate here — this leg authenticates the CLIENT (Readiness's
    // backend), not a user's bearer token.
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request) => {
      const input = oauthTokenSchema.parse(request.body);
      if (
        input.clientId !== config.ATLAS_OAUTH_CLIENT_ID ||
        !secretsMatch(config.ATLAS_OAUTH_CLIENT_SECRET, input.clientSecret)
      ) {
        throw new AppError(401, "INVALID_CLIENT", "Client authentication failed.");
      }
      const subject = app.oauthCodes.consume(input.code, {
        clientId: input.clientId,
        redirectUri: input.redirectUri,
      });
      if (!subject) {
        throw new AppError(
          400,
          "INVALID_GRANT",
          "The authorization code is invalid, expired, or already used.",
        );
      }
      // Re-fetch live rather than trusting anything beyond the two IDs encoded in
      // the code — the same "don't trust stale claims" discipline app.authenticate
      // already applies to bearer tokens on every request.
      const [user, membership, organization] = await Promise.all([
        app.store.getUser(subject.userId),
        app.store.getMembership(subject.userId, subject.organizationId),
        app.store.getOrganization(subject.organizationId),
      ]);
      if (!user || !membership || !organization) throw unauthorized();
      request.actor = { userId: user.id, organizationId: organization.id, role: membership.role };
      await audit(app.store, request, "user", user.id, "oauth.token_issued", {
        clientId: input.clientId,
      });
      return success(request, {
        subject: { atlasUserId: user.id, email: user.email, name: user.name },
        organization: {
          atlasOrganizationId: organization.id,
          atlasOrganizationName: organization.name,
        },
        role: membership.role,
      });
    },
  );
};
