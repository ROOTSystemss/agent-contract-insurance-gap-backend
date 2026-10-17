const API = "/api/v1";
const app = document.querySelector("#app");
const toastRegion = document.querySelector("#toast-region");

const state = {
  token: sessionStorage.getItem("authorityAtlasToken"),
  me: null,
  projects: [],
  project: null,
  agents: [],
  documents: [],
  analyses: [],
  auditEvents: [],
  members: [],
  report: null,
  view: "overview",
  authMode: "register",
  handoff: null,
};

const icon = (name) => {
  const paths = {
    overview: '<path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z"/>',
    agent: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0M19 4v4M17 6h4"/>',
    evidence: '<path d="M6 2h9l5 5v15H6zM14 2v6h6M9 13h8M9 17h6"/>',
    analysis: '<path d="M4 19V9M10 19V5M16 19v-7M22 19V2"/>',
    activity: '<path d="M4 12h3l2-6 4 12 2-6h5M5 3v18h16"/>',
  };
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
};

const escapeHtml = (value = "") =>
  String(value).replace(
    /[&<>'"]/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "'": "&#39;",
        '"': "&quot;",
      })[character],
  );
const pretty = (value = "") =>
  String(value)
    .replaceAll("_", " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
const initials = (value = "") =>
  value
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase() || "RS";
const formDataObject = (form) => Object.fromEntries(new FormData(form).entries());

// ---- Floor 3 handoff from Standards Readiness -------------------------
// Arrives as URL parameters, so it is untrusted input: every value is
// validated/clamped here and only ever written to the DOM via .value or
// textContent, never innerHTML. It only pre-fills a form the user must confirm.
const HANDOFF_KEY = "floor3Handoff";
const HANDOFF_BANDS = ["NOT_READY", "DEVELOPING", "SUBSTANTIALLY_READY"];
const cleanText = (value, max) =>
  // eslint-disable-next-line no-control-regex
  String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const cleanInt = (value, max) => {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) && number >= 0 ? Math.min(number, max) : null;
};
function captureHandoff() {
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get("handoff") !== "readiness") return;
    const subject = cleanText(params.get("subject"), 120);
    if (subject.length >= 2) {
      const band = params.get("band");
      sessionStorage.setItem(
        HANDOFF_KEY,
        JSON.stringify({
          source: "Standards Readiness",
          subject,
          band: HANDOFF_BANDS.includes(band) ? band : null,
          score: cleanInt(params.get("score"), 100),
          critical: cleanInt(params.get("critical"), 999),
          ref: cleanText(params.get("ref"), 40) || null,
        }),
      );
    }
    window.history.replaceState(null, "", window.location.pathname);
  } catch {
    /* storage or history unavailable: the handoff is simply skipped */
  }
}
function loadHandoff() {
  try {
    return JSON.parse(sessionStorage.getItem(HANDOFF_KEY) || "null");
  } catch {
    return null;
  }
}
function clearHandoff() {
  state.handoff = null;
  try {
    sessionStorage.removeItem(HANDOFF_KEY);
  } catch {
    /* ignore */
  }
}
function handoffPrefill(handoff) {
  const facts = [];
  if (handoff.band) facts.push(`readiness band ${pretty(handoff.band)}`);
  if (handoff.score !== null) facts.push(`score ${handoff.score}/100`);
  if (handoff.critical !== null)
    facts.push(`${handoff.critical} critical gap${handoff.critical === 1 ? "" : "s"}`);
  return {
    name: `Coverage check: ${handoff.subject}`.slice(0, 120),
    description:
      `Started from an Standards Readiness assessment of "${handoff.subject}"` +
      (facts.length ? ` (${facts.join(", ")}; self-reported, not verified here)` : "") +
      ". Review whether contracts and insurance actually cover the authority this AI system has.",
  };
}

// ---- Floor 3 journey indicator (Readiness -> Contract Gap -> Trust Proof) ----
function flowStrip(current) {
  const steps = [
    ["Standards Readiness", "Flag readiness gaps", "1"],
    ["Contract & Insurance Gap", "Check contracts and insurance", "2"],
    ["Named Sign-off", "Sign the decision", "3"],
  ];
  const stateFor = (index) =>
    index + 1 < current ? "done" : index + 1 === current ? "current" : "upcoming";
  return `<nav class="f3-flow" aria-label="AI Agent Trust journey"><span class="f3-flow__label">AI Agent Trust journey</span><ol>${steps
    .map(([name, note, number], index) => {
      const status = stateFor(index);
      const soon = "";
      return `<li class="f3-flow__step f3-flow__step--${status}"${status === "current" ? ' aria-current="step"' : ""}><span class="f3-flow__num">${status === "done" ? "✓" : number}</span><span class="f3-flow__copy"><strong>${name}</strong><small>${note}</small></span>${soon}</li>`;
    })
    .join("")}</ol></nav>`;
}

function handoffBanner() {
  const handoff = state.handoff;
  if (!handoff) return "";
  return `<div class="f3-handoff" role="status"><div><span class="eyebrow">From ${escapeHtml(handoff.source)}</span><strong>${escapeHtml(handoff.subject)}</strong><p>Context carried over: ${handoff.band ? escapeHtml(pretty(handoff.band)) : "no band"}${handoff.score !== null ? ` · ${handoff.score}/100` : ""}${handoff.critical !== null ? ` · ${handoff.critical} critical gap${handoff.critical === 1 ? "" : "s"}` : ""}. Unverified summary; nothing else was transferred.</p></div><div class="header-actions"><button class="button button-primary" data-handoff-start>Start this review</button><button class="button button-ghost" data-handoff-dismiss>Dismiss</button></div></div>`;
}

function toast(message, type = "success") {
  const element = document.createElement("div");
  element.className = `toast ${type}`;
  element.textContent = message;
  toastRegion.append(element);
  setTimeout(() => element.remove(), 4200);
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (state.token) headers.set("Authorization", `Bearer ${state.token}`);
  if (options.body && !(options.body instanceof FormData))
    headers.set("Content-Type", "application/json");
  const response = await fetch(`${API}${path}`, { ...options, headers });
  if (response.status === 204) return null;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && state.token) logout(false);
    const details = payload.error?.details?.map((item) => item.message).join(" ");
    throw new Error(details || payload.error?.message || "The request could not be completed.");
  }
  return payload.data;
}

function authView() {
  const register = state.authMode === "register";
  app.innerHTML = `
    <main class="auth-page">
      <section class="auth-story">
        <div>
          <div class="brand"><img class="brand-mark-img" src="/rs-logo.svg" alt="" width="29" height="32"><span>RootSystems</span></div>
        </div>
        <div class="story-copy">
          <span class="eyebrow">AI Agent Trust</span>
          <h1>Know where your agent's <em>authority</em> outruns the paperwork.</h1>
          <p>Map AI-agent capabilities against contracts and insurance evidence with a deterministic, review-ready workflow.</p>
          <div class="trust-row"><span>Evidence linked</span><span>Deterministic by default</span><span>Built for expert review</span></div>
        </div>
        <div class="auth-footer">Decision support only — not legal advice, an insurance coverage opinion, or a substitute for professional review.</div>
      </section>
      <section class="auth-panel">
        <div class="auth-card">
          <span class="eyebrow">Secure workspace</span>
          <h2>${register ? "Create your workspace" : "Welcome back"}</h2>
          <p class="intro">${register ? "Start a private authority review for your organization." : "Sign in to continue your authority review."}</p>
          <div class="segmented" role="tablist" aria-label="Authentication mode">
            <button class="segment ${register ? "active" : ""}" data-auth-mode="register" role="tab">Create account</button>
            <button class="segment ${!register ? "active" : ""}" data-auth-mode="login" role="tab">Sign in</button>
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
            <div class="field full"><button class="button button-primary button-block" type="submit">${register ? "Create secure workspace" : "Sign in"}<span>→</span></button><p id="auth-message" class="form-message"></p></div>
          </form>
          <p class="small muted">Your documents stay private to this workspace and are encrypted at rest.</p>
        </div>
      </section>
    </main>`;
  document.querySelectorAll("[data-auth-mode]").forEach((button) =>
    button.addEventListener("click", () => {
      state.authMode = button.dataset.authMode;
      authView();
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
    const data = await api(`/auth/${state.authMode}`, {
      method: "POST",
      body: JSON.stringify(formDataObject(form)),
    });
    state.token = data.accessToken;
    sessionStorage.setItem("authorityAtlasToken", state.token);
    await initialize();
    toast(state.authMode === "register" ? "Workspace created." : "Signed in successfully.");
  } catch (error) {
    message.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

function shell(content) {
  const user = state.me?.user || {};
  const org = state.me?.organization || {};
  const nav = [
    ["overview", "Workspace", "overview"],
    ["agent", "Agent profile", "agent"],
    ["evidence", "Evidence", "evidence"],
    ["analysis", "Analysis", "analysis"],
    ["activity", "Activity", "activity"],
  ];
  app.innerHTML = `<div class="workspace">
    <aside class="sidebar">
      <div class="brand"><img class="brand-mark-img" src="/rs-logo.svg" alt="" width="29" height="32"><span>RootSystems</span></div><div class="product-tag">AI Agent Trust</div>
      <div class="nav-group-label">Review workspace</div>
      <nav aria-label="Main navigation">${nav.map(([view, label, ico]) => `<button class="nav-button ${state.view === view ? "active" : ""}" data-view="${view}">${icon(ico)}<span>${label}</span></button>`).join("")}</nav>
      <a class="nav-button" href="/console#/settings" id="plans-link">${icon("overview")}<span>Plans &amp; billing</span></a>
      <div class="sidebar-spacer"></div>
      <div class="sidebar-card"><strong>Decision support</strong><p>Results identify attention areas. Always involve qualified legal and insurance professionals.</p></div>
      <div class="user-menu"><div class="avatar">${escapeHtml(initials(user.name))}</div><div class="user-copy"><strong>${escapeHtml(user.name)}</strong><span>${escapeHtml(org.name)}</span></div></div>
    </aside>
    <section class="main">
      <header class="topbar"><div class="breadcrumb"><span>${escapeHtml(org.name || "Workspace")}</span><span class="slash">/</span><strong>${escapeHtml(state.project?.name || "All projects")}</strong></div><button class="button button-secondary session-signout" data-logout aria-label="Sign out">Sign out</button></header>
      <div class="content">${["admin", "owner"].includes(state.me?.role) ? '<div style="margin-bottom:16px"><button class="button button-secondary" data-governance-export>Export governance summary</button><p class="small muted">AI Agent Trust · Export project inventory for your readiness dashboard. Source documents and accounts stay separate.</p></div>' : ""}${content}</div>
    </section>
  </div>`;
  bindShell();
}

function bindShell() {
  document.querySelector("[data-governance-export]")?.addEventListener("click", async () => {
    try {
      const summary = await api("/governance/export");
      const url = URL.createObjectURL(new Blob([JSON.stringify(summary, null, 2)], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = "atlas-governance-summary.json";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast("Summary exported. Import it in Standards Readiness; it contains project names and statuses.");
    } catch (error) { toast(error.message, "error"); }
  });
  document
    .querySelectorAll("[data-view]")
    .forEach((button) => button.addEventListener("click", () => navigate(button.dataset.view)));
  document.querySelector("[data-logout]")?.addEventListener("click", () => logout());
}

async function navigate(view) {
  state.view = view;
  if (view === "overview") return renderOverview();
  if (!state.project) {
    toast("Create or select a project first.", "error");
    state.view = "overview";
    return renderOverview();
  }
  if (view === "agent") return renderAgent();
  if (view === "evidence") {
    await loadDocuments();
    return renderEvidence();
  }
  if (view === "analysis") {
    await loadAnalysisData();
    return renderAnalysis();
  }
  if (view === "activity") {
    await loadAuditEvents();
    return renderActivity();
  }
}

function logout(showToast = true) {
  sessionStorage.removeItem("authorityAtlasToken");
  Object.assign(state, {
    token: null,
    me: null,
    projects: [],
    project: null,
    agents: [],
    documents: [],
    analyses: [],
    auditEvents: [],
    members: [],
    report: null,
    view: "overview",
  });
  authView();
  if (showToast) toast("Signed out.");
}

async function initialize() {
  try {
    state.me = await api("/auth/me");
    state.projects = await api("/projects/?pageSize=100");
    const savedId = sessionStorage.getItem("authorityAtlasProject");
    state.project =
      state.projects.find((project) => project.id === savedId) || state.projects[0] || null;
    if (state.project) await loadProjectResources();
    state.view = "overview";
    state.handoff = loadHandoff();
    renderOverview();
    if (state.handoff) openProjectModal(handoffPrefill(state.handoff));
  } catch {
    logout(false);
  }
}

async function loadProjectResources() {
  if (!state.project) return;
  [state.agents, state.documents, state.analyses, state.auditEvents] = await Promise.all([
    api(`/projects/${state.project.id}/agents`),
    api(`/projects/${state.project.id}/documents?pageSize=100`),
    api(`/projects/${state.project.id}/analyses?pageSize=100`),
    api(`/projects/${state.project.id}/audit-events?pageSize=100`),
  ]);
  state.analyses.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function pageHeader(eyebrow, title, description, actions = "") {
  return `<div class="page-header"><div class="page-title"><span class="eyebrow">${eyebrow}</span><h1>${title}</h1><p>${description}</p></div>${actions ? `<div class="header-actions">${actions}</div>` : ""}</div>`;
}

function renderOverview() {
  const completed = state.analyses.filter((analysis) =>
    analysis.state.startsWith("completed"),
  ).length;
  const latestScore = state.analyses.find((analysis) => analysis.attentionScore)?.attentionScore
    ?.score;
  shell(`${flowStrip(2)}${handoffBanner()}${pageHeader("Review portfolio", "Authority workspace", "Create a review, describe the agent, add governing documents, and generate evidence-linked attention findings.", `${state.project ? '<button class="button button-secondary" data-project-settings>Review settings</button>' : ""}<button class="button button-primary" data-new-project>+ New review</button>`)}
    <div class="grid grid-3">
      <div class="card card-pad metric"><div class="metric-label">Active reviews</div><div class="metric-value">${state.projects.length}</div><div class="metric-detail">Across ${escapeHtml(state.me.organization.name)}</div></div>
      <div class="card card-pad metric"><div class="metric-label">Evidence documents</div><div class="metric-value">${state.documents.length}</div><div class="metric-detail">Contract and insurance sources</div></div>
      <div class="card card-pad metric"><div class="metric-label">Latest attention score</div><div class="metric-value">${latestScore ?? "—"}${latestScore !== undefined ? '<small style="font-size:1rem"> / 100</small>' : ""}</div><div class="metric-detail">${completed ? `${completed} completed analysis${completed === 1 ? "" : "es"}` : "No completed analysis yet"}</div></div>
    </div>
    <div class="card card-pad" style="margin-top:18px">
      <div class="section-head"><div><h2>Your reviews</h2><p>Select a workspace or start a new authority review.</p></div></div>
      ${state.projects.length ? `<div class="project-list">${state.projects.map((project) => `<button class="project-row" data-project-id="${project.id}"><span class="project-badge">${escapeHtml(project.primaryCountryCode)}</span><span><strong>${escapeHtml(project.name)}</strong><span>${escapeHtml(project.description || "No description")} · ${escapeHtml(project.primaryCountryCode)}${project.primarySubdivisionCode ? ` / ${escapeHtml(project.primarySubdivisionCode)}` : ""}</span></span><span class="chevron">→</span></button>`).join("")}</div>` : `<div class="empty-state"><div class="empty-icon">⌁</div><h3>Start your first authority review</h3><p>Create a project for one AI agent and the contracts or insurance materials you want to compare.</p><button class="button button-primary" data-new-project>Create first review</button></div>`}
    </div>`);
  document.querySelector("[data-handoff-start]")?.addEventListener("click", () => openProjectModal(handoffPrefill(state.handoff)));
  document.querySelector("[data-handoff-dismiss]")?.addEventListener("click", () => {
    clearHandoff();
    renderOverview();
  });
  document
    .querySelectorAll("[data-new-project]")
    .forEach((button) => button.addEventListener("click", openProjectModal));
  document
    .querySelector("[data-project-settings]")
    ?.addEventListener("click", openProjectSettingsModal);
  document.querySelectorAll("[data-project-id]").forEach((button) =>
    button.addEventListener("click", async () => {
      state.project = state.projects.find((project) => project.id === button.dataset.projectId);
      sessionStorage.setItem("authorityAtlasProject", state.project.id);
      await loadProjectResources();
      state.view = state.agents.length ? "evidence" : "agent";
      navigate(state.view);
    }),
  );
}

function openProjectSettingsModal() {
  const project = state.project;
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="settings-modal-title">
    <div class="modal-head"><div><span class="eyebrow">Review settings</span><h2 id="settings-modal-title">Update the scope</h2></div><button class="icon-button" data-close-modal aria-label="Close dialog">×</button></div>
    <form id="settings-form" class="field-grid">
      <div class="field full"><label for="settings-name">Review name</label><input id="settings-name" name="name" required minlength="2" value="${escapeHtml(project.name)}" /></div>
      <div class="field full"><label for="settings-description">Purpose</label><textarea id="settings-description" name="description">${escapeHtml(project.description || "")}</textarea></div>
      <div class="field"><label for="settings-country">Primary country</label><input id="settings-country" name="primaryCountryCode" maxlength="2" required value="${escapeHtml(project.primaryCountryCode)}" /></div>
      <div class="field"><label for="settings-subdivision">State / subdivision</label><input id="settings-subdivision" name="primarySubdivisionCode" value="${escapeHtml(project.primarySubdivisionCode || "")}" placeholder="e.g. US-IL" pattern="[A-Za-z]{2}-[A-Za-z0-9]{1,3}" title="Use a code like US-IL: country code, a dash, then the region." /></div>
      <div class="field full"><label for="settings-affected">Other affected countries</label><input id="settings-affected" name="affectedCountryCodes" value="${escapeHtml(project.affectedCountryCodes.join(", "))}" /></div>
      <div class="field full"><p id="settings-message" class="form-message"></p><div class="form-actions split-actions"><button type="button" class="button button-ghost danger-text" data-delete-project>Delete review</button><span><button type="button" class="button button-secondary" data-close-modal>Cancel</button> <button type="submit" class="button button-primary">Save changes</button></span></div></div>
    </form></div>`;
  document.body.append(backdrop);
  backdrop
    .querySelectorAll("[data-close-modal]")
    .forEach((button) => button.addEventListener("click", () => backdrop.remove()));
  backdrop.querySelector("[data-delete-project]").addEventListener("click", async (event) => {
    if (!window.confirm(`Permanently delete the review “${project.name}” and its records?`)) return;
    event.currentTarget.disabled = true;
    try {
      await api(`/projects/${project.id}`, { method: "DELETE" });
      sessionStorage.removeItem("authorityAtlasProject");
      state.project = null;
      state.agents = [];
      state.documents = [];
      state.analyses = [];
      state.auditEvents = [];
      state.report = null;
      state.projects = await api("/projects/?pageSize=100");
      backdrop.remove();
      toast("Review deleted.");
      renderOverview();
    } catch (error) {
      toast(error.message, "error");
      event.currentTarget.disabled = false;
    }
  });
  backdrop.querySelector("#settings-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const values = formDataObject(form);
    const submit = form.querySelector("button[type=submit]");
    submit.disabled = true;
    try {
      state.project = await api(`/projects/${project.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: values.name,
          description: values.description || null,
          primaryCountryCode: values.primaryCountryCode.toUpperCase(),
          primarySubdivisionCode: values.primarySubdivisionCode || null,
          affectedCountryCodes: commaList(values.affectedCountryCodes).map((value) =>
            value.toUpperCase(),
          ),
        }),
      });
      state.projects = state.projects.map((item) =>
        item.id === state.project.id ? state.project : item,
      );
      backdrop.remove();
      toast("Review settings updated.");
      renderOverview();
    } catch (error) {
      form.querySelector("#settings-message").textContent = error.message;
    } finally {
      submit.disabled = false;
    }
  });
}

function openProjectModal(prefill = {}) {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="project-modal-title">
    <div class="modal-head"><div><span class="eyebrow">New review</span><h2 id="project-modal-title">Define the scope</h2></div><button class="icon-button" data-close-modal aria-label="Close dialog">×</button></div>
    <form id="project-form" class="field-grid">
      <div class="field full"><label for="project-name">Review name</label><input id="project-name" name="name" required minlength="2" placeholder="Vendor purchasing agent review" /></div>
      <div class="field full"><label for="project-description">Purpose</label><textarea id="project-description" name="description" placeholder="Review authority in customer, vendor, and insurance documents."></textarea></div>
      <div class="field"><label for="project-country">Primary country</label><select id="project-country" name="primaryCountryCode"><option value="US">United States</option><option value="GB">United Kingdom</option><option value="CA">Canada</option><option value="IN">India</option><option value="AU">Australia</option></select></div>
      <div class="field"><label for="project-subdivision">State / subdivision</label><input id="project-subdivision" name="primarySubdivisionCode" placeholder="e.g. US-IL" pattern="[A-Za-z]{2}-[A-Za-z0-9]{1,3}" title="Use a code like US-IL: country code, a dash, then the region." /><span class="field-hint">Optional. Format: US-IL.</span></div>
      <div class="field full"><label for="affected-countries">Other affected countries</label><input id="affected-countries" name="affectedCountryCodes" placeholder="GB, CA" /><span class="field-hint">Optional, comma-separated ISO country codes.</span></div>
      <div class="field full"><p id="project-message" class="form-message"></p><div class="form-actions"><button type="button" class="button button-secondary" data-close-modal>Cancel</button><button type="submit" class="button button-primary">Create review →</button></div></div>
    </form></div>`;
  document.body.append(backdrop);
  if (prefill.name) backdrop.querySelector("#project-name").value = prefill.name;
  if (prefill.description) backdrop.querySelector("#project-description").value = prefill.description;
  backdrop
    .querySelectorAll("[data-close-modal]")
    .forEach((button) => button.addEventListener("click", () => backdrop.remove()));
  backdrop.querySelector("#project-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const values = formDataObject(form);
    const submit = form.querySelector("button[type=submit]");
    submit.disabled = true;
    try {
      const payload = {
        name: values.name,
        description: values.description || null,
        primaryCountryCode: values.primaryCountryCode,
        primarySubdivisionCode: values.primarySubdivisionCode || null,
        affectedCountryCodes: values.affectedCountryCodes
          ? values.affectedCountryCodes
              .split(",")
              .map((value) => value.trim().toUpperCase())
              .filter(Boolean)
          : [],
      };
      state.project = await api("/projects/", { method: "POST", body: JSON.stringify(payload) });
      state.projects.unshift(state.project);
      state.agents = [];
      state.documents = [];
      state.analyses = [];
      sessionStorage.setItem("authorityAtlasProject", state.project.id);
      if (prefill.name && state.handoff) clearHandoff();
      backdrop.remove();
      toast("Review created. Now describe the agent.");
      navigate("agent");
    } catch (error) {
      form.querySelector("#project-message").textContent = error.message;
    } finally {
      submit.disabled = false;
    }
  });
}

const capabilityFields = [
  ["canCommunicateExternally", "Communicate externally"],
  ["canMakeRepresentations", "Make representations"],
  ["canAcceptTerms", "Accept terms"],
  ["canExecuteTransactions", "Execute transactions"],
  ["canSpendMoney", "Spend money"],
  ["canIssueRefundsOrCredits", "Issue refunds or credits"],
  ["canChangePrices", "Change prices"],
  ["canEnterContracts", "Enter contracts"],
  ["canApproveOrRejectPeople", "Approve or reject people"],
  ["canApproveOrRejectVendors", "Approve or reject vendors"],
  ["canAccessPersonalData", "Access personal data"],
  ["canAccessSensitivePersonalData", "Access sensitive personal data"],
  ["canAccessConfidentialBusinessData", "Access confidential business data"],
  ["canAccessRegulatedData", "Access regulated data"],
  ["canModifyOrDeleteData", "Modify or delete data"],
  ["canCreateIntellectualProperty", "Create intellectual property"],
  ["canPublishContent", "Publish content"],
  ["canDeployCode", "Deploy code"],
  ["canControlInfrastructure", "Control infrastructure"],
  ["canHireOrTerminateWorkers", "Hire or terminate workers"],
  ["canDelegateToSubAgents", "Delegate to sub-agents"],
];

function renderAgent() {
  const agent = state.agents[0] || {};
  shell(`${pageHeader("Contract & Insurance Gap · part 1 of 3", agent.id ? "Agent authority profile" : "Describe the agent", "Capture what the system can actually do. Precise capability boundaries make the comparison more useful.", agent.id ? '<span class="badge badge-green">Profile saved</span>' : '<button type="button" class="button button-secondary" data-fill-example>Fill example profile</button>')}
    <div class="progress-track"><i class="progress-step done"></i><i class="progress-step"></i><i class="progress-step"></i></div>
    <form id="agent-form" class="card form-card">
      <section class="form-section"><div class="form-section-title"><span class="section-number">01</span><div><h3>Identity and deployment</h3><p>Basic operating context for this agent.</p></div></div>
        <div class="field-grid">
          <div class="field"><label for="agent-name">Agent name</label><input id="agent-name" name="name" required minlength="2" value="${escapeHtml(agent.name || "")}" placeholder="Procurement copilot" /></div>
          <div class="field"><label for="agent-status">Deployment status</label><select id="agent-status" name="deploymentStatus">${["planning", "pilot", "production", "retired"].map((value) => `<option value="${value}" ${agent.deploymentStatus === value ? "selected" : ""}>${pretty(value)}</option>`).join("")}</select></div>
          <div class="field full"><label for="agent-purpose">Business purpose</label><textarea id="agent-purpose" name="businessPurpose" required minlength="5" placeholder="Reviews vendor proposals and prepares purchase recommendations.">${escapeHtml(agent.businessPurpose || "")}</textarea></div>
          <div class="field"><label for="operator">Operator organization</label><input id="operator" name="operatorOrganization" required value="${escapeHtml(agent.operatorOrganization || state.me.organization.name)}" /></div>
          <div class="field"><label for="provider">Developer / provider</label><input id="provider" name="developerProvider" value="${escapeHtml(agent.developerProvider || "")}" placeholder="Internal team or vendor" /></div>
          <div class="field"><label for="agent-type">Agent type</label><input id="agent-type" name="agentType" required value="${escapeHtml(agent.agentType || "Task-oriented AI agent")}" /></div>
          <div class="field"><label for="jurisdiction">Primary jurisdiction</label><input id="jurisdiction" name="primaryJurisdiction" required maxlength="2" value="${escapeHtml(agent.primaryJurisdiction || state.project.primaryCountryCode)}" /></div>
          <div class="field"><label for="deployment-countries">Deployment countries</label><input id="deployment-countries" name="deploymentCountries" required value="${escapeHtml((agent.deploymentCountries || [state.project.primaryCountryCode]).join(", "))}" /></div>
          <div class="field"><label for="affected-agent-countries">Affected countries</label><input id="affected-agent-countries" name="affectedCountries" value="${escapeHtml((agent.affectedCountries || state.project.affectedCountryCodes || []).join(", "))}" /></div>
        </div>
      </section>
      <section class="form-section"><div class="form-section-title"><span class="section-number">02</span><div><h3>Authority and oversight</h3><p>Define autonomy, review controls, and financial boundaries.</p></div></div>
        <div class="field-grid">
          <div class="field"><label for="autonomy">Autonomy level (0–5)</label><input id="autonomy" name="autonomyLevel" type="number" min="0" max="5" required value="${agent.autonomyLevel ?? 2}" /></div>
          <div class="field"><label for="oversight">Human oversight</label><select id="oversight" name="humanOversightLevel">${["continuous", "pre_action_approval", "threshold_approval", "periodic_review", "exception_only", "none"].map((value) => `<option value="${value}" ${agent.humanOversightLevel === value ? "selected" : ""}>${pretty(value)}</option>`).join("")}</select></div>
          <div class="field"><label for="reversibility">Reversibility</label><select id="reversibility" name="reversibility">${["fully_reversible", "partially_reversible", "irreversible", "unknown"].map((value) => `<option value="${value}" ${agent.reversibility === value ? "selected" : ""}>${pretty(value)}</option>`).join("")}</select></div>
          <div class="field"><label for="logging">Logging level</label><select id="logging" name="loggingLevel">${["none", "basic", "detailed", "tamper_evident"].map((value) => `<option value="${value}" ${agent.loggingLevel === value ? "selected" : ""}>${pretty(value)}</option>`).join("")}</select></div>
          <div class="field"><label for="transaction-limit">Per-transaction limit</label><input id="transaction-limit" name="perTransactionLimit" type="number" min="0" value="${agent.perTransactionLimit ?? ""}" placeholder="5000" /></div>
          <div class="field"><label for="aggregate-limit">Aggregate spending limit</label><input id="aggregate-limit" name="aggregateSpendingLimit" type="number" min="0" value="${agent.aggregateSpendingLimit ?? ""}" placeholder="25000" /></div>
          <div class="field"><label for="currency">Currency</label><input id="currency" name="currency" maxlength="3" value="${escapeHtml(agent.currency || "USD")}" /></div>
          <div class="field"><label for="thresholds">Approval thresholds</label><input id="thresholds" name="approvalThresholds" value="${escapeHtml((agent.approvalThresholds || []).join(", "))}" placeholder="Human approval above $1,000" /></div>
        </div>
      </section>
      <section class="form-section"><div class="form-section-title"><span class="section-number">03</span><div><h3>Capabilities</h3><p>Select every action the agent can perform, even when approval is required.</p></div></div>
        <div class="toggle-grid">${capabilityFields.map(([name, label]) => `<label class="toggle"><input type="checkbox" name="${name}" ${agent[name] ? "checked" : ""} /><span>${label}</span></label>`).join("")}</div>
      </section>
      <section class="form-section"><div class="form-section-title"><span class="section-number">04</span><div><h3>Systems and safeguards</h3><p>Add operational context that a reviewer should understand.</p></div></div>
        <div class="field-grid">
          <div class="field"><label for="tools">Third-party tools</label><input id="tools" name="thirdPartyToolsUsed" value="${escapeHtml((agent.thirdPartyToolsUsed || []).join(", "))}" placeholder="OpenAI API, Stripe" /></div>
          <div class="field"><label for="systems">Systems accessed</label><input id="systems" name="systemsAccessed" value="${escapeHtml((agent.systemsAccessed || []).join(", "))}" placeholder="CRM, procurement portal" /></div>
          <div class="field"><label for="stop">Emergency stop mechanism</label><input id="stop" name="emergencyStopMechanism" value="${escapeHtml(agent.emergencyStopMechanism || "")}" placeholder="Operator kill switch" /></div>
          <div class="field"><label for="incident-owner">Incident response owner</label><input id="incident-owner" name="incidentResponseOwner" value="${escapeHtml(agent.incidentResponseOwner || "")}" placeholder="Security Operations" /></div>
          <div class="field full"><label for="limitations">Known limitations</label><textarea id="limitations" name="knownLimitations" placeholder="Cannot verify vendor identity without human review.">${escapeHtml((agent.knownLimitations || []).join("\n"))}</textarea></div>
          <div class="field full"><label for="notes">Reviewer notes</label><textarea id="notes" name="notes">${escapeHtml(agent.notes || "")}</textarea></div>
        </div>
      </section>
      <p id="agent-message" class="form-message"></p><div class="form-actions">${agent.id ? '<button type="button" class="button button-secondary" data-view="evidence">Go to evidence →</button>' : ""}<button type="submit" class="button button-primary">${agent.id ? "Update profile" : "Save and add evidence →"}</button></div>
    </form>${agent.id ? '<section id="authority-certificate" class="card authority-card" aria-label="Authority certificate"></section>' : ""}`);
  document.querySelector("#agent-form").addEventListener("submit", submitAgent);
  document.querySelector("[data-fill-example]")?.addEventListener("click", fillExampleAgent);
  if (agent.id) window.mountCertificatePanel?.(agent);
}

function fillExampleAgent() {
  const form = document.querySelector("#agent-form");
  const values = {
    name: "Procurement Agent",
    deploymentStatus: "pilot",
    businessPurpose: "Prepare vendor recommendations and execute purchases after approval.",
    operatorOrganization: state.me.organization.name,
    developerProvider: "Internal AI team",
    agentType: "Transaction agent",
    primaryJurisdiction: state.project.primaryCountryCode,
    deploymentCountries: state.project.primaryCountryCode,
    affectedCountries: state.project.affectedCountryCodes.join(", "),
    autonomyLevel: "4",
    humanOversightLevel: "threshold_approval",
    reversibility: "partially_reversible",
    loggingLevel: "detailed",
    perTransactionLimit: "5000",
    aggregateSpendingLimit: "25000",
    currency: "USD",
    approvalThresholds: "Human approval above USD 1,000",
    thirdPartyToolsUsed: "Procurement portal",
    systemsAccessed: "Vendor database, purchasing system",
    emergencyStopMechanism: "Operator kill switch",
    incidentResponseOwner: "Security Operations",
    knownLimitations: "Cannot independently verify vendor identity",
  };
  for (const [name, value] of Object.entries(values)) form.elements[name].value = value;
  [
    "canCommunicateExternally",
    "canMakeRepresentations",
    "canAcceptTerms",
    "canExecuteTransactions",
    "canSpendMoney",
    "canEnterContracts",
    "canApproveOrRejectVendors",
    "canAccessPersonalData",
    "canAccessConfidentialBusinessData",
  ].forEach((name) => {
    form.elements[name].checked = true;
  });
  toast("Example profile filled. Review the values, then save.");
}

const commaList = (value) =>
  value
    ? value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
async function submitAgent(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const values = formDataObject(form);
  const submit = form.querySelector("button[type=submit]");
  submit.disabled = true;
  const payload = {
    name: values.name,
    deploymentStatus: values.deploymentStatus,
    businessPurpose: values.businessPurpose,
    operatorOrganization: values.operatorOrganization,
    developerProvider: values.developerProvider || undefined,
    deploymentCountries: commaList(values.deploymentCountries).map((v) => v.toUpperCase()),
    affectedCountries: commaList(values.affectedCountries).map((v) => v.toUpperCase()),
    primaryJurisdiction: values.primaryJurisdiction.toUpperCase(),
    jurisdictionSubdivisions: [],
    agentType: values.agentType,
    autonomyLevel: Number(values.autonomyLevel),
    humanOversightLevel: values.humanOversightLevel,
    perTransactionLimit:
      values.perTransactionLimit === "" ? undefined : Number(values.perTransactionLimit),
    aggregateSpendingLimit:
      values.aggregateSpendingLimit === "" ? undefined : Number(values.aggregateSpendingLimit),
    currency: values.currency ? values.currency.toUpperCase() : undefined,
    reversibility: values.reversibility,
    loggingLevel: values.loggingLevel,
    approvalThresholds: commaList(values.approvalThresholds),
    thirdPartyToolsUsed: commaList(values.thirdPartyToolsUsed),
    systemsAccessed: commaList(values.systemsAccessed),
    emergencyStopMechanism: values.emergencyStopMechanism || undefined,
    incidentResponseOwner: values.incidentResponseOwner || undefined,
    knownLimitations: values.knownLimitations
      ? values.knownLimitations
          .split("\n")
          .map((v) => v.trim())
          .filter(Boolean)
      : [],
    notes: values.notes || undefined,
  };
  capabilityFields.forEach(([name]) => {
    payload[name] = form.elements[name].checked;
  });
  if (!payload.canSpendMoney) {
    delete payload.perTransactionLimit;
    delete payload.aggregateSpendingLimit;
    delete payload.currency;
  }
  try {
    const existing = state.agents[0];
    const saved = await api(
      existing ? `/agents/${existing.id}` : `/projects/${state.project.id}/agents`,
      { method: existing ? "PATCH" : "POST", body: JSON.stringify(payload) },
    );
    state.agents = [saved];
    toast(existing ? "Agent profile updated." : "Agent profile saved. Now add the evidence.");
    if (!existing) await navigate("evidence");
    else renderAgent();
  } catch (error) {
    form.querySelector("#agent-message").textContent = error.message;
  } finally {
    submit.disabled = false;
  }
}

async function loadDocuments() {
  state.documents = await api(`/projects/${state.project.id}/documents?pageSize=100`);
}

function renderEvidence() {
  shell(`${pageHeader("Contract & Insurance Gap · part 2 of 3", "Add governing evidence", "Upload the agreements and insurance materials that may define, limit, or cover the agent's authority.", `<span class="badge ${state.documents.length ? "badge-green" : "badge-gray"}">${state.documents.length} document${state.documents.length === 1 ? "" : "s"}</span>`)}
    <div class="progress-track"><i class="progress-step done"></i><i class="progress-step done"></i><i class="progress-step"></i></div>
    <div class="grid grid-2">
      <form id="upload-form" class="card card-pad">
        <div class="section-head"><div><h2>Upload a document</h2><p>PDF, DOCX, or TXT · maximum 10 MB</p></div></div>
        <div class="field-grid" style="margin-bottom:16px"><div class="field"><label for="document-type">Document type</label><select id="document-type" name="documentType">${["commercial_contract", "master_services_agreement", "statement_of_work", "vendor_agreement", "customer_agreement", "terms_of_service", "data_processing_agreement", "employment_or_contractor_agreement", "insurance_policy", "insurance_endorsement", "insurance_certificate", "insurance_schedule", "other"].map((value) => `<option value="${value}">${pretty(value)}</option>`).join("")}</select></div><div class="field"><label for="document-country">Country</label><input id="document-country" name="countryCode" value="${escapeHtml(state.project.primaryCountryCode)}" maxlength="2" required /></div></div>
        <label class="upload-zone" for="document-file"><input id="document-file" name="file" type="file" accept=".pdf,.docx,.txt,text/plain,application/pdf" required /><span style="font-size:1.5rem;color:var(--orange)">⇧</span><strong id="file-label">Choose a document</strong><span>Files are validated, hashed, and privately stored.</span></label>
        <p id="upload-message" class="form-message"></p><button type="submit" class="button button-primary button-block">Upload and extract</button>
      </form>
      <div class="card card-pad"><div class="section-head"><div><h2>Evidence checklist</h2><p>Strong reviews usually include both contractual and insurance evidence.</p></div></div>
        <div class="document-list">
          <div class="document-row"><span class="file-icon">CTR</span><span><strong>Authority-defining agreement</strong><span>MSA, SOW, customer, vendor, or employment agreement</span></span><span class="badge ${state.documents.some((d) => !d.documentType.startsWith("insurance")) ? "badge-green" : "badge-gray"}">${state.documents.some((d) => !d.documentType.startsWith("insurance")) ? "Added" : "Needed"}</span></div>
          <div class="document-row"><span class="file-icon">INS</span><span><strong>Insurance evidence</strong><span>Policy, endorsement, certificate, or schedule</span></span><span class="badge ${state.documents.some((d) => d.documentType.startsWith("insurance")) ? "badge-green" : "badge-gray"}">${state.documents.some((d) => d.documentType.startsWith("insurance")) ? "Added" : "Needed"}</span></div>
        </div>
      </div>
    </div>
    <div class="card card-pad" style="margin-top:18px"><div class="section-head"><div><h2>Uploaded evidence</h2><p>Only successfully extracted text is considered by the rules engine.</p></div>${state.agents.length ? '<button class="button button-dark" data-go-analysis>Continue to analysis →</button>' : ""}</div>
      ${state.documents.length ? `<div class="document-list">${state.documents.map(documentRow).join("")}</div>` : `<div class="empty-state"><div class="empty-icon">≡</div><h3>No evidence uploaded</h3><p>You can still run an analysis to identify missing-document attention items.</p><button class="button button-secondary" data-go-analysis>Continue without documents</button></div>`}
    </div>`);
  const input = document.querySelector("#document-file");
  input.addEventListener("change", () => {
    const filename = input.files[0]?.name || "";
    document.querySelector("#file-label").textContent = filename || "Choose a document";
    if (/insurance|policy|endorsement|coverage/i.test(filename)) {
      document.querySelector("#document-type").value = "insurance_policy";
      toast("Document type set to Insurance Policy based on the filename.");
    }
  });
  document.querySelector("#upload-form").addEventListener("submit", submitUpload);
  document
    .querySelectorAll("[data-go-analysis]")
    .forEach((button) => button.addEventListener("click", () => navigate("analysis")));
  document.querySelectorAll("[data-delete-document]").forEach((button) =>
    button.addEventListener("click", async () => {
      const documentName = button.dataset.documentName;
      if (!window.confirm(`Remove ${documentName} from this review?`)) return;
      button.disabled = true;
      try {
        await api(`/documents/${button.dataset.deleteDocument}`, { method: "DELETE" });
        await loadDocuments();
        toast("Document removed.");
        renderEvidence();
      } catch (error) {
        toast(error.message, "error");
        button.disabled = false;
      }
    }),
  );
}

function documentRow(document) {
  const badgeClass =
    document.extractionStatus === "completed"
      ? "badge-green"
      : document.extractionStatus.includes("warning") ||
          document.extractionStatus === "ocr_required"
        ? "badge-orange"
        : "badge-red";
  const extension = document.originalFilename.split(".").pop().slice(0, 3).toUpperCase();
  return `<div class="document-row"><span class="file-icon">${escapeHtml(extension)}</span><span><strong>${escapeHtml(document.originalFilename)}</strong><span>${pretty(document.documentType)} · ${(document.size / 1024).toFixed(1)} KB</span></span><span class="row-actions"><span class="badge ${badgeClass}">${pretty(document.extractionStatus)}</span><button class="icon-button danger-button" data-delete-document="${document.id}" data-document-name="${escapeHtml(document.originalFilename)}" aria-label="Remove ${escapeHtml(document.originalFilename)}">×</button></span></div>`;
}

async function submitUpload(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const file = form.elements.file.files[0];
  const button = form.querySelector("button[type=submit]");
  if (!file) return;
  button.disabled = true;
  button.textContent = "Extracting…";
  const body = new FormData();
  body.append("file", file);
  const query = new URLSearchParams({
    documentType: form.elements.documentType.value,
    countryCode: form.elements.countryCode.value.toUpperCase(),
  });
  try {
    await api(`/projects/${state.project.id}/documents?${query}`, { method: "POST", body });
    await loadDocuments();
    toast("Document uploaded and extracted.");
    renderEvidence();
  } catch (error) {
    form.querySelector("#upload-message").textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = "Upload and extract";
  }
}

async function loadAnalysisData() {
  [state.documents, state.analyses] = await Promise.all([
    api(`/projects/${state.project.id}/documents?pageSize=100`),
    api(`/projects/${state.project.id}/analyses?pageSize=100`),
  ]);
  state.analyses.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const latest = state.analyses[0];
  if (latest?.state.startsWith("completed") && analysisMatchesCurrentEvidence(latest))
    state.report = await api(`/analyses/${latest.id}/report`);
  else state.report = null;
}

function analysisMatchesCurrentEvidence(analysis) {
  if (!analysis || analysis.agentProfileId !== state.agents[0]?.id) return false;
  const analyzedIds = [...analysis.documentIds].sort();
  const currentIds = state.documents.map((document) => document.id).sort();
  return (
    analyzedIds.length === currentIds.length &&
    analyzedIds.every((documentId, index) => documentId === currentIds[index])
  );
}

function renderAnalysis() {
  const latest = state.analyses[0];
  const report = state.report;
  const agent = state.agents[0];
  if (!agent) {
    shell(
      `${pageHeader("Contract & Insurance Gap · part 3 of 3", "Analysis", "An agent profile is required before the comparison can run.")}<div class="card empty-state"><div class="empty-icon">!</div><h3>Agent profile required</h3><p>Describe the agent's real capabilities before starting an analysis.</p><button class="button button-primary" data-view="agent">Create profile</button></div>`,
    );
    return;
  }
  shell(`${flowStrip(2, { reportReady: Boolean(report) })}${pageHeader("Contract & Insurance Gap · part 3 of 3", report ? "Review findings" : "Run the comparison", "Generate deterministic findings that separate document facts, agent facts, system inferences, and professional review questions.", report ? '<button class="button button-secondary" data-download-report>Export JSON</button><button class="button button-secondary" data-download-pdf>Download PDF</button><button class="button button-secondary" data-print-report>Print</button><button class="button button-primary" data-rerun>Rerun analysis</button>' : "")}
    <div class="progress-track"><i class="progress-step done"></i><i class="progress-step done"></i><i class="progress-step done"></i></div>
    ${
      report
        ? reportView(report)
        : `<div class="card analysis-hero"><span class="eyebrow">Ready to compare</span><h2>${escapeHtml(agent.name)} across ${state.documents.length} source${state.documents.length === 1 ? "" : "s"}</h2><p>The engine will assess authority, autonomy, approvals, transactions, data access, contractual language, insurance definitions, and jurisdiction support. Missing evidence will be reported explicitly.</p><button class="button button-primary" data-run-analysis>${latest ? "Run analysis" : "Create and run analysis"} →</button></div>
      <div class="grid grid-3" style="margin-top:18px"><div class="card card-pad"><div class="metric-label">Agent</div><strong style="display:block;margin-top:8px">${escapeHtml(agent.name)}</strong><span class="small muted">Autonomy ${agent.autonomyLevel}/5 · ${pretty(agent.humanOversightLevel)}</span></div><div class="card card-pad"><div class="metric-label">Evidence</div><strong style="display:block;margin-top:8px">${state.documents.length} document${state.documents.length === 1 ? "" : "s"}</strong><span class="small muted">${state.documents.length ? "Ready for structural review" : "Missing-evidence rules will apply"}</span></div><div class="card card-pad"><div class="metric-label">Jurisdiction</div><strong style="display:block;margin-top:8px">${escapeHtml(state.project.primaryCountryCode)}</strong><span class="small muted">Universal structural rules with support limitations</span></div></div>`
    }`);
  if (report) window.mountAssurancePanel?.(latest);
  document.querySelector("[data-run-analysis]")?.addEventListener("click", runAnalysis);
  document.querySelector("[data-rerun]")?.addEventListener("click", runAnalysis);
  document.querySelector("[data-print-report]")?.addEventListener("click", () => window.print());
  document.querySelector("[data-copy-decision]")?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(decisionSummaryText(state.report));
      toast("Decision summary copied.");
    } catch {
      toast("Copy is not available in this browser.", "error");
    }
  });
  // Named Sign-off: hand the decision to the console's Approvals, where named owners sign it with
  // their own keys. The draft travels in this tab's sessionStorage (same sign-in, same origin).
  document.querySelector("[data-request-signoff]")?.addEventListener("click", () => {
    const report = state.report;
    const analysisId = (report && report.analysisId) || (state.analyses && state.analyses[0] && state.analyses[0].id) || "";
    sessionStorage.setItem("rsSignoffDraft", JSON.stringify({
      title: `Decide on ${report.agentSummary.name}: contract and insurance gaps`.slice(0, 200),
      details: decisionSummaryText(report),
      reference: analysisId ? `Contract & Insurance Gap analysis ${analysisId}`.slice(0, 200) : "",
    }));
    window.location.href = "/console#/approvals";
  });
  document.querySelector("[data-download-report]")?.addEventListener("click", downloadReport);
  document.querySelector("[data-download-pdf]")?.addEventListener("click", downloadPdfReport);
  document.querySelectorAll("[data-finding-status]").forEach((select) =>
    select.addEventListener("change", async () => {
      select.disabled = true;
      try {
        await api(`/findings/${select.dataset.findingStatus}/status`, {
          method: "PATCH",
          body: JSON.stringify({ status: select.value }),
        });
        const latest = state.analyses[0];
        state.report = await api(`/analyses/${latest.id}/report`);
        toast("Finding status updated.");
        renderAnalysis();
      } catch (error) {
        toast(error.message, "error");
        select.disabled = false;
      }
    }),
  );
}

const SEVERITY_ORDER = ["critical", "high", "moderate", "low", "informational"];
function decisionSummaryText(report) {
  const findings = Object.values(report.findingsBySeverity || {}).flat();
  const counts = SEVERITY_ORDER.map((severity) => [severity, findings.filter((f) => f.severity === severity).length]).filter(([, n]) => n > 0);
  return [
    `Contract & Insurance Gap review: ${state.project?.name || "review"}`,
    `Agent: ${report.agentSummary.name}`,
    `Attention score: ${report.overallAttentionScore ?? "n/a"}/100`,
    `Findings: ${counts.map(([severity, n]) => `${n} ${severity}`).join(", ") || "none"}`,
    `Generated: ${new Date().toISOString()}`,
    "Decision (accept the risk / require an insurance update / restrict the agent's authority): ________",
    "Decided by: ________",
  ].join("\n");
}
function signoffCard(report) {
  const findings = Object.values(report.findingsBySeverity || {}).flat();
  const worst = SEVERITY_ORDER.find((severity) => findings.some((f) => f.severity === severity));
  const needsDecision = findings.filter((f) => ["critical", "high", "moderate"].includes(f.severity)).length;
  return `<div class="card f3-signoff" id="named-signoff" style="margin-top:18px"><span class="badge badge-green">Named Sign-off</span><h2>Sign the decision</h2><p>${needsDecision ? `${needsDecision} finding${needsDecision === 1 ? "" : "s"} at moderate severity or above${worst ? ` (highest: ${pretty(worst)})` : ""} need a named owner's call: accept the risk, require an insurance update, or restrict the agent's authority.` : "No moderate-or-higher findings need a decision right now."}</p><p class="small muted">Ask the owners who decide: each one signs with their own key in Approvals, and the signed decision records who made the call and when, in a way anyone can verify independently. You cannot sign your own request.</p><div class="form-actions"><button class="button button-primary" data-request-signoff>Ask a named owner to sign →</button><button class="button button-secondary" data-copy-decision>Copy decision summary</button></div></div>`;
}

function reportView(report) {
  const findings = Object.values(report.findingsBySeverity || {}).flat();
  return `<div class="card card-pad"><div class="score-layout"><div class="score-ring" style="--score:${report.overallAttentionScore || 0}"><div class="score-center"><strong>${report.overallAttentionScore ?? "—"}</strong><span>ATTENTION / 100</span></div></div><div><span class="badge ${report.overallAttentionScore >= 70 ? "badge-red" : report.overallAttentionScore >= 40 ? "badge-orange" : "badge-green"}">${pretty(report.attentionLabel || "not scored")}</span><h2 style="font-family:Georgia,serif;font-size:1.8rem;font-weight:500;margin:12px 0 7px">${findings.length} review item${findings.length === 1 ? "" : "s"} identified</h2><p class="muted" style="line-height:1.6">${escapeHtml(report.executiveSummary)}</p></div></div></div>
    <div class="report-grid"><div class="card"><div class="section-head"><div><h2>Priority findings</h2><p>Ordered by severity for efficient expert review.</p></div></div><div class="finding-list">${findings.length ? findings.map(findingCard).join("") : '<p class="muted">No findings were generated.</p>'}</div></div>
      <aside><div class="card"><h2>Review context</h2><p><strong>${escapeHtml(report.agentSummary.name)}</strong><br/>${escapeHtml(report.agentSummary.businessPurpose)}</p><p>${report.analyzedDocuments.length} analyzed document${report.analyzedDocuments.length === 1 ? "" : "s"}<br/>Support: ${pretty(report.jurisdictionSupportLevel)}</p></div><div class="card" style="margin-top:18px"><h2>Questions for counsel</h2>${
        report.questionsForLegalCounsel.length
          ? `<ul>${report.questionsForLegalCounsel
              .slice(0, 5)
              .map((question) => `<li>${escapeHtml(question)}</li>`)
              .join("")}</ul>`
          : "<p>No counsel-specific questions generated.</p>"
      }<h2 style="margin-top:20px">Questions for insurance</h2>${
        report.questionsForInsuranceBrokerOrInsurer.length
          ? `<ul>${report.questionsForInsuranceBrokerOrInsurer
              .slice(0, 5)
              .map((question) => `<li>${escapeHtml(question)}</li>`)
              .join("")}</ul>`
          : "<p>No insurance-specific questions generated.</p>"
      }</div><div class="card" style="margin-top:18px"><h2>Analysis history</h2><div class="history-list">${state.analyses.map((analysis) => `<div><span><strong>${pretty(analysis.state)}</strong><small>${new Date(analysis.createdAt).toLocaleString()}</small></span><span class="badge ${analysis.state.startsWith("completed") ? "badge-green" : "badge-gray"}">${analysis.attentionScore?.score ?? "—"}/100</span></div>`).join("")}</div></div>${signoffCard(report)}</aside></div>
    <section id="assurance-pack" class="card authority-card" aria-label="Assurance Pack"></section>
    <div class="disclaimer">${escapeHtml(report.disclaimer)}</div>`;
}

function findingCard(finding) {
  const statuses = [
    "open",
    "under_review",
    "accepted",
    "mitigated",
    "false_positive",
    "not_applicable",
  ];
  return `<article class="finding"><div class="finding-top"><div><div class="finding-tags"><span class="badge severity-${finding.severity}">${pretty(finding.severity)}</span><span class="badge badge-gray">${pretty(finding.category)}</span></div><h3>${escapeHtml(finding.title)}</h3></div><label class="status-control"><span>Status</span><select data-finding-status="${finding.id}" aria-label="Status for ${escapeHtml(finding.title)}">${statuses.map((status) => `<option value="${status}" ${finding.status === status ? "selected" : ""}>${pretty(status)}</option>`).join("")}</select></label></div><p>${escapeHtml(finding.analysisExplanation)}</p><p><strong style="color:var(--ink)">Question:</strong> ${escapeHtml(finding.recommendedReviewQuestions?.[0] || "Professional review is recommended.")}</p><details class="finding-details"><summary>View factual basis and evidence</summary><div class="fact-grid"><div><span>Document fact</span><p>${escapeHtml(finding.documentFact)}</p></div><div><span>Agent fact</span><p>${escapeHtml(finding.agentProfileFact)}</p></div><div><span>System inference</span><p>${escapeHtml(finding.systemInference)}</p></div><div><span>Review rule</span><p>${escapeHtml(finding.reviewRule)}</p></div></div>${finding.evidence?.length ? `<div class="evidence-quote"><span>Evidence excerpt</span><blockquote>${escapeHtml(finding.evidence[0].excerpt)}</blockquote></div>` : ""}<p><strong style="color:var(--ink)">Uncertainty:</strong> ${escapeHtml(finding.uncertainty)}</p></details></article>`;
}

function downloadReport() {
  const blob = new Blob([JSON.stringify(state.report, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `${state.project.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-authority-report.json`;
  link.click();
  URL.revokeObjectURL(link.href);
  toast("Report export prepared.");
}

async function downloadPdfReport() {
  const button = document.querySelector("[data-download-pdf]");
  const latest = state.analyses[0];
  button.disabled = true;
  try {
    const response = await fetch(`${API}/analyses/${latest.id}/report.pdf`, {
      headers: { Authorization: `Bearer ${state.token}` },
    });
    if (!response.ok) throw new Error("The PDF report could not be generated.");
    const blob = await response.blob();
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${state.project.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-authority-report.pdf`;
    link.click();
    URL.revokeObjectURL(link.href);
    toast("PDF report prepared.");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    button.disabled = false;
  }
}

async function runAnalysis() {
  const button = document.querySelector("[data-run-analysis], [data-rerun]");
  button.disabled = true;
  button.textContent = "Running deterministic review…";
  try {
    let analysis = state.analyses[0];
    if (!analysisMatchesCurrentEvidence(analysis))
      analysis = await api(`/projects/${state.project.id}/analyses`, {
        method: "POST",
        body: JSON.stringify({
          agentProfileId: state.agents[0].id,
          documentIds: state.documents.map((document) => document.id),
        }),
      });
    await api(
      `/analyses/${analysis.id}/${analysis.state.startsWith("completed") ? "rerun" : "run"}`,
      { method: "POST" },
    );
    state.analyses = await api(`/projects/${state.project.id}/analyses?pageSize=100`);
    state.analyses.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    state.report = await api(`/analyses/${analysis.id}/report`);
    toast("Analysis complete.");
    renderAnalysis();
  } catch (error) {
    toast(error.message, "error");
    button.disabled = false;
    button.textContent = "Try analysis again";
  }
}

async function loadAuditEvents() {
  const canManageWorkspace = ["owner", "admin"].includes(state.me.role);
  [state.auditEvents, state.members] = await Promise.all([
    api(`/projects/${state.project.id}/audit-events?pageSize=100`),
    canManageWorkspace ? api("/organizations/current/members") : Promise.resolve([]),
  ]);
}

function renderActivity() {
  shell(`${pageHeader("Traceability", "Review activity", "A chronological record of material actions, analysis runs, extraction events, and reviewer decisions.")}
    <div class="activity-layout"><div class="card card-pad"><div class="section-head"><div><h2>Audit trail</h2><p>${state.auditEvents.length} recorded event${state.auditEvents.length === 1 ? "" : "s"} for this review.</p></div><button class="button button-secondary" data-refresh-activity>Refresh</button></div>
      ${state.auditEvents.length ? `<div class="timeline">${state.auditEvents.map((event) => `<div class="timeline-event"><i></i><div><strong>${pretty(event.action.replaceAll(".", " "))}</strong><span>${new Date(event.createdAt).toLocaleString()} · ${escapeHtml(event.resourceType)}</span><code>${escapeHtml(event.requestId)}</code></div></div>`).join("")}</div>` : `<div class="empty-state"><div class="empty-icon">↻</div><h3>No activity recorded yet</h3><p>Material review actions will appear here as you build and analyze the project.</p></div>`}
    </div><aside>${["owner", "admin"].includes(state.me.role) ? `<form id="organization-form" class="card card-pad"><div class="section-head"><div><h2>Workspace settings</h2><p>Organization details for this review environment.</p></div></div><div class="field"><label for="organization-name">Organization name</label><input id="organization-name" name="name" required minlength="2" value="${escapeHtml(state.me.organization.name)}" /></div><button type="submit" class="button button-secondary button-block">Update workspace</button></form><div class="card card-pad" style="margin-top:18px"><div class="section-head"><div><h2>Members</h2><p>${state.members.length} workspace member${state.members.length === 1 ? "" : "s"}</p></div></div><div class="member-list">${state.members.map((member) => `<div><span class="avatar">${escapeHtml(initials(member.user?.name || "Member"))}</span><span><strong>${escapeHtml(member.user?.name || "Workspace member")}</strong><small>${pretty(member.role)}</small></span></div>`).join("")}</div></div>` : '<div class="card card-pad"><h2>Workspace access</h2><p class="muted small">Organization settings are available to owners and administrators.</p></div>'}</aside></div>`);
  document.querySelector("[data-refresh-activity]").addEventListener("click", async () => {
    await loadAuditEvents();
    renderActivity();
  });
  document.querySelector("#organization-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    try {
      const organization = await api("/organizations/current", {
        method: "PATCH",
        body: JSON.stringify({ name: form.elements.name.value }),
      });
      state.me.organization = organization;
      toast("Workspace name updated.");
      renderActivity();
    } catch (error) {
      toast(error.message, "error");
      button.disabled = false;
    }
  });
}

captureHandoff();
if (state.token) initialize();
else authView();
