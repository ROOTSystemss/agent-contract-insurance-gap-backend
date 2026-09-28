import { randomBytes } from "node:crypto";
import type { Organization, ServiceLink } from "../domain/types.js";
import type { Store } from "../persistence/store.js";
import { AppError } from "../shared/errors.js";
import type { SecretBox } from "./secret-box.js";

// The Agent Governance console gives a workspace one place to run the Floor 3 chain. Behind it,
// each workspace is linked to its own Authority Atlas identity (which issues and revokes the
// agents' certificates) and its own Trust Proof organization (which checks and records every agent
// action). The links are created on first use with random credentials the customer never sees;
// the credentials are sealed in the database (SecretBox) and every call goes through here.

export interface GatewayOptions {
  atlasUrl: string | null;
  trustProofUrl: string | null;
  fetchImpl?: typeof fetch;
  // Render's free instances sleep; the first call after a sleep can take close to a minute.
  timeoutMs?: number;
  // Synthetic mailbox domain for the linked service accounts (never emailed).
  accountDomain?: string;
  // CONSOLE_SERVICE_TOKEN, sent as x-rootsystems-service so Atlas/Trust Proof know this is the console.
  serviceToken?: string | null;
}

export interface IssueCertificateInput {
  agentId: string;
  agentName: string;
  permissions: string[];
  limits: { maxAmountUsd?: number; maxActionsPerDay?: number };
  expiresInDays: number;
}

export interface AtlasCertificate {
  jti: string;
  agentId: string;
  agentName: string | null;
  permissions: string[] | null;
  limits: { maxAmountUsd?: number; maxActionsPerDay?: number } | null;
  organization: string;
  issuedAt: string;
  expiresAt: string;
  revokedAt: string | null;
  status: "active" | "revoked" | "expired";
  registryBinding: string;
}

export interface LedgerAction {
  id: number | string;
  certificateJti: string;
  agentId: string;
  action: string;
  resource?: string | null;
  amountUsd?: number | null;
  verdict: "within_authority" | "outside_authority";
  reasons: string[];
  occurredAt: string;
  detailsHash?: string | null;
  previousChainHash?: string;
  chainHash?: string;
  [key: string]: unknown;
}

const ATLAS_CLIENT_ID = "agent-governance-console";
const TOKEN_REUSE_MS = 55 * 60 * 1000; // Atlas identity tokens last one hour.

interface UpstreamResult {
  status: number;
  body: unknown;
  setCookie: string | null;
}

function upstreamMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    for (const key of ["error", "message"]) {
      if (typeof record[key] === "string") return record[key];
    }
  }
  return fallback;
}

export class GovernanceGateway {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly accountDomain: string;
  private readonly linking = new Map<string, Promise<ServiceLink>>();
  private readonly atlasTokens = new Map<string, { token: string; until: number }>();

  constructor(
    private readonly store: Store,
    private readonly box: SecretBox,
    private readonly options: GatewayOptions,
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.accountDomain = options.accountDomain ?? "console.rootsystems.app";
  }

  trustProofUrl(): string | null {
    return this.options.trustProofUrl;
  }

  status(): { atlas: boolean; trustProof: boolean } {
    return { atlas: Boolean(this.options.atlasUrl), trustProof: Boolean(this.options.trustProofUrl) };
  }

  // ---------- plumbing ----------

  private requireConfigured(): { atlasUrl: string; trustProofUrl: string } {
    const { atlasUrl, trustProofUrl } = this.options;
    if (!atlasUrl || !trustProofUrl) {
      throw new AppError(503, "CONSOLE_NOT_CONFIGURED", "The Agent Governance console is not configured on this server.");
    }
    return { atlasUrl, trustProofUrl };
  }

  private async call(
    base: string,
    method: string,
    path: string,
    { body, token, cookie }: { body?: unknown; token?: string; cookie?: string } = {},
  ): Promise<UpstreamResult> {
    const headers: Record<string, string> = { Accept: "application/json", Origin: base };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (token) headers.Authorization = `Bearer ${token}`;
    if (cookie) headers.Cookie = cookie;
    if (this.options.serviceToken) headers["x-rootsystems-service"] = this.options.serviceToken;
    let response: Response;
    try {
      response = await this.fetchImpl(base + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "manual",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new AppError(502, "UPSTREAM_UNAVAILABLE", "A linked RootSystems service did not respond. Try again in a moment.");
    }
    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // keep the raw text
    }
    return { status: response.status, body: parsed, setCookie: response.headers.get("set-cookie") };
  }

  private fail(result: UpstreamResult, what: string): never {
    const message = upstreamMessage(result.body, `${what} failed.`);
    if (result.status === 400) throw new AppError(400, "VALIDATION_ERROR", message);
    if (result.status === 404) throw new AppError(404, "NOT_FOUND", message);
    if (result.status === 409) throw new AppError(409, "CONFLICT", message);
    if (result.status === 429) {
      // Name the busy service so the customer (and support) know what to wait for.
      const service = what.includes("Trust Proof") || what.includes("ledger") ? "Trust Proof" : "Authority Atlas";
      throw new AppError(429, "RATE_LIMITED", `${service} is busy right now (${what.toLowerCase()}). Please try again in a few minutes.`);
    }
    throw new AppError(502, "UPSTREAM_ERROR", `${what} failed (linked service answered ${result.status}).`);
  }

  // ---------- linking ----------

  async ensureLink(organization: Organization): Promise<ServiceLink> {
    const existing = await this.store.getServiceLink(organization.id);
    if (existing) return existing;
    // One link per workspace even if two requests arrive together.
    const pending = this.linking.get(organization.id);
    if (pending) return pending;
    const creating = this.createLink(organization).finally(() => this.linking.delete(organization.id));
    this.linking.set(organization.id, creating);
    return creating;
  }

  private async createLink(organization: Organization): Promise<ServiceLink> {
    const { atlasUrl, trustProofUrl } = this.requireConfigured();
    const tag = `${organization.id.slice(0, 8)}-${randomBytes(4).toString("hex")}`;
    const orgName = organization.name.trim().slice(0, 100) || "RootSystems workspace";

    const atlasEmail = `atlas-${tag}@${this.accountDomain}`;
    const atlasPassword = randomBytes(24).toString("base64url");
    const registered = await this.call(atlasUrl, "POST", "/register", {
      body: { email: atlasEmail, password: atlasPassword, name: "Agent Governance console", org: orgName },
    });
    if (registered.status !== 201) this.fail(registered, "Linking Authority Atlas");

    const trustProofEmail = `trustproof-${tag}@${this.accountDomain}`;
    const trustProofPassword = randomBytes(24).toString("base64url");
    const signup = await this.call(trustProofUrl, "POST", "/auth/signup", {
      body: { orgName: orgName.length >= 2 ? orgName : `${orgName} workspace`, name: "Agent Governance console", email: trustProofEmail, password: trustProofPassword },
    });
    const cookie = (signup.setCookie ?? "").split(";")[0];
    if (signup.status >= 300 || !cookie) this.fail(signup, "Linking Trust Proof");
    const keyResult = await this.call(trustProofUrl, "POST", "/api-keys", { body: { name: "Agent Governance console" }, cookie });
    const apiKey = (keyResult.body as { key?: unknown } | null)?.key;
    if (keyResult.status !== 201 || typeof apiKey !== "string") this.fail(keyResult, "Creating the Trust Proof API key");

    return this.store.saveServiceLink({
      organizationId: organization.id,
      atlasEmail,
      atlasSecret: this.box.seal(atlasPassword),
      trustProofEmail,
      trustProofSecret: this.box.seal(trustProofPassword),
      trustProofApiKey: this.box.seal(apiKey),
    });
  }

  private async atlasToken(organization: Organization): Promise<string> {
    const cached = this.atlasTokens.get(organization.id);
    if (cached && cached.until > Date.now()) return cached.token;
    const { atlasUrl } = this.requireConfigured();
    const link = await this.ensureLink(organization);
    const login = await this.call(atlasUrl, "POST", "/login", {
      body: { email: link.atlasEmail, password: this.box.open(link.atlasSecret) },
    });
    const code = (login.body as { code?: unknown } | null)?.code;
    if (login.status !== 200 || typeof code !== "string") this.fail(login, "Signing in to Authority Atlas");
    const exchange = await this.call(atlasUrl, "POST", "/token/exchange", { body: { code, client_id: ATLAS_CLIENT_ID } });
    const token = (exchange.body as { identity_token?: unknown } | null)?.identity_token;
    if (exchange.status !== 200 || typeof token !== "string") this.fail(exchange, "Signing in to Authority Atlas");
    this.atlasTokens.set(organization.id, { token, until: Date.now() + TOKEN_REUSE_MS });
    return token;
  }

  private async trustProofKey(organization: Organization): Promise<string> {
    const link = await this.ensureLink(organization);
    return this.box.open(link.trustProofApiKey);
  }

  // ---------- certificates (Authority Atlas) ----------

  async listCertificates(organization: Organization): Promise<AtlasCertificate[]> {
    const { atlasUrl } = this.requireConfigured();
    const result = await this.call(atlasUrl, "GET", "/agents/certificates", { token: await this.atlasToken(organization) });
    if (result.status !== 200) this.fail(result, "Listing certificates");
    return ((result.body as { certificates?: AtlasCertificate[] }).certificates ?? []);
  }

  async issueCertificate(organization: Organization, input: IssueCertificateInput) {
    const { atlasUrl } = this.requireConfigured();
    const result = await this.call(atlasUrl, "POST", "/agents/certificates", { body: input, token: await this.atlasToken(organization) });
    if (result.status !== 201) this.fail(result, "Issuing the certificate");
    const issued = result.body as { certificate: string; jti: string; agentId: string; expiresAt: string; pqSignature?: unknown };
    await this.store.addConsoleCertificate({
      jti: issued.jti,
      organizationId: organization.id,
      agentId: issued.agentId,
      certificate: issued.certificate,
      pqSignature: issued.pqSignature ?? null,
    });
    return issued;
  }

  async revokeCertificate(organization: Organization, jti: string): Promise<{ jti: string; revokedAt: string }> {
    const { atlasUrl } = this.requireConfigured();
    const result = await this.call(atlasUrl, "POST", `/agents/certificates/${encodeURIComponent(jti)}/revoke`, {
      body: {},
      token: await this.atlasToken(organization),
    });
    if (result.status !== 200) this.fail(result, "Revoking the certificate");
    return result.body as { jti: string; revokedAt: string };
  }

  async verifyCertificate(organization: Organization, jti: string) {
    const { atlasUrl } = this.requireConfigured();
    const stored = await this.store.getConsoleCertificate(organization.id, jti);
    if (!stored) throw new AppError(404, "NOT_FOUND", "This certificate was not issued from this workspace's console.");
    const result = await this.call(atlasUrl, "POST", "/agents/verify", {
      body: { certificate: stored.certificate, ...(stored.pqSignature ? { pqSignature: stored.pqSignature } : {}) },
    });
    if (result.status !== 200) this.fail(result, "Verifying the certificate");
    return { certificate: stored.certificate, pqSignature: stored.pqSignature, verification: result.body };
  }

  // ---------- ledger (Trust Proof) ----------

  async ledger(
    organization: Organization,
    filters: { agentId?: string; verdict?: "within_authority" | "outside_authority"; limit?: number },
  ): Promise<{ count: number; actions: LedgerAction[] }> {
    const { trustProofUrl } = this.requireConfigured();
    const query = new URLSearchParams();
    if (filters.agentId) query.set("agentId", filters.agentId);
    if (filters.verdict) query.set("verdict", filters.verdict);
    query.set("limit", String(filters.limit ?? 200));
    const result = await this.call(trustProofUrl, "GET", `/api/v1/agent-actions?${query.toString()}`, { token: await this.trustProofKey(organization) });
    if (result.status !== 200) this.fail(result, "Reading the action ledger");
    return result.body as { count: number; actions: LedgerAction[] };
  }

  async verifyLedger(organization: Organization): Promise<unknown> {
    const { trustProofUrl } = this.requireConfigured();
    const result = await this.call(trustProofUrl, "GET", "/api/v1/agent-actions/verify-chain", { token: await this.trustProofKey(organization) });
    if (result.status !== 200) this.fail(result, "Verifying the action ledger");
    return result.body;
  }

  // ---------- approvals (Trust Proof decisions signed by named people) ----------

  private async trustProofSession(email: string, password: string, what: string): Promise<string> {
    const { trustProofUrl } = this.requireConfigured();
    const login = await this.call(trustProofUrl, "POST", "/auth/login", { body: { email, password } });
    const cookie = (login.setCookie ?? "").split(";")[0];
    if (login.status === 401 || login.status === 400) {
      // 403, not 401: a wrong signing passphrase must not sign the person out of the console.
      throw new AppError(403, "INVALID_PASSPHRASE", "That signing passphrase is not correct.");
    }
    if (login.status >= 300 || !cookie) this.fail(login, what);
    return cookie;
  }

  // Creates a personal Trust Proof signer account for a workspace member. The passphrase becomes
  // that account's password and locks their signing keys; it is passed through once, never stored.
  async enrollSigner(organization: Organization, member: { id: string; name: string; email: string }, passphrase: string): Promise<string> {
    const { trustProofUrl } = this.requireConfigured();
    const link = await this.ensureLink(organization);
    const admin = await this.trustProofSession(link.trustProofEmail, this.box.open(link.trustProofSecret), "Signing in to Trust Proof");
    const result = await this.call(trustProofUrl, "POST", "/users", {
      body: { name: member.name, email: member.email, roles: ["signer"], initialPassword: passphrase },
      cookie: admin,
    });
    if (result.status === 409) {
      throw new AppError(409, "SIGNER_EMAIL_TAKEN", "This email already has a Trust Proof signing account. Contact RootSystems to link it.");
    }
    if (result.status === 400) throw new AppError(400, "VALIDATION_ERROR", upstreamMessage(result.body, "The passphrase was not accepted."));
    if (result.status >= 300) this.fail(result, "Creating the signing key");
    return member.email.toLowerCase();
  }

  async listDecisions(organization: Organization): Promise<unknown[]> {
    const { trustProofUrl } = this.requireConfigured();
    const result = await this.call(trustProofUrl, "GET", "/api/v1/decisions", { token: await this.trustProofKey(organization) });
    if (result.status !== 200) this.fail(result, "Listing approvals");
    return (result.body as { decisions?: unknown[] }).decisions ?? [];
  }

  async getDecision(organization: Organization, id: string): Promise<unknown> {
    const { trustProofUrl } = this.requireConfigured();
    const result = await this.call(trustProofUrl, "GET", `/api/v1/decisions/${encodeURIComponent(id)}`, { token: await this.trustProofKey(organization) });
    if (result.status !== 200) this.fail(result, "Reading the approval");
    return (result.body as { decision?: unknown }).decision;
  }

  async createDecision(
    organization: Organization,
    input: { decisionType: string; content: string; requiredSigners: string[]; proposedBy: string; externalRef?: string },
  ): Promise<unknown> {
    const { trustProofUrl } = this.requireConfigured();
    const result = await this.call(trustProofUrl, "POST", "/api/v1/decisions", {
      body: { ...input, framework: "Agent Governance" },
      token: await this.trustProofKey(organization),
    });
    if (result.status !== 201) this.fail(result, "Creating the approval request");
    return (result.body as { decision?: unknown }).decision ?? result.body;
  }

  async signDecision(
    organization: Organization,
    signerEmail: string,
    id: string,
    passphrase: string,
    decline?: { reason?: string },
  ): Promise<unknown> {
    const { trustProofUrl } = this.requireConfigured();
    await this.ensureLink(organization);
    const session = await this.trustProofSession(signerEmail, passphrase, "Signing in to Trust Proof");
    const path = `/decisions/${encodeURIComponent(id)}/${decline ? "decline" : "sign"}`;
    const result = await this.call(trustProofUrl, "POST", path, {
      body: decline ? { password: passphrase, ...(decline.reason ? { reason: decline.reason } : {}) } : { password: passphrase },
      cookie: session,
    });
    if (result.status === 403 || result.status === 409) {
      throw new AppError(result.status, "SIGNING_REFUSED", upstreamMessage(result.body, "Trust Proof refused this signature."));
    }
    if (result.status !== 201 && result.status !== 200) this.fail(result, decline ? "Declining" : "Signing");
    return result.body;
  }

  // What an agent runtime needs to report its actions: the Trust Proof address and this workspace's
  // key. Shown only to workspace admins.
  async agentConnection(organization: Organization): Promise<{ trustProofUrl: string; apiKey: string }> {
    const { trustProofUrl } = this.requireConfigured();
    return { trustProofUrl, apiKey: await this.trustProofKey(organization) };
  }
}
