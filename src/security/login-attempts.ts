import { createHmac, timingSafeEqual } from "node:crypto";

// Failed sign-in limiter, the same rules as Vendor Risk and HIPAA (BIG-FIX-1 B2 + QA fix 2026-11-14):
//  - 8 sign-ins for one account from one client address per 15 minutes, then that address waits;
//  - a per-account backstop of 30 per 15 minutes from anywhere, so rotating addresses does not help an attacker.
//    A browser that has signed in to the account before (a signed "known device" cookie) skips the backstop,
//    so someone hammering an email from elsewhere cannot lock its owner out;
//  - the attempt is counted BEFORE the slow password check, so parallel tries cannot slip past;
//  - a correct password gives the attempt back and clears the address + account counter.
// Bounded and in memory (one instance on Render). The client address comes from the TRUST_PROXY_HOPS setting.

export const PER_IP_EMAIL = 8;
export const PER_EMAIL = 30;
export const WINDOW_MS = 15 * 60 * 1000;

interface Entry { count: number; until: number }

export interface LoginAttempts {
  attempt(ip: string, email: string, options?: { knownDevice?: boolean }): boolean;
  retryAfter(ip: string, email: string, options?: { knownDevice?: boolean }): number;
  succeeded(ip: string, email: string): void;
  forget(email: string): void;
}

export function createLoginAttempts({ now = Date.now, windowMs = WINDOW_MS, maximum = 10_000, perIpEmail = PER_IP_EMAIL, perEmail = PER_EMAIL } = {}): LoginAttempts {
  const entries = new Map<string, Entry>();
  const norm = (email: string) => String(email || "").trim().toLowerCase();
  const keysFor = (ip: string, email: string) => [JSON.stringify(["ip+email", String(ip), norm(email)]), JSON.stringify(["email", norm(email)])] as const;
  const prune = () => { const t = now(); for (const [key, value] of entries) if (value.until <= t) entries.delete(key); };
  const countOf = (key: string) => entries.get(key)?.count ?? 0;
  const bump = (key: string) => {
    if (!entries.has(key) && entries.size >= maximum) entries.delete(entries.keys().next().value as string);
    const value = entries.get(key) ?? { count: 0, until: now() + windowMs };
    value.count += 1;
    entries.set(key, value);
  };
  const over = (ip: string, email: string, knownDevice: boolean) => {
    const [both, mail] = keysFor(ip, email);
    return countOf(both) >= perIpEmail || (!knownDevice && countOf(mail) >= perEmail);
  };
  return {
    attempt(ip, email, { knownDevice = false } = {}) {
      prune();
      if (over(ip, email, knownDevice)) return false;
      const [both, mail] = keysFor(ip, email);
      bump(both);
      bump(mail);
      return true;
    },
    retryAfter(ip, email, { knownDevice = false } = {}) {
      const [both, mail] = keysFor(ip, email);
      const ends = [entries.get(both), knownDevice ? undefined : entries.get(mail)].filter((v): v is Entry => Boolean(v)).map((v) => v.until);
      return ends.length ? Math.max(1, Math.ceil((Math.max(...ends) - now()) / 1000)) : 0;
    },
    succeeded(ip, email) {
      const [both, mail] = keysFor(ip, email);
      entries.delete(both);
      const m = entries.get(mail);
      if (m && m.count > 0) m.count -= 1;
    },
    // After a password reset the account starts clean everywhere.
    forget(email) {
      const target = norm(email);
      for (const key of [...entries.keys()]) {
        const parsed = JSON.parse(key) as string[];
        if (parsed[parsed.length - 1] === target) entries.delete(key);
      }
    },
  };
}

// ----- Known devices -----
// A cookie holding up to 5 short HMAC tags, one per account this browser has signed in to. A tag is
// HMAC(secret, "known-device:" + email); it cannot be made up without the server secret.
export const DEVICE_COOKIE = "rootsystems.acg.dev";
const MAX_TAGS = 5;
const TAG_RE = /^[A-Za-z0-9_-]{22}$/;

export function knownDevices(secret: string) {
  const tagFor = (email: string) => createHmac("sha256", secret).update("known-device:" + String(email || "").trim().toLowerCase()).digest("base64url").slice(0, 22);
  const readTags = (cookieHeader: string | undefined) => {
    const raw = String(cookieHeader || "").split(/;\s*/).find((c) => c.startsWith(DEVICE_COOKIE + "="));
    if (!raw) return [];
    try {
      return decodeURIComponent(raw.slice(DEVICE_COOKIE.length + 1)).split(".").filter((t) => TAG_RE.test(t));
    } catch {
      return [];
    }
  };
  return {
    isKnown(cookieHeader: string | undefined, email: string): boolean {
      const want = Buffer.from(tagFor(email));
      return readTags(cookieHeader).some((t) => { const b = Buffer.from(t); return b.length === want.length && timingSafeEqual(b, want); });
    },
    // The Set-Cookie value that adds this account to the browser's known devices (180 days).
    cookieFor(cookieHeader: string | undefined, email: string, secure: boolean): string {
      const tag = tagFor(email);
      const tags = [tag, ...readTags(cookieHeader).filter((t) => t !== tag)].slice(0, MAX_TAGS);
      return `${DEVICE_COOKIE}=${encodeURIComponent(tags.join("."))}; Path=/api/v1/auth; Max-Age=${180 * 24 * 3600}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
    },
  };
}
