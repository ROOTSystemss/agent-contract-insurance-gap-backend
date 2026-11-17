import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// Knock-out 2026-11-16 (S-11): two-factor sign-in for the AI Agent Trust console, the same rules as Offboarding
// Proof, Vendor Risk, HIPAA and Standards Readiness:
// - TOTP (RFC 6238: HMAC-SHA1, 6 digits, 30-second steps), any authenticator app.
// - Owners and Admins without it are prompted; nobody is locked out.
// - Once on, every sign-in returns a pending state; the code (or a one-time recovery code) issues the tokens.
// - The secret is sealed at rest (field vault); recovery codes are stored only as SHA-256 hashes and each works
//   once; a code is accepted at most once (last used step).
// - Turning it off needs the password AND a current code (or a recovery code).

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const STEP_SECONDS = 30;
const WINDOW = 1;
const ISSUER = "AI Agent Trust";

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str: string): Buffer {
  const clean = String(str || "").toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | ALPHABET.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export const newSecret = (): string => base32Encode(randomBytes(20));
export const stepAt = (ms = Date.now()): number => Math.floor(ms / 1000 / STEP_SECONDS);

export function codeAt(secretB32: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = createHmac("sha1", base32Decode(secretB32)).update(counter).digest();
  const o = h[h.length - 1]! & 15;
  const n = ((h[o]! & 127) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!;
  return String(n % 1e6).padStart(6, "0");
}

// The matching step, or null. lastStep: the last step already used (replay protection).
export function matchStep(secretB32: string, code: string, { now = Date.now(), lastStep = -1 } = {}): number | null {
  const c = String(code || "").replace(/\s+/g, "");
  if (!/^\d{6}$/.test(c)) return null;
  const s = stepAt(now);
  for (let d = -WINDOW; d <= WINDOW; d++) {
    const step = s + d;
    if (step <= lastStep) continue;
    if (timingSafeEqual(Buffer.from(codeAt(secretB32, step)), Buffer.from(c))) return step;
  }
  return null;
}

export const otpauthUri = (email: string, secretB32: string): string =>
  "otpauth://totp/" + encodeURIComponent(ISSUER + ":" + email) + "?secret=" + secretB32 + "&issuer=" + encodeURIComponent(ISSUER) + "&algorithm=SHA1&digits=6&period=" + STEP_SECONDS;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const normRecovery = (s: string): string => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
export const hashRecovery = (code: string): string => sha256(normRecovery(code));
export function newRecoveryCodes(n = 8): string[] {
  return Array.from({ length: n }, () => { const h = randomBytes(5).toString("hex"); return h.slice(0, 5) + "-" + h.slice(5); });
}

// A TOTP code (returns its step) or one unused recovery code (returns the remaining hashes).
export function checkCode(
  record: { secret: string; lastStep: number | null; recoveryHashes: string[] },
  input: string,
  now = Date.now(),
): { ok: false } | { ok: true; method: "app"; step: number } | { ok: true; method: "recovery"; remaining: string[] } {
  const step = matchStep(record.secret, input, { now, lastStep: record.lastStep ?? -1 });
  if (step !== null) return { ok: true, method: "app", step };
  const norm = normRecovery(input);
  if (norm.length === 10) {
    const h = sha256(norm);
    if (record.recoveryHashes.includes(h)) return { ok: true, method: "recovery", remaining: record.recoveryHashes.filter((x) => x !== h) };
  }
  return { ok: false };
}

// Pending sign-in (password right, code still needed): a short HMAC-signed ticket, never a JWT, so it can never be
// accepted as an access token. Single use and 10 minutes.
export function pendingTickets(secret: string, { ttlMs = 10 * 60 * 1000, now = Date.now } = {}) {
  const key = createHmac("sha256", secret).update("two-factor-pending-v1").digest();
  const used = new Map<string, number>();
  const mac = (body: string) => createHmac("sha256", key).update(body).digest("base64url");
  return {
    issue(userId: string, organizationId: string, role: string): string {
      const body = Buffer.from(JSON.stringify({ u: userId, o: organizationId, r: role, e: now() + ttlMs, n: randomBytes(9).toString("base64url") })).toString("base64url");
      return body + "." + mac(body);
    },
    // Reads a ticket without spending it (for wrong-code retries); null when forged, expired or spent.
    read(ticket: string): { userId: string; organizationId: string; role: string; nonce: string } | null {
      const [body, sig] = String(ticket || "").split(".");
      if (!body || !sig) return null;
      const want = Buffer.from(mac(body));
      const got = Buffer.from(sig);
      if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
      let p: { u: string; o: string; r: string; e: number; n: string };
      try { p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { return null; }
      if (!p || typeof p.e !== "number" || p.e < now() || used.has(p.n)) return null;
      return { userId: p.u, organizationId: p.o, role: p.r, nonce: p.n };
    },
    spend(nonce: string): void {
      const t = now();
      for (const [n, until] of used) if (until < t) used.delete(n);
      used.set(nonce, t + ttlMs);
    },
  };
}
