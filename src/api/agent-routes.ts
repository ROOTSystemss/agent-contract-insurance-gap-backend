import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { notFound } from "../shared/errors.js";
import { actor, audit, requireRole, success } from "./helpers.js";
import { agentProfileSchema } from "./schemas.js";

const projectParams = z.object({ projectId: z.string().uuid() });
const agentParams = z.object({ id: z.string().uuid() });

export const projectAgentRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);

  app.post("/:projectId/agents", async (request, reply) => {
    requireRole(request, "analyst");
    const { projectId } = projectParams.parse(request.params);
    const authenticated = actor(request);
    if (!(await app.store.getProject(authenticated.organizationId, projectId)))
      throw notFound("Project");
    const agent = await app.store.createAgent(
      authenticated.organizationId,
      projectId,
      agentProfileSchema.parse(request.body),
    );
    await audit(app.store, request, "agent_profile", agent.id, "agent_profile.create", {
      projectId,
    });
    return reply.code(201).send(success(request, agent));
  });

  app.get("/:projectId/agents", async (request) => {
    const { projectId } = projectParams.parse(request.params);
    const authenticated = actor(request);
    if (!(await app.store.getProject(authenticated.organizationId, projectId)))
      throw notFound("Project");
    return success(request, await app.store.listAgents(authenticated.organizationId, projectId));
  });
};

export const agentRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);

  app.get("/:id", async (request) => {
    const { id } = agentParams.parse(request.params);
    const agent = await app.store.getAgent(actor(request).organizationId, id);
    if (!agent) throw notFound("Agent profile");
    return success(request, agent);
  });

  app.patch("/:id", async (request) => {
    requireRole(request, "analyst");
    const { id } = agentParams.parse(request.params);
    const input = agentProfileSchema.partial().parse(request.body);
    const agent = await app.store.updateAgent(actor(request).organizationId, id, input);
    if (!agent) throw notFound("Agent profile");
    await audit(app.store, request, "agent_profile", agent.id, "agent_profile.update", {
      projectId: agent.projectId,
    });
    return success(request, agent);
  });

  app.delete("/:id", async (request, reply) => {
    requireRole(request, "admin");
    const { id } = agentParams.parse(request.params);
    const existing = await app.store.getAgent(actor(request).organizationId, id);
    if (!existing || !(await app.store.deleteAgent(actor(request).organizationId, id)))
      throw notFound("Agent profile");
    await audit(app.store, request, "agent_profile", id, "agent_profile.delete", {
      projectId: existing.projectId,
    });
    return reply.code(204).send();
  });
};
