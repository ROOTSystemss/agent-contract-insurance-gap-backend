import { randomUUID } from "node:crypto";

// Fake Authority Atlas + Trust Proof for console governance-record tests (knock-out Phase 5). Enough of both
// services for the console gateway: linking, Atlas sign-in, certificates (issue, list, revoke, verify), the
// Trust Proof action ledger. `atlasDown` makes Atlas answer 500 to certificate reads (three-state tests).

export interface FakeCert {
  jti: string;
  agentId: string;
  agentName: string | null;
  permissions: string[];
  limits: Record<string, number>;
  organization: string;
  issuedAt: string;
  expiresAt: string;
  revokedAt: string | null;
  status: "active" | "revoked" | "expired";
  registryBinding: string;
  certificate: string;
}

export interface FakeAction {
  id: number;
  certificateJti: string;
  agentId: string;
  action: string;
  amountUsd: number | null;
  verdict: "within_authority" | "outside_authority";
  reasons: string[];
  occurredAt: string;
}

export function governanceFakes() {
  const certs: FakeCert[] = [];
  const actions: FakeAction[] = [];
  const state = { atlasDown: false, revokeFails: false, ledgerDown: false, issuerLinkFails: false };
  const issuerLinks: Array<{ apiKey: string; identityToken: string }> = [];
  const json = (status: number, body?: unknown, headers: Record<string, string> = {}) =>
    new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

  const fetchImpl = (async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};
    if (url.host === "atlas.test") {
      if (url.pathname === "/register") return json(201, { ok: true });
      if (url.pathname === "/login") return json(200, { code: "code-1" });
      if (url.pathname === "/token/exchange") return json(200, { identity_token: "atlas-token" });
      if (state.atlasDown && url.pathname.startsWith("/agents")) return json(500, { error: "unavailable" }); // 500: not retried by the gateway (503 is)
      if (url.pathname === "/agents/certificates" && method === "GET") return json(200, { certificates: certs.map(({ certificate: _c, ...rest }) => rest) });
      if (url.pathname === "/agents/certificates" && method === "POST") {
        const jti = randomUUID();
        const now = new Date();
        const cert: FakeCert = {
          jti, agentId: String(body.agentId), agentName: String(body.agentName ?? ""), permissions: (body.permissions as string[]) ?? [],
          limits: (body.limits as Record<string, number>) ?? {}, organization: "Fake Org", issuedAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + 30 * 864e5).toISOString(), revokedAt: null, status: "active", registryBinding: "fake", certificate: `cert.${jti}`,
        };
        certs.push(cert);
        return json(201, { certificate: cert.certificate, jti, agentId: cert.agentId, expiresAt: cert.expiresAt, pqSignature: null });
      }
      const revoke = url.pathname.match(/^\/agents\/certificates\/([^/]+)\/revoke$/);
      if (revoke && method === "POST") {
        if (state.revokeFails) return json(500, { error: "boom" });
        const cert = certs.find((c) => c.jti === decodeURIComponent(revoke[1]!));
        if (!cert) return json(404, { error: "not_found" });
        cert.status = "revoked";
        cert.revokedAt = new Date().toISOString();
        return json(200, { jti: cert.jti, revokedAt: cert.revokedAt });
      }
      if (url.pathname === "/agents/verify" && method === "POST") {
        const cert = certs.find((c) => c.certificate === body.certificate);
        if (!cert) return json(200, { valid: false, reason: "unknown_certificate" });
        return json(200, cert.status === "active" ? { valid: true, certificate: { agentId: cert.agentId, permissions: cert.permissions } } : { valid: false, reason: cert.status });
      }
      return json(404, { error: "unexpected atlas " + url.pathname });
    }
    if (url.host === "tp.test") {
      if (url.pathname === "/auth/signup") return json(201, { ok: true }, { "set-cookie": "sid=abc; Path=/; HttpOnly" });
      if (url.pathname === "/api-keys") return json(201, { key: "rs_test_key" });
      if (url.pathname === "/api/v1/agent-actions" && state.ledgerDown) return json(500, { error: "unavailable" });
      if (url.pathname === "/api/v1/atlas-issuers" && method === "POST") {
        // QA 2026-11-18 F21: the console links its Atlas identity (by its token) to its Trust Proof org.
        if (state.issuerLinkFails) return json(500, { error: "boom" });
        issuerLinks.push({ apiKey: String((init?.headers as Record<string, string>)?.Authorization ?? ""), identityToken: String(body.identityToken) });
        return json(201, { issuer: { id: issuerLinks.length, fingerprint: "f".repeat(64) }, created: true });
      }
      if (url.pathname === "/api/v1/agent-actions") {
        const agentId = url.searchParams.get("agentId");
        const limit = Number(url.searchParams.get("limit") ?? 200);
        const rows = actions.filter((a) => !agentId || a.agentId === agentId).slice().reverse();
        return json(200, { count: rows.length, actions: rows.slice(0, limit) });
      }
      return json(404, { error: "unexpected tp " + url.pathname });
    }
    return json(404, { error: "unexpected host" });
  }) as typeof fetch;

  const addAction = (agentId: string, verdict: FakeAction["verdict"], occurredAt: string, amountUsd: number | null = null) =>
    actions.push({ id: actions.length + 1, certificateJti: certs.find((c) => c.agentId === agentId)?.jti ?? "none", agentId, action: "invoices:pay", amountUsd, verdict, reasons: verdict === "outside_authority" ? ["over_limit"] : [], occurredAt });

  return { fetchImpl, certs, actions, state, addAction, issuerLinks };
}
