import { createHash, randomBytes, verify as nodeVerify, X509Certificate } from "node:crypto";

// RFC 3161 timestamps for Assurance Packs (RootSystems Trunk): an independent timestamp authority
// signs "this contentHash existed at this time". A TypeScript port of rootsystems-core's der.js +
// tsa.js (claude/rfc3161 fd66daa), kept behaviour-for-behaviour identical so a token from any
// RootSystems product verifies the same way.
//
// verifyTimestampToken() checks, offline: the token stamps exactly this hash (and our nonce, when
// given); the TSA's CMS signature over the signed attributes, and that the signed messageDigest
// matches the timestamp content; the signing certificate is marked for time-stamping and was valid at
// the stamped time; with trustedRoots (PEM), the chain up to one of them. Without trustedRoots it says
// plainly that the chain was not checked. This VERIFIES third-party RSA/ECDSA signatures (TSAs do not
// offer post-quantum ones yet); it never signs with them.

export const DEFAULT_TSA_URL = "http://timestamp.digicert.com";

// ---- just enough ASN.1 DER to build a request and read the reply ----
interface DerElement {
  tag: number;
  len: number;
  end: number;
  value: Buffer;
  raw: Buffer;
}

function encodeLength(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n = Math.floor(n / 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag: number, content: Buffer) =>
  Buffer.concat([Buffer.from([tag]), encodeLength(content.length), content]);
const seq = (...parts: Buffer[]) => tlv(0x30, Buffer.concat(parts));
const octets = (buf: Buffer) => tlv(0x04, buf);
const nul = () => Buffer.from([0x05, 0x00]);
const bool = (v: boolean) => Buffer.from([0x01, 0x01, v ? 0xff : 0x00]);
function int(buf: Buffer): Buffer {
  let b = Buffer.from(buf);
  while (b.length > 1 && b[0] === 0 && !(b[1]! & 0x80)) b = b.subarray(1);
  if (b[0]! & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
}
function oid(dotted: string): Buffer {
  const arcs = dotted.split(".").map(Number);
  const out = [40 * arcs[0]! + arcs[1]!];
  for (const arc of arcs.slice(2)) {
    const stack = [arc & 0x7f];
    let v = Math.floor(arc / 128);
    while (v > 0) {
      stack.unshift((v & 0x7f) | 0x80);
      v = Math.floor(v / 128);
    }
    out.push(...stack);
  }
  return tlv(0x06, Buffer.from(out));
}
function read(buf: Buffer, offset = 0): DerElement {
  if (offset + 2 > buf.length) throw new Error("DER: truncated header");
  const tag = buf[offset]!;
  let len = buf[offset + 1]!;
  let headerLen = 2;
  if (len & 0x80) {
    const count = len & 0x7f;
    if (count === 0 || count > 4) throw new Error("DER: unsupported length");
    len = 0;
    for (let i = 0; i < count; i++) len = len * 256 + buf[offset + 2 + i]!;
    headerLen += count;
  }
  const start = offset + headerLen;
  const end = start + len;
  if (end > buf.length) throw new Error("DER: element runs past the end");
  return { tag, len, end, value: buf.subarray(start, end), raw: buf.subarray(offset, end) };
}
function children(el: DerElement | undefined): DerElement[] {
  if (!el) throw new Error("DER: missing element");
  const out: DerElement[] = [];
  let off = 0;
  while (off < el.value.length) {
    const c = read(el.value, off);
    out.push(c);
    off = c.end;
  }
  return out;
}
function decodeOid(el: DerElement | undefined): string {
  if (!el) throw new Error("DER: missing OID");
  const b = el.value;
  const arcs = [Math.floor(b[0]! / 40), b[0]! % 40];
  let v = 0;
  for (let i = 1; i < b.length; i++) {
    v = v * 128 + (b[i]! & 0x7f);
    if (!(b[i]! & 0x80)) {
      arcs.push(v);
      v = 0;
    }
  }
  return arcs.join(".");
}
const decodeInt = (el: DerElement | undefined) => BigInt("0x" + (el?.value.toString("hex") || "0"));
function decodeGeneralizedTime(el: DerElement | undefined): string {
  const s = el?.value.toString("ascii") ?? "";
  const m = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\.\d+)?Z$/);
  if (!m) throw new Error("DER: unsupported GeneralizedTime " + s);
  return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7] || ""}Z`).toISOString();
}

// ---- RFC 3161 ----
const OID = {
  sha256: "2.16.840.1.101.3.4.2.1",
  sha384: "2.16.840.1.101.3.4.2.2",
  sha512: "2.16.840.1.101.3.4.2.3",
  signedData: "1.2.840.113549.1.7.2",
  tstInfo: "1.2.840.113549.1.9.16.1.4",
  messageDigest: "1.2.840.113549.1.9.4",
  rsa: "1.2.840.113549.1.1.1",
  sha256Rsa: "1.2.840.113549.1.1.11",
  sha384Rsa: "1.2.840.113549.1.1.12",
  sha512Rsa: "1.2.840.113549.1.1.13",
  ecdsaSha256: "1.2.840.10045.4.3.2",
  ecdsaSha384: "1.2.840.10045.4.3.3",
  ecdsaSha512: "1.2.840.10045.4.3.4",
  timeStamping: "1.3.6.1.5.5.7.3.8",
};
const HASH_BY_OID: Record<string, string> = {
  [OID.sha256]: "sha256",
  [OID.sha384]: "sha384",
  [OID.sha512]: "sha512",
};
const SIG_HASH: Record<string, string> = {
  [OID.sha256Rsa]: "sha256",
  [OID.sha384Rsa]: "sha384",
  [OID.sha512Rsa]: "sha512",
  [OID.ecdsaSha256]: "sha256",
  [OID.ecdsaSha384]: "sha384",
  [OID.ecdsaSha512]: "sha512",
};

// A request stamping a SHA-256 digest (here: the Assurance Pack's contentHash).
export function buildRequest(sha256Hex: string, nonce: Buffer = randomBytes(8)) {
  const digest = Buffer.from(sha256Hex, "hex");
  if (digest.length !== 32) throw new Error("buildRequest needs a 64-char SHA-256 hex digest.");
  const req = seq(
    int(Buffer.from([1])),
    seq(seq(oid(OID.sha256), nul()), octets(digest)),
    int(nonce),
    bool(true),
  );
  return { der: req, nonceHex: nonce.toString("hex") };
}

export interface Rfc3161Stamp {
  tokenBase64: string;
  genTime: string;
  tsa: string;
  nonceHex: string;
}

// Sends a request to a TSA and checks the reply before returning it.
export async function requestTimestamp(
  sha256Hex: string,
  tsaUrl: string = DEFAULT_TSA_URL,
  {
    fetchImpl = globalThis.fetch,
    timeoutMs = 15000,
  }: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<Rfc3161Stamp> {
  const { der: body, nonceHex } = buildRequest(sha256Hex);
  const res = await fetchImpl(tsaUrl, {
    method: "POST",
    headers: { "Content-Type": "application/timestamp-query" },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`TSA answered HTTP ${res.status}`);
  const token = extractToken(Buffer.from(await res.arrayBuffer()));
  const check = verifyTimestampToken(token, sha256Hex, { nonceHex });
  if (!check.valid) throw new Error("TSA reply did not verify: " + check.reason);
  return { tokenBase64: token.toString("base64"), genTime: check.genTime!, tsa: tsaUrl, nonceHex };
}

export function extractToken(reply: Buffer): Buffer {
  const [statusInfo, token] = children(read(reply));
  const status = Number(decodeInt(children(statusInfo)[0]));
  if (status !== 0 && status !== 1) throw new Error(`TSA refused the request (status ${status})`);
  if (!token) throw new Error("TSA reply has no token");
  return Buffer.from(token.raw);
}

interface ParsedToken {
  tstDer: Buffer;
  certs: X509Certificate[];
  signerInfo: DerElement;
  imprintAlg: string;
  imprint: string;
  genTime: string;
  policy: string;
  serial: string;
  nonceHex: string | null;
}

function parseToken(tokenDer: Buffer): ParsedToken {
  const [ctype, ctx] = children(read(tokenDer));
  if (decodeOid(ctype) !== OID.signedData) throw new Error("not CMS SignedData");
  const sd = children(children(ctx)[0]);
  const encap = sd.find((c, i) => i > 1 && c.tag === 0x30);
  const [eType, eCtx] = children(encap);
  if (decodeOid(eType) !== OID.tstInfo) throw new Error("not a timestamp token");
  const tstDer = children(eCtx)[0]!.value;
  const certsEl = sd.find((c) => c.tag === 0xa0);
  const certs = certsEl
    ? children(certsEl)
        .filter((c) => c.tag === 0x30)
        .map((c) => new X509Certificate(Buffer.from(c.raw)))
    : [];
  const signerInfo = children(sd[sd.length - 1])[0]!;
  const t = children(read(tstDer));
  const mi = children(t[2]);
  const nonceEl = t.slice(5).find((c) => c.tag === 0x02);
  return {
    tstDer: Buffer.from(tstDer),
    certs,
    signerInfo,
    imprintAlg: decodeOid(children(mi[0])[0]),
    imprint: mi[1]!.value.toString("hex"),
    genTime: decodeGeneralizedTime(t[4]),
    policy: decodeOid(t[1]),
    serial: decodeInt(t[3]).toString(16),
    nonceHex: nonceEl ? nonceEl.value.toString("hex").replace(/^00/, "") : null,
  };
}

function checkSignature(
  p: ParsedToken,
): { ok: true; signer: X509Certificate } | { ok: false; reason: string } {
  const si = children(p.signerInfo);
  const digestAlg = HASH_BY_OID[decodeOid(children(si[2])[0])];
  const signedAttrs = si.find((c) => c.tag === 0xa0);
  if (!digestAlg || !signedAttrs) return { ok: false, reason: "unsupported_signer_info" };
  const sigAlg = decodeOid(children(si[4])[0]);
  const signature = si[5]!.value;
  const md = children(signedAttrs).find(
    (attr) => decodeOid(children(attr)[0]) === OID.messageDigest,
  );
  if (!md) return { ok: false, reason: "no_message_digest" };
  const signedDigest = children(children(md)[1])[0]!.value.toString("hex");
  if (signedDigest !== createHash(digestAlg).update(p.tstDer).digest("hex"))
    return { ok: false, reason: "message_digest_mismatch" };
  // The signature covers the signed attributes re-tagged as a SET (0x31), per RFC 5652.
  const toVerify = Buffer.concat([Buffer.from([0x31]), Buffer.from(signedAttrs.raw.subarray(1))]);
  const hash = SIG_HASH[sigAlg] ?? (sigAlg === OID.rsa ? digestAlg : null);
  if (!hash) return { ok: false, reason: "unsupported_signature_algorithm " + sigAlg };
  const signer = p.certs.find((c) => {
    try {
      return nodeVerify(hash, toVerify, c.publicKey, signature);
    } catch {
      return false;
    }
  });
  return signer ? { ok: true, signer } : { ok: false, reason: "bad_signature" };
}

function chainToRoot(
  cert: X509Certificate,
  pool: X509Certificate[],
  roots: X509Certificate[],
): boolean {
  let current = cert;
  for (let depth = 0; depth < 6; depth++) {
    if (roots.some((r) => current.checkIssued(r) && current.verify(r.publicKey))) return true;
    const next = pool.find(
      (c) => c !== current && current.checkIssued(c) && current.verify(c.publicKey),
    );
    if (!next) return false;
    current = next;
  }
  return false;
}

export interface TimestampCheck {
  valid: boolean;
  reason?: string;
  genTime?: string;
  tsaSubject?: string;
  serial?: string;
  policy?: string;
  chain?: "not_checked" | "trusted";
}

export function verifyTimestampToken(
  token: Buffer | string,
  sha256Hex: string,
  { nonceHex, trustedRoots }: { nonceHex?: string; trustedRoots?: string[] } = {},
): TimestampCheck {
  let p: ParsedToken;
  try {
    p = parseToken(Buffer.isBuffer(token) ? token : Buffer.from(token, "base64"));
  } catch (e) {
    return { valid: false, reason: "unreadable_token: " + (e as Error).message };
  }
  if (p.imprintAlg !== OID.sha256 || p.imprint !== String(sha256Hex).toLowerCase())
    return { valid: false, reason: "stamps_a_different_hash" };
  if (
    nonceHex &&
    p.nonceHex !== nonceHex.toLowerCase().replace(/^0+/, "") &&
    p.nonceHex !== nonceHex.toLowerCase()
  )
    return { valid: false, reason: "nonce_mismatch" };
  const sig = checkSignature(p);
  if (!sig.ok) return { valid: false, reason: sig.reason };
  if (!(sig.signer.keyUsage || []).includes(OID.timeStamping))
    return { valid: false, reason: "signer_not_a_timestamping_certificate" };
  const at = Date.parse(p.genTime);
  if (at < Date.parse(sig.signer.validFrom) || at > Date.parse(sig.signer.validTo))
    return { valid: false, reason: "certificate_not_valid_at_stamp_time" };
  let chain: "not_checked" | "trusted" = "not_checked";
  if (trustedRoots && trustedRoots.length) {
    if (
      !chainToRoot(
        sig.signer,
        p.certs,
        trustedRoots.map((pem) => new X509Certificate(pem)),
      )
    )
      return { valid: false, reason: "chain_does_not_reach_a_trusted_root" };
    chain = "trusted";
  }
  return {
    valid: true,
    genTime: p.genTime,
    tsaSubject: sig.signer.subject.replace(/\n/g, ", "),
    serial: p.serial,
    policy: p.policy,
    chain,
  };
}
