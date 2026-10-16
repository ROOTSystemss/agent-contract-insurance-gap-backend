import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import { MemoryStore } from "../src/persistence/memory-store.js";

// The Oct 16 QA fixes: plans visible before sign-in, a readable error for a badly formatted
// state code, one set of product names, and step labels that do not clash with the journey strip.
describe("QA fixes (Oct 16)", () => {
  let app: FastifyInstance;
  let uploadDirectory: string;

  beforeAll(async () => {
    uploadDirectory = await mkdtemp(path.join(tmpdir(), "gap-qa16-"));
    const config = loadConfig({
      NODE_ENV: "test",
      JWT_SECRET: "test-secret-with-at-least-thirty-two-characters",
      UPLOAD_DIRECTORY: uploadDirectory,
      LOG_LEVEL: "silent",
      PERSISTENCE_DRIVER: "memory",
    });
    app = await buildApp({ config, store: new MemoryStore(), logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await rm(uploadDirectory, { recursive: true, force: true });
  });

  it("lists the plans without signing in", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/plans" });
    expect(response.statusCode).toBe(200);
    const plans = (JSON.parse(response.body) as { data: { plans: unknown[] } }).data.plans;
    expect(plans.length).toBeGreaterThan(0);
  });

  it("explains a badly formatted state code in plain words", async () => {
    const registered = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email: "qa16@example.test", name: "QA Person", organizationName: "QA Fictional Ltd", password: "Correct Horse Battery 123!" },
    });
    const token = (JSON.parse(registered.body) as { data: { accessToken: string } }).data.accessToken;
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Bad code", primaryCountryCode: "US", primarySubdivisionCode: "Illinois", affectedCountryCodes: [] },
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain("like US-IL");
  });

  it("uses one set of product names and clear step labels", async () => {
    const pub = path.join(__dirname, "..", "public");
    const files = await Promise.all(["app.js", "authority.js", "authorize.js", "console.js", "index.html", "authorize.html"].map((f) => readFile(path.join(pub, f), "utf8")));
    const all = files.join("\n");
    expect(all).not.toMatch(/Authority Atlas|Import it in AI Governance|Trust Proof will record/);
    expect(all).not.toMatch(/"Step [123] of 3"/);
    expect(files[0]).toContain("Save and add evidence →");
    expect(files[4]).toContain("<title>AI Agent Trust — RootSystems</title>");
  });
});
