import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { keyHistory } from "../crypto/key-history.js";
import { verifyWithPublicKey } from "../crypto/pq-sign.js";
import { verifyOne } from "../evidence/receipts.js";
import { verifyAssurancePack } from "../reports/assurance-pack.js";

// Public checks, no account: anyone holding an AI Agent Trust Evidence Notary receipt or an Agent
// Assurance Pack (an auditor, a broker, a customer) can confirm who issued it and that it is unchanged.
// Keys come from this service's own published key history, never from the file being checked.

const receiptBody = z.object({ receipt: z.record(z.string(), z.unknown()) });
const packBody = z.object({
  pack: z.record(z.string(), z.unknown()),
  contentHash: z.string().regex(/^[0-9a-fA-F]{64}$/),
  signature: z.object({ value: z.string().min(1).max(8000), publicKey: z.string().max(4000).optional() }).passthrough().optional(),
});

export const publicVerifyRoutes: FastifyPluginAsync = async (app) => {
  const publishedKeys = () => {
    const history = keyHistory("ai-agent-trust", app.pqSigner, process.env.PQ_KEY_HISTORY_JSON) as { keys?: { keyId: string; publicKey: string }[] } | null;
    return history && Array.isArray(history.keys) ? history.keys : [];
  };

  app.post("/api/v1/public/verify", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (request) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (body.receipt) {
      const { receipt } = receiptBody.parse(body);
      const result = verifyOne(receipt, publishedKeys(), verifyWithPublicKey);
      if (!result.valid) return { data: { kind: "receipt", verdict: "FAIL", reason: result.reason } };
      // The Bitcoin timestamp, when this service still holds the receipt (looked up by its own fingerprint).
      const orgId = typeof receipt.orgId === "string" ? receipt.orgId : "";
      const stored = /^[0-9a-f-]{36}$/i.test(orgId) ? await app.store.getReceipt(orgId, Number(receipt.seq)) : null;
      const timestamp = stored && stored.anchorHash === result.anchorHash ? { status: stored.otsStatus, blockHeight: stored.otsBlockHeight } : { status: "unknown", blockHeight: null };
      return { data: { kind: "receipt", verdict: "PASS", issuer: "AI Agent Trust", keyId: result.keyId, type: result.type, seq: result.seq, issuedAt: result.issuedAt, subject: result.subject, facts: result.facts, timestamp } };
    }
    if (body.pack) {
      const parsed = packBody.parse(body);
      const result = verifyAssurancePack(parsed.pack, parsed.contentHash, parsed.signature, app.pqSigner);
      const reason = result.valid ? null
        : result.computedHash !== parsed.contentHash.toLowerCase() ? "The pack was changed after it was built (its fingerprint does not match)."
        : result.signature.status === "not_this_service" ? "The pack is signed, but not by AI Agent Trust's published key."
        : "The signature does not match the pack.";
      return { data: { kind: "assurance-pack", verdict: result.valid ? "PASS" : "FAIL", reason, signature: result.signature.status, computedHash: result.computedHash } };
    }
    return { data: { kind: null, verdict: "FAIL", reason: "Choose a receipt or an Agent Assurance Pack (.json)." } };
  });

  app.get("/verify", async (_request, reply) => reply.type("text/html; charset=utf-8").send(PAGE));
};

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Check an AI Agent Trust record</title>
<style>
:root{--bg:#f7f8fa;--card:#fff;--ink:#16202b;--muted:#5b6876;--line:#dde3ea;--ok:#127a43;--bad:#b42318;--accent:#6d4aff}
@media (prefers-color-scheme:dark){:root{--bg:#0f141a;--card:#161d25;--ink:#e8edf2;--muted:#9aa7b4;--line:#2a3542;--ok:#4cc38a;--bad:#ff7a6b}}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:720px;margin:0 auto;padding:32px 16px}h1{font-size:1.6rem;margin:0 0 4px}p.lead{color:var(--muted);margin:0 0 24px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px;margin-bottom:16px}
label{display:block;font-weight:600;margin:12px 0 4px}small{color:var(--muted)}input[type=file]{width:100%}
button{margin-top:16px;background:var(--accent);color:#fff;border:0;border-radius:8px;padding:10px 18px;font-weight:600;cursor:pointer}
.verdict{font-size:1.3rem;font-weight:700}.PASS{color:var(--ok)}.FAIL{color:var(--bad)}dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 12px}dt{color:var(--muted)}
</style></head><body><main>
<h1>Check an AI Agent Trust record</h1>
<p class="lead">Confirm that an Evidence Notary receipt or an Agent Assurance Pack was issued by AI Agent Trust and has not been changed. No account needed. Checked against the signing keys AI Agent Trust publishes at <a href="/.well-known/rootsystems-signing-keys.json">/.well-known/rootsystems-signing-keys.json</a>.</p>
<form id="f" class="card"><label for="file">Receipt or Assurance Pack (.json)</label><input id="file" type="file" accept=".json,application/json" required>
<small>A receipt downloaded from the console, or the Assurance Pack exactly as it was handed to you (with its contentHash and signature).</small>
<div><button type="submit">Check</button></div></form>
<section id="out" class="card" hidden aria-live="polite"></section>
</main><script>
const esc=(s)=>String(s??"").replace(/[&<>"]/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
document.getElementById("f").addEventListener("submit",async(e)=>{e.preventDefault();const out=document.getElementById("out");out.hidden=false;out.textContent="Checking…";
try{const f=document.getElementById("file").files[0];const doc=JSON.parse(await f.text());
const body=doc.receiptVersion?{receipt:doc}:doc.pack?{pack:doc.pack,contentHash:doc.contentHash,signature:doc.signature&&doc.signature.value?{value:doc.signature.value,publicKey:doc.signature.publicKey}:undefined}:doc.data&&doc.data.pack?{pack:doc.data.pack,contentHash:doc.data.contentHash,signature:doc.data.signature&&doc.data.signature.value?{value:doc.data.signature.value,publicKey:doc.data.signature.publicKey}:undefined}:{};
const r=await fetch("/api/v1/public/verify",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});const j=await r.json();const d=j.data||{verdict:"FAIL",reason:(j.error&&j.error.message)||"Could not check."};
let html='<p class="verdict '+d.verdict+'">'+(d.verdict==="PASS"?"Authentic":"Not verified")+(d.kind==="receipt"?" — Evidence Notary receipt":d.kind==="assurance-pack"?" — Agent Assurance Pack":"")+"</p>"+(d.reason?"<p>"+esc(d.reason)+"</p>":"");
if(d.verdict==="PASS"&&d.kind==="receipt")html+="<dl><dt>Issued by</dt><dd>AI Agent Trust (ML-DSA-65 key "+esc(d.keyId)+")</dd><dt>What</dt><dd>"+esc(d.type)+" (#"+esc(d.seq)+")</dd><dt>When</dt><dd>"+esc(d.issuedAt)+"</dd><dt>Bitcoin timestamp</dt><dd>"+esc(d.timestamp&&d.timestamp.status)+(d.timestamp&&d.timestamp.blockHeight?" (block "+esc(d.timestamp.blockHeight)+")":"")+"</dd></dl><p><small>Its place in the workspace's chain of receipts is checked in the console under Receipts.</small></p>";
if(d.verdict==="PASS"&&d.kind==="assurance-pack")html+="<p><small>Signature: "+esc(d.signature)+". The fingerprint proves the pack is unchanged since it was built, not that its contents are true.</small></p>";
out.innerHTML=html}catch(err){out.innerHTML='<p class="verdict FAIL">Could not check</p><p>The file is not valid JSON.</p>'}});
</script></body></html>`;
