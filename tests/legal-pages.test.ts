import { readFileSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import { MemoryStore } from "../src/persistence/memory-store.js";

// Live QA 2026-11-02 D2: /terms, /privacy and /refund were 404. They now go to the company policies, and
// every public page links them in its footer. D1: the console's activation error stays on the page.
describe("legal pages and footer (D2)", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    const config = loadConfig({ NODE_ENV: "test", JWT_SECRET: "test-secret-with-at-least-thirty-two-characters", LOG_LEVEL: "silent", PERSISTENCE_DRIVER: "memory" });
    app = await buildApp({ config, store: new MemoryStore(), logger: false });
  });
  afterAll(async () => { await app.close(); });

  for (const page of ["terms", "privacy", "refund"]) {
    it(`/${page} redirects to rootsystems.app/${page}`, async () => {
      const response = await app.inject({ method: "GET", url: `/${page}` });
      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe(`https://rootsystems.app/${page}`);
    });
  }

  it("the landing, console and authorize pages link Terms, Privacy and Refunds", () => {
    for (const file of ["index.html", "console.html", "authorize.html"]) {
      const html = readFileSync(path.join(__dirname, "..", "public", file), "utf8");
      for (const href of ["/terms", "/privacy", "/refund"]) expect(html, file).toContain(`href="${href}"`);
    }
  });

  it("D1: a failed activation shows a lasting error with a Try again button", () => {
    const js = readFileSync(path.join(__dirname, "..", "public", "console.js"), "utf8");
    expect(js).toContain('id: "activate-error", role: "alert"');
    expect(js).toContain('id: "activate-retry"');
    expect(js).toContain("errBox.hidden = false");
  });
});
