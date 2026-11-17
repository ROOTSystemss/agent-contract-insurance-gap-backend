// Account page: the links in verification and password-reset emails land here, and so do "Forgot your
// password?" and "Change password". The one-time token travels in the URL fragment (#verify=… / #reset=…),
// which browsers never send to the server, and it is removed from the address bar as soon as it is read.
(function () {
  const API = "/api/v1";
  const TOKEN_KEY = "authorityAtlasToken"; // the session shared with the coverage workspace and the console
  const app = document.querySelector("#account-app");
  const esc = (value) => String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  async function api(path, body, token) {
    const headers = { "Content-Type": "application/json", Accept: "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(`${API}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = payload.error && payload.error.details && payload.error.details[0] && payload.error.details[0].message;
      throw new Error(detail || (payload.error && payload.error.message) || `Something went wrong (${response.status}).`);
    }
    return payload.data;
  }

  async function apiGet(path, token) {
    const response = await fetch(`${API}${path}`, { headers: { Accept: "application/json", Authorization: `Bearer ${token}` } });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error((payload.error && payload.error.message) || `Something went wrong (${response.status}).`);
    return payload.data;
  }

  function page(title, intro, inner) {
    app.innerHTML = `<main class="auth-page"><section class="auth-story"><div><div class="brand"><img class="brand-mark-img" src="/rs-logo.svg" alt="" width="29" height="32"><span>RootSystems</span></div></div><div class="story-copy"><span class="eyebrow">AI Agent Trust</span><h1>Your <em>account</em></h1><p>Email confirmation and password changes for the Agent Governance console and the coverage workspace (one sign-in for both).</p></div></section><section class="auth-panel"><div class="auth-card"><span class="eyebrow">Account</span><h2>${esc(title)}</h2><p class="intro">${intro}</p>${inner}</div></section></main>`;
  }
  const links = `<p class="small" style="margin-top:18px"><a href="/console">Open the console</a> · <a href="/">Open the coverage workspace</a> · <a href="/account#change">Change password</a> · <a href="/account#2fa">Two-factor sign-in</a> · <a href="/account#delete" id="delete-account-link">Delete my account</a></p>`;
  const passwordFields = (prefix) =>
    `<div class="field full"><label for="${prefix}-new">New password</label><input id="${prefix}-new" name="password" type="password" autocomplete="new-password" required minlength="12" maxlength="128" placeholder="At least 12 characters" /></div>
     <div class="field full"><label for="${prefix}-again">Repeat the new password</label><input id="${prefix}-again" name="again" type="password" autocomplete="new-password" required minlength="12" maxlength="128" /></div>`;
  function wire(form, onSubmit) {
    const message = form.querySelector(".form-message");
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const button = form.querySelector("button[type=submit]");
      const values = Object.fromEntries(new FormData(form).entries());
      message.textContent = "";
      if (values.password !== undefined && values.again !== undefined && values.password !== values.again) {
        message.textContent = "The two passwords are different.";
        return;
      }
      button.disabled = true;
      try {
        await onSubmit(values);
      } catch (error) {
        message.textContent = error.message;
        button.disabled = false;
      }
    });
  }

  async function verify(token) {
    page("Confirming your email…", "One moment.", "");
    try {
      await api("/auth/verify-email", { token });
      page("Email confirmed", "Thank you. Certificates, approvals and signed Assurance Packs are now open to your account.", links);
    } catch (error) {
      page("This link did not work", `${esc(error.message)} Links expire after 48 hours and work once; sign in and use “Send a new link” at the top of the page.`, links);
    }
  }

  function reset(token) {
    page("Choose a new password", "Signing in again is needed afterwards on every device: the change signs out all earlier sessions.",
      `<form id="reset-form" class="field-grid">${passwordFields("reset")}<div class="field full"><button class="button button-primary button-block" type="submit">Set the new password<span>→</span></button><p class="form-message" role="alert"></p></div></form>`);
    wire(document.querySelector("#reset-form"), async (values) => {
      const result = await api("/auth/reset-password", { token, password: values.password });
      sessionStorage.removeItem(TOKEN_KEY);
      page("Password changed", esc(result.message), links);
    });
  }

  function forgot() {
    page("Forgot your password?", "Enter the email you sign in with. If it has an account, we email it a link to choose a new password.",
      `<form id="forgot-form" class="field-grid"><div class="field full"><label for="forgot-email">Work email</label><input id="forgot-email" name="email" type="email" autocomplete="email" required maxlength="254" placeholder="you@company.com" /></div><div class="field full"><button class="button button-primary button-block" type="submit">Email me a link<span>→</span></button><p class="form-message" role="alert"></p></div></form>${links}`);
    wire(document.querySelector("#forgot-form"), async (values) => {
      const result = await api("/auth/forgot-password", { email: values.email });
      page("Check your email", `${esc(result.message)} If nothing arrives in a few minutes, check the spam folder.`, links);
    });
  }

  function change() {
    const token = sessionStorage.getItem(TOKEN_KEY);
    if (!token) {
      page("Sign in first", "Changing your password needs you to be signed in. If you have forgotten it, reset it instead.", `<p><a class="button button-primary" href="/console">Sign in</a> <a class="button button-secondary" href="/account#forgot">Reset my password</a></p>`);
      return;
    }
    page("Change your password", "Every other session is signed out; this one stays signed in.",
      `<form id="change-form" class="field-grid"><div class="field full"><label for="change-current">Current password</label><input id="change-current" name="currentPassword" type="password" autocomplete="current-password" required maxlength="128" /></div>${passwordFields("change")}<div class="field full"><button class="button button-primary button-block" type="submit">Change password<span>→</span></button><p class="form-message" role="alert"></p></div></form>`);
    wire(document.querySelector("#change-form"), async (values) => {
      const result = await api("/auth/change-password", { currentPassword: values.currentPassword, newPassword: values.password }, token);
      sessionStorage.setItem(TOKEN_KEY, result.accessToken);
      page("Password changed", "Other sessions were signed out. You are still signed in here.", links);
    });
  }

  // Two-factor sign-in (knock-out 2026-11-16): set up with an authenticator app, recovery codes shown once,
  // turning it off needs the password and a current code.
  async function twoFactor() {
    const token = sessionStorage.getItem(TOKEN_KEY);
    const signIn = `<p><a class="button button-primary" href="/console">Sign in</a></p>`;
    if (!token) { page("Sign in first", "Setting up two-factor sign-in needs you to be signed in.", signIn); return; }
    let status;
    try { status = await apiGet("/auth/two-factor", token); } catch (error) { page("Sign in again", esc(error.message), signIn); return; }
    if (status.enabled) {
      page("Two-factor sign-in is on", `Every sign-in asks for a code from your authenticator app. Recovery codes left: ${esc(status.recoveryCodesLeft)}.`,
        `<p class="small" id="twofa-on">On since ${esc(status.enabledAt)}.</p><form id="twofa-off" class="field-grid"><div class="field full"><label for="off-pw">Password</label><input id="off-pw" name="password" type="password" autocomplete="current-password" required maxlength="128" /></div><div class="field full"><label for="off-code">Current code, or a recovery code</label><input id="off-code" name="code" inputmode="numeric" autocomplete="one-time-code" required maxlength="20" /></div><div class="field full"><button class="button button-secondary button-block" type="submit">Turn two-factor sign-in off</button><p class="form-message" role="alert"></p></div></form>${links}`);
      wire(document.querySelector("#twofa-off"), async (values) => {
        await api("/auth/two-factor/disable", { password: values.password, code: values.code }, token);
        twoFactor();
      });
      return;
    }
    page("Turn on two-factor sign-in", "Add AI Agent Trust to an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, Authy). After that, every sign-in also asks for its 6-digit code." + (status.prompt ? " Recommended for workspace owners and admins." : ""),
      `<form id="twofa-start"><button class="button button-primary button-block" type="submit">Start setup</button><p class="form-message" role="alert"></p></form>${links}`);
    wire(document.querySelector("#twofa-start"), async () => {
      const setup = await api("/auth/two-factor/start", {}, token);
      page("Add the key to your app", "In your authenticator app choose to enter a setup key (time-based), then type the 6-digit code it shows.",
        `<p class="small">Setup key</p><p><code id="twofa-secret">${esc(setup.secret.replace(/(.{4})/g, "$1 ").trim())}</code></p><p class="small">On your phone you can open this <a href="${esc(setup.otpauthUri)}">setup link</a> instead.</p><form id="twofa-enable" class="field-grid"><div class="field full"><label for="en-code">6-digit code</label><input id="en-code" name="code" inputmode="numeric" autocomplete="one-time-code" required maxlength="6" /></div><div class="field full"><button class="button button-primary button-block" type="submit">Turn on</button><p class="form-message" role="alert"></p></div></form>`);
      wire(document.querySelector("#twofa-enable"), async (values) => {
        const on = await api("/auth/two-factor/enable", { code: values.code }, token);
        page("Two-factor sign-in is on", "Save these recovery codes somewhere safe now. Each works once if you lose your phone. They are not shown again.",
          `<ul id="recovery-codes" class="small">${on.recoveryCodes.map((c) => `<li><code>${esc(c)}</code></li>`).join("")}</ul>${links}`);
      });
    });
  }

  // Delete my account (S-14, knock-out 2026-11-17). Password (+ two-factor code when on) and typing DELETE.
  function deleteAccountPage() {
    const token = sessionStorage.getItem(TOKEN_KEY);
    if (!token) { page("Sign in first", "Deleting your account needs you to be signed in.", `<p><a class="button button-primary" href="/console">Sign in</a></p>`); return; }
    page("Delete my account", "This cannot be undone.",
      `<div id="delete-warning" class="small"><p><strong>What happens:</strong></p><ul>
        <li>Workspaces you own <strong>alone</strong> are deleted for everyone in them: projects, agent profiles, uploaded documents (the files too), analyses, findings, audit history, console certificates (revoked on Authority Atlas first), approvals records and receipts kept here.</li>
        <li>In workspaces with another owner, you leave; your past actions there stay in their audit history as "Deleted user".</li>
        <li>Signed receipts and certificates already handed out stay checkable on /verify: our signing keys are not touched.</li>
        <li>The Authority Atlas identity and Trust Proof organization created for a workspace have no delete call; the result lists them so you can ask RootSystems to remove them.</li>
      </ul></div>
      <form id="delete-form" class="field-grid">
        <div class="field full"><label for="del-pw">Password</label><input id="del-pw" name="password" type="password" autocomplete="current-password" required maxlength="128" /></div>
        <div class="field full"><label for="del-code">Two-factor code (only if two-factor sign-in is on)</label><input id="del-code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="20" /></div>
        <div class="field full"><label for="del-confirm">Type DELETE to confirm</label><input id="del-confirm" name="confirm" required maxlength="10" /></div>
        <div class="field full"><button class="button button-secondary button-block" type="submit">Delete my account</button><p class="form-message" role="alert"></p></div>
      </form>${links}`);
    wire(document.querySelector("#delete-form"), async (values) => {
      if (String(values.confirm || "").trim() !== "DELETE") throw new Error("Type DELETE (capital letters) to confirm.");
      const body = { password: values.password };
      if (values.code) body.code = values.code;
      const r = await api("/auth/delete-account", body, token);
      sessionStorage.removeItem(TOKEN_KEY);
      const remote = (r.remoteNotDeleted || []).map((x) => `<li>${esc(x.service)}: ${esc(x.what)}</li>`).join("");
      page("Your account is deleted", `Workspaces deleted: ${esc(r.workspacesDeleted)}. Workspaces left: ${esc(r.workspacesLeft)}. Files deleted: ${esc(r.filesDeleted)}. Certificates revoked: ${esc(r.certificatesRevoked)}${r.certificatesNotRevoked ? ` (not revoked: ${esc(r.certificatesNotRevoked)})` : ""}.`,
        `<div id="delete-done">${remote ? `<p class="small"><strong>Not deleted (no delete call on those services):</strong></p><ul class="small">${remote}</ul><p class="small">Email <a href="mailto:hello@rootsystems.app">hello@rootsystems.app</a> to have them removed.</p>` : ""}</div>`);
    });
  }

  window.addEventListener("hashchange", () => window.location.reload());
  const hash = window.location.hash.replace(/^#/, "");
  const [kind, token] = hash.split("=");
  if ((kind === "verify" || kind === "reset") && token) {
    // Keep the one-time token out of the address bar and the browser history.
    window.history.replaceState(null, "", "/account");
    if (kind === "verify") verify(token);
    else reset(token);
  } else if (kind === "change") change();
  else if (kind === "2fa") twoFactor();
  else if (kind === "delete") deleteAccountPage();
  else forgot();
})();
