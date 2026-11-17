"use strict";

// @rootsystems/runtime-gate (BM-40): ask the AI Agent Trust console before an agent acts.
//
//   const { createRuntimeGate } = require("@rootsystems/runtime-gate");
//   const gate = createRuntimeGate({
//     consoleUrl: "https://your-console.example",
//     gateKey: process.env.RUNTIME_GATE_KEY,        // created by a workspace admin: Console > Runtime keys
//     agentId: "pay-bot",
//     approvalWaitMs: 10 * 60 * 1000,                // wait up to 10 minutes for a person to approve
//     ledger: createGuard({ ... }),                  // optional: @rootsystems/agent-guard, records to the Trust Proof ledger
//   });
//   await gate.run("invoices:pay", { resource: "INV-9", amountUsd: 120 }, () => payInvoice());
//
// Order of a check:
//   1. POST {consoleUrl}/api/v1/runtime/gate/check   allowed (200) / blocked (403) / needs-approval (202)
//   2. needs-approval: poll GET /api/v1/runtime/approvals/:requestId until approved, declined, expired, or the wait ends
//   3. if a ledger is given, record the outcome there (agent-guard check). The action goes ahead only if BOTH the gate
//      and the ledger allow it.
// It FAILS CLOSED: a timeout, an unreachable service, an unexpected answer, or an approval still pending when the wait
// ends is "not allowed". Nothing is stored; the key stays in your process. Zero dependencies, Node 18+ (global fetch).
// Decision support: the gate only stops the actions your runtime asks about.

class RuntimeGateDeniedError extends Error {
  constructor(result) {
    super("Action not allowed (" + result.decision + "): " + (result.reasons && result.reasons.length ? result.reasons.join("; ") : "no reason given"));
    this.name = "RuntimeGateDeniedError";
    this.code = "RUNTIME_GATE_DENIED";
    this.result = result;
  }
}

const MAX_WAIT_MS = 24 * 3600 * 1000; // an approval request expires after 24 hours on the console
const KEY_RE = /^rgk_[0-9a-f-]{36}_[A-Za-z0-9_-]{43}$/;

function createRuntimeGate(options) {
  const o = options || {};
  const fetchImpl = o.fetch || globalThis.fetch;
  if (typeof o.consoleUrl !== "string" || !/^https?:\/\//.test(o.consoleUrl)) throw new TypeError("createRuntimeGate: consoleUrl must be an http(s) URL");
  if (typeof o.gateKey !== "string" || !KEY_RE.test(o.gateKey)) throw new TypeError("createRuntimeGate: gateKey must be a runtime key (rgk_...) created in the console");
  if (typeof o.agentId !== "string" || !o.agentId) throw new TypeError("createRuntimeGate: agentId is required");
  if (typeof fetchImpl !== "function") throw new Error("createRuntimeGate: no fetch available (Node 18+ required)");
  if (o.ledger !== undefined && (!o.ledger || typeof o.ledger.check !== "function")) throw new TypeError("createRuntimeGate: ledger must be an agent-guard (an object with check(action, details))");
  const root = o.consoleUrl.replace(/\/+$/, "");
  const timeoutMs = o.timeoutMs > 0 ? o.timeoutMs : 8000;
  const retries = Number.isInteger(o.retries) && o.retries >= 0 ? o.retries : 1;
  const defaultWait = Math.min(o.approvalWaitMs > 0 ? o.approvalWaitMs : 0, MAX_WAIT_MS);
  const pollMs = Math.max(o.pollMs > 0 ? o.pollMs : 5000, 10);
  const now = o.now || Date.now;
  const sleep = o.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const headers = { "Content-Type": "application/json", Authorization: "Bearer " + o.gateKey };

  // One HTTP call with a timeout and a retry on network failure / 503. Returns { status, json } or { error }.
  async function call(method, path, body) {
    let last = "no attempt made";
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await fetchImpl(root + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
        if (response.status === 503) { last = "service temporarily unavailable (503)"; continue; }
        const json = await response.json().catch(() => null);
        return { status: response.status, json };
      } catch (error) {
        last = error && (error.name === "TimeoutError" || error.name === "AbortError") ? "timed out" : "could not reach the console";
      }
    }
    return { error: last };
  }

  const denied = (decision, reasons, extra) => Object.assign({ allowed: false, decision, reasons, requestId: null, impact: null, ledger: { recorded: false, reason: "not asked" } }, extra || {});

  // Interpret the gate's answer. Anything that is not exactly one of the three documented answers is "unavailable".
  function readGate(res) {
    if (res.error) return denied("unavailable", ["gate_unavailable: " + res.error]);
    const data = res.json && res.json.data;
    if (!data || typeof data.decision !== "string") return denied("unavailable", ["gate_unexpected_response: HTTP " + res.status + (res.json && res.json.error && res.json.error.code ? " " + res.json.error.code : "")]);
    const base = { reasons: Array.isArray(data.reasons) ? data.reasons : [], requestId: data.requestId || null, impact: data.impact || null, certificateSource: data.certificateSource || null };
    if (res.status === 200 && data.decision === "allowed") return Object.assign({ allowed: true, decision: "allowed", ledger: { recorded: false, reason: "not asked" } }, base);
    if (res.status === 403 && data.decision === "blocked") return Object.assign(denied("blocked", base.reasons), base);
    if (res.status === 202 && data.decision === "needs-approval" && data.requestId) return Object.assign(denied("needs-approval", base.reasons), base);
    return denied("unavailable", ["gate_unexpected_response: HTTP " + res.status + " " + data.decision]);
  }

  // waitForApproval(): polls the approval request this key opened until a person decides or the wait ends.
  // Returns "approved" | "declined" | "expired" | "pending" (still waiting when the time ran out) | "unavailable".
  async function waitForApproval(requestId, waitMs) {
    const wait = Math.min(Math.max(Number(waitMs) || 0, 0), MAX_WAIT_MS);
    const deadline = now() + wait;
    let last = "pending";
    for (;;) {
      const res = await call("GET", "/api/v1/runtime/approvals/" + encodeURIComponent(requestId));
      const state = res.json && res.json.data && res.json.data.state;
      if (!res.error && res.status === 200 && ["approved", "declined", "expired"].includes(state)) return { state, approval: res.json.data };
      if (!res.error && res.status === 200 && state === "pending") last = "pending";
      else if (!res.error && (res.status === 401 || res.status === 404)) return { state: "unavailable", detail: "HTTP " + res.status };
      else last = "unavailable"; // a transient failure: keep trying until the deadline, then fail closed
      const left = deadline - now();
      if (left <= 0) return { state: last };
      await sleep(Math.min(pollMs, left));
    }
  }

  async function record(action, details, result) {
    if (!o.ledger) return Object.assign(result, { ledger: { recorded: false, reason: "no ledger configured" } });
    const ledgerDetails = Object.assign({}, details.details || {}, { runtimeGate: { decision: result.decision, requestId: result.requestId, impact: result.impact } });
    let entry;
    try {
      entry = await o.ledger.check(action, { resource: details.resource, amountUsd: details.amountUsd, details: ledgerDetails });
    } catch (error) {
      entry = { allowed: false, verdict: "unavailable", reasons: ["ledger_error: " + (error && error.message ? error.message : "unknown")], entry: null };
    }
    const recorded = Boolean(entry && entry.entry);
    result.ledger = { recorded, allowed: Boolean(entry && entry.allowed === true), verdict: entry ? entry.verdict : "unavailable", reasons: (entry && entry.reasons) || [], entry: (entry && entry.entry) || null };
    // The action goes ahead only if the ledger also allows it (and a ledger that cannot answer is a "no").
    if (result.allowed && !result.ledger.allowed) {
      result.allowed = false;
      result.decision = "ledger-denied";
      result.reasons = result.reasons.concat(result.ledger.reasons.length ? result.ledger.reasons : ["ledger_" + result.ledger.verdict]);
    }
    return result;
  }

  // check(): never throws; returns { allowed, decision, reasons, requestId, impact, ledger }.
  // decision: allowed | approved | blocked | declined | expired | needs-approval (still pending) | unavailable | ledger-denied
  async function check(action, details, checkOptions) {
    details = details || {};
    const body = { agentId: o.agentId, action, resource: details.resource === undefined ? "" : String(details.resource) };
    if (details.amountUsd !== undefined) body.amountUsd = details.amountUsd;
    let result = readGate(await call("POST", "/api/v1/runtime/gate/check", body));
    if (result.decision === "needs-approval") {
      const waitMs = checkOptions && checkOptions.approvalWaitMs !== undefined ? checkOptions.approvalWaitMs : defaultWait;
      const outcome = waitMs > 0 ? await waitForApproval(result.requestId, waitMs) : { state: "pending" };
      if (outcome.state === "approved") result = Object.assign(result, { allowed: true, decision: "approved", approval: outcome.approval });
      else if (outcome.state === "declined" || outcome.state === "expired") result = Object.assign(result, { decision: outcome.state, reasons: result.reasons.concat("approval " + outcome.state) });
      else if (outcome.state === "unavailable") result = Object.assign(result, { decision: "unavailable", reasons: result.reasons.concat("approval_unavailable" + (outcome.detail ? ": " + outcome.detail : "")) });
      else result.reasons = result.reasons.concat("approval still pending (request " + result.requestId + ")");
    }
    return record(action, details, result);
  }

  // run(): checks, and calls fn(result) only if allowed. Throws RuntimeGateDeniedError otherwise.
  async function run(action, details, fn) {
    if (typeof details === "function") { fn = details; details = {}; }
    const result = await check(action, details);
    if (!result.allowed) throw new RuntimeGateDeniedError(result);
    return fn(result);
  }

  // wrapTool(): a function that gates every call to fn. describe(...args) may return { resource, amountUsd, details }.
  function wrapTool(action, fn, describe) {
    return (...args) => run(action, describe ? describe(...args) || {} : {}, () => fn(...args));
  }

  return { check, run, wrapTool, waitForApproval };
}

module.exports = { createRuntimeGate, RuntimeGateDeniedError };
