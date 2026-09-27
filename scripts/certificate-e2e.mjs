// Real end-to-end proof: starts the actual Authority Atlas server and the actual (built) Agent
// Contract Gap server, issues a certificate at Atlas, and has Contract Gap verify and reconcile
// it over real HTTP. No injected fakes.
// Needs `npm run build` first and the Atlas repo (branch agent-authority): set ATLAS_DIR.
// Run: ATLAS_DIR=<path> node scripts/certificate-e2e.mjs
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ATLAS_DIR = process.env.ATLAS_DIR;
if (!ATLAS_DIR) {
  console.error("Set ATLAS_DIR to the Authority Atlas checkout that has the certificate feature.");
  process.exit(2);
}
const ATLAS_PORT = 4061;
const GAP_PORT = 4461;
const ATLAS = `http://127.0.0.1:${ATLAS_PORT}`;
const GAP = `http://127.0.0.1:${GAP_PORT}`;
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `  [${String(detail).slice(0, 110)}]` : ""}`);
};

const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", {
  namedCurve: "P-256",
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

function start(args, cwd, env, ready) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env: { ...process.env, ...env } });
    let out = "";
    const on = (d) => {
      out += d;
      if (ready.test(out)) resolve(child);
    };
    child.stdout.on("data", on);
    child.stderr.on("data", (d) => {
      out += d;
      if (ready.test(out)) resolve(child);
    });
    child.on("exit", (c) => {
      if (!ready.test(out)) reject(new Error(`exited ${c}: ${out.slice(-300)}`));
    });
    setTimeout(() => reject(new Error(`start timeout: ${out.slice(-200)}`)), 25000);
  });
}
const stop = (child) =>
  new Promise((resolve) => {
    if (!child) return resolve();
    child.once("exit", resolve);
    child.kill("SIGKILL");
  });

async function call(base, method, url, { body, token } = {}) {
  const response = await fetch(base + url, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: response.status, json };
}

const uploads = fs.mkdtempSync(path.join(os.tmpdir(), "gap-e2e-"));
let atlas;
let gap;
try {
  const b64 = (s) => Buffer.from(s).toString("base64");
  atlas = await start(["src/server.js"], ATLAS_DIR, { PORT: String(ATLAS_PORT), NODE_ENV: "production", ATLAS_PRIVATE_KEY_B64: b64(privateKey), ATLAS_PUBLIC_KEY_B64: b64(publicKey), DATABASE_URL: "" }, /running on/);
  gap = await start(["dist/server.js"], ROOT, {
    PORT: String(GAP_PORT), HOST: "127.0.0.1", NODE_ENV: "development", PERSISTENCE_DRIVER: "memory", LOG_LEVEL: "info",
    JWT_SECRET: "e2e-secret-with-at-least-thirty-two-characters", UPLOAD_DIRECTORY: uploads, AUTHORITY_ATLAS_URL: ATLAS, DATABASE_URL: "",
  }, /listening|Server listening/);

  // An organization at Atlas issues a certificate for a spending agent.
  const email = `boss_${crypto.randomBytes(3).toString("hex")}@example.com`;
  const password = "Correct-Horse-Battery-9!";
  await call(ATLAS, "POST", "/register", { body: { email, password, name: "Boss", org: "Fictional Acme Procurement Ltd" } });
  const login = await call(ATLAS, "POST", "/login", { body: { email, password } });
  const exchange = await call(ATLAS, "POST", "/token/exchange", { body: { code: login.json.code, client_id: "e2e" } });
  const issue = (permissions, limits) =>
    call(ATLAS, "POST", "/agents/certificates", { token: exchange.json.identity_token, body: { agentId: "procure-bot", agentName: "ProcureBot", permissions, limits, expiresInDays: 30 } });
  const good = (await issue(["contracts:sign", "payments:send", "email:send"], { maxAmountUsd: 9000 })).json;
  check("Atlas issued a certificate", typeof good.certificate === "string");

  // A Contract Gap org with an agent profile that UNDERSTATES that authority.
  const reg = await call(GAP, "POST", "/api/v1/auth/register", { body: { email: `gap_${crypto.randomBytes(3).toString("hex")}@example.test`, name: "Gap Tester", organizationName: "Fictional Acme Procurement Ltd", password: "Correct Horse Battery 123!" } });
  const token = reg.json.data.accessToken;
  const project = await call(GAP, "POST", "/api/v1/projects", { token, body: { name: "Cert e2e", description: "Fictional project", primaryCountryCode: "US", primarySubdivisionCode: "US-IL", affectedCountryCodes: ["CA"] } });
  const profile = {
    name: "ProcureBot", description: "Fictional", deploymentStatus: "pilot", businessPurpose: "Prepare bounded purchase orders",
    operatorOrganization: "Fictional Acme Procurement Ltd", deploymentCountries: ["US"], affectedCountries: ["US"], primaryJurisdiction: "US",
    jurisdictionSubdivisions: ["US-IL"], agentType: "procurement", autonomyLevel: 3, humanOversightLevel: "threshold_approval",
    canCommunicateExternally: true, canMakeRepresentations: false, canAcceptTerms: false, canExecuteTransactions: true, canSpendMoney: true,
    perTransactionLimit: 1000, currency: "USD", canIssueRefundsOrCredits: false, canChangePrices: false, canEnterContracts: false,
    canApproveOrRejectPeople: false, canApproveOrRejectVendors: false, canAccessPersonalData: false, canAccessSensitivePersonalData: false,
    canAccessConfidentialBusinessData: false, canAccessRegulatedData: false, canModifyOrDeleteData: false, canCreateIntellectualProperty: false,
    canPublishContent: false, canDeployCode: false, canControlInfrastructure: false, canHireOrTerminateWorkers: false, canDelegateToSubAgents: false,
    thirdPartyToolsUsed: [], systemsAccessed: [], reversibility: "partially_reversible", loggingLevel: "detailed", approvalThresholds: [], knownLimitations: [],
  };
  const agent = await call(GAP, "POST", `/api/v1/projects/${project.json.data.id}/agents`, { token, body: profile });
  const agentId = agent.json.data.id;
  check("agent profile created", agent.status === 201, agent.status);

  let r = await call(GAP, "POST", `/api/v1/agents/${agentId}/certificate-check`, { token, body: { certificate: good.certificate } });
  check("real Atlas-verified certificate reconciles (200)", r.status === 200, r.status);
  const kinds = (r.json?.data?.differences ?? []).map((d) => `${d.kind}:${d.capability ?? ""}`);
  check("understated contract authority is flagged high", kinds.includes("profile_understates_certificate:canEnterContracts"), kinds.join(","));
  check("a limit below the certificate's is flagged", kinds.some((k) => k.startsWith("profile_limit_below_certificate")), kinds.join(","));
  check("profileCoversCertificate is false", r.json?.data?.profileCoversCertificate === false);

  r = await call(GAP, "POST", `/api/v1/agents/${agentId}/adopt-certificate`, { token, body: { certificate: good.certificate } });
  check("adopting the certificate succeeds", r.status === 200 && r.json.data.agent.canEnterContracts === true && r.json.data.agent.perTransactionLimit === 9000, r.status);

  r = await call(GAP, "POST", `/api/v1/agents/${agentId}/certificate-check`, { token, body: { certificate: good.certificate } });
  check("after adopting, no high-severity differences remain", r.json.data.differences.every((d) => d.severity !== "high") && r.json.data.profileCoversCertificate === true);

  // Revocation at Atlas is honoured live.
  await call(ATLAS, "POST", `/agents/certificates/${good.jti}/revoke`, { token: exchange.json.identity_token });
  r = await call(GAP, "POST", `/api/v1/agents/${agentId}/certificate-check`, { token, body: { certificate: good.certificate } });
  check("a certificate revoked at Atlas is rejected (422)", r.status === 422 && /revoked/.test(JSON.stringify(r.json)), r.status);

  // A forged certificate is rejected.
  const [h, p, s] = good.certificate.split(".");
  const payload = JSON.parse(Buffer.from(p, "base64url").toString());
  payload.permissions = ["*"];
  const forged = `${h}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${s}`;
  r = await call(GAP, "POST", `/api/v1/agents/${agentId}/certificate-check`, { token, body: { certificate: forged } });
  check("a forged certificate is rejected (422)", r.status === 422 && /bad_signature/.test(JSON.stringify(r.json)), r.status);

  // Fail closed when Atlas is unreachable.
  await stop(atlas);
  atlas = null;
  r = await call(GAP, "POST", `/api/v1/agents/${agentId}/certificate-check`, { token, body: { certificate: good.certificate } });
  check("Atlas unreachable: 503, never trusted", r.status === 503, r.status);
} catch (error) {
  check("test run completed without an error", false, error.message);
} finally {
  await stop(atlas);
  await stop(gap);
  fs.rmSync(uploads, { recursive: true, force: true });
}
const failed = results.filter((ok) => !ok).length;
console.log(failed ? `\n${failed} FAILED of ${results.length}` : `\nALL ${results.length} PASSED`);
process.exit(failed ? 1 : 0);
