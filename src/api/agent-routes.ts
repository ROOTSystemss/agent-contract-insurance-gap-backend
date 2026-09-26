import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { notFound } from "../shared/errors.js";
import { actor, audit, requireRole, success } from "./helpers.js";
import { agentProfileSchema } from "./schemas.js";
import {
  escalationPatch,
  reconcile,
  type CertificateSummary,
  type CertificateVerifier,
} from "../authority/certificate.js";
import { AppError } from "../shared/errors.js";

const projectParams = z.object({ projectId: z.string().uuid() });
const agentParams = z.object({ id: z.string().uuid() });
const certificateBody = z.object({ certificate: z.string().min(20).max(8000) });

// Verifies a certificate with Authority Atlas. Anything other than a confirmed-valid certificate
// stops the request: an unverifiable certificate must never influence a risk analysis.
async function verifiedCertificate(
  verifier: CertificateVerifier | null,
  certificate: string,
): Promise<CertificateSummary> {
  if (!verifier) {
    throw new AppError(503, "CERTIFICATE_VERIFIER_NOT_CONFIGURED", "Certificate checks are not configured on this server.");
  }
  const result = await verifier(certificate);
  if (result.ok) return result.certificate;
  if (result.reason === "verifier_unavailable") {
    throw new AppError(503, "CERTIFICATE_VERIFIER_UNAVAILABLE", "The certificate could not be verified right now. Try again.");
  }
  throw new AppError(422, "CERTIFICATE_NOT_VALID", "The certificate is not valid: " + result.reason + ".");
}

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

  // Compares the agent's declared profile with what a signed authority certificate authorizes.
  // Read-only: reports differences, changes nothing.
  app.post("/:id/certificate-check", async (request) => {
    requireRole(request, "analyst");
    const { id } = agentParams.parse(request.params);
    const { certificate } = certificateBody.parse(request.body);
    const agent = await app.store.getAgent(actor(request).organizationId, id);
    if (!agent) throw notFound("Agent profile");
    const summary = await verifiedCertificate(app.certificateVerifier, certificate);
    const result = reconcile(agent, summary);
    await audit(app.store, request, "agent_profile", agent.id, "agent_profile.certificate_check", {
      projectId: agent.projectId,
      differences: result.differences.length,
      profileCoversCertificate: result.profileCoversCertificate,
    });
    return success(request, result);
  });

  // Brings an under-stated profile up to what its certificate authorizes. Escalation only.
  app.post("/:id/adopt-certificate", async (request) => {
    requireRole(request, "analyst");
    const { id } = agentParams.parse(request.params);
    const { certificate } = certificateBody.parse(request.body);
    const agent = await app.store.getAgent(actor(request).organizationId, id);
    if (!agent) throw notFound("Agent profile");
    const summary = await verifiedCertificate(app.certificateVerifier, certificate);
    const escalation = escalationPatch(agent, summary);
    if ("error" in escalation) throw new AppError(422, "CERTIFICATE_CANNOT_BE_ADOPTED", escalation.error);
    if (escalation.changed.length === 0) {
      return success(request, { changed: [], agent, note: "The profile already covers this certificate." });
    }
    const updated = await app.store.updateAgent(actor(request).organizationId, id, escalation.patch);
    if (!updated) throw notFound("Agent profile");
    await audit(app.store, request, "agent_profile", agent.id, "agent_profile.adopt_certificate", {
      projectId: agent.projectId,
      changed: escalation.changed.join(","),
    });
    return success(request, { changed: escalation.changed, agent: updated });
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
