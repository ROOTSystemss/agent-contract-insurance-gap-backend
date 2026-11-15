import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { publishedKeys } from "../crypto/key-history.js";
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
  const keys = () => publishedKeys(app.pqSigner, process.env.PQ_KEY_HISTORY_JSON);

  app.post("/api/v1/public/verify", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (request) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (body.receipt) {
      const { receipt } = receiptBody.parse(body);
      const result = verifyOne(receipt, keys(), verifyWithPublicKey);
      if (!result.valid) return { data: { kind: "receipt", verdict: "FAIL", reason: result.reason } };
      // The Bitcoin timestamp, when this service still holds the receipt (looked up by its own fingerprint).
      const orgId = typeof receipt.orgId === "string" ? receipt.orgId : "";
      const stored = /^[0-9a-f-]{36}$/i.test(orgId) ? await app.store.getReceipt(orgId, Number(receipt.seq)) : null;
      const timestamp = stored && stored.anchorHash === result.anchorHash ? { status: stored.otsStatus, blockHeight: stored.otsBlockHeight } : { status: "unknown", blockHeight: null };
      return { data: { kind: "receipt", verdict: "PASS", issuer: "AI Agent Trust", keyId: result.keyId, type: result.type, seq: result.seq, issuedAt: result.issuedAt, subject: result.subject, facts: result.facts, timestamp } };
    }
    // An agent authority certificate: asked live of Authority Atlas, which signed it. Fails closed:
    // anything Atlas cannot confirm (forged, expired, revoked, unreachable) is "not verified".
    if (typeof body.certificate === "string") {
      const { certificate } = z.object({ certificate: z.string().trim().min(20).max(8000) }).parse(body);
      if (!app.certificateVerifier) return { data: { kind: "certificate", verdict: "FAIL", reason: "Certificate checks are not available on this server right now." } };
      const result = await app.certificateVerifier(certificate);
      if (!result.ok) {
        const reason = result.reason === "verifier_unavailable" ? "The certificate could not be checked right now (Authority Atlas did not answer). Try again in a minute." : "Not a valid certificate: " + result.reason.replace(/_/g, " ") + ".";
        return { data: { kind: "certificate", verdict: "FAIL", reason } };
      }
      const c = result.certificate;
      return { data: { kind: "certificate", verdict: "PASS", agentId: c.agentId, agentName: c.agentName, organization: c.organization, organizationVerified: c.organizationVerified === true, permissions: c.permissions, limits: c.limits, issuedAt: c.issuedAt, expiresAt: c.expiresAt } };
    }
    if (body.pack) {
      const parsed = packBody.parse(body);
      const result = verifyAssurancePack(parsed.pack, parsed.contentHash, parsed.signature, app.pqSigner, keys());
      const reason = result.valid ? null
        : result.computedHash !== parsed.contentHash.toLowerCase() ? "The pack was changed after it was built (its fingerprint does not match)."
        : result.signature.status === "not_this_service" ? "The pack is signed, but not by AI Agent Trust's published key."
        : result.signature.status === "signed_after_key_retired" ? "The pack is signed with a retired AI Agent Trust key, after that key was retired."
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
<p class="lead">Confirm that an agent authority certificate is genuine and still valid, or that an Evidence Notary receipt or an Agent Assurance Pack was issued by AI Agent Trust and has not been changed. No account needed. Checked against the signing keys AI Agent Trust publishes at <a href="/.well-known/rootsystems-signing-keys.json">/.well-known/rootsystems-signing-keys.json</a>.</p>
<form id="check" class="card" novalidate>
<label for="cert">Agent authority certificate</label>
<textarea id="cert" name="certificate" rows="4" style="width:100%;font:13px monospace" spellcheck="false" autocomplete="off" placeholder="Paste the certificate (the long eyJ… text)"></textarea>
<small>Issued by Authority Atlas. It is checked live: genuine, unexpired and not revoked.</small>
<label for="file">Or: an Evidence Notary receipt or Agent Assurance Pack (.json)</label>
<input id="file" name="file" type="file" accept=".json,application/json">
<small>A receipt downloaded from the console, or the Assurance Pack exactly as it was handed to you (with its contentHash and signature). If you paste a certificate and choose a file, the certificate is checked.</small>
<div><button type="submit" id="go">Check</button></div>
</form>
<section id="out" class="card" hidden aria-live="polite"></section>
</main><script>
(function(){
var esc=function(s){return String(s==null?"":s).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];});};
var form=document.getElementById("check");
var out=document.getElementById("out");
var certBox=document.getElementById("cert");
var fileInput=document.getElementById("file");
var go=document.getElementById("go");
var KIND={certificate:" · Agent authority certificate",receipt:" · Evidence Notary receipt","assurance-pack":" · Agent Assurance Pack"};
function verdictLine(pass,kind){return '<p class="verdict '+(pass?"PASS":"FAIL")+'">'+(pass?"PASS · Authentic":"FAIL · Not verified")+(KIND[kind]||"")+"</p>";}
function fail(reason){return verdictLine(false,null)+"<p>"+esc(reason)+"</p>";}
function packBody(p){return {pack:p.pack,contentHash:p.contentHash,signature:p.signature&&p.signature.value?{value:p.signature.value,publicKey:p.signature.publicKey}:undefined};}
function bodyFromFile(doc){
  if(!doc||typeof doc!=="object")return null;
  if(doc.receiptVersion)return {receipt:doc};
  if(doc.pack)return packBody(doc);
  if(doc.data&&doc.data.pack)return packBody(doc.data);
  return null;
}
function render(d){
  var pass=d.verdict==="PASS";
  var html=verdictLine(pass,d.kind)+(d.reason?"<p>"+esc(d.reason)+"</p>":"");
  if(pass&&d.kind==="certificate"){
    var limits=d.limits&&typeof d.limits==="object"?Object.keys(d.limits).map(function(k){return esc(k)+": "+esc(d.limits[k]);}).join(", "):"";
    html+="<dl><dt>Agent</dt><dd>"+esc(d.agentName)+" ("+esc(d.agentId)+")</dd><dt>Organization</dt><dd>"+esc(d.organization)+(d.organizationVerified?"":" <small>(name declared by the issuer, not independently verified)</small>")+"</dd><dt>Allowed to</dt><dd>"+esc((d.permissions||[]).join(", "))+"</dd>"+(limits?"<dt>Limits</dt><dd>"+limits+"</dd>":"")+"<dt>Valid until</dt><dd>"+esc(d.expiresAt)+"</dd></dl>";
  }
  if(pass&&d.kind==="receipt")html+="<dl><dt>Issued by</dt><dd>AI Agent Trust (ML-DSA-65 key "+esc(d.keyId)+")</dd><dt>What</dt><dd>"+esc(d.type)+" (#"+esc(d.seq)+")</dd><dt>When</dt><dd>"+esc(d.issuedAt)+"</dd><dt>Bitcoin timestamp</dt><dd>"+esc(d.timestamp&&d.timestamp.status)+(d.timestamp&&d.timestamp.blockHeight?" (block "+esc(d.timestamp.blockHeight)+")":"")+"</dd></dl><p><small>Its place in the workspace's chain of receipts is checked in the console under Receipts.</small></p>";
  if(pass&&d.kind==="assurance-pack")html+="<p><small>Signature: "+esc(d.signature)+". The fingerprint proves the pack is unchanged since it was built, not that its contents are true.</small></p>";
  return html;
}
form.addEventListener("submit",function(e){
  e.preventDefault();
  out.hidden=false;
  out.textContent="Checking…";
  go.disabled=true;
  var cert=certBox.value.trim();
  var file=fileInput.files&&fileInput.files[0];
  var ready;
  if(cert){ready=Promise.resolve({certificate:cert});}
  else if(file){ready=file.text().then(function(text){var doc;try{doc=JSON.parse(text);}catch(_){throw new Error("The file is not valid JSON.");}var b=bodyFromFile(doc);if(!b)throw new Error("This file is not an Evidence Notary receipt or an Agent Assurance Pack.");return b;});}
  else{out.innerHTML=fail("Paste a certificate or choose a receipt or Assurance Pack file first.");go.disabled=false;return;}
  ready.then(function(body){
    return fetch("/api/v1/public/verify",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)}).then(function(r){
      return r.json().catch(function(){return {};}).then(function(j){
        var d=j&&j.data?j.data:{verdict:"FAIL",kind:null,reason:(j&&j.error&&(j.error.details&&j.error.details[0]&&j.error.details[0].message||j.error.message))||("The check could not be completed (HTTP "+r.status+").")};
        out.innerHTML=render(d);
      });
    },function(){out.innerHTML=fail("Could not reach the server. Check your connection and try again.");});
  }).catch(function(err){out.innerHTML=fail(err&&err.message?err.message:"Could not check.");}).then(function(){go.disabled=false;});
});
})();
</script></body></html>`;
