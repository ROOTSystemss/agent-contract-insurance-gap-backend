import { z } from "zod";

const booleanFromString = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    HOST: z.string().default("0.0.0.0"),
    PORT: z.coerce.number().int().min(1).max(65535).default(4400),
    DATABASE_URL: z.string().optional(),
    JWT_SECRET: z.string().default("development-only-secret-change-before-production"),
    JWT_EXPIRES_IN: z.string().default("1h"),
    CORS_ORIGINS: z.string().default("http://localhost:3000"),
    PERSISTENCE_DRIVER: z.enum(["memory", "postgres"]).default("memory"),
    UPLOAD_DIRECTORY: z.string().default("./uploads"),
    DOCUMENT_ENCRYPTION_KEY: z
      .string()
      .refine(
        (value) => /^[A-Za-z0-9+/]{43}=$/.test(value) && Buffer.from(value, "base64").length === 32,
        {
          message: "DOCUMENT_ENCRYPTION_KEY must be a base64-encoded 32-byte key.",
        },
      )
      .optional(),
    MAX_FILE_SIZE_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(10 * 1024 * 1024),
    DOCUMENT_RETENTION_DAYS: z.coerce.number().int().min(1).default(30),
    RETENTION_SWEEP_INTERVAL_MS: z.coerce.number().int().min(60_000).default(3_600_000),
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
    RATE_LIMIT_WINDOW: z.string().default("1 minute"),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    TRUST_PROXY: booleanFromString,
    // Minimal single-client OAuth2-authorization-code IdP config for "Sign in with
    // Authority Atlas" on AI Compliance Readiness. Readiness is the only registered
    // client — no dynamic client registration — so a static shared secret configured
    // identically on both sides is the whole trust model (same pattern as ATLAS_URL
    // on the Readiness side).
    ATLAS_OAUTH_CLIENT_ID: z.string().default("ai-compliance-readiness"),
    ATLAS_OAUTH_CLIENT_SECRET: z
      .string()
      .default("development-only-oauth-secret-change-before-production"),
    ATLAS_OAUTH_REDIRECT_URIS: z.string().default("http://localhost:4605/auth/atlas/callback"),
    ATLAS_OAUTH_CODE_TTL_MS: z.coerce.number().int().min(15_000).max(300_000).default(60_000),
    // Base URL of the Authority Atlas service that issues and verifies agent authority certificates
    // (not this app's own sign-in bridge above). Optional: without it, certificate checks answer 503.
    AUTHORITY_ATLAS_URL: z.string().url().optional(),
    // Base URL of Trust Proof, which checks and records agent actions. With AUTHORITY_ATLAS_URL it
    // enables the Agent Governance console (/console); without both, console calls answer 503.
    TRUST_PROOF_URL: z.string().url().optional(),
    // Shared with Authority Atlas and Trust Proof (same value on all three): lets the console create one
    // identity/organization per workspace from this single server without hitting per-IP signup limits.
    CONSOLE_SERVICE_TOKEN: z.string().min(32).optional(),
    // Agent Governance console billing (Dodo Payments). Without the key and both product ids, the
    // console runs on the free trial plan only and checkout answers 503.
    DODO_PAYMENTS_API_KEY: z.string().optional(),
    DODO_ENVIRONMENT: z.enum(["live_mode", "test_mode"]).default("test_mode"),
    DODO_PAYMENTS_WEBHOOK_KEY: z.string().optional(),
    DODO_PRODUCT_ID_TEAM: z.string().optional(),
    DODO_PRODUCT_ID_BUSINESS: z.string().optional(),
    // Public address of this service, used for the checkout return link.
    PUBLIC_BASE_URL: z.string().url().default("http://localhost:4400"),
    // 32 random bytes, base64: the ML-DSA-65 key that signs Assurance Packs. Optional; without it packs
    // are not signed and say so. Never change it once set (the published key would change).
    PQ_SIGNING_SEED: z.string().optional(),
  })
  .superRefine((env, context) => {
    if (env.PQ_SIGNING_SEED && Buffer.from(env.PQ_SIGNING_SEED, "base64").length !== 32) {
      context.addIssue({ code: "custom", path: ["PQ_SIGNING_SEED"], message: "PQ_SIGNING_SEED must be 32 random bytes, base64-encoded." });
    }
    if (env.NODE_ENV === "production") {
      if (env.JWT_SECRET.length < 32 || /development|replace|secret/i.test(env.JWT_SECRET)) {
        context.addIssue({
          code: "custom",
          path: ["JWT_SECRET"],
          message:
            "Production JWT_SECRET must be at least 32 characters and must not be a placeholder.",
        });
      }
      if (env.PERSISTENCE_DRIVER !== "postgres" || !env.DATABASE_URL) {
        context.addIssue({
          code: "custom",
          path: ["DATABASE_URL"],
          message: "Production requires PostgreSQL persistence and DATABASE_URL.",
        });
      }
      if (!env.DOCUMENT_ENCRYPTION_KEY) {
        context.addIssue({
          code: "custom",
          path: ["DOCUMENT_ENCRYPTION_KEY"],
          message: "Production requires encrypted document storage and encrypted customer data in the database.",
        });
      }
      if (
        env.ATLAS_OAUTH_CLIENT_SECRET.length < 32 ||
        /development|replace|secret/i.test(env.ATLAS_OAUTH_CLIENT_SECRET)
      ) {
        context.addIssue({
          code: "custom",
          path: ["ATLAS_OAUTH_CLIENT_SECRET"],
          message:
            "Production ATLAS_OAUTH_CLIENT_SECRET must be at least 32 characters and must not be a placeholder.",
        });
      }
      if (env.AUTHORITY_ATLAS_URL && !env.AUTHORITY_ATLAS_URL.startsWith("https://")) {
        context.addIssue({
          code: "custom",
          path: ["AUTHORITY_ATLAS_URL"],
          message: "Production AUTHORITY_ATLAS_URL must be https://.",
        });
      }
      for (const uri of env.ATLAS_OAUTH_REDIRECT_URIS.split(",").map((value) => value.trim())) {
        if (uri && !uri.startsWith("https://")) {
          context.addIssue({
            code: "custom",
            path: ["ATLAS_OAUTH_REDIRECT_URIS"],
            message: `Production ATLAS_OAUTH_REDIRECT_URIS entries must be https:// — got "${uri}".`,
          });
        }
      }
    }
  });

export type AppConfig = z.infer<typeof envSchema> & {
  corsOrigins: string[];
  atlasOAuthRedirectUris: string[];
};

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(source);
  return {
    ...parsed,
    corsOrigins: parsed.CORS_ORIGINS.split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
    atlasOAuthRedirectUris: parsed.ATLAS_OAUTH_REDIRECT_URIS.split(",")
      .map((uri) => uri.trim())
      .filter(Boolean),
  };
}
