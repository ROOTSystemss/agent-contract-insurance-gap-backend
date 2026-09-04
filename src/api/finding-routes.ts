import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { notFound } from "../shared/errors.js";
import { actor, audit, requireRole, success } from "./helpers.js";
import { findingStatusSchema } from "./schemas.js";

const paramsSchema = z.object({ id: z.string().min(1).max(64) });

export const findingRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);

  app.get("/:id", async (request) => {
    const { id } = paramsSchema.parse(request.params);
    const finding = await app.store.getFinding(actor(request).organizationId, id);
    if (!finding) throw notFound("Finding");
    return success(request, finding);
  });

  app.patch("/:id/status", async (request) => {
    requireRole(request, "analyst");
    const { id } = paramsSchema.parse(request.params);
    const { status } = findingStatusSchema.parse(request.body);
    const finding = await app.store.updateFindingStatus(actor(request).organizationId, id, status);
    if (!finding) throw notFound("Finding");
    await audit(app.store, request, "finding", id, "finding.status_change", {
      projectId: finding.projectId,
      status,
    });
    return success(request, finding);
  });
};
