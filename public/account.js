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

  function page(title, intro, inner) {
    app.innerHTML = `<main class="auth-page"><section class="auth-story"><div><div class="brand"><img class="brand-mark-img" src="/rs-logo.svg" alt="" width="29" height="32"><span>RootSystems</span></div></div><div class="story-copy"><span class="eyebrow">AI Agent Trust</span><h1>Your <em>account</em></h1><p>Email confirmation and password changes for the Agent Governance console and the coverage workspace (one sign-in for both).</p></div></section><section class="auth-panel"><div class="auth-card"><span class="eyebrow">Account</span><h2>${esc(title)}</h2><p class="intro">${intro}</p>${inner}</div></section></main>`;
  }
  const links = `<p class="small" style="margin-top:18px"><a href="/console">Open the console</a> · <a href="/">Open the coverage workspace</a></p>`;
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

  const hash = window.location.hash.replace(/^#/, "");
  const [kind, token] = hash.split("=");
  if ((kind === "verify" || kind === "reset") && token) {
    // Keep the one-time token out of the address bar and the browser history.
    window.history.replaceState(null, "", "/account");
    if (kind === "verify") verify(token);
    else reset(token);
  } else if (kind === "change") change();
  else forgot();
})();
