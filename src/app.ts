import { mkdir } from "node:fs/promises";
import path from "node:path";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import jwt from "@fastify/jwt";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { auditRoutes } from "./api/audit-routes.js";
import { agentRoutes, projectAgentRoutes } from "./api/agent-routes.js";
import { analysisRoutes, projectAnalysisRoutes } from "./api/analysis-routes.js";
import { authRoutes } from "./api/auth-routes.js";
import { documentRoutes, projectDocumentRoutes } from "./api/document-routes.js";
import { findingRoutes } from "./api/finding-routes.js";
import { jurisdictionRoutes } from "./api/jurisdiction-routes.js";
import { organizationRoutes } from "./api/organization-routes.js";
import { projectRoutes } from "./api/project-routes.js";
import { loadConfig, type AppConfig } from "./config/env.js";
import { DocumentService } from "./documents/document-service.js";
import { LocalDocumentStorage, type DocumentStorage } from "./documents/storage.js";
import { JURISDICTION_PACKS } from "./jurisdictions/packs.js";
import { MemoryStore } from "./persistence/memory-store.js";
import { PrismaStore } from "./persistence/prisma-store.js";
import type { Store } from "./persistence/store.js";
import type { Role } from "./domain/types.js";
import { CANONICAL_DISCLAIMER } from "./shared/disclaimer.js";
import { AppError, unauthorized } from "./shared/errors.js";

export interface BuildAppOptions {
  config?: AppConfig;
  store?: Store;
  storage?: DocumentStorage;
  logger?: boolean;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig();
  const store =
    options.store ??
    (config.PERSISTENCE_DRIVER === "postgres" ? new PrismaStore() : new MemoryStore());
  const storage =
    options.storage ?? new LocalDocumentStorage(path.resolve(config.UPLOAD_DIRECTORY));
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
  app.decorate("documentService", new DocumentService(store, storage, config));
  app.decorateRequest("actor", null);

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin(origin, callback) {
      if (!origin || config.corsOrigins.includes(origin)) callback(null, true);
      else
        callback(
          new AppError(403, "CORS_ORIGIN_DENIED", "The request origin is not allowed."),
          false,
        );
    },
    credentials: false,
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

  app.addHook("onClose", async () => {
    if (store instanceof PrismaStore) await store.disconnect();
  });

  app.get(
    "/health",
    { schema: { tags: ["system"], summary: "Liveness check" } },
    async (request) => ({ data: { status: "ok" }, meta: {}, requestId: request.id }),
  );
  app.get(
    "/ready",
    { schema: { tags: ["system"], summary: "Readiness check" } },
    async (request) => {
      await mkdir(path.resolve(config.UPLOAD_DIRECTORY), { recursive: true });
      await store.ready();
      return {
        data: { status: "ready", persistence: config.PERSISTENCE_DRIVER },
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
  app.get("/api/v1/openapi.json", async (_request, reply) => reply.send(app.swagger()));

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
    if (statusCode >= 500) request.log.error({ err: error }, "request failed");
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

  return app;
}
