import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/env.js";

const productionBase = {
  NODE_ENV: "production",
  JWT_SECRET: "production-jwt-value-with-more-than-thirty-two-random-characters",
  PERSISTENCE_DRIVER: "postgres",
  DATABASE_URL: "postgresql://service:password@database:5432/authority_atlas",
  ATLAS_OAUTH_CLIENT_SECRET: "production-oauth-value-with-more-than-thirty-two-characters",
  ATLAS_OAUTH_REDIRECT_URIS: "https://readiness.example.com/auth/atlas/callback",
};

describe("configuration security", () => {
  it("rejects production without document encryption", () => {
    expect(() => loadConfig(productionBase)).toThrow("encrypted document storage");
  });

  it("accepts a valid 256-bit document encryption key", () => {
    const config = loadConfig({
      ...productionBase,
      DOCUMENT_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString("base64"),
    });
    expect(Buffer.from(config.DOCUMENT_ENCRYPTION_KEY!, "base64")).toHaveLength(32);
  });

  it("rejects malformed encryption keys", () => {
    expect(() =>
      loadConfig({ ...productionBase, DOCUMENT_ENCRYPTION_KEY: "not-a-valid-key" }),
    ).toThrow("base64-encoded 32-byte key");
  });

  const validEncryption = { DOCUMENT_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString("base64") };

  it("rejects a placeholder ATLAS_OAUTH_CLIENT_SECRET in production", () => {
    expect(() =>
      loadConfig({
        ...productionBase,
        ...validEncryption,
        ATLAS_OAUTH_CLIENT_SECRET: "replace-me",
      }),
    ).toThrow("ATLAS_OAUTH_CLIENT_SECRET");
  });

  it("rejects a non-HTTPS ATLAS_OAUTH_REDIRECT_URIS entry in production", () => {
    expect(() =>
      loadConfig({
        ...productionBase,
        ...validEncryption,
        ATLAS_OAUTH_REDIRECT_URIS: "http://readiness.example.com/auth/atlas/callback",
      }),
    ).toThrow("ATLAS_OAUTH_REDIRECT_URIS");
  });

  it("accepts a valid production ATLAS_OAUTH configuration", () => {
    const config = loadConfig({ ...productionBase, ...validEncryption });
    expect(config.atlasOAuthRedirectUris).toEqual([
      "https://readiness.example.com/auth/atlas/callback",
    ]);
  });
});
