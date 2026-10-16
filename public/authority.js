// Authority certificate check (agent profile page) and Assurance Pack (analysis page).
// Loaded before app.js and only uses its globals (state, api, escapeHtml, pretty, toast,
// renderAgent) when a panel is mounted, i.e. after both scripts have run.
/* global state, api, escapeHtml, toast, renderAgent */

const capabilityLabel = (key = "") =>
  String(key)
    .replace(/^can/, "")
    .replace(/([A-Z])/g, " $1")
    .trim()
    .toLowerCase();

const DIFFERENCE_SEVERITY_ORDER = ["high", "moderate", "informational"];
const DIFFERENCE_SEVERITY_TITLE = {
  high: "The analysis may under-report risk",
  moderate: "Worth correcting",
  informational: "For your information",
};

function shortDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString(undefined, { timeZone: "UTC" });
}

function downloadJson(filename, data) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function copyText(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${label} copied.`);
  } catch {
    toast("Copy is not available in this browser.", "error");
  }
}

// ---- Authority certificate panel -------------------------------------------------------------

let pendingCertificateRecheck = null;

function mountCertificatePanel(agent) {
  const host = document.querySelector("#authority-certificate");
  if (!host || !agent?.id) return;
  host.innerHTML = `<div class="section-head"><div><h2>Authority certificate</h2><p>Paste this agent's signed authority certificate from Agent Certificates to compare it with the profile above. Checking changes nothing.</p></div></div>
    <form class="authority-form" data-cert-form>
      <div class="field"><label for="cert-text">Certificate</label><textarea id="cert-text" name="certificate" rows="4" required minlength="20" maxlength="8000" spellcheck="false" autocomplete="off" placeholder="Paste the certificate text"></textarea></div>
      <div class="form-actions"><button type="submit" class="button button-primary">Check against this agent</button></div>
    </form>
    <div data-cert-result aria-live="polite"></div>`;
  const form = host.querySelector("[data-cert-form]");
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    checkCertificate(agent, form);
  });
  if (pendingCertificateRecheck) {
    form.elements.certificate.value = pendingCertificateRecheck;
    pendingCertificateRecheck = null;
    checkCertificate(agent, form);
  }
}

async function checkCertificate(agent, form) {
  const result = document.querySelector("[data-cert-result]");
  const submit = form.querySelector("button[type=submit]");
  const certificate = form.elements.certificate.value.trim();
  result.innerHTML = "";
  submit.disabled = true;
  submit.textContent = "Checking with Agent Certificates…";
  try {
    const data = await api(`/agents/${agent.id}/certificate-check`, {
      method: "POST",
      body: JSON.stringify({ certificate }),
    });
    result.innerHTML = certificateResultView(data);
    result.querySelector("[data-adopt-certificate]")?.addEventListener("click", (event) =>
      adoptCertificate(agent, certificate, event.currentTarget),
    );
  } catch (error) {
    result.innerHTML = `<div class="authority-error" role="alert"><strong>No result.</strong> ${escapeHtml(error.message)}</div>`;
  } finally {
    submit.disabled = false;
    submit.textContent = "Check against this agent";
  }
}

function certificateResultView(data) {
  const certificate = data.certificate || {};
  const derived = data.derived || {};
  const differences = data.differences || [];
  const limits = certificate.limits || {};
  const limitParts = [];
  if (limits.maxAmountUsd !== undefined) limitParts.push(`up to USD ${Number(limits.maxAmountUsd).toLocaleString()} per action`);
  if (limits.maxActionsPerDay !== undefined) limitParts.push(`${limits.maxActionsPerDay} actions per day`);
  const understates = differences.some(
    (d) => d.kind === "profile_understates_certificate" || d.kind === "profile_limit_below_certificate",
  );

  const status = data.profileCoversCertificate
    ? `<div class="authority-status authority-status--ok"><strong>The profile covers what this certificate authorizes.</strong><span>The analysis is not missing any authority stated on the certificate.</span></div>`
    : `<div class="authority-status authority-status--warn"><strong>The profile understates this certificate.</strong><span>The certificate allows more than the profile says, so the gap analysis would under-report risk until the profile is updated.</span></div>`;

  const groups = DIFFERENCE_SEVERITY_ORDER.map((severity) => {
    const items = differences.filter((d) => d.severity === severity);
    if (!items.length) return "";
    return `<div class="authority-diff-group authority-diff-group--${severity}"><h3>${DIFFERENCE_SEVERITY_TITLE[severity]} <span>${items.length}</span></h3><ul>${items
      .map((d) => `<li>${escapeHtml(d.message)}</li>`)
      .join("")}</ul></div>`;
  }).join("");

  return `${status}
    ${derived.broadAuthority ? '<div class="authority-broad"><strong>This certificate grants everything (*).</strong> Treat the agent as able to do any action its systems allow.</div>' : ""}
    <div class="authority-facts">
      <div><span>Agent on certificate</span><strong>${escapeHtml(certificate.agentName || "—")}</strong></div>
      <div><span>Issued by</span><strong>${escapeHtml(certificate.organization || "—")}</strong>${certificate.organizationVerified ? "" : "<small>The organization name is the issuer's own claim and is not independently verified.</small>"}</div>
      <div><span>Valid</span><strong>${shortDate(certificate.issuedAt)} to ${shortDate(certificate.expiresAt)}</strong></div>
      <div><span>Limits</span><strong>${limitParts.length ? escapeHtml(limitParts.join(", ")) : "No limits stated"}</strong></div>
    </div>
    <div class="authority-perms"><span>Permissions on the certificate</span><div class="authority-chips">${(certificate.permissions || []).map((p) => `<code>${escapeHtml(p)}</code>`).join("") || '<em class="muted">None</em>'}</div></div>
    ${derived.unmappedPermissions?.length ? `<p class="authority-unmapped"><strong>We could not classify these:</strong> ${derived.unmappedPermissions.map((p) => `<code>${escapeHtml(p)}</code>`).join(" ")}. Check them by hand against the profile.</p>` : ""}
    ${differences.length ? `<div class="authority-diffs">${groups}</div>` : '<p class="muted small">No differences between the profile and the certificate.</p>'}
    ${understates ? '<div class="form-actions"><button type="button" class="button button-primary" data-adopt-certificate>Bring profile up to this certificate</button></div>' : ""}
    <p class="small muted">Decision support only, not legal or insurance advice.</p>`;
}

async function adoptCertificate(agent, certificate, button) {
  const ok = window.confirm(
    "Bring the profile up to this certificate?\n\nThis only turns capabilities on and raises the spending limit to match the certificate. It never turns anything off or lowers a limit, so the analysis can only become more cautious.",
  );
  if (!ok) return;
  button.disabled = true;
  try {
    const data = await api(`/agents/${agent.id}/adopt-certificate`, {
      method: "POST",
      body: JSON.stringify({ certificate }),
    });
    state.agents = [data.agent];
    toast(
      data.changed.length
        ? `Profile updated: ${data.changed.map(capabilityLabel).join(", ")}. Rerun the analysis to see the effect.`
        : data.note || "The profile already covers this certificate.",
    );
    pendingCertificateRecheck = certificate;
    renderAgent();
  } catch (error) {
    button.disabled = false;
    toast(error.message, "error");
  }
}

// ---- Assurance Pack panel --------------------------------------------------------------

const SIGNATURE_WORDS = {
  valid: "Signature valid: made by this service's key.",
  invalid: "The signature does not check out.",
  not_this_service: "Signed, but by a different key, not by this service.",
  not_supplied: "No signature was supplied, so only the fingerprint was checked.",
};

function mountAssurancePanel(analysis) {
  const host = document.querySelector("#assurance-pack");
  if (!host || !analysis?.state?.startsWith("completed")) return;
  host.innerHTML = `<div class="section-head"><div><h2>Assurance Pack</h2><p>A fingerprinted summary of this analysis, the agent profile and the evidence reviewed, ready to hand to a broker, auditor or lawyer.</p></div></div>
    <form class="authority-form" data-pack-form>
      <details class="assurance-optional"><summary>Include an authority certificate (optional)</summary>
        <div class="field"><label for="pack-cert">Certificate</label><textarea id="pack-cert" name="certificate" rows="3" maxlength="8000" spellcheck="false" autocomplete="off" placeholder="Paste the certificate text"></textarea></div>
        <p class="small muted">It is verified with Agent Certificates first. The pack then records whether the profile covers it.</p>
      </details>
      <div class="form-actions"><button type="submit" class="button button-primary">Build assurance pack</button></div>
    </form>
    <div data-pack-result aria-live="polite"></div>
    <details class="assurance-verify"><summary>Verify a pack</summary>
      <form class="authority-form" data-verify-form>
        <div class="field"><label for="verify-file">Pack file (.json)</label><input id="verify-file" name="file" type="file" accept="application/json,.json" /></div>
        <div class="field"><label for="verify-json">Or paste the pack JSON</label><textarea id="verify-json" name="json" rows="3" spellcheck="false" placeholder='{"pack": …, "contentHash": "…"}'></textarea></div>
        <div class="field"><label for="verify-hash">Fingerprint (SHA-256)</label><input id="verify-hash" name="hash" maxlength="64" spellcheck="false" autocomplete="off" placeholder="Only needed if the file does not include it" /></div>
        <div class="form-actions"><button type="submit" class="button button-secondary">Verify</button></div>
      </form>
      <div data-verify-result aria-live="polite"></div>
    </details>`;
  host.querySelector("[data-pack-form]").addEventListener("submit", (event) => {
    event.preventDefault();
    buildPack(analysis, event.currentTarget);
  });
  host.querySelector("[data-verify-form]").addEventListener("submit", (event) => {
    event.preventDefault();
    verifyPack(event.currentTarget);
  });
}

async function buildPack(analysis, form) {
  const result = document.querySelector("[data-pack-result]");
  const submit = form.querySelector("button[type=submit]");
  const certificate = form.elements.certificate.value.trim();
  result.innerHTML = "";
  submit.disabled = true;
  submit.textContent = "Building…";
  try {
    const built = await api(`/analyses/${analysis.id}/assurance-pack`, {
      method: "POST",
      body: JSON.stringify(certificate ? { certificate } : {}),
    });
    result.innerHTML = packResultView(built);
    result.querySelector("[data-pack-download]").addEventListener("click", () => {
      const name = (state.project?.name || "agent").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      downloadJson(`${name || "agent"}-assurance-pack.json`, built);
    });
    result.querySelector("[data-pack-copy]").addEventListener("click", () => copyText(built.contentHash, "Fingerprint"));
  } catch (error) {
    result.innerHTML = `<div class="authority-error" role="alert"><strong>No pack was built.</strong> ${escapeHtml(error.message)}</div>`;
  } finally {
    submit.disabled = false;
    submit.textContent = "Build assurance pack";
  }
}

function packResultView(built) {
  const signature = built.signature || {};
  const signed = signature.status === "signed";
  return `<div class="assurance-result">
      <p class="assurance-lead">Anyone can confirm this file is unchanged by checking this fingerprint.</p>
      <div class="hash-box"><code>${escapeHtml(built.contentHash)}</code><button type="button" class="button button-secondary" data-pack-copy>Copy</button></div>
      <p class="assurance-sign ${signed ? "assurance-sign--yes" : ""}">${signed ? `Signed by this service · key ${escapeHtml(String(signature.keyId || "").slice(0, 12))}` : "Not signed: this server has no signing key configured. The fingerprint still works."}</p>
      <div class="form-actions"><button type="button" class="button button-primary" data-pack-download>Download pack (JSON)</button></div>
      <details class="assurance-tech"><summary>Technical details</summary>
        <dl>
          <dt>SHA-256</dt><dd><code>${escapeHtml(built.contentHash)}</code></dd>
          <dt>SHA-512</dt><dd><code>${escapeHtml(built.contentHashSha512 || "—")}</code></dd>
          <dt>Canonical form</dt><dd>${escapeHtml(built.canonicalization || "—")}</dd>
          <dt>Signature</dt><dd>${signed ? `${escapeHtml(signature.algorithm)} (${escapeHtml(signature.standard || "")}), key ${escapeHtml(signature.keyId || "")}` : escapeHtml(signature.algorithm || "none")}</dd>
        </dl>
      </details>
      <p class="small muted">The fingerprint shows the pack has not been changed. It does not show its contents are true. Not legal or insurance advice.</p>
    </div>`;
}

async function verifyPack(form) {
  const result = document.querySelector("[data-verify-result]");
  const submit = form.querySelector("button[type=submit]");
  result.innerHTML = "";
  let parsed;
  try {
    const file = form.elements.file.files[0];
    const text = file ? await file.text() : form.elements.json.value.trim();
    if (!text) throw new Error("Choose the pack file or paste its JSON.");
    parsed = JSON.parse(text);
  } catch (error) {
    result.innerHTML = `<div class="authority-error" role="alert">${escapeHtml(error instanceof SyntaxError ? "That is not valid JSON." : error.message)}</div>`;
    return;
  }
  const wrapped = parsed && typeof parsed === "object" && parsed.pack && typeof parsed.pack === "object";
  const pack = wrapped ? parsed.pack : parsed;
  const contentHash = (form.elements.hash.value.trim() || (wrapped ? parsed.contentHash : "") || "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(contentHash)) {
    result.innerHTML = '<div class="authority-error" role="alert">Enter the 64-character SHA-256 fingerprint that came with the pack.</div>';
    return;
  }
  const body = { pack, contentHash };
  if (wrapped && parsed.signature?.status === "signed" && parsed.signature.value) {
    body.signature = { value: parsed.signature.value, publicKey: parsed.signature.publicKey };
  }
  submit.disabled = true;
  try {
    const data = await api("/analyses/assurance-pack/verify", { method: "POST", body: JSON.stringify(body) });
    const words = SIGNATURE_WORDS[data.signature?.status] || "";
    result.innerHTML = data.valid
      ? `<div class="authority-status authority-status--ok"><strong>Unchanged since it was built.</strong><span>${escapeHtml(words)} This confirms the file was not altered; it does not confirm that what it says is true.</span></div>`
      : `<div class="authority-status authority-status--warn"><strong>This pack does not match.</strong><span>${data.computedHash !== contentHash ? "It was changed after it was built, or the fingerprint belongs to a different pack." : ""} ${escapeHtml(words)}</span></div>`;
  } catch (error) {
    result.innerHTML = `<div class="authority-error" role="alert">${escapeHtml(error.message)}</div>`;
  } finally {
    submit.disabled = false;
  }
}

Object.assign(window, { mountCertificatePanel, mountAssurancePanel });
