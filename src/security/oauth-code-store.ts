import { randomBytes } from "node:crypto";

interface IssuedCode {
  userId: string;
  organizationId: string;
  clientId: string;
  redirectUri: string;
  expiresAt: number;
}

export interface OAuthCodeSubject {
  userId: string;
  organizationId: string;
}

/**
 * One-time authorization codes for the minimal "Sign in with Authority Atlas" OAuth
 * bridge. Deliberately in-memory, not persisted: codes live tens of seconds, must
 * never survive a restart, and this codebase already assumes a single trusted
 * instance (see the document-retention sweep in src/app.ts, and the QA harness
 * running Atlas with PERSISTENCE_DRIVER=memory). If Atlas is ever horizontally
 * scaled, this must move to a shared store (Redis, or a short-lived Postgres
 * table) — /authorize and /token can be hit by different instances of the process.
 */
export class OAuthCodeStore {
  private readonly codes = new Map<string, IssuedCode>();
  private readonly sweepTimer: NodeJS.Timeout;

  constructor(private readonly ttlMs: number) {
    this.sweepTimer = setInterval(() => this.sweep(), Math.min(ttlMs, 60_000));
    this.sweepTimer.unref();
  }

  issue(subject: {
    userId: string;
    organizationId: string;
    clientId: string;
    redirectUri: string;
  }): string {
    const code = randomBytes(32).toString("base64url");
    this.codes.set(code, { ...subject, expiresAt: Date.now() + this.ttlMs });
    return code;
  }

  /**
   * Single-use, race-safe within one process: the check-and-delete happens
   * synchronously with no `await` in between, so a concurrent redemption of the
   * same code cannot both succeed.
   */
  consume(
    code: string,
    expected: { clientId: string; redirectUri: string },
  ): OAuthCodeSubject | null {
    const issued = this.codes.get(code);
    if (!issued) return null;
    this.codes.delete(code);
    if (issued.expiresAt < Date.now()) return null;
    if (issued.clientId !== expected.clientId) return null;
    if (issued.redirectUri !== expected.redirectUri) return null;
    return { userId: issued.userId, organizationId: issued.organizationId };
  }

  private sweep(): void {
    const now = Date.now();
    for (const [code, issued] of this.codes) {
      if (issued.expiresAt < now) this.codes.delete(code);
    }
  }

  stop(): void {
    clearInterval(this.sweepTimer);
  }
}
