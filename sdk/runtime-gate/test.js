"use strict";

// Tests for @rootsystems/runtime-gate with fake servers on 127.0.0.1 only (no real network). Run: node test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { createRuntimeGate, RuntimeGateDeniedError } = require("./index.js");
const { createGateProxy } = require("./examples/http-proxy.js");

const KEY = "rgk_00000000-0000-4000-8000-000000000001_" + "a".repeat(43);
const REQ = "11111111-1111-4111-8111-111111111111";

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve({ server, url: "http://127.0.0.1:" + server.address().port, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) }));
  });
}
const send = (res, status, data) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify({ data })); };
const readJson = async (req) => { let s = ""; for await (const c of req) s += c; return s ? JSON.parse(s) : null; };

// A fake console: gate answers come from `answer(body)`; approval states are served from `states` in order.
async function fakeConsole({ answer, states = [], authCheck = true }) {
  const seen = { checks: [], polls: 0, auth: [] };
  const srv = await listen(async (req, res) => {
    seen.auth.push(req.headers.authorization);
    if (authCheck && req.headers.authorization !== "Bearer " + KEY) return send(res, 401, undefined);
    if (req.method === "POST" && req.url === "/api/v1/runtime/gate/check") {
      const body = await readJson(req);
      seen.checks.push(body);
      const [status, data] = answer(body);
      if (status === "hang") return; // never answers
      if (status === "garbage") { res.writeHead(200); return res.end("not json"); }
      return send(res, status, data);
    }
    if (req.method === "GET" && req.url === "/api/v1/runtime/approvals/" + REQ) {
      seen.polls++;
      const state = states.length > 1 ? states.shift() : states[0];
      if (state === "500") return send(res, 500, undefined);
      return send(res, 200, { requestId: REQ, state });
    }
    send(res, 404, undefined);
  });
  return Object.assign(srv, { seen });
}

const allowed = () => [200, { decision: "allowed", impact: "medium", reasons: ["within permissions"], requestId: null }];
const blocked = () => [403, { decision: "blocked", impact: "medium", reasons: ["action outside the agent's certificate permissions"], requestId: null }];
const needs = () => [202, { decision: "needs-approval", impact: "high", reasons: ["high impact"], requestId: REQ }];
const opts = (url, extra) => Object.assign({ consoleUrl: url, gateKey: KEY, agentId: "pay-bot", timeoutMs: 500, pollMs: 15 }, extra || {});

test("validates its options", () => {
  assert.throws(() => createRuntimeGate({ consoleUrl: "ftp://x", gateKey: KEY, agentId: "a" }), /consoleUrl/);
  assert.throws(() => createRuntimeGate({ consoleUrl: "http://x", gateKey: "not-a-key", agentId: "a" }), /gateKey/);
  assert.throws(() => createRuntimeGate({ consoleUrl: "http://x", gateKey: KEY }), /agentId/);
  assert.throws(() => createRuntimeGate({ consoleUrl: "http://x", gateKey: KEY, agentId: "a", ledger: {} }), /ledger/);
});

test("allowed: sends the key, agent, action, resource and amount; runs the action", async () => {
  const c = await fakeConsole({ answer: allowed });
  try {
    const gate = createRuntimeGate(opts(c.url));
    const out = await gate.run("invoices:pay", { resource: "INV-1", amountUsd: 120 }, (r) => "paid:" + r.decision);
    assert.equal(out, "paid:allowed");
    assert.deepEqual(c.seen.checks[0], { agentId: "pay-bot", action: "invoices:pay", resource: "INV-1", amountUsd: 120 });
    const r = await gate.check("invoices:pay");
    assert.equal(r.ledger.recorded, false);
    assert.equal(r.ledger.reason, "no ledger configured");
  } finally { await c.close(); }
});

test("blocked: run throws RuntimeGateDeniedError and the action never runs", async () => {
  const c = await fakeConsole({ answer: blocked });
  try {
    const gate = createRuntimeGate(opts(c.url));
    let ran = false;
    await assert.rejects(gate.run("email:send", () => { ran = true; }), (e) => e instanceof RuntimeGateDeniedError && e.result.decision === "blocked" && /outside/.test(e.message));
    assert.equal(ran, false);
  } finally { await c.close(); }
});

test("fails closed: unreachable, timeout, 401, 500/503, malformed body, unknown decision", async () => {
  const dead = await listen(() => {});
  const deadUrl = dead.url;
  await dead.close();
  const r1 = await createRuntimeGate(opts(deadUrl)).check("x:y");
  assert.equal(r1.allowed, false);
  assert.equal(r1.decision, "unavailable");
  assert.match(r1.reasons[0], /could not reach/);

  const hang = await fakeConsole({ answer: () => ["hang"] });
  const started = Date.now();
  const r2 = await createRuntimeGate(opts(hang.url, { timeoutMs: 80, retries: 0 })).check("x:y");
  assert.equal(r2.decision, "unavailable");
  assert.match(r2.reasons[0], /timed out/);
  assert.ok(Date.now() - started < 2000);
  await hang.close();

  const wrongKey = await fakeConsole({ answer: allowed });
  const r3 = await createRuntimeGate(opts(wrongKey.url, { gateKey: "rgk_00000000-0000-4000-8000-000000000002_" + "b".repeat(43) })).check("x:y");
  assert.equal(r3.decision, "unavailable");
  assert.match(r3.reasons[0], /HTTP 401/);
  await wrongKey.close();

  for (const answer of [() => [500, undefined], () => [503, undefined], () => ["garbage"], () => [200, { decision: "maybe" }], () => [200, { decision: "blocked" }], () => [202, { decision: "needs-approval" }]]) {
    const c = await fakeConsole({ answer });
    const r = await createRuntimeGate(opts(c.url)).check("x:y");
    assert.equal(r.allowed, false, JSON.stringify(answer()));
    assert.equal(r.decision, "unavailable");
    await c.close();
  }
});

test("503 is retried once, then succeeds", async () => {
  let n = 0;
  const c = await fakeConsole({ answer: () => (n++ === 0 ? [503, undefined] : allowed()) });
  try {
    const r = await createRuntimeGate(opts(c.url)).check("x:y");
    assert.equal(r.allowed, true);
    assert.equal(c.seen.checks.length, 2);
  } finally { await c.close(); }
});

test("needs-approval with no wait: not allowed, returns the request id", async () => {
  const c = await fakeConsole({ answer: needs, states: ["approved"] });
  try {
    const r = await createRuntimeGate(opts(c.url)).check("invoices:pay", { amountUsd: 900 });
    assert.equal(r.allowed, false);
    assert.equal(r.decision, "needs-approval");
    assert.equal(r.requestId, REQ);
    assert.equal(c.seen.polls, 0);
  } finally { await c.close(); }
});

test("needs-approval with a wait: polls until approved, then allowed", async () => {
  const c = await fakeConsole({ answer: needs, states: ["pending", "500", "pending", "approved"] });
  try {
    const r = await createRuntimeGate(opts(c.url, { approvalWaitMs: 5000 })).check("invoices:pay");
    assert.equal(r.allowed, true);
    assert.equal(r.decision, "approved");
    assert.equal(c.seen.polls, 4);
  } finally { await c.close(); }
});

test("declined and expired approvals are not allowed", async () => {
  for (const state of ["declined", "expired"]) {
    const c = await fakeConsole({ answer: needs, states: ["pending", state] });
    const r = await createRuntimeGate(opts(c.url, { approvalWaitMs: 5000 })).check("invoices:pay");
    assert.equal(r.allowed, false);
    assert.equal(r.decision, state);
    await c.close();
  }
});

test("the wait is bounded: still pending when it ends is not allowed", async () => {
  const c = await fakeConsole({ answer: needs, states: ["pending"] });
  try {
    const started = Date.now();
    const r = await createRuntimeGate(opts(c.url, { approvalWaitMs: 120 })).check("invoices:pay");
    assert.equal(r.allowed, false);
    assert.equal(r.decision, "needs-approval");
    assert.ok(Date.now() - started < 2000);
    assert.ok(c.seen.polls >= 2);
    // A per-call override can wait (or not) independently.
    const later = await createRuntimeGate(opts(c.url)).check("invoices:pay", {}, { approvalWaitMs: 40 });
    assert.equal(later.decision, "needs-approval");
  } finally { await c.close(); }
});

test("ledger: the outcome is recorded; the action goes ahead only if the gate AND the ledger allow it", async () => {
  const c = await fakeConsole({ answer: allowed });
  const calls = [];
  const ledger = (answer) => ({ check: async (action, details) => { calls.push({ action, details }); return answer; } });
  try {
    const ok = await createRuntimeGate(opts(c.url, { ledger: ledger({ allowed: true, verdict: "within_authority", reasons: [], entry: { seq: 7 } }) })).check("invoices:pay", { resource: "INV-1", amountUsd: 10, details: { note: "x" } });
    assert.equal(ok.allowed, true);
    assert.deepEqual(ok.ledger, { recorded: true, allowed: true, verdict: "within_authority", reasons: [], entry: { seq: 7 } });
    assert.deepEqual(calls[0], { action: "invoices:pay", details: { resource: "INV-1", amountUsd: 10, details: { note: "x", runtimeGate: { decision: "allowed", requestId: null, impact: "medium" } } } });

    const no = await createRuntimeGate(opts(c.url, { ledger: ledger({ allowed: false, verdict: "outside_authority", reasons: ["certificate_revoked"], entry: { seq: 8 } }) })).check("invoices:pay");
    assert.equal(no.allowed, false);
    assert.equal(no.decision, "ledger-denied");
    assert.ok(no.reasons.includes("certificate_revoked"));

    const down = await createRuntimeGate(opts(c.url, { ledger: { check: async () => { throw new Error("boom"); } } })).check("invoices:pay");
    assert.equal(down.allowed, false);
    assert.equal(down.decision, "ledger-denied");
    assert.equal(down.ledger.recorded, false);
  } finally { await c.close(); }

  const b = await fakeConsole({ answer: blocked });
  try {
    calls.length = 0;
    const r = await createRuntimeGate(opts(b.url, { ledger: ledger({ allowed: true, verdict: "within_authority", reasons: [], entry: { seq: 9 } }) })).check("email:send");
    assert.equal(r.allowed, false, "a ledger yes never overrides a gate no");
    assert.equal(r.decision, "blocked");
    assert.equal(calls[0].details.details.runtimeGate.decision, "blocked", "blocked attempts are recorded too");
  } finally { await b.close(); }
});

test("wrapTool gates every call and passes the arguments through", async () => {
  const c = await fakeConsole({ answer: allowed });
  try {
    const gate = createRuntimeGate(opts(c.url));
    const pay = gate.wrapTool("invoices:pay", async (id, usd) => id + "=" + usd, (id, usd) => ({ resource: id, amountUsd: usd }));
    assert.equal(await pay("INV-3", 30), "INV-3=30");
    assert.equal(c.seen.checks[0].resource, "INV-3");
  } finally { await c.close(); }
});

test("example HTTP proxy: forwards allowed calls, refuses blocked ones without calling the upstream", async () => {
  let upstreamHits = 0;
  const upstream = await listen(async (req, res) => {
    upstreamHits++;
    const body = await readJson(req);
    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ path: req.url, body, sawAgentHeader: Object.keys(req.headers).some((h) => h.startsWith("x-agent-")) }));
  });
  const c = await fakeConsole({ answer: (b) => (b.action === "invoices:pay" ? allowed() : b.action === "invoices:approve" ? needs() : blocked()) });
  const proxy = createGateProxy({ gate: createRuntimeGate(opts(c.url)), upstreamUrl: upstream.url + "/api" });
  await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + proxy.address().port;
  try {
    const ok = await fetch(base + "/pay", { method: "POST", headers: { "Content-Type": "application/json", "X-Agent-Action": "invoices:pay", "X-Agent-Resource": "INV-5", "X-Agent-Amount-Usd": "50" }, body: JSON.stringify({ id: "INV-5" }) });
    assert.equal(ok.status, 201);
    assert.deepEqual(await ok.json(), { path: "/api/pay", body: { id: "INV-5" }, sawAgentHeader: false });
    assert.deepEqual(c.seen.checks[0], { agentId: "pay-bot", action: "invoices:pay", resource: "INV-5", amountUsd: 50 });

    const no = await fetch(base + "/send", { method: "POST", headers: { "X-Agent-Action": "email:send" } });
    assert.equal(no.status, 403);
    assert.equal((await no.json()).decision, "blocked");
    const wait = await fetch(base + "/approve", { method: "POST", headers: { "X-Agent-Action": "invoices:approve" } });
    assert.equal(wait.status, 202);
    assert.equal((await wait.json()).requestId, REQ);
    assert.equal((await fetch(base + "/x")).status, 400, "no X-Agent-Action");
    assert.equal((await fetch(base + "/x", { headers: { "X-Agent-Action": "invoices:pay", "X-Agent-Amount-Usd": "-1" } })).status, 400);
    assert.equal(upstreamHits, 1);
  } finally {
    proxy.closeAllConnections();
    await new Promise((r) => proxy.close(r));
    await c.close();
    await upstream.close();
  }
});
