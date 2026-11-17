# @rootsystems/runtime-gate

Ask the AI Agent Trust console **before** an AI agent acts. The answer is one of:

| Gate answer | What the SDK does |
| --- | --- |
| `allowed` (HTTP 200) | the action may go ahead |
| `blocked` (HTTP 403) | not allowed: no active certificate, outside its permissions, or over its limit |
| `needs-approval` (HTTP 202) | a person must decide in the console's approval inbox; the SDK can wait (bounded) for the answer |

It **fails closed**: a timeout, an unreachable console, an unexpected answer, a revoked key, or an approval that is still
pending when the wait ends all mean *not allowed*. Zero dependencies, Node 18+.

If you pass a Trust Proof ledger (the existing `@rootsystems/agent-guard`, in the Trust Proof repository at `sdk/agent-guard`),
every outcome is recorded in your tamper-evident ledger, and the action goes ahead only if **both** the gate and the
ledger allow it.

Decision support: the gate stops only the actions your runtime asks about. It does not watch your agents.

## 1. Create a runtime key

A workspace admin creates one in the console (Runtime keys), or by API:

```
POST /api/v1/console/runtime-keys          {"name": "Payments runtime"}    -> 201 { key: "rgk_...", ... }
GET  /api/v1/console/runtime-keys                                          -> names, prefixes, dates (never the key)
POST /api/v1/console/runtime-keys/:id/revoke                               -> stops the key at once
```

The key is shown **once**; the console keeps only its SHA-256 hash. It works on exactly two routes:
`POST /api/v1/runtime/gate/check` and `GET /api/v1/runtime/approvals/:requestId` (only the requests it opened).
It cannot read or change anything else. Requests it opens are decided by a person, never by the key.

## 2. Node

```js
const { createRuntimeGate, RuntimeGateDeniedError } = require("@rootsystems/runtime-gate");
const { createGuard } = require("@rootsystems/agent-guard"); // optional: record to the Trust Proof ledger

const gate = createRuntimeGate({
  consoleUrl: "https://your-console.example",
  gateKey: process.env.RUNTIME_GATE_KEY,
  agentId: "pay-bot",
  approvalWaitMs: 10 * 60 * 1000, // wait up to 10 minutes for a person (default 0: return at once)
  pollMs: 5000,
  ledger: createGuard({
    baseUrl: "https://your-trust-proof.example",
    apiKey: process.env.TRUST_PROOF_API_KEY,
    certificate: process.env.PAY_BOT_CERTIFICATE,
  }),
});

// run(): only calls the function if allowed; otherwise throws RuntimeGateDeniedError (err.result has the details).
try {
  await gate.run("invoices:pay", { resource: "INV-9", amountUsd: 120 }, () => payInvoice("INV-9"));
} catch (err) {
  if (err instanceof RuntimeGateDeniedError) console.log(err.result.decision, err.result.reasons);
  else throw err;
}

// check(): never throws.
const result = await gate.check("email:send", { resource: "customer-42" });
// { allowed, decision, reasons, requestId, impact, ledger: { recorded, allowed, verdict, entry } }

// wrapTool(): gate every call to a tool.
const pay = gate.wrapTool("invoices:pay", payInvoice, (id, usd) => ({ resource: id, amountUsd: usd }));

// Ask now, wait later (for example from a job queue):
const r = await gate.check("invoices:pay", { amountUsd: 900 }, { approvalWaitMs: 0 });
if (r.decision === "needs-approval") {
  const { state } = await gate.waitForApproval(r.requestId, 60 * 60 * 1000); // approved | declined | expired | pending
}
```

`decision` is one of `allowed`, `approved`, `blocked`, `declined`, `expired`, `needs-approval` (still pending),
`unavailable` (fail closed) or `ledger-denied` (the gate said yes, the ledger said no or could not answer).

Options: `consoleUrl`, `gateKey`, `agentId` (required); `timeoutMs` (8000), `retries` on network error or 503 (1),
`approvalWaitMs` (0, at most 24 hours: requests expire after 24 hours), `pollMs` (5000), `ledger`, `fetch`.

## 3. Minimal HTTP proxy

[`examples/http-proxy.js`](examples/http-proxy.js) puts the gate in front of any HTTP API. The agent calls the proxy and
names what it is doing in `X-Agent-Action` (plus optional `X-Agent-Resource`, `X-Agent-Amount-Usd`). Allowed calls are
forwarded unchanged; others get 403 (or 202 while waiting for a person) and the upstream is never called.

```
CONSOLE_URL=https://your-console.example RUNTIME_GATE_KEY=rgk_... AGENT_ID=pay-bot \
UPSTREAM_URL=https://payments.internal.example PORT=8088 node examples/http-proxy.js

curl -X POST http://127.0.0.1:8088/payments -H "X-Agent-Action: invoices:pay" \
     -H "X-Agent-Resource: INV-9" -H "X-Agent-Amount-Usd: 120" -d '{"invoice":"INV-9"}'
```

It is an example (buffers bodies up to 1 MB), not a production gateway.

## Tests

`node --test test.js`: fake console, ledger and upstream servers on 127.0.0.1 only; no real network.
