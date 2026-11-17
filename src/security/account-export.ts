import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { recordReceipt } from "../evidence/receipts.js";
import { ACCOUNT_EXPORT_SCHEMA, signDocument } from "../reports/signed-document.js";

// AD-077 (knock-out 2026-11-17): self-serve export for a workspace owner or admin. One ZIP: account.json (the
// signed-in person), workspace/<Model>.json for every kind of record the workspace holds (decrypted), the uploaded
// contract/insurance files that are still kept, secrets-excluded.json, README.txt, and export-manifest.json: the
// SHA-256 of every file, signed in the Agent Assurance Pack format so the public /verify checks it (kind
// "account-export"). An "account-export" Evidence Notary receipt records the manifest's content hash.

export interface ExportFile { name: string; data: Buffer }

// Values left out on purpose: each would let someone act as the person, the workspace or its agents.
export const EXCLUDED: Record<string, Record<string, string>> = {
  User: { passwordHash: "password hash", emailHash: "keyed email index (internal lookup value)" },
  UserTwoFactor: { secret: "two-factor secret", recoveryHashes: "two-factor recovery code hashes", lastStep: "two-factor replay counter" },
  AuthToken: { tokenHash: "one-time link hash (email confirmation / password reset)" },
  ServiceLink: { atlasSecret: "Agent Certificates service credential", trustProofSecret: "Trust Proof service credential", trustProofApiKey: "Trust Proof API key (agents use it to report actions)" },
  ConsoleCertificate: { certificate: "the agent certificate token itself (works as the agent's credential); its id, agent and dates are kept" },
};

function strip(model: string, row: unknown): unknown {
  if (!row || typeof row !== "object") return row;
  const out: Record<string, unknown> = {};
  const excluded = EXCLUDED[model] ?? {};
  for (const [k, v] of Object.entries(row as Record<string, unknown>)) if (!(k in excluded)) out[k] = v;
  return out;
}

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const json = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + "\n", "utf8");

export async function buildAccountExport(app: FastifyInstance, userId: string, organizationId: string): Promise<{ files: ExportFile[]; receiptSeq: number | null; contentHash: string }> {
  const files: ExportFile[] = [];
  const user = await app.store.exportUserData(userId);
  const account: Record<string, unknown> = {};
  for (const [model, rows] of Object.entries(user)) account[model] = rows.map((r) => strip(model, r));
  account.twoFactorEnabled = (user.UserTwoFactor ?? []).some((t) => Boolean((t as { enabledAt?: unknown }).enabledAt));
  files.push({ name: "account.json", data: json(account) });

  const org = await app.store.exportOrganizationData(organizationId);
  for (const [model, rows] of Object.entries(org)) files.push({ name: `workspace/${model}.json`, data: json(rows.map((r) => strip(model, r))) });
  const missing: string[] = [];
  for (const doc of (org.Document ?? []) as Array<{ id: string; storageKey?: string; safeFilename?: string; deletedAt?: unknown }>) {
    if (doc.deletedAt || !doc.storageKey) continue;
    try { files.push({ name: `workspace/files/${doc.id}-${String(doc.safeFilename ?? "document").replace(/[^A-Za-z0-9._-]/g, "_")}`, data: await app.documentStorage.get(doc.storageKey) }); }
    catch { missing.push(doc.id); }
  }

  const excluded = Object.entries(EXCLUDED).flatMap(([model, cols]) => Object.entries(cols).map(([field, why]) => ({ model, field, why })));
  excluded.push({ model: "(none)", field: "signing keys", why: "the service's signing keys are not account data; the public keys are at /.well-known/rootsystems-signing-keys.json" });
  files.push({ name: "secrets-excluded.json", data: json({ note: "These values were left out on purpose: each would let someone act as you, your workspace or your agents.", excluded, filesNoLongerReadable: missing }) });
  files.push({ name: "README.txt", data: Buffer.from([
    "AI Agent Trust - your data export",
    "",
    "account.json      your account (no password or two-factor secrets) and your workspace memberships",
    "workspace/        one JSON file per kind of record this workspace holds, decrypted for you; workspace/files/ holds the",
    "                  uploaded documents still kept (they are deleted after their retention date)",
    "secrets-excluded.json  what was left out on purpose and why",
    "export-manifest.json   the SHA-256 of every file, signed (ML-DSA-65). Check it on the public /verify page (paste it as",
    "                  an Agent Assurance Pack): it reads 'account-export'. A receipt for it is on your Receipts list.",
    "",
    "Records kept by the separate Agent Certificates and Trust Proof services are not in this file.",
  ].join("\r\n") + "\r\n", "utf8") });

  const doc = { schema: ACCOUNT_EXPORT_SCHEMA, generatedAt: new Date().toISOString(), organizationId, files: files.map((f) => ({ name: f.name, bytes: f.data.length, sha256: sha256(f.data) })) };
  const signed = signDocument(doc, app.pqSigner);
  files.push({ name: "export-manifest.json", data: json(signed) });
  const receipt = await recordReceipt(app.store, app.pqSigner, { orgId: organizationId, type: "account-export", subject: { kind: "account-export", id: signed.contentHash }, facts: { files: files.length, manifestContentHash: signed.contentHash } }, app.log);
  return { files, receiptSeq: receipt ? receipt.seq : null, contentHash: signed.contentHash };
}

// A plain "stored" ZIP (no compression, no dependency): local header + data per file, then the central directory.
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf: Buffer): number { let c = 0xffffffff; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

export function zipStored(files: ExportFile[]): Buffer {
  const parts: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8"), crc = crc32(f.data), size = f.data.length;
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 10); local.writeUInt32LE(crc, 14); local.writeUInt32LE(size, 18); local.writeUInt32LE(size, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0x0800, 8); cd.writeUInt16LE(0, 10);
    cd.writeUInt32LE(0, 12); cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(size, 20); cd.writeUInt32LE(size, 24); cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    parts.push(local, name, f.data); central.push(cd, name);
    offset += 30 + name.length + size;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBuf, end]);
}
