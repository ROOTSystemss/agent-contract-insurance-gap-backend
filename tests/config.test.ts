import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/env.js";

const productionBase = {
  NODE_ENV: "production",
  JWT_SECRET: "production-jwt-value-with-more-than-thirty-two-random-characters",
  PERSISTENCE_DRIVER: "postgres",
  DATABASE_URL: "postgresql://service:password@database:5432/authority_atlas",
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
});
