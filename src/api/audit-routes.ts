import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { notFound } from "../shared/errors.js";
import { actor, paginatedMeta, pagination, success } from "./helpers.js";

export const auditRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);
  app.get("/:projectId/audit-events", async (request) => {
    const { projectId } = z.object({ projectId: z.string().uuid() }).parse(request.params);
    const authenticated = actor(request);
    if (!(await app.store.getProject(authenticated.organizationId, projectId)))
      throw notFound("Project");
    const result = await app.store.listAuditEvents(
      authenticated.organizationId,
      projectId,
      pagination(request.query),
    );
    return success(request, result.items, paginatedMeta(result));
  });
};
