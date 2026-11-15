import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { CertificateVerifier } from "../src/authority/certificate.js";
import { loadConfig } from "../src/config/env.js";
import { createPqSigner } from "../src/crypto/pq-sign.js";
import { MemoryStore } from "../src/persistence/memory-store.js";
import { agentInput } from "./helpers.js";

// The public /verify page is checked by running its real inline script (the HTML the server sends)
// against a minimal DOM, with fetch routed into the app. QA 2026-11-14 C1: the old script did not parse
// (a duplicated `const out`), read a file input the page did not have, and never read the certificate box.

const GOOD_CERT = "eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.eyJ0eXBlIjoiYWdlbnRfYXV0aG9yaXR5In0.R29vZFNpZ25hdHVyZVZhbHVl";
const HOSTILE_CERT = GOOD_CERT.replace("R29v", "SG9z");
const summary = (agentName: string) => ({ agentId: "payables-bot", agentName, organization: "Fictional Payables Ltd", organizationVerified: false, permissions: ["invoices:read", "invoices:pay"], limits: { maxAmountUsd: 500 }, issuedAt: "2026-11-14T00:00:00.000Z", expiresAt: "2026-12-14T00:00:00.000Z" });
const verifier: CertificateVerifier = async (certificate) =>
  certificate === GOOD_CERT ? { ok: true, certificate: summary("Payables Bot") }
  : certificate === HOSTILE_CERT ? { ok: true, certificate: summary('<img src=x onerror="alert(1)">') }
  : { ok: false, reason: "bad_signature" };

interface FakeElement {
  id: string;
  value: string;
  files: Array<{ text: () => Promise<string> }>;
  hidden: boolean;
  textContent: string;
  innerHTML: string;
  disabled: boolean;
  listeners: Record<string, (event: { preventDefault: () => void }) => unknown>;
  addEventListener: (type: string, listener: (event: { preventDefault: () => void }) => unknown) => void;
}

function pageScript(html: string): string {
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!match) throw new Error("no inline script on the page");
  return match[1]!;
}

function mountPage(html: string, app: FastifyInstance) {
  const elements: Record<string, FakeElement> = {};
  for (const [, id] of html.matchAll(/\bid="([^"]+)"/g)) {
    elements[id!] = {
      id: id!, value: "", files: [], hidden: true, textContent: "", innerHTML: "", disabled: false, listeners: {},
      addEventListener(type, listener) { this.listeners[type] = listener; },
    };
  }
  const fetchImpl = async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
    const response = await app.inject({ method: init.method as "POST", url, headers: init.headers, payload: init.body });
    return { status: response.statusCode, json: async () => JSON.parse(response.body) as unknown };
  };
  const context = vm.createContext({ document: { getElementById: (id: string) => elements[id] ?? null }, fetch: fetchImpl });
  new vm.Script(pageScript(html)).runInContext(context);
  const submit = async (): Promise<string> => {
    elements.out!.innerHTML = "";
    elements.check!.listeners.submit!({ preventDefault() {} });
    for (let i = 0; i < 400 && (elements.out!.innerHTML === "" || elements.go!.disabled); i++) await new Promise((resolve) => setTimeout(resolve, 5));
    return elements.out!.innerHTML;
  };
  const choose = (contents: string) => { elements.file!.files = [{ text: async () => contents }]; };
  return { elements, submit, choose };
}

describe("public /verify page (QA 2026-11-14 C1)", () => {
  let dir: string;
  let app: FastifyInstance;
  let html: string;
  let built: { pack: Record<string, unknown>; contentHash: string; signature: { value?: string; publicKey?: string } };

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "gap-verify-page-"));
    app = await buildApp({
      config: loadConfig({ NODE_ENV: "test", JWT_SECRET: "test-secret-with-at-least-thirty-two-characters", UPLOAD_DIRECTORY: dir, LOG_LEVEL: "silent", PERSISTENCE_DRIVER: "memory" }),
      store: new MemoryStore(), logger: false, certificateVerifier: verifier, pqSigner: createPqSigner(Buffer.alloc(32, 73).toString("base64")),
    });
    await app.ready();
    html = (await app.inject({ method: "GET", url: "/verify" })).body;

    const api = (method: "POST", url: string, token: string | null, payload?: object) =>
      app.inject({ method, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload });
    const data = <T>(r: { body: string }) => (JSON.parse(r.body) as { data: T }).data;
    const token = data<{ accessToken: string }>(await api("POST", "/api/v1/auth/register", null, { email: "verify-page@example.test", name: "Verify Page", organizationName: "Fictional Verify Ltd", password: "Correct Horse Battery 123!" })).accessToken;
    const projectId = data<{ id: string }>(await api("POST", "/api/v1/projects", token, { name: "Verify Page Project", description: "Fictional", primaryCountryCode: "US", primarySubdivisionCode: "US-IL", affectedCountryCodes: ["CA"] })).id;
    const agentId = data<{ id: string }>(await api("POST", `/api/v1/projects/${projectId}/agents`, token, agentInput({}))).id;
    const analysisId = data<{ id: string }>(await api("POST", `/api/v1/projects/${projectId}/analyses`, token, { agentProfileId: agentId, documentIds: [] })).id;
    await api("POST", `/api/v1/analyses/${analysisId}/run`, token, {});
    built = data(await api("POST", `/api/v1/analyses/${analysisId}/assurance-pack`, token, {}));
  });
  afterAll(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("serves a script that parses", () => {
    expect(() => new vm.Script(pageScript(html))).not.toThrow();
  });

  it("only looks up elements that exist on the page, and has both the certificate box and a file input", () => {
    const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
    const used = [...pageScript(html).matchAll(/getElementById\("([^"]+)"\)/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(0);
    for (const id of used) expect(ids.has(id)).toBe(true);
    expect(html).toMatch(/<textarea id="cert"/);
    expect(html).toMatch(/<input id="file"[^>]*type="file"/);
  });

  it("a genuine certificate pasted in the box says PASS", async () => {
    const page = mountPage(html, app);
    page.elements.cert!.value = `  ${GOOD_CERT}\n`;
    const out = await page.submit();
    expect(out).toContain("PASS · Authentic");
    expect(out).toContain("Agent authority certificate");
    expect(out).toContain("Payables Bot");
    expect(out).toContain("not independently verified");
  });

  it("the same certificate with one character changed says FAIL", async () => {
    const page = mountPage(html, app);
    const last = GOOD_CERT.slice(-1);
    page.elements.cert!.value = GOOD_CERT.slice(0, -1) + (last === "e" ? "f" : "e");
    const out = await page.submit();
    expect(out).toContain("FAIL · Not verified");
    expect(out).toContain("bad signature");
    expect(out).not.toContain("PASS");
  });

  it("a genuine signed Assurance Pack file says PASS", async () => {
    expect(built.signature.value).toBeTruthy();
    const page = mountPage(html, app);
    page.choose(JSON.stringify(built));
    const out = await page.submit();
    expect(out).toContain("PASS · Authentic");
    expect(out).toContain("Agent Assurance Pack");
    expect(out).toContain("Signature: valid");
  });

  it("the pack with one character changed says FAIL", async () => {
    const page = mountPage(html, app);
    const project = String(built.pack.project);
    const changed = { ...built, pack: { ...built.pack, project: (project[0] === "X" ? "Y" : "X") + project.slice(1) } };
    page.choose(JSON.stringify(changed));
    const out = await page.submit();
    expect(out).toContain("FAIL · Not verified");
    expect(out).toContain("changed after it was built");
  });

  it("the pack with one character of its signature changed says FAIL", async () => {
    const page = mountPage(html, app);
    const value = built.signature.value!;
    const flipped = value.slice(0, 10) + (value[10] === "A" ? "B" : "A") + value.slice(11);
    page.choose(JSON.stringify({ ...built, signature: { ...built.signature, value: flipped } }));
    const out = await page.submit();
    expect(out).toContain("FAIL · Not verified");
  });

  it("explains a missing input, a non-JSON file and an unrelated JSON file instead of doing nothing", async () => {
    const empty = mountPage(html, app);
    expect(await empty.submit()).toContain("Paste a certificate or choose");
    const notJson = mountPage(html, app);
    notJson.choose("this is not json");
    expect(await notJson.submit()).toContain("not valid JSON");
    const unrelated = mountPage(html, app);
    unrelated.choose(JSON.stringify({ hello: "world" }));
    expect(await unrelated.submit()).toContain("not an Evidence Notary receipt or an Agent Assurance Pack");
  });

  it("escapes what the server returns", async () => {
    const page = mountPage(html, app);
    page.elements.cert!.value = HOSTILE_CERT;
    const out = await page.submit();
    expect(out).toContain("PASS");
    expect(out).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(out).not.toContain("<img");
  });
});
