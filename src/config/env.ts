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
    MAX_FILE_SIZE_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(10 * 1024 * 1024),
    DOCUMENT_RETENTION_DAYS: z.coerce.number().int().min(1).default(30),
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
    RATE_LIMIT_WINDOW: z.string().default("1 minute"),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    TRUST_PROXY: booleanFromString,
  })
  .superRefine((env, context) => {
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
    }
  });

export type AppConfig = z.infer<typeof envSchema> & { corsOrigins: string[] };

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(source);
  return {
    ...parsed,
    corsOrigins: parsed.CORS_ORIGINS.split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  };
}
