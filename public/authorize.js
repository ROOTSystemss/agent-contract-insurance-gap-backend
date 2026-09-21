// Minimal "Sign in with Authority Atlas" authorize page for the OAuth bridge to
// AI Compliance Readiness. Deliberately standalone (not part of the main SPA in
// app.js) — this page's only job is: prove who you are on Atlas, show one
// explicit confirm step, then hand a one-time code back to the redirect_uri.
const API = "/api/v1";
const app = document.querySelector("#authorize-app");
const TOKEN_KEY = "authorityAtlasToken";

const params = new URLSearchParams(window.location.search);
const oauthRequest = {
  clientId: params.get("client_id") || "",
  redirectUri: params.get("redirect_uri") || "",
  state: params.get("state") || "",
};

let authMode = "login";

const escapeHtml = (value = "") =>
  String(value).replace(
    /[&<>'"]/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character],
  );

async function api(path, options = {}) {
  const token = sessionStorage.getItem(TOKEN_KEY);
  const headers = new Headers(options.headers || {});
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (options.body) headers.set("Content-Type", "application/json");
  const response = await fetch(`${API}${path}`, { ...options, headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const details = payload.error?.details?.map((item) => item.message).join(" ");
    throw new Error(details || payload.error?.message || "The request could not be completed.");
  }
  return payload.data;
}

function invalidRequestView() {
  app.innerHTML = `<main class="auth-page"><section class="auth-panel"><div class="auth-card">
    <span class="eyebrow">Authority Atlas</span>
    <h2>Sign-in link is incomplete</h2>
    <p class="intro">This link is missing required information and can't continue. Return to AI Compliance Readiness and choose "Continue with Authority Atlas" again.</p>
  </div></section></main>`;
}

function loginView() {
  const register = authMode === "register";
  app.innerHTML = `
    <main class="auth-page">
      <section class="auth-story">
        <div><div class="brand"><i class="brand-mark"></i><span>RootSystems</span></div></div>
        <div class="story-copy">
          <span class="eyebrow">Authority Atlas</span>
          <h1>Sign in to continue to <em>AI Compliance Readiness</em>.</h1>
          <p>Your Atlas password stays on Atlas. Readiness only ever receives your name, email, and organization, and only after you confirm on the next screen.</p>
        </div>
      </section>
      <section class="auth-panel">
        <div class="auth-card">
          <span class="eyebrow">Secure workspace</span>
          <h2>${register ? "Create your Atlas workspace" : "Sign in to Authority Atlas"}</h2>
          <p class="intro">${register ? "Start a workspace, then continue to AI Compliance Readiness." : "Sign in to continue to AI Compliance Readiness."}</p>
          <div class="segmented" role="tablist" aria-label="Authentication mode">
            <button class="segment ${!register ? "active" : ""}" data-auth-mode="login" role="tab">Sign in</button>
            <button class="segment ${register ? "active" : ""}" data-auth-mode="register" role="tab">Create account</button>
          </div>
          <form id="auth-form" class="field-grid">
            ${
              register
                ? `
              <div class="field"><label for="name">Your name</label><input id="name" name="name" autocomplete="name" required minlength="2" placeholder="Alex Morgan" /></div>
              <div class="field"><label for="organizationName">Organization</label><input id="organizationName" name="organizationName" required minlength="2" placeholder="Northstar Labs" /></div>`
                : ""
            }
            <div class="field full"><label for="email">Work email</label><input id="email" name="email" type="email" autocomplete="email" required placeholder="you@company.com" /></div>
            <div class="field full"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="${register ? "new-password" : "current-password"}" required minlength="${register ? 12 : 1}" placeholder="${register ? "At least 12 characters" : "Your password"}" /></div>
            <div class="field full"><button class="button button-primary button-block" type="submit">${register ? "Create workspace" : "Sign in"}<span>→</span></button><p id="auth-message" class="form-message"></p></div>
          </form>
        </div>
      </section>
    </main>`;
  document.querySelectorAll("[data-auth-mode]").forEach((button) =>
    button.addEventListener("click", () => {
      authMode = button.dataset.authMode;
      loginView();
    }),
  );
  document.querySelector("#auth-form").addEventListener("submit", submitAuth);
}

async function submitAuth(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button[type=submit]");
  const message = form.querySelector("#auth-message");
  button.disabled = true;
  message.textContent = "";
  try {
    const payload = Object.fromEntries(new FormData(form).entries());
    const data = await api(`/auth/${authMode}`, { method: "POST", body: JSON.stringify(payload) });
    sessionStorage.setItem(TOKEN_KEY, data.accessToken);
    await confirmView();
  } catch (error) {
    message.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function confirmView() {
  let me;
  try {
    me = await api("/auth/me");
  } catch {
    sessionStorage.removeItem(TOKEN_KEY);
    return loginView();
  }
  app.innerHTML = `
    <main class="auth-page">
      <section class="auth-panel" style="margin-inline:auto;">
        <div class="auth-card">
          <span class="eyebrow">Authority Atlas</span>
          <h2>Continue to AI Compliance Readiness?</h2>
          <p class="intro">Signed in as <strong>${escapeHtml(me.user.name)}</strong> (${escapeHtml(me.user.email)}) — workspace <strong>${escapeHtml(me.organization.name)}</strong>.</p>
          <p class="small muted">AI Compliance Readiness will receive your name, email, and organization. Your Atlas password is never shared.</p>
          <div class="field-grid">
            <div class="field full"><button id="continue-button" class="button button-primary button-block" type="button">Continue<span>→</span></button><p id="confirm-message" class="form-message"></p></div>
            <div class="field full"><button id="switch-account" class="button button-secondary button-block" type="button">Use a different account</button></div>
          </div>
        </div>
      </section>
    </main>`;
  document.querySelector("#continue-button").addEventListener("click", onContinue);
  document.querySelector("#switch-account").addEventListener("click", () => {
    sessionStorage.removeItem(TOKEN_KEY);
    loginView();
  });
}

async function onContinue() {
  const button = document.querySelector("#continue-button");
  const message = document.querySelector("#confirm-message");
  button.disabled = true;
  message.textContent = "";
  try {
    const data = await api("/oauth/authorize", {
      method: "POST",
      body: JSON.stringify({
        clientId: oauthRequest.clientId,
        redirectUri: oauthRequest.redirectUri,
        state: oauthRequest.state,
        responseType: "code",
      }),
    });
    window.location.assign(data.redirectTo);
  } catch (error) {
    message.textContent = error.message;
    button.disabled = false;
  }
}

async function init() {
  if (!oauthRequest.clientId || !oauthRequest.redirectUri || !oauthRequest.state) {
    return invalidRequestView();
  }
  if (sessionStorage.getItem(TOKEN_KEY)) return confirmView();
  return loginView();
}

init();
