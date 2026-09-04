import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { notFound } from "../shared/errors.js";
import { actor, audit, requireRole, success } from "./helpers.js";

export const organizationRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);

  app.get("/current", async (request) => {
    const organization = await app.store.getOrganization(actor(request).organizationId);
    if (!organization) throw notFound("Organization");
    return success(request, organization);
  });

  app.patch("/current", async (request) => {
    requireRole(request, "admin");
    const input = z.object({ name: z.string().trim().min(2).max(160) }).parse(request.body);
    const authenticated = actor(request);
    const organization = await app.store.updateOrganization(
      authenticated.organizationId,
      input.name,
    );
    if (!organization) throw notFound("Organization");
    await audit(app.store, request, "organization", organization.id, "organization.update");
    return success(request, organization);
  });

  app.get("/current/members", async (request) => {
    requireRole(request, "admin");
    return success(request, await app.store.listMembers(actor(request).organizationId));
  });
};
