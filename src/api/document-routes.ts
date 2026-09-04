import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { notFound } from "../shared/errors.js";
import { AppError } from "../shared/errors.js";
import { actor, audit, paginatedMeta, pagination, requireRole, success } from "./helpers.js";
import { documentMetadataSchema } from "./schemas.js";

const projectParams = z.object({ projectId: z.string().uuid() });
const documentParams = z.object({ id: z.string().uuid() });

function publicDocument<T extends { storageKey: string }>(document: T): Omit<T, "storageKey"> {
  const { storageKey: _storageKey, ...safe } = document;
  return safe;
}

export const projectDocumentRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);

  app.post("/:projectId/documents", async (request, reply) => {
    requireRole(request, "analyst");
    const { projectId } = projectParams.parse(request.params);
    const metadata = documentMetadataSchema.parse(request.query);
    const upload = await request.file();
    if (!upload) throw new AppError(400, "FILE_REQUIRED", "A multipart file is required.");
    const authenticated = actor(request);
    const document = await app.documentService.upload({
      organizationId: authenticated.organizationId,
      projectId,
      uploaderId: authenticated.userId,
      filename: upload.filename,
      mimeType: upload.mimetype,
      buffer: await upload.toBuffer(),
      documentType: metadata.documentType,
      countryCode: metadata.countryCode,
      ...(metadata.subdivisionCode ? { subdivisionCode: metadata.subdivisionCode } : {}),
    });
    await audit(app.store, request, "document", document.id, "document.upload", {
      projectId,
      documentType: document.documentType,
      checksum: document.checksum,
      extractionStatus: document.extractionStatus,
    });
    await audit(app.store, request, "document", document.id, "document.extraction", {
      projectId,
      extractionStatus: document.extractionStatus,
      pageCount: document.pageCount,
    });
    return reply.code(201).send(success(request, publicDocument(document)));
  });

  app.get("/:projectId/documents", async (request) => {
    const { projectId } = projectParams.parse(request.params);
    const authenticated = actor(request);
    if (!(await app.store.getProject(authenticated.organizationId, projectId)))
      throw notFound("Project");
    const result = await app.store.listDocuments(
      authenticated.organizationId,
      projectId,
      pagination(request.query),
    );
    return success(request, result.items.map(publicDocument), paginatedMeta(result));
  });
};

export const documentRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);

  app.get("/:id", async (request) => {
    const { id } = documentParams.parse(request.params);
    const document = await app.store.getDocument(actor(request).organizationId, id);
    if (!document) throw notFound("Document");
    return success(request, publicDocument(document));
  });

  app.delete("/:id", async (request, reply) => {
    requireRole(request, "admin");
    const { id } = documentParams.parse(request.params);
    const authenticated = actor(request);
    const document = await app.store.getDocument(authenticated.organizationId, id);
    if (!document || !(await app.documentService.delete(authenticated.organizationId, id)))
      throw notFound("Document");
    await audit(app.store, request, "document", id, "document.delete", {
      projectId: document.projectId,
    });
    return reply.code(204).send();
  });

  app.post("/:id/retry-extraction", async (request) => {
    requireRole(request, "analyst");
    const { id } = documentParams.parse(request.params);
    const document = await app.documentService.retryExtraction(actor(request).organizationId, id);
    await audit(app.store, request, "document", id, "document.extraction_retry", {
      projectId: document.projectId,
      extractionStatus: document.extractionStatus,
    });
    return success(request, publicDocument(document));
  });
};
