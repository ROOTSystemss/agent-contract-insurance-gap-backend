import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import { MemoryStore } from "../src/persistence/memory-store.js";
import { governanceFakes } from "./governance-fakes.js";

// QA 2026-11-18 F21: Trust Proof accepts a certificate only from the Atlas issuer a workspace has linked. The console
// links its own Atlas identity (by that identity's token) to its Trust Proof organization: on activation, on the
// next certificate list or issue if that failed, and for every already-activated workspace after a restart.

type Res = { statusCode: number; payload: string };
const data = <T>(res: Res) => (JSON.parse(res.payload) as { data: T }).data;

describe("F21: the console links its Atlas issuer to its Trust Proof organization", () => {
  let app: FastifyInstance;
  const store = new MemoryStore();
  const fakes = governanceFakes();
  let ownerToken: string;
  let otherToken: string;
  const call = (method: string, url: string, token: string, payload?: unknown) =>
    app.inject({ method: method as "GET", url, headers: { authorization: `Bearer ${token}` }, ...(payload === undefined ? {} : { payload: payload as object }) });

  beforeAll(async () => {
    const config = loadConfig({ NODE_ENV: "test", JWT_SECRET: "test-secret-with-at-least-thirty-two-characters", LOG_LEVEL: "silent", PERSISTENCE_DRIVER: "memory", PQ_SIGNING_SEED: Buffer.alloc(32, 41).toString("base64") });
    app = await buildApp({ config, store, logger: false, governance: { atlasUrl: "https://atlas.test", trustProofUrl: "https://tp.test", fetchImpl: fakes.fetchImpl } });
    const register = async (email: string) =>
      data<{ accessToken: string }>(await app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { email, name: "Issuer Link", organizationName: "Issuer Org " + email, password: "Correct Horse Battery 123!" } })).accessToken;
    ownerToken = await register("issuer-owner@example.com");
    otherToken = await register("issuer-other@example.com");
  });
  afterAll(async () => {
    await app.close();
  });

  it("activation links the issuer with the workspace's own Atlas identity token and Trust Proof key", async () => {
    const res = await call("POST", "/api/v1/console/link", ownerToken, {});
    expect(res.statusCode).toBe(200);
    expect(data<{ issuerLinked: boolean }>(res).issuerLinked).toBe(true);
    expect(fakes.issuerLinks).toHaveLength(1);
    expect(fakes.issuerLinks[0]).toEqual({ apiKey: "Bearer rs_test_key", identityToken: "atlas-token" });
    // once linked, not asked again in this process
    await call("GET", "/api/v1/console/certificates", ownerToken);
    expect(fakes.issuerLinks).toHaveLength(1);
  });

  it("a failed link does not break the console; the next certificate list retries it", async () => {
    fakes.state.issuerLinkFails = true;
    const res = await call("POST", "/api/v1/console/link", otherToken, {});
    expect(res.statusCode).toBe(200);
    expect(data<{ issuerLinked: boolean }>(res).issuerLinked).toBe(false);
    expect((await call("GET", "/api/v1/console/certificates", otherToken)).statusCode).toBe(200);
    expect(fakes.issuerLinks).toHaveLength(1);
    fakes.state.issuerLinkFails = false;
    await call("GET", "/api/v1/console/certificates", otherToken);
    expect(fakes.issuerLinks).toHaveLength(2);
  });

  it("the restart backfill links every activated workspace (and is cheap when already linked)", async () => {
    const ids = await store.listServiceLinkOrganizationIds();
    expect(ids.length).toBe(2);
    const organizations = (await Promise.all(ids.map((id) => store.getOrganization(id)))).filter((o) => o !== null);
    expect(await app.governance.linkAllIssuers(organizations)).toEqual({ linked: 2, failed: 0 });
    expect(fakes.issuerLinks).toHaveLength(2);
  });
});
