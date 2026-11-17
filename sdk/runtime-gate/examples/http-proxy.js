"use strict";

// A minimal HTTP proxy that puts the runtime gate in front of an upstream API (BM-40 example).
//
// The agent sends its requests to this proxy instead of the upstream, naming what it is about to do:
//   X-Agent-Action: invoices:pay      (required; the gate action)
//   X-Agent-Resource: INV-9           (optional)
//   X-Agent-Amount-Usd: 120           (optional)
// The proxy asks the gate. Allowed or approved: the request is forwarded unchanged (minus the X-Agent-* headers).
// Otherwise the agent gets 403 (blocked / declined / expired / unavailable) or 202 (still waiting for a person) with
// the reasons, and the upstream is never called.
//
//   CONSOLE_URL=https://your-console.example RUNTIME_GATE_KEY=rgk_... AGENT_ID=pay-bot \
//   UPSTREAM_URL=https://payments.internal.example PORT=8088 node examples/http-proxy.js
//
// Zero dependencies. It buffers request bodies (up to 1 MB); it is an example, not a production gateway.

const http = require("node:http");
const https = require("node:https");
const { createRuntimeGate } = require("..");

const HOP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-authorization", "te", "trailer", "host"]);

function createGateProxy({ gate, upstreamUrl, maxBodyBytes = 1024 * 1024 }) {
  const upstream = new URL(upstreamUrl);
  const reply = (res, status, body) => { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(body)); };

  return http.createServer(async (req, res) => {
    const action = String(req.headers["x-agent-action"] || "");
    if (!action) return reply(res, 400, { error: "X-Agent-Action header is required" });
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxBodyBytes) return reply(res, 413, { error: "request body too large" });
      chunks.push(chunk);
    }
    const amount = req.headers["x-agent-amount-usd"];
    const details = { resource: req.headers["x-agent-resource"] ? String(req.headers["x-agent-resource"]) : undefined };
    if (amount !== undefined && amount !== "") {
      const n = Number(amount);
      if (!Number.isFinite(n) || n < 0) return reply(res, 400, { error: "X-Agent-Amount-Usd must be a non-negative number" });
      details.amountUsd = n;
    }
    const result = await gate.check(action, details);
    if (!result.allowed) {
      return reply(res, result.decision === "needs-approval" ? 202 : 403, { allowed: false, decision: result.decision, reasons: result.reasons, requestId: result.requestId });
    }
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && !k.startsWith("x-agent-")) headers[k] = v;
    const forward = (upstream.protocol === "https:" ? https : http).request({ protocol: upstream.protocol, hostname: upstream.hostname, port: upstream.port, method: req.method, path: upstream.pathname.replace(/\/$/, "") + req.url, headers }, (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    });
    forward.on("error", () => { if (!res.headersSent) reply(res, 502, { error: "upstream unreachable" }); else res.destroy(); });
    forward.end(Buffer.concat(chunks));
  });
}

module.exports = { createGateProxy };

if (require.main === module) {
  const gate = createRuntimeGate({
    consoleUrl: process.env.CONSOLE_URL,
    gateKey: process.env.RUNTIME_GATE_KEY,
    agentId: process.env.AGENT_ID,
    approvalWaitMs: Number(process.env.APPROVAL_WAIT_MS || 0),
  });
  const port = Number(process.env.PORT || 8088);
  createGateProxy({ gate, upstreamUrl: process.env.UPSTREAM_URL }).listen(port, "127.0.0.1", () => {
    console.log("runtime gate proxy on http://127.0.0.1:" + port + " -> " + process.env.UPSTREAM_URL);
  });
}
