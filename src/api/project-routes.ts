import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { notFound } from "../shared/errors.js";
import { actor, audit, paginatedMeta, pagination, requireRole, success } from "./helpers.js";
import { projectCreateSchema, projectUpdateSchema } from "./schemas.js";

const idParams = z.object({ id: z.string().uuid() });

export const projectRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);

  app.post("/", async (request, reply) => {
    requireRole(request, "analyst");
    const authenticated = actor(request);
    const project = await app.store.createProject(
      authenticated.organizationId,
      projectCreateSchema.parse(request.body),
    );
    await audit(app.store, request, "project", project.id, "project.create", {
      projectId: project.id,
    });
    return reply.code(201).send(success(request, project));
  });

  app.get("/", async (request) => {
    const result = await app.store.listProjects(
      actor(request).organizationId,
      pagination(request.query),
    );
    return success(request, result.items, paginatedMeta(result));
  });

  app.get("/:id", async (request) => {
    const { id } = idParams.parse(request.params);
    const project = await app.store.getProject(actor(request).organizationId, id);
    if (!project) throw notFound("Project");
    return success(request, project);
  });

  app.patch("/:id", async (request) => {
    requireRole(request, "analyst");
    const { id } = idParams.parse(request.params);
    const project = await app.store.updateProject(
      actor(request).organizationId,
      id,
      projectUpdateSchema.parse(request.body),
    );
    if (!project) throw notFound("Project");
    await audit(app.store, request, "project", project.id, "project.update", {
      projectId: project.id,
    });
    return success(request, project);
  });

  app.delete("/:id", async (request, reply) => {
    requireRole(request, "admin");
    const { id } = idParams.parse(request.params);
    if (!(await app.store.deleteProject(actor(request).organizationId, id)))
      throw notFound("Project");
    await audit(app.store, request, "project", id, "project.delete", { projectId: id });
    return reply.code(204).send();
  });
};
