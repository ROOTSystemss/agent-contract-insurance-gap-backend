// Real end-to-end proof of the Agent Governance console: starts the actual Authority Atlas, the
// actual Trust Proof and the actual (built) Contract Gap server, then drives the whole Floor 3 chain
// through the console API only: link, issue, verify, act, read the ledger, revoke, isolate tenants.
// Needs `npm run build` first. ATLAS_DIR / TRUST_PROOF_DIR default to the sibling checkouts.
// Run: node scripts/console-e2e.mjs
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ATLAS_DIR = process.env.ATLAS_DIR || path.join(ROOT, "..", "supply-atlas");
const TP_DIR = process.env.TRUST_PROOF_DIR || path.join(ROOT, "..", "accountability-signatures");
const ATLAS_PORT = 4071, TP_PORT = 3911, GAP_PORT = 4471;
const ATLAS = `http://127.0.0.1:${ATLAS_PORT}`, TP = `http://127.0.0.1:${TP_PORT}`, GAP = `http://127.0.0.1:${GAP_PORT}`;
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && detail ? `  [${String(detail).slice(0, 220)}]` : ""}`);
};
const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", {
  namedCurve: "P-256",
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const b64 = (s) => Buffer.from(s).toString("base64");

function start(args, cwd, env, ready) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env: { ...process.env, ...env } });
    let out = "";
    const on = (d) => { out += d; if (ready.test(out)) resolve(child); };
    child.stdout.on("data", on);
    child.stderr.on("data", on);
    child.on("exit", (c) => { if (!ready.test(out)) reject(new Error(`${cwd} exited ${c}: ${out.slice(-400)}`)); });
    setTimeout(() => reject(new Error(`start timeout ${cwd}: ${out.slice(-300)}`)), 40000);
  });
}
const stop = (child) => new Promise((resolve) => { if (!child || child.exitCode !== null) return resolve(); child.once("exit", resolve); child.kill("SIGKILL"); });

async function call(base, method, p, { body, token } = {}) {
  const headers = { Accept: "application/json", Origin: base };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}
async function workspace(name) {
  const r = await call(GAP, "POST", "/api/v1/auth/register", {
    body: { email: `console_${crypto.randomBytes(4).toString("hex")}@example.com`, name: "Console Tester", organizationName: name, password: "Correct Horse Battery 123!" },
  });
  return r.json?.data?.accessToken;
}

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "console-e2e-tp-"));
let atlas, tp, gap;
try {
  atlas = await start(["src/server.js"], ATLAS_DIR, {
    PORT: String(ATLAS_PORT), NODE_ENV: "production", DATABASE_URL: "",
    ATLAS_PRIVATE_KEY_B64: b64(privateKey), ATLAS_PUBLIC_KEY_B64: b64(publicKey),
    PQ_SIGNING_SEED: Buffer.alloc(32, 71).toString("base64"),
  }, /running on/);
  tp = await start(["src/app.js"], TP_DIR, {
    PORT: String(TP_PORT), DATA_DIR, NODE_ENV: "development", ATLAS_URL: ATLAS, APP_URL: TP, DATABASE_URL: "",
    SESSION_SECRET: "console-e2e-secret-not-for-production-use-only", ANCHOR_INTERVAL_MINUTES: "1440",
    PQ_SIGNING_SEED: Buffer.alloc(32, 72).toString("base64"),
    CONNECTOR_API_RATE_LIMIT_PER_MINUTE: "100000", CONNECTOR_API_PREAUTH_RATE_LIMIT_PER_MINUTE: "100000", AGENT_ACTIONS_RATE_LIMIT_PER_MINUTE: "100000",
  }, /listening/);
  gap = await start(["dist/server.js"], ROOT, {
    PORT: String(GAP_PORT), HOST: "127.0.0.1", NODE_ENV: "development", PERSISTENCE_DRIVER: "memory", LOG_LEVEL: "info",
    AUTHORITY_ATLAS_URL: ATLAS, TRUST_PROOF_URL: TP, DATABASE_URL: "",
    DOCUMENT_ENCRYPTION_KEY: crypto.randomBytes(32).toString("base64"),
    JWT_SECRET: "console-e2e-jwt-secret-long-enough-000000", RATE_LIMIT_MAX: "100000",
  }, /listening|Server listening|started/i);

  const a = await workspace("Northwind Robotics");
  const b = await workspace("Other Company");
  check("two workspaces registered", typeof a === "string" && typeof b === "string");

  let r = await call(GAP, "GET", "/api/v1/console/status", { token: a });
  check("status: configured for Atlas and Trust Proof, not yet linked", r.json?.data?.configured?.atlas === true && r.json?.data?.configured?.trustProof === true && r.json?.data?.linked === false, JSON.stringify(r.json));
  r = await call(GAP, "GET", "/api/v1/console/status");
  check("console refuses signed-out callers (401)", r.status === 401, r.status);

  const [l1, l2] = await Promise.all([call(GAP, "POST", "/api/v1/console/link", { token: a }), call(GAP, "POST", "/api/v1/console/link", { token: a })]);
  check("linking works, even with two requests at once", l1.status === 200 && l2.status === 200, `${l1.status} ${JSON.stringify(l1.json).slice(0, 150)}`);
  r = await call(GAP, "GET", "/api/v1/console/status", { token: a });
  check("status now linked", r.json?.data?.linked === true);

  r = await call(GAP, "POST", "/api/v1/console/certificates", {
    token: a, body: { agentId: "pay-bot", agentName: "Payments Bot", permissions: ["invoices:read", "invoices:pay"], limits: { maxAmountUsd: 500 }, expiresInDays: 30 },
  });
  const issued = r.json?.data;
  check("certificate issued through the console (201)", r.status === 201 && typeof issued?.certificate === "string" && typeof issued?.jti === "string", `${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
  check("issued certificate carries the ML-DSA-65 countersignature", typeof issued?.pqSignature?.value === "string");

  r = await call(GAP, "POST", "/api/v1/console/certificates", { token: a, body: { agentId: "bad bot!", agentName: "x", permissions: ["nope nope"] } });
  check("invalid certificate input rejected with a clear message (400)", r.status === 400, r.status);

  r = await call(GAP, "GET", "/api/v1/console/certificates", { token: a });
  const listed = r.json?.data ?? [];
  check("certificate list shows it as active with its permissions", listed.length === 1 && listed[0].status === "active" && listed[0].permissions?.length === 2, JSON.stringify(r.json).slice(0, 200));

  r = await call(GAP, "GET", `/api/v1/console/certificates/${issued.jti}/verify`, { token: a });
  const v = r.json?.data?.verification;
  check("verify: valid, SHA-512 registry binding, post-quantum signature valid", v?.valid === true && v?.assurance?.registryBinding === "sha512" && v?.assurance?.pqSignature === "valid", JSON.stringify(r.json).slice(0, 250));

  r = await call(GAP, "GET", "/api/v1/console/connection", { token: a });
  const apiKey = r.json?.data?.apiKey;
  check("connection details give the agent runtime its Trust Proof key", typeof apiKey === "string" && r.json?.data?.trustProofUrl === TP);
  const act = (body) => call(TP, "POST", "/api/v1/agent-actions", { token: apiKey, body: { certificate: issued.certificate, ...body } });
  r = await act({ action: "invoices:pay", amountUsd: 120, resource: "INV-1001" });
  check("agent action inside its authority is allowed", r.json?.allowed === true, JSON.stringify(r.json).slice(0, 150));
  r = await act({ action: "invoices:pay", amountUsd: 9000, resource: "INV-1002" });
  check("agent action over its limit is blocked", r.json?.allowed === false, JSON.stringify(r.json).slice(0, 150));
  r = await act({ action: "payroll:run" });
  check("agent action outside its permissions is blocked", r.json?.allowed === false);

  r = await call(GAP, "GET", "/api/v1/console/ledger", { token: a });
  check("ledger shows all three actions", r.json?.data?.count === 3 && r.json.data.actions.length === 3, JSON.stringify(r.json).slice(0, 200));
  r = await call(GAP, "GET", "/api/v1/console/ledger?verdict=outside_authority", { token: a });
  check("ledger filter: two blocked actions", r.json?.data?.actions?.length === 2 && r.json.data.actions.every((x) => x.verdict === "outside_authority"));

  r = await call(GAP, "GET", "/api/v1/console/overview", { token: a });
  const o = r.json?.data;
  check("overview: 1 active certificate, 3 actions, 2 blocked", o?.certificates?.active === 1 && o?.ledger?.total === 3 && o?.ledger?.blocked === 2 && o?.latest?.length === 3, JSON.stringify(o).slice(0, 250));

  r = await call(GAP, "GET", "/api/v1/console/ledger/verify", { token: a });
  check("ledger chain verifies and the checkpoint is ML-DSA-65 signed", r.json?.data?.valid === true && r.json?.data?.signature?.algorithm === "ML-DSA-65", JSON.stringify(r.json).slice(0, 200));

  // Tenant isolation
  r = await call(GAP, "GET", "/api/v1/console/certificates", { token: b });
  check("another workspace sees none of these certificates", r.status === 200 && Array.isArray(r.json?.data) && r.json.data.length === 0, JSON.stringify(r.json).slice(0, 150));
  r = await call(GAP, "GET", "/api/v1/console/ledger", { token: b });
  check("another workspace sees none of these actions", r.json?.data?.count === 0);
  r = await call(GAP, "GET", `/api/v1/console/certificates/${issued.jti}/verify`, { token: b });
  check("another workspace cannot open this certificate (404)", r.status === 404, r.status);
  r = await call(GAP, "POST", `/api/v1/console/certificates/${issued.jti}/revoke`, { token: b });
  check("another workspace cannot revoke it (404)", r.status === 404, `${r.status} ${JSON.stringify(r.json).slice(0, 120)}`);

  // Revocation
  r = await call(GAP, "POST", `/api/v1/console/certificates/${issued.jti}/revoke`, { token: a });
  check("owner revokes the certificate", r.status === 200 && typeof r.json?.data?.revokedAt === "string", `${r.status} ${JSON.stringify(r.json).slice(0, 150)}`);
  r = await call(GAP, "GET", "/api/v1/console/certificates", { token: a });
  check("list now shows it revoked", r.json?.data?.[0]?.status === "revoked");
  r = await act({ action: "invoices:pay", amountUsd: 50 });
  check("a money action with the revoked certificate is blocked at once", r.json?.allowed === false, JSON.stringify(r.json).slice(0, 150));
} catch (error) {
  check("run completed without an exception", false, error.stack);
} finally {
  await Promise.all([stop(gap), stop(tp), stop(atlas)]);
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
}
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
