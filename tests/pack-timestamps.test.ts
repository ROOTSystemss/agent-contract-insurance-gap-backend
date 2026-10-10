import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import { createPqSigner } from "../src/crypto/pq-sign.js";
import { buildRequest } from "../src/crypto/tsa.js";
import { MemoryStore } from "../src/persistence/memory-store.js";
import { timestampPack, verifyPackTimestamps } from "../src/reports/pack-timestamps.js";
import { TRUNK_FEATURES } from "../src/governance/trunk.js";
import { agentInput } from "./helpers.js";

const HASH = "a".repeat(64);

// RootSystems Trunk: two independent timestamps on Assurance Packs.
describe("pack timestamps (logic)", () => {
  it("asks for both timestamps when enabled and reports what came back", async () => {
    const out = await timestampPack(
      HASH,
      { FEATURE_RFC3161: "1" },
      {
        rfc3161: async (h, url) => ({
          tokenBase64: "dG9rZW4=",
          genTime: "2026-10-10T00:00:00.000Z",
          tsa: url,
          nonceHex: h.slice(0, 4),
        }),
        ots: async () => "b3Rz",
      },
    );
    expect(out.rfc3161?.tsa).toBe("http://timestamp.digicert.com");
    expect(out.openTimestamps).toEqual({ proofBase64: "b3Rz", status: "pending" });
    expect(out.covers).toBe("contentHash");
    expect(out.errors).toEqual([]);
  });

  it("never throws: a failing authority is reported, the other timestamp still arrives", async () => {
    const out = await timestampPack(
      HASH,
      { FEATURE_RFC3161: "1" },
      {
        rfc3161: async () => {
          throw new Error("TSA answered HTTP 503");
        },
        ots: async () => "b3Rz",
      },
    );
    expect(out.rfc3161).toBeNull();
    expect(out.openTimestamps?.proofBase64).toBe("b3Rz");
    expect(out.errors).toEqual(["rfc3161: TSA answered HTTP 503"]);
  });

  it("RFC 3161 is off unless FEATURE_RFC3161=1, OpenTimestamps is on unless FEATURE_OTS=0", async () => {
    let calls = 0;
    const deps = {
      rfc3161: async () => {
        calls++;
        throw new Error("x");
      },
      ots: async () => {
        calls++;
        return "b3Rz";
      },
    };
    expect((await timestampPack(HASH, { FEATURE_OTS: "0" }, deps)).openTimestamps).toBeNull();
    expect(calls).toBe(0);
  });

  it("builds a well-formed RFC 3161 request for a SHA-256 digest", () => {
    const { der, nonceHex } = buildRequest(HASH, Buffer.from("0102030405060708", "hex"));
    expect(der[0]).toBe(0x30);
    expect(der.toString("hex")).toContain(HASH);
    expect(nonceHex).toBe("0102030405060708");
    expect(() => buildRequest("abc")).toThrow(/SHA-256/);
  });

  it("garbage timestamps do not verify", () => {
    const result = verifyPackTimestamps(HASH, {
      rfc3161: { tokenBase64: "AAAA" },
      openTimestamps: { proofBase64: "AAAA" },
    });
    expect(result.rfc3161).toMatchObject({ valid: false });
    expect(result.openTimestamps).toBe("does_not_match");
    expect(verifyPackTimestamps(HASH, undefined)).toEqual({
      rfc3161: "not_supplied",
      openTimestamps: "not_supplied",
    });
  });

  it("the Trunk panel lists two timestamps as live only where FEATURE_RFC3161=1", () => {
    const saved = process.env.FEATURE_RFC3161;
    const feature = TRUNK_FEATURES.find((f) => f.id === "two-timestamps");
    process.env.FEATURE_RFC3161 = "";
    expect(feature?.status).toBe("by-hand");
    process.env.FEATURE_RFC3161 = "1";
    expect(feature?.status).toBe("live");
    process.env.FEATURE_RFC3161 = saved;
  });
});

// Real network: DigiCert's public TSA and the OpenTimestamps calendars. Run with LIVE_TIMESTAMP_TESTS=1.
describe.runIf(process.env.LIVE_TIMESTAMP_TESTS === "1")(
  "pack timestamps (live, real authorities)",
  () => {
    let dir: string;
    const saved = { trunk: process.env.TRUNK_ORGANIZATION_IDS, rfc: process.env.FEATURE_RFC3161 };
    beforeAll(async () => {
      dir = await mkdtemp(path.join(tmpdir(), "pack-ts-"));
    });
    afterAll(async () => {
      process.env.TRUNK_ORGANIZATION_IDS = saved.trunk;
      process.env.FEATURE_RFC3161 = saved.rfc;
      await rm(dir, { recursive: true, force: true });
    });

    it("a Trunk workspace's pack carries two timestamps that verify; others carry none", async () => {
      const app = await buildApp({
        config: loadConfig({
          NODE_ENV: "test",
          JWT_SECRET: "test-secret-with-at-least-thirty-two-characters",
          UPLOAD_DIRECTORY: dir,
          LOG_LEVEL: "silent",
          PERSISTENCE_DRIVER: "memory",
        }),
        store: new MemoryStore(),
        logger: false,
        certificateVerifier: null,
        pqSigner: createPqSigner(Buffer.alloc(32, 73).toString("base64")),
      });
      await app.ready();
      const api = (method: "GET" | "POST", url: string, auth: string | null, payload?: object) =>
        app.inject({
          method,
          url,
          headers: auth ? { authorization: `Bearer ${auth}` } : {},
          payload,
        });
      const json = <T>(r: { payload: string }) => JSON.parse(r.payload) as T;
      const packFor = async (email: string) => {
        const reg = json<{ data: { accessToken: string; organization: { id: string } } }>(
          await api("POST", "/api/v1/auth/register", null, {
            email,
            name: "TS Tester",
            organizationName: "TS Fictional Ltd",
            password: "Correct Horse Battery 123!",
          }),
        ).data;
        const token = reg.accessToken;
        const projectId = json<{ data: { id: string } }>(
          await api("POST", "/api/v1/projects", token, {
            name: "TS Project",
            description: "Fictional",
            primaryCountryCode: "US",
            primarySubdivisionCode: "US-IL",
            affectedCountryCodes: ["CA"],
          }),
        ).data.id;
        const agentId = json<{ data: { id: string } }>(
          await api("POST", `/api/v1/projects/${projectId}/agents`, token, agentInput({})),
        ).data.id;
        const analysisId = json<{ data: { id: string } }>(
          await api("POST", `/api/v1/projects/${projectId}/analyses`, token, {
            agentProfileId: agentId,
            documentIds: [],
          }),
        ).data.id;
        await api("POST", `/api/v1/analyses/${analysisId}/run`, token, {});
        return { orgId: reg.organization.id, token, analysisId };
      };

      const trunkOrg = await packFor(`ts${Math.random()}@example.test`);
      process.env.TRUNK_ORGANIZATION_IDS = trunkOrg.orgId;
      process.env.FEATURE_RFC3161 = "1";
      type Built = {
        pack: Record<string, unknown>;
        contentHash: string;
        timestamps: {
          rfc3161: { tokenBase64: string; tsa: string } | null;
          openTimestamps: { proofBase64: string } | null;
          errors: string[];
        } | null;
      };
      const built = json<{ data: Built }>(
        await api(
          "POST",
          `/api/v1/analyses/${trunkOrg.analysisId}/assurance-pack`,
          trunkOrg.token,
          {},
        ),
      ).data;
      expect(built.timestamps?.errors).toEqual([]);
      expect(built.timestamps?.rfc3161?.tsa).toBe("http://timestamp.digicert.com");
      expect(built.timestamps?.openTimestamps?.proofBase64).toBeTruthy();

      const verified = json<{
        data: {
          valid: boolean;
          timestamps: { rfc3161: { valid: boolean; genTime: string }; openTimestamps: string };
        };
      }>(
        await api("POST", "/api/v1/analyses/assurance-pack/verify", trunkOrg.token, {
          pack: built.pack,
          contentHash: built.contentHash,
          timestamps: built.timestamps,
        }),
      ).data;
      expect(verified.valid).toBe(true);
      expect(verified.timestamps.rfc3161.valid).toBe(true);
      expect(verified.timestamps.openTimestamps).toBe("commits_to_this_pack");

      // An edited pack: its recomputed hash no longer matches what was timestamped.
      const edited = { ...built.pack, project: "Edited" };
      const tampered = json<{
        data: {
          valid: boolean;
          timestamps: { rfc3161: { valid: boolean }; openTimestamps: string };
        };
      }>(
        await api("POST", "/api/v1/analyses/assurance-pack/verify", trunkOrg.token, {
          pack: edited,
          contentHash: built.contentHash,
          timestamps: built.timestamps,
        }),
      ).data;
      expect(tampered.valid).toBe(false);
      expect(tampered.timestamps.rfc3161.valid).toBe(false);
      expect(tampered.timestamps.openTimestamps).toBe("does_not_match");

      const plain = await packFor(`tsplain${Math.random()}@example.test`);
      const plainBuilt = json<{ data: Built }>(
        await api("POST", `/api/v1/analyses/${plain.analysisId}/assurance-pack`, plain.token, {}),
      ).data;
      expect(plainBuilt.timestamps).toBeNull();
      await app.close();
    }, 90000);
  },
);
