import "@fastify/jwt";
import type { AuthenticatedActor } from "../domain/types.js";
import type { DocumentService } from "../documents/document-service.js";
import type { Store } from "../persistence/store.js";

declare module "fastify" {
  interface FastifyInstance {
    store: Store;
    documentService: DocumentService;
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    actor: AuthenticatedActor | null;
  }
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { sub: string; organizationId: string; role: AuthenticatedActor["role"] };
    user: { sub: string; organizationId: string; role: AuthenticatedActor["role"] };
  }
}
