import "@fastify/jwt";
import type { AuthenticatedActor } from "../domain/types.js";
import type { DocumentService } from "../documents/document-service.js";
import type { Store } from "../persistence/store.js";
import type { OAuthCodeStore } from "../security/oauth-code-store.js";
import type { CertificateVerifier } from "../authority/certificate.js";

declare module "fastify" {
  interface FastifyInstance {
    store: Store;
    documentService: DocumentService;
    oauthCodes: OAuthCodeStore;
    // null when AUTHORITY_ATLAS_URL is not configured
    certificateVerifier: CertificateVerifier | null;
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
