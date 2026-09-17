import type { FastifyPluginAsync } from "fastify";
import { actor, audit, requireRole, success } from "./helpers.js";

export const governanceRoutes: FastifyPluginAsync = async (app) => {
  app.get("/export", { preHandler: app.authenticate }, async (request, reply) => {
    requireRole(request, "admin");
    const orgId = actor(request).organizationId;
    const organization = await app.store.getOrganization(orgId);
    const projects = await app.store.listProjects(orgId, { page: 1, pageSize: 100 });
    await audit(app.store, request, "organization", orgId, "governance.summary_export");
    reply.header("Cache-Control", "no-store");
    return success(request, {
      schema: "rootsystems.atlas-summary.v1",
      exportedAt: new Date().toISOString(),
      organization: { id: orgId, name: organization?.name || "Atlas workspace" },
      totalProjects: projects.total,
      // listProjects is capped at pageSize 100 above; when an org has more projects than
      // that, this export is an incomplete inventory, not a full one — surface that instead
      // of silently disagreeing with totalProjects (Readiness's importer also caps at 100
      // projects, so raising the page size wouldn't remove the ceiling, just move it).
      truncated: projects.total > projects.items.length,
      projects: projects.items.map((project) => ({
        id: project.id,
        name: project.name,
        status: "Inventory only; analysis not included",
      })),
    });
  });
};
