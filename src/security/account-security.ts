import { createHash, randomBytes } from "node:crypto";
import type { AppConfig } from "../config/env.js";
import type { AuthTokenPurpose, User } from "../domain/types.js";
import type { Store } from "../persistence/store.js";
import { AppError } from "../shared/errors.js";
import { resetMessage, verificationMessage, type Mailer, type MailResult } from "./mailer.js";

// Email verification and password reset (QA 2026-11-14 H3), on the same rules as Offboarding Proof:
//  - required in production; off in development and tests unless EMAIL_VERIFICATION=1; EMAIL_VERIFICATION=0
//    turns it off anywhere (the startup log says so);
//  - an unverified account can sign in and work privately, but cannot create anything signed or shown to
//    third parties (requireVerified);
//  - links are one-time, expire (48 hours / 60 minutes), carry the token in the URL fragment so it never
//    reaches server logs, and only the token's SHA-256 is stored.

export const VERIFY_TOKEN_HOURS = 48;
export const RESET_TOKEN_MINUTES = 60;
const PRODUCT = "AI Agent Trust";
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
// At most this many emails of one kind per account per hour, whatever is asked.
const SENDS_PER_HOUR = 3;

export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

export function verificationRequired(config: Pick<AppConfig, "NODE_ENV" | "EMAIL_VERIFICATION">): boolean {
  if (config.EMAIL_VERIFICATION === "0") return false;
  return config.NODE_ENV === "production" || config.EMAIL_VERIFICATION === "1";
}

export class AccountSecurity {
  private readonly sends = new Map<string, { count: number; until: number }>();

  constructor(
    private readonly store: Store,
    private readonly mailer: Mailer,
    private readonly config: Pick<AppConfig, "NODE_ENV" | "EMAIL_VERIFICATION" | "PUBLIC_BASE_URL">,
  ) {}

  get required(): boolean {
    return verificationRequired(this.config);
  }

  isVerified(user: Pick<User, "emailVerifiedAt">): boolean {
    return Boolean(user.emailVerifiedAt);
  }

  private link(kind: "verify" | "reset", token: string): string {
    return `${new URL(this.config.PUBLIC_BASE_URL).origin}/account#${kind}=${token}`;
  }

  private allowSend(key: string): boolean {
    const now = Date.now();
    for (const [k, v] of this.sends) if (v.until <= now) this.sends.delete(k);
    const entry = this.sends.get(key) ?? { count: 0, until: now + 3_600_000 };
    if (entry.count >= SENDS_PER_HOUR) return false;
    entry.count += 1;
    this.sends.set(key, entry);
    return true;
  }

  private async issue(userId: string, purpose: AuthTokenPurpose, ttlMs: number): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    await this.store.saveAuthToken({ userId, purpose, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + ttlMs).toISOString() });
    return token;
  }

  // Never throws: a mail problem must not fail the request that triggered it.
  async sendVerification(user: User): Promise<MailResult | { sent: false; reason: "throttled" | "error" }> {
    try {
      if (!this.allowSend(`verify:${user.id}`)) return { sent: false, reason: "throttled" };
      const token = await this.issue(user.id, "verify_email", VERIFY_TOKEN_HOURS * 3_600_000);
      return await this.mailer.send(verificationMessage(PRODUCT, user.email, this.link("verify", token), VERIFY_TOKEN_HOURS));
    } catch {
      return { sent: false, reason: "error" };
    }
  }

  async sendReset(user: User): Promise<MailResult | { sent: false; reason: "throttled" | "error" }> {
    try {
      if (!this.allowSend(`reset:${user.id}`)) return { sent: false, reason: "throttled" };
      const token = await this.issue(user.id, "reset_password", RESET_TOKEN_MINUTES * 60_000);
      return await this.mailer.send(resetMessage(PRODUCT, user.email, this.link("reset", token), RESET_TOKEN_MINUTES));
    } catch {
      return { sent: false, reason: "error" };
    }
  }

  // The user id the token belongs to, once; null for anything else.
  async consume(token: unknown, purpose: AuthTokenPurpose): Promise<string | null> {
    if (typeof token !== "string" || !TOKEN_RE.test(token)) return null;
    const claimed = await this.store.consumeAuthToken(hashToken(token), purpose, new Date().toISOString());
    return claimed ? claimed.userId : null;
  }

  async requireVerified(userId: string): Promise<void> {
    if (!this.required) return;
    const user = await this.store.getUser(userId);
    if (user && this.isVerified(user)) return;
    throw new AppError(
      403,
      "EMAIL_NOT_VERIFIED",
      "Confirm your email address first: open the link we emailed you. You can send a new link from the notice at the top of the page.",
    );
  }
}
