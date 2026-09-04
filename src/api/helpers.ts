import { randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { AuditEvent, Paginated, PaginationInput, Role } from "../domain/types.js";
import type { Store } from "../persistence/store.js";
import { forbidden, unauthorized } from "../shared/errors.js";
import { roleRank } from "../persistence/store.js";
import { paginationSchema } from "./schemas.js";

export function actor(request: FastifyRequest) {
  if (!request.actor) throw unauthorized();
  return request.actor;
}

export function requireRole(request: FastifyRequest, minimum: Role): void {
  if (roleRank[actor(request).role] < roleRank[minimum]) throw forbidden();
}

export function pagination(query: unknown): PaginationInput {
  return paginationSchema.parse(query);
}

export function success<T>(request: FastifyRequest, data: T, meta: Record<string, unknown> = {}) {
  return { data, meta, requestId: request.id };
}

export async function audit(
  store: Store,
  request: FastifyRequest,
  resourceType: string,
  resourceId: string,
  action: string,
  metadata: AuditEvent["metadata"] = {},
): Promise<void> {
  const authenticated = actor(request);
  await store.addAuditEvent({
    id: randomUUID(),
    organizationId: authenticated.organizationId,
    actorId: authenticated.userId,
    resourceType,
    resourceId,
    action,
    requestId: request.id,
    metadata,
    createdAt: new Date().toISOString(),
  });
}

export function paginatedMeta<T>(result: Paginated<T>) {
  return { page: result.page, pageSize: result.pageSize, total: result.total };
}
