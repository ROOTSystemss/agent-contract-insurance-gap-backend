import { mkdir } from "node:fs/promises";
import path from "node:path";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import jwt from "@fastify/jwt";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { auditRoutes } from "./api/audit-routes.js";
import { createAtlasVerifier, type CertificateVerifier } from "./authority/certificate.js";
import { GovernanceGateway, type GatewayOptions } from "./governance/gateway.js";
import { SecretBox } from "./governance/secret-box.js";
import { ConsoleBilling, PLANS } from "./governance/billing.js";
import { billingWebhookRoutes } from "./api/billing-webhook-routes.js";
import { consoleRoutes } from "./api/console-routes.js";
import { createPqSigner, publicKeyInfo, type PqSigner } from "./crypto/pq-sign.js";
import { keyHistory } from "./crypto/key-history.js";
import { agentRoutes, projectAgentRoutes } from "./api/agent-routes.js";
import { analysisRoutes, projectAnalysisRoutes } from "./api/analysis-routes.js";
import { authRoutes } from "./api/auth-routes.js";
import { documentRoutes, projectDocumentRoutes } from "./api/document-routes.js";
import { findingRoutes } from "./api/finding-routes.js";
import { jurisdictionRoutes } from "./api/jurisdiction-routes.js";
import { organizationRoutes } from "./api/organization-routes.js";
import { projectRoutes } from "./api/project-routes.js";
import { uiRoutes } from "./api/ui-routes.js";
import { governanceRoutes } from "./api/governance-routes.js";
import { oauthRoutes } from "./api/oauth-routes.js";
import { loadConfig, type AppConfig } from "./config/env.js";
import { OAuthCodeStore } from "./security/oauth-code-store.js";
import { DocumentService } from "./documents/document-service.js";
import {
  EncryptedDocumentStorage,
  LocalDocumentStorage,
  type DocumentStorage,
} from "./documents/storage.js";
import { JURISDICTION_PACKS } from "./jurisdictions/packs.js";
import { MemoryStore } from "./persistence/memory-store.js";
import { PrismaStore } from "./persistence/prisma-store.js";
import { EmailVault } from "./persistence/email-vault.js";
import type { Store } from "./persistence/store.js";
import type { Role } from "./domain/types.js";
import { CANONICAL_DISCLAIMER } from "./shared/disclaimer.js";
import { AppError, loggableError, unauthorized } from "./shared/errors.js";

export interface BuildAppOptions {
  config?: AppConfig;
  store?: Store;
  storage?: DocumentStorage;
  logger?: boolean;
  // Tests inject a verifier; production builds one from AUTHORITY_ATLAS_URL.
  certificateVerifier?: CertificateVerifier | null;
  pqSigner?: PqSigner | null;
  // Tests point the console gateway at stand-in services (and a fake fetch).
  governance?: Partial<GatewayOptions>;
}

// Our own origin comes from PUBLIC_BASE_URL - never from the request's Host header, which a client
// controls. Outside production the request's own host is also accepted, for local development.
export function isAllowedOrigin(
  request: FastifyRequest,
  configuredOrigins: string[],
  publicBaseUrl: string,
  production: boolean,
): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  if (configuredOrigins.includes(origin)) return true;
  if (origin === new URL(publicBaseUrl).origin) return true;
  if (production || !request.headers.host) return false;
  return origin === `${request.protocol}://${request.headers.host}`;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
// Dodo calls this server-to-server; it is authenticated by its Standard Webhooks signature instead.
const BROWSER_CHECK_EXEMPT = new Set(["/api/v1/billing/webhook"]);

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig();
  const store =
    options.store ??
    (config.PERSISTENCE_DRIVER === "postgres"
      ? new PrismaStore(
          undefined,
          new EmailVault(config.DOCUMENT_ENCRYPTION_KEY ? Buffer.from(config.DOCUMENT_ENCRYPTION_KEY, "base64") : null),
        )
      : new MemoryStore());
  const localStorage = new LocalDocumentStorage(path.resolve(config.UPLOAD_DIRECTORY));
  const storage =
    options.storage ??
    (config.DOCUMENT_ENCRYPTION_KEY
      ? new EncryptedDocumentStorage(
          localStorage,
          Buffer.from(config.DOCUMENT_ENCRYPTION_KEY, "base64"),
        )
      : localStorage);
  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            level: config.LOG_LEVEL,
            redact: {
              paths: [
                "req.headers.authorization",
                "req.headers.cookie",
                "req.body.password",
                "req.body.token",
                "req.body.clientSecret",
                "req.body.code",
              "req.headers['x-rootsystems-service']",
                "res.headers['set-cookie']",
              ],
              censor: "[REDACTED]",
            },
          },
    trustProxy: config.TRUST_PROXY,
    bodyLimit: Math.max(config.MAX_FILE_SIZE_BYTES + 1024 * 1024, 2 * 1024 * 1024),
    requestIdHeader: "x-request-id",
  });

  app.decorate("store", store);
  const documentService = new DocumentService(store, storage, config);
  app.decorate("documentService", documentService);
  const oauthCodes = new OAuthCodeStore(config.ATLAS_OAUTH_CODE_TTL_MS);
  app.decorate("oauthCodes", oauthCodes);
  app.decorate(
    "certificateVerifier",
    options.certificateVerifier !== undefined
      ? options.certificateVerifier
      : config.AUTHORITY_ATLAS_URL
        ? createAtlasVerifier(new URL(config.AUTHORITY_ATLAS_URL).origin)
        : null,
  );
  app.decorate(
    "governance",
    new GovernanceGateway(
      store,
      new SecretBox(config.DOCUMENT_ENCRYPTION_KEY ? Buffer.from(config.DOCUMENT_ENCRYPTION_KEY, "base64") : null),
      {
        atlasUrl: config.AUTHORITY_ATLAS_URL ? new URL(config.AUTHORITY_ATLAS_URL).origin : null,
        trustProofUrl: config.TRUST_PROOF_URL ? new URL(config.TRUST_PROOF_URL).origin : null,
        serviceToken: config.CONSOLE_SERVICE_TOKEN ?? null,
        ...options.governance,
      },
    ),
  );
  app.decorate(
    "billing",
    new ConsoleBilling(store, {
      apiKey: config.DODO_PAYMENTS_API_KEY ?? null,
      environment: config.DODO_ENVIRONMENT,
      webhookKey: config.DODO_PAYMENTS_WEBHOOK_KEY ?? null,
      productIds: { team: config.DODO_PRODUCT_ID_TEAM ?? null, business: config.DODO_PRODUCT_ID_BUSINESS ?? null },
      returnUrl: `${new URL(config.PUBLIC_BASE_URL).origin}/console#/settings`,
    }),
  );
  app.decorate("pqSigner", options.pqSigner !== undefined ? options.pqSigner : createPqSigner(config.PQ_SIGNING_SEED));
  app.decorateRequest("actor", null);

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'none'"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", "data:"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        imgSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
      },
    },
  });
  await app.register(cors, {
    delegator(request, callback) {
      if (isAllowedOrigin(request, config.corsOrigins, config.PUBLIC_BASE_URL, config.NODE_ENV === "production")) {
        callback(null, { origin: true, credentials: false });
        return;
      }
      // Reading (GET, HEAD, OPTIONS) is never refused: the response simply carries no permission for
      // another site to read it. Only state-changing requests from a foreign origin are rejected.
      const path = request.url.split("?")[0] ?? "";
      if (SAFE_METHODS.has(request.method) || BROWSER_CHECK_EXEMPT.has(path)) {
        callback(null, { origin: false });
        return;
      }
      callback(new AppError(403, "CORS_ORIGIN_DENIED", "The request origin is not allowed."));
    },
  });
  await app.register(rateLimit, {
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW,
  });
  await app.register(multipart, {
    limits: { fileSize: config.MAX_FILE_SIZE_BYTES, files: 1, fields: 10, parts: 11 },
  });
  await app.register(jwt, {
    secret: config.JWT_SECRET,
    sign: { expiresIn: config.JWT_EXPIRES_IN },
  });
  await app.register(swagger, {
    openapi: {
      info: {
        title: "Agent Contract & Insurance Gap Engine API",
        version: "0.1.0",
        description: `${CANONICAL_DISCLAIMER}\n\nDeterministic, API-first structural review of AI-agent authority against supplied contract and insurance documents.`,
      },
      servers: [{ url: "/", description: "Current server" }],
      components: {
        securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } },
      },
    },
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });

  app.decorate("authenticate", async (request) => {
    try {
      const payload = await request.jwtVerify<{
        sub: string;
        organizationId: string;
        role: Role;
      }>();
      const membership = await store.getMembership(payload.sub, payload.organizationId);
      if (!membership || membership.role !== payload.role) throw unauthorized();
      request.actor = {
        userId: payload.sub,
        organizationId: payload.organizationId,
        role: payload.role,
      };
    } catch {
      throw unauthorized();
    }
  });

  let retentionTimer: NodeJS.Timeout | undefined;
  app.addHook("onReady", async () => {
    const result = await documentService.purgeExpired();
    if (result.deleted || result.failed) app.log.info(result, "document retention sweep completed");
    retentionTimer = setInterval(() => {
      void documentService
        .purgeExpired()
        .then((sweep) => {
          if (sweep.deleted || sweep.failed)
            app.log.info(sweep, "document retention sweep completed");
        })
        .catch((error: unknown) =>
          app.log.error({ err: loggableError(error) }, "document retention sweep failed"),
        );
    }, config.RETENTION_SWEEP_INTERVAL_MS);
    retentionTimer.unref();
  });

  app.addHook("onClose", async () => {
    if (retentionTimer) clearInterval(retentionTimer);
    oauthCodes.stop();
    if (store instanceof PrismaStore) await store.disconnect();
  });

  // Must be set before ANY route is registered (directly or via app.register(plugin)):
  // Fastify's encapsulation snapshots each child context's error/not-found handler at the
  // moment it's created, so a plugin registered before these calls silently keeps Fastify's
  // default (undecorated) error shape instead of this app's {error:{code,message,details,
  // requestId}} contract. governanceRoutes previously sat before this block and its errors
  // were bypassing the contract as a result - caught while adding oauthRoutes below.
  app.setNotFoundHandler((request, reply) => {
    void reply.code(404).send({
      error: {
        code: "ROUTE_NOT_FOUND",
        message: "The requested route was not found.",
        details: [],
        requestId: request.id,
      },
    });
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "The request did not pass validation.",
          details: error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
          requestId: request.id,
        },
      });
    }
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
          requestId: request.id,
        },
      });
    }
    const possibleStatus =
      typeof error === "object" && error !== null && "statusCode" in error
        ? (error as { statusCode?: unknown }).statusCode
        : undefined;
    const statusCode =
      typeof possibleStatus === "number" && possibleStatus >= 400 && possibleStatus < 500
        ? possibleStatus
        : 500;
    if (statusCode >= 500) request.log.error({ err: loggableError(error) }, "request failed");
    return reply.code(statusCode).send({
      error: {
        code: statusCode === 413 ? "PAYLOAD_TOO_LARGE" : "INTERNAL_ERROR",
        message:
          statusCode === 413
            ? "The request payload exceeds the configured limit."
            : "An unexpected error occurred.",
        details: [],
        requestId: request.id,
      },
    });
  });

  app.get(
    "/health",
    { schema: { tags: ["system"], summary: "Liveness check" } },
    async (request) => ({ data: { status: "ok" }, meta: {}, requestId: request.id }),
  );
  app.get(
    "/.well-known/rootsystems-signing-key.json",
    { schema: { tags: ["system"], summary: "Public ML-DSA-65 key that signs Assurance Packs" } },
    async () => publicKeyInfo(app.pqSigner),
  );
  // Every signing key this product has used (crypto/key-history.ts), as the other RootSystems products publish.
  app.get(
    "/.well-known/rootsystems-signing-keys.json",
    { schema: { tags: ["system"], summary: "Signing key history (rootsystems.keyring/v1)" } },
    async (request, reply) => {
      const history = keyHistory("ai-agent-trust", app.pqSigner, process.env.PQ_KEY_HISTORY_JSON);
      if (!history) return reply.code(404).send({ error: { code: "NOT_CONFIGURED", message: "No signing key is configured." }, requestId: request.id });
      return history;
    },
  );
  app.get(
    "/ready",
    { schema: { tags: ["system"], summary: "Readiness check" } },
    async (request) => {
      await mkdir(path.resolve(config.UPLOAD_DIRECTORY), { recursive: true });
      await store.ready();
      return {
        data: {
          status: "ready",
          persistence: config.PERSISTENCE_DRIVER,
          documentEncryption: Boolean(config.DOCUMENT_ENCRYPTION_KEY),
        },
        meta: {},
        requestId: request.id,
      };
    },
  );
  app.get("/api/v1/meta", async (request) => ({
    data: {
      name: "Agent Contract & Insurance Gap Engine",
      version: "0.1.0",
      engineVersion: "gap-engine@1.0.0",
      primaryStatement:
        "Identify where an AI agent’s actual authority may exceed what your contracts and insurance policies clearly contemplate.",
      deterministicByDefault: true,
      externalAiRequired: false,
      jurisdictionPacks: JURISDICTION_PACKS.map((pack) => ({
        id: pack.id,
        countryCode: pack.countryCode,
        status: pack.status,
        version: pack.version,
      })),
      disclaimer: CANONICAL_DISCLAIMER,
    },
    meta: {},
    requestId: request.id,
  }));
  // Public, read-only: the plans a workspace can buy (the same PLANS the checkout uses), so the sign-in
  // screen and the main app can show prices before anyone signs up.
  app.get("/api/v1/plans", async () => ({ data: { plans: Object.values(PLANS), upgradeWhere: "Console, Settings, Plan & billing" } }));
  // The website's price buttons: straight to Dodo checkout, no account needed.
  app.get("/buy/:plan", async (request, reply) => {
    const { plan } = request.params as { plan: string };
    if (plan !== "team" && plan !== "business") return reply.redirect("/console");
    try {
      return reply.redirect(await app.billing.guestCheckout(plan, "https://rootsystems.app/pricing#agent-governance"));
    } catch {
      return reply.redirect("/console");
    }
  });
  app.get("/api/v1/openapi.json", async (_request, reply) => reply.send(app.swagger()));

  await app.register(uiRoutes);
  await app.register(governanceRoutes, { prefix: "/api/v1/governance" });
  await app.register(oauthRoutes, { prefix: "/api/v1/oauth", config });

  await app.register(authRoutes, { prefix: "/api/v1/auth" });
  await app.register(organizationRoutes, { prefix: "/api/v1/organizations" });
  await app.register(jurisdictionRoutes, { prefix: "/api/v1" });
  await app.register(projectRoutes, { prefix: "/api/v1/projects" });
  await app.register(projectAgentRoutes, { prefix: "/api/v1/projects" });
  await app.register(agentRoutes, { prefix: "/api/v1/agents" });
  await app.register(projectDocumentRoutes, { prefix: "/api/v1/projects" });
  await app.register(documentRoutes, { prefix: "/api/v1/documents" });
  await app.register(projectAnalysisRoutes, { prefix: "/api/v1/projects" });
  await app.register(analysisRoutes, { prefix: "/api/v1/analyses" });
  await app.register(findingRoutes, { prefix: "/api/v1/findings" });
  await app.register(auditRoutes, { prefix: "/api/v1/projects" });
  await app.register(consoleRoutes, { prefix: "/api/v1/console" });
  await app.register(billingWebhookRoutes, { prefix: "/api/v1/billing" });

  return app;
}
