/* RootSystems Agent Governance console.
   One workspace login for the Floor 3 chain: certificates (Authority Atlas), the action ledger
   (Trust Proof) and coverage analyses (Agent Contract Gap). Talks only to /api/v1 on this origin.
   All text from the server is inserted with textContent, never as HTML. */
(function () {
  "use strict";

  var TOKEN_KEY = "authorityAtlasToken"; // shared with the coverage app on this origin
  var state = { token: sessionStorage.getItem(TOKEN_KEY), me: null, status: null, route: "overview", cache: {} };
  var app = document.getElementById("app");

  // ---------- tiny DOM helpers ----------
  function h(tag, props) {
    var el = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (key) {
        var value = props[key];
        if (value === null || value === undefined || value === false) return;
        if (key === "class") el.className = value;
        else if (key === "text") el.textContent = value;
        else if (key.slice(0, 2) === "on") el.addEventListener(key.slice(2).toLowerCase(), value);
        else if (value === true) el.setAttribute(key, "");
        else el.setAttribute(key, value);
      });
    }
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function append(el, child) {
    if (child === null || child === undefined || child === false) return;
    if (Array.isArray(child)) return child.forEach(function (c) { append(el, c); });
    el.appendChild(typeof child === "string" || typeof child === "number" ? document.createTextNode(String(child)) : child);
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

  var ICONS = {
    overview: "M3 13h8V3H3zM13 21h8v-6h-8zM13 3v8h8V3zM3 21h8v-4H3z",
    agents: "M12 2l3 5h-6zM5 9h14v11H5zM9 13h.01M15 13h.01M9 17h6",
    ledger: "M4 6h16M4 12h16M4 18h10M18 16l2 2 3-4",
    approvals: "M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9",
    coverage: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z",
    settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
    search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3",
    plus: "M12 5v14M5 12h14",
    check: "M20 6L9 17l-5-5",
    x: "M18 6L6 18M6 6l12 12",
    alert: "M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
    shield: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10zM9 12l2 2 4-4",
    bolt: "M13 2L3 14h9l-1 8 10-12h-9z",
    ban: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM4.9 4.9l14.2 14.2",
    copy: "M9 9h11v11H9zM5 15H4V4h11v1",
    eye: "M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
    download: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3",
    refresh: "M23 4v6h-6M1 20v-6h6M3.5 9a9 9 0 0 1 14.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0 0 20.5 15",
    link: "M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7",
    logout: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9",
    menu: "M3 6h18M3 12h18M3 18h18",
    lock: "M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4",
    cpu: "M9 9h6v6H9zM4 4h16v16H4zM9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3",
    arrow: "M5 12h14M13 6l6 6-6 6",
    loader: "M12 2v4M12 18v4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M2 12h4M18 12h4M4.9 19.1l2.8-2.8M16.3 7.7l2.8-2.8",
  };
  function icon(name, cls) {
    var ns = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.8");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    if (cls) svg.setAttribute("class", cls);
    var path = document.createElementNS(ns, "path");
    path.setAttribute("d", ICONS[name] || ICONS.check);
    svg.appendChild(path);
    return svg;
  }

  // ---------- formatting ----------
  function ago(iso) {
    var s = Math.round((Date.now() - Date.parse(iso)) / 1000);
    if (!isFinite(s)) return "";
    if (s < 45) return "just now";
    if (s < 3600) return Math.round(s / 60) + "m ago";
    if (s < 86400) return Math.round(s / 3600) + "h ago";
    return Math.round(s / 86400) + "d ago";
  }
  function date(iso) {
    var d = new Date(iso);
    return isNaN(d) ? "—" : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }
  function short(value, n) { value = String(value || ""); return value.length > n ? value.slice(0, n) + "…" : value; }
  function money(v) { return typeof v === "number" ? "$" + v.toLocaleString(undefined, { maximumFractionDigits: 2 }) : null; }
  function limitsText(l) {
    if (!l) return "No limits recorded";
    var parts = [];
    if (l.maxAmountUsd) parts.push("up to " + money(l.maxAmountUsd) + " per action");
    if (l.maxActionsPerDay) parts.push(l.maxActionsPerDay + " actions / day");
    return parts.length ? parts.join(" · ") : "No limits";
  }

  // ---------- API ----------
  function api(path, options) {
    options = options || {};
    var headers = { Accept: "application/json" };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    if (state.token) headers.Authorization = "Bearer " + state.token;
    return fetch("/api/v1" + path, { method: options.method || "GET", headers: headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) })
      .then(function (res) {
        return res.text().then(function (text) {
          var body = null;
          try { body = text ? JSON.parse(text) : null; } catch { body = null; }
          if (res.status === 401 && state.token && path.indexOf("/auth/") !== 0) { signOut(true); }
          if (!res.ok) {
            var err = body && body.error;
            var message = (err && (err.message || err.code)) || "Something went wrong (" + res.status + ").";
            if (err && err.details && err.details[0] && err.details[0].message) message = err.details[0].message;
            var e = new Error(message);
            e.status = res.status;
            e.code = err && err.code;
            throw e;
          }
          return body ? body.data : null;
        });
      });
  }

  function toast(message, isError) {
    var box = document.getElementById("toasts");
    var t = h("div", { class: "toast" + (isError ? " is-error" : "") }, icon(isError ? "alert" : "check"), h("span", { text: message }));
    box.appendChild(t);
    setTimeout(function () { t.remove(); }, 4200);
  }
  function copy(text, label) {
    navigator.clipboard.writeText(text).then(function () { toast((label || "Copied") + " to clipboard"); }, function () { toast("Copy failed", true); });
  }

  // ---------- auth ----------
  function signOut(expired) {
    state.token = null; state.me = null; state.status = null; state.cache = {};
    sessionStorage.removeItem(TOKEN_KEY);
    if (expired) toast("Your session ended. Sign in again.", true);
    render();
  }

  function renderAuth(mode) {
    mode = mode || "signin";
    var errorBox = h("div");
    function submit(ev) {
      ev.preventDefault();
      var form = ev.target;
      var data = Object.fromEntries(new FormData(form).entries());
      var btn = form.querySelector("button[type=submit]");
      btn.disabled = true;
      clear(errorBox);
      var call = mode === "signin"
        ? api("/auth/login", { method: "POST", body: { email: data.email, password: data.password } })
        : api("/auth/register", { method: "POST", body: { email: data.email, password: data.password, name: data.name, organizationName: data.organization } });
      call.then(function (res) {
        state.token = res.accessToken;
        sessionStorage.setItem(TOKEN_KEY, state.token);
        location.hash = "#/overview";
        boot();
      }).catch(function (err) {
        btn.disabled = false;
        append(errorBox, h("div", { class: "form-error", role: "alert", text: err.message }));
      });
    }
    var fields = mode === "signin"
      ? [
          field("Work email", h("input", { class: "input", type: "email", name: "email", autocomplete: "email", required: true, placeholder: "you@company.com" })),
          field("Password", h("input", { class: "input", type: "password", name: "password", autocomplete: "current-password", required: true })),
        ]
      : [
          h("div", { class: "auth__row" },
            field("Your name", h("input", { class: "input", name: "name", required: true, minlength: "2", placeholder: "Alex Morgan", autocomplete: "name" })),
            field("Organization", h("input", { class: "input", name: "organization", required: true, minlength: "2", placeholder: "Northwind Robotics", autocomplete: "organization" }))),
          field("Work email", h("input", { class: "input", type: "email", name: "email", autocomplete: "email", required: true, placeholder: "you@company.com" })),
          field("Password", h("input", { class: "input", type: "password", name: "password", autocomplete: "new-password", required: true, minlength: "12" }), "At least 12 characters."),
        ];
    clear(app);
    app.appendChild(h("div", { class: "auth" },
      h("section", { class: "auth__story" },
        h("div", { class: "auth__brand" }, h("img", { src: "/rs-logo.svg", alt: "" }), "RootSystems"),
        h("div", null,
          h("h1", { class: "auth__title" }, "Authority your agents ", h("em", { text: "can prove." })),
          h("p", { class: "auth__lead", text: "Issue every AI agent a signed certificate of what it may do, watch each action checked against it in real time, and revoke it with one switch. Signed evidence your auditors, customers and insurers can check." }),
          h("ul", { class: "auth__points" },
            h("li", null, icon("shield"), h("span", null, h("strong", { text: "Post-quantum signed. " }), "Certificates and ledger checkpoints carry ML-DSA-65 signatures (NIST FIPS 204).")),
            h("li", null, icon("bolt"), h("span", null, h("strong", { text: "Enforced live. " }), "Over-limit, out-of-scope or revoked actions are blocked and recorded.")),
            h("li", null, icon("ledger"), h("span", null, h("strong", { text: "Tamper-evident. " }), "Every action joins a hash chain nobody can quietly edit.")))),
        h("p", { class: "auth__foot", text: "Decision support and evidence, not legal or insurance advice." })),
      h("section", { class: "auth__form" },
        h("div", { class: "auth__card" },
          h("h2", { text: mode === "signin" ? "Welcome back" : "Create your workspace" }),
          h("p", { text: mode === "signin" ? "Sign in to your Agent Governance console." : "One workspace for certificates, the action ledger and coverage." }),
          h("form", { onsubmit: submit },
            fields,
            errorBox,
            h("button", { class: "btn btn--primary btn--lg", type: "submit" }, mode === "signin" ? "Sign in" : "Create workspace", icon("arrow"))),
          h("div", { class: "auth__switch" },
            mode === "signin" ? "New to RootSystems? " : "Already have a workspace? ",
            h("button", { type: "button", onclick: function () { renderAuth(mode === "signin" ? "signup" : "signin"); }, text: mode === "signin" ? "Create a workspace" : "Sign in" }))))));
  }
  function field(label, input, hint) {
    var id = "f-" + Math.random().toString(36).slice(2, 8);
    input.id = id;
    return h("div", { class: "field" }, h("label", { for: id, text: label }), input, hint ? h("small", { text: hint }) : null);
  }

  // ---------- shell ----------
  var NAV = [
    { id: "overview", label: "Overview", icon: "overview" },
    { id: "agents", label: "Agents & certificates", icon: "agents" },
    { id: "ledger", label: "Action ledger", icon: "ledger" },
    { id: "approvals", label: "Approvals", icon: "approvals" },
    { id: "coverage", label: "Coverage", icon: "coverage" },
    { id: "settings", label: "Settings", icon: "settings" },
  ];
  var TITLES = { overview: "Overview", agents: "Agents & certificates", ledger: "Action ledger", approvals: "Approvals", coverage: "Contract & insurance coverage", settings: "Settings" };

  function renderShell() {
    var me = state.me || {};
    var org = (me.organization && me.organization.name) || "Workspace";
    var name = (me.user && me.user.name) || "";
    var shell = h("div", { class: "shell" });
    var content = h("section", { class: "content", id: "content" });
    shell.appendChild(h("aside", { class: "sidebar", "aria-label": "Console navigation" },
      h("div", { class: "sidebar__brand" }, h("img", { src: "/rs-logo.svg", alt: "" }), h("div", null, h("strong", { text: "RootSystems" }), h("span", { text: "Agent Governance" }))),
      h("nav", { class: "nav" },
        h("div", { class: "nav__label", text: "Control" }),
        NAV.slice(0, 4).map(navLink),
        h("div", { class: "nav__label", text: "Assurance" }),
        NAV.slice(4).map(navLink)),
      h("div", { class: "sidebar__foot" },
        h("div", { class: "pq-badge" }, icon("lock"), h("div", null, h("strong", { text: "Post-quantum signed" }), h("span", { text: "ML-DSA-65 · SHA-512" }))),
        h("div", { class: "who" },
          h("div", { class: "who__avatar", text: (name || org).slice(0, 1).toUpperCase() }),
          h("div", { class: "who__text" }, h("strong", { text: org }), h("span", { text: name + (me.role ? " · " + me.role : "") })),
          h("button", { class: "btn btn--ghost btn--sm", title: "Sign out", "aria-label": "Sign out", onclick: function () { signOut(false); } }, icon("logout"))))));
    shell.appendChild(h("main", { class: "main" },
      h("header", { class: "topbar" },
        h("button", { class: "btn btn--ghost btn--sm menu-toggle", "aria-label": "Menu", onclick: function () { shell.classList.toggle("nav-open"); } }, icon("menu")),
        h("div", { class: "topbar__title" }, h("small", { text: org }), h("strong", { text: TITLES[state.route] || "" })),
        h("button", { class: "kbar", type: "button", onclick: openPalette, "aria-label": "Open command palette" }, icon("search"), h("span", { text: "Jump to or do anything…" }), h("kbd", { text: "Ctrl K" })),
        state.status && state.status.linked ? h("button", { class: "btn btn--primary", onclick: function () { openIssueDrawer(); }, "aria-label": "Issue certificate" }, icon("plus"), h("span", { class: "btn__label", text: "Issue certificate" })) : null),
      content));
    clear(app).appendChild(shell);
    return content;
  }
  function navLink(item) {
    return h("a", { href: "#/" + item.id, "aria-current": state.route === item.id ? "page" : null }, icon(item.icon), item.label, item.soon ? h("span", { class: "soon", text: "NEXT" }) : null);
  }

  // ---------- boot / routing ----------
  function boot() {
    if (!state.token) return renderAuth("signin");
    clear(app).appendChild(h("div", { class: "empty", style: "min-height:100vh" }, icon("loader", "spin"), h("p", { text: "Opening your console…" })));
    Promise.all([api("/auth/me"), api("/console/status")]).then(function (res) {
      state.me = res[0];
      state.status = res[1];
      render();
    }).catch(function (err) {
      if (err.status === 401) return;
      clear(app).appendChild(h("div", { class: "empty", style: "min-height:100vh" }, icon("alert"), h("h4", { text: "The console could not load" }), h("p", { text: err.message }), h("button", { class: "btn", onclick: boot }, icon("refresh"), "Try again")));
    });
  }
  function currentRoute() {
    var r = (location.hash || "#/overview").replace(/^#\//, "").split("/")[0];
    return TITLES[r] ? r : "overview";
  }
  function closeOverlays() {
    document.querySelectorAll(".palette, .drawer, .modal, .scrim").forEach(function (el) { el.remove(); });
  }
  function render() {
    closeOverlays();
    if (!state.token) return renderAuth("signin");
    if (!state.me) return boot();
    state.route = currentRoute();
    var content = renderShell();
    if (state.status && (!state.status.configured.atlas || !state.status.configured.trustProof)) return viewNotConfigured(content);
    if (state.status && !state.status.linked && state.route !== "coverage") return viewActivate(content);
    ({ overview: viewOverview, agents: viewAgents, ledger: viewLedger, approvals: viewApprovals, coverage: viewCoverage, settings: viewSettings })[state.route](content);
  }
  window.addEventListener("hashchange", function () { if (state.me) render(); });

  // ---------- views ----------
  function viewNotConfigured(content) {
    content.appendChild(h("div", { class: "panel" }, h("div", { class: "empty" }, icon("alert"), h("h4", { text: "Agent Governance is not switched on for this server" }), h("p", { text: "The console needs its Authority Atlas and Trust Proof services. Contact RootSystems to enable it." }))));
  }

  function viewActivate(content) {
    var steps = [
      { title: "Authority Atlas", text: "A private identity that signs your agents' certificates." },
      { title: "Trust Proof", text: "A private ledger that checks and records every agent action." },
      { title: "Sealed credentials", text: "Keys encrypted with AES-256 — you never handle them." },
    ];
    var stepEls = steps.map(function (s) { return h("div", { class: "step" }, h("b", null, icon("check"), s.title), h("p", { text: s.text })); });
    var btn = h("button", { class: "btn btn--primary btn--lg" }, icon("bolt"), "Activate Agent Governance");
    btn.addEventListener("click", function () {
      btn.disabled = true;
      stepEls.forEach(function (el) { el.classList.add("is-busy"); el.querySelector("svg").replaceWith(icon("loader")); });
      api("/console/link", { method: "POST" }).then(function () {
        stepEls.forEach(function (el) { el.classList.remove("is-busy"); el.classList.add("is-done"); el.querySelector("svg").replaceWith(icon("check")); });
        state.status.linked = true;
        toast("Agent Governance is active");
        setTimeout(render, 700);
      }).catch(function (err) {
        btn.disabled = false;
        stepEls.forEach(function (el) { el.classList.remove("is-busy"); el.querySelector("svg").replaceWith(icon("check")); });
        toast(err.message, true);
      });
    });
    content.appendChild(h("div", { class: "panel activate" },
      h("div", { class: "pill pill--pq", text: "Branch 3 · AI Agent Trust" }),
      h("h2", { style: "margin-top:16px" }, "Give every agent a signed scope of authority."),
      h("p", { text: "Activation creates this workspace's private links to Authority Atlas and Trust Proof. It takes a few seconds (up to a minute if a service is waking up) and only happens once." }),
      h("div", { class: "steps" }, stepEls),
      btn));
  }

  function kpi(label, value, sub, iconName, tone) {
    return h("div", { class: "panel kpi" + (tone ? " kpi--" + tone : "") },
      h("div", { class: "kpi__label" }, icon(iconName), label),
      h("div", { class: "kpi__value", text: value }),
      h("div", { class: "kpi__sub", text: sub }));
  }

  function viewOverview(content) {
    var kpis = h("div", { class: "grid grid--kpi" }, [0, 1, 2, 3].map(function () { return h("div", { class: "panel kpi" }, h("div", { class: "skeleton", style: "width:50%" }), h("div", { class: "skeleton", style: "height:34px;margin-top:14px;width:40%" })); }));
    var feed = h("ul", { class: "feed" });
    var integrityHost = h("div");
    content.appendChild(kpis);
    content.appendChild(h("div", { class: "grid grid--2", style: "margin-top:18px" },
      h("div", { class: "panel" },
        h("div", { class: "panel__head" }, h("div", null, h("h3", { text: "Live activity" }), h("p", { text: "The latest actions your agents reported, as Trust Proof judged them." })), h("div", { class: "actions" }, h("a", { class: "btn btn--sm", href: "#/ledger" }, "Open ledger", icon("arrow")))),
        feed),
      h("div", { class: "panel" },
        h("div", { class: "panel__head" }, h("div", null, h("h3", { text: "Chain integrity" }), h("p", { text: "Recompute the whole ledger and get a signed checkpoint." }))),
        integrityHost)));
    renderIntegrity(integrityHost, null);

    api("/console/overview").then(function (o) {
      clear(kpis);
      append(kpis, [
        kpi("Active certificates", String(o.certificates.active), o.certificates.revoked + " revoked · " + o.certificates.expired + " expired", "agents", "teal"),
        kpi("Actions · 24 h", String(o.ledger.last24h), o.ledger.total + " recorded in total", "bolt", null),
        kpi("Blocked · 24 h", String(o.ledger.blocked24h), o.ledger.blocked + " blocked in total", "ban", "rose"),
        kpi("Signature standard", "FIPS 204", "ML-DSA-65 + SHA-512 on every certificate", "lock", "violet"),
      ]);
      clear(feed);
      if (!o.latest.length) {
        feed.appendChild(h("li", { style: "display:block" }, h("div", { class: "empty", style: "padding:30px 10px" }, icon("ledger"), h("h4", { text: "No agent activity yet" }), h("p", { text: "Issue a certificate, connect your agent runtime (Settings), and every action appears here." }))));
      } else {
        o.latest.forEach(function (a) {
          var within = a.verdict === "within_authority";
          feed.appendChild(h("li", null,
            h("span", { class: "feed__dot feed__dot--" + (within ? "within" : "outside") }),
            h("div", { class: "feed__main" },
              h("strong", { text: a.agentId }), " ", h("span", { class: "mono", style: "display:inline;color:var(--mute)", text: a.action }),
              h("span", { text: within ? "Allowed" + (a.amountUsd ? " · " + money(a.amountUsd) : "") : "Blocked · " + (a.reasons || []).join(", ").replace(/_/g, " ") })),
            h("span", { class: "feed__time", text: ago(a.occurredAt) })));
        });
      }
    }).catch(function (err) { clear(kpis); toast(err.message, true); });
  }

  function renderIntegrity(host, result, busy) {
    clear(host);
    var C = 2 * Math.PI * 56;
    var cls = "integrity__ring" + (busy || !result ? " is-idle" : result.valid ? "" : " is-bad");
    var ns = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 132 132");
    [["track", C, 0], ["arc", C, result && !busy ? 0 : C]].forEach(function (spec) {
      var c = document.createElementNS(ns, "circle");
      c.setAttribute("cx", "66"); c.setAttribute("cy", "66"); c.setAttribute("r", "56");
      c.setAttribute("fill", "none"); c.setAttribute("stroke-width", "6"); c.setAttribute("class", spec[0]);
      c.setAttribute("stroke-dasharray", String(spec[1]));
      c.setAttribute("stroke-dashoffset", String(spec[1]));
      c.setAttribute("transform", "rotate(-90 66 66)");
      svg.appendChild(c);
      if (spec[0] === "arc") requestAnimationFrame(function () { requestAnimationFrame(function () { c.setAttribute("stroke-dashoffset", String(spec[2])); }); });
      else c.setAttribute("stroke-dashoffset", "0");
    });
    var ring = h("div", { class: cls }, svg, h("div", { class: "integrity__icon" }, icon(busy ? "loader" : !result ? "shield" : result.valid ? "check" : "alert", busy ? "spin" : null)));
    var title = busy ? "Recomputing the chain…" : !result ? "Not checked yet" : result.valid ? "Chain intact" : "Chain broken";
    var text = busy ? "Every entry is re-hashed from the first one."
      : !result ? "Recompute every entry from genesis and receive a checkpoint signed with ML-DSA-65."
      : result.valid ? (result.entries + " entries verified · signed checkpoint " + (result.signature && result.signature.algorithm ? "(" + result.signature.algorithm + ")" : "")) : "An entry does not match the chain. Contact RootSystems.";
    var verifyBtn = h("button", { class: "btn btn--sm", onclick: function () {
      renderIntegrity(host, null, true);
      api("/console/ledger/verify").then(function (r) { renderIntegrity(host, r); }).catch(function (err) { renderIntegrity(host, null); toast(err.message, true); });
    } }, icon("refresh"), result ? "Verify again" : "Verify now");
    var actions = h("div", { style: "display:flex;gap:8px;justify-content:center;flex-wrap:wrap" }, busy ? null : verifyBtn,
      result && !busy ? h("button", { class: "btn btn--sm", onclick: function () { downloadJson(result, "trust-proof-checkpoint-" + new Date().toISOString().slice(0, 19).replace(/:/g, "") + ".json"); } }, icon("download"), "Signed checkpoint") : null);
    append(host, h("div", { class: "integrity" }, ring, h("h4", { text: title }), h("p", { text: text }),
      result && result.latestChainHash ? h("div", { class: "hash", title: result.latestChainHash, text: "head " + result.latestChainHash }) : null, actions));
  }
  function downloadJson(obj, filename) {
    var url = URL.createObjectURL(new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" }));
    var a = h("a", { href: url, download: filename });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  // ----- agents & certificates -----
  function viewAgents(content) {
    var filter = "all";
    var list = [];
    var body = h("tbody");
    var seg = h("div", { class: "segmented", role: "group", "aria-label": "Filter certificates" });
    ["all", "active", "revoked", "expired"].forEach(function (f) {
      seg.appendChild(h("button", { type: "button", "aria-pressed": String(f === filter), onclick: function () { filter = f; Array.from(seg.children).forEach(function (b) { b.setAttribute("aria-pressed", String(b.textContent.toLowerCase() === f)); }); paint(); }, text: f[0].toUpperCase() + f.slice(1) }));
    });
    content.appendChild(h("div", { class: "toolbar" }, seg, h("div", { class: "spacer" }), h("button", { class: "btn", onclick: load }, icon("refresh"), "Refresh")));
    var panel = h("div", { class: "panel" }, h("div", { class: "table-wrap" }, h("table", { class: "data cards cards--agents" },
      h("thead", null, h("tr", null, ["Agent", "Permissions", "Limits", "Expires", "Status", "Active"].map(function (t) { return h("th", { text: t, class: t === "Limits" || t === "Expires" ? "hide-sm" : null }); }))), body)));
    content.appendChild(panel);

    function paint() {
      clear(body);
      var rows = list.filter(function (c) { return filter === "all" || c.status === filter; });
      if (!rows.length) {
        body.appendChild(h("tr", null, h("td", { colspan: "6" }, h("div", { class: "empty" }, icon("agents"),
          h("h4", { text: list.length ? "Nothing in this view" : "No agents yet" }),
          h("p", { text: list.length ? "Try another filter." : "Issue your first certificate: name the agent, list what it may do, and set its limits." }),
          list.length ? null : h("button", { class: "btn btn--primary", onclick: function () { openIssueDrawer(); } }, icon("plus"), "Issue certificate")))));
        return;
      }
      rows.forEach(function (c) {
        var sw = h("button", { class: "switch", role: "switch", "aria-checked": String(c.status === "active"), "aria-label": "Certificate active", disabled: c.status !== "active" ? true : null, title: c.status === "active" ? "Revoke this certificate" : "Revoked or expired certificates cannot be reactivated" });
        sw.addEventListener("click", function (ev) { ev.stopPropagation(); confirmRevoke(c, load); });
        body.appendChild(h("tr", { class: "clickable", tabindex: "0", onclick: function () { openCertDrawer(c, load); }, onkeydown: function (ev) { if (ev.key === "Enter") openCertDrawer(c, load); } },
          h("td", { class: "c-agent" }, h("div", { class: "agent-cell" }, h("div", { class: "agent-cell__icon" }, icon("cpu")), h("div", null, h("strong", { text: c.agentName || c.agentId }), h("span", { text: c.agentId })))),
          h("td", { class: "c-perms" }, h("div", { class: "perm-list" }, (c.permissions || []).slice(0, 4).map(function (p) { return h("span", { class: "chip", text: p }); }), (c.permissions || []).length > 4 ? h("span", { class: "chip", text: "+" + ((c.permissions || []).length - 4) }) : null)),
          h("td", { class: "muted hide-sm", text: limitsText(c.limits) }),
          h("td", { class: "muted hide-sm", text: date(c.expiresAt) }),
          h("td", { class: "c-status" }, h("span", { class: "pill pill--" + c.status, text: c.status })),
          h("td", { class: "c-active" }, sw)));
      });
    }
    function load() {
      clear(body).appendChild(h("tr", null, h("td", { colspan: "6" }, h("div", { class: "skeleton" }))));
      api("/console/certificates").then(function (r) { list = r || []; paint(); }).catch(function (err) { clear(body); toast(err.message, true); });
    }
    state.refreshAgents = load;
    load();
  }

  function confirmRevoke(cert, after) {
    var scrim = h("div", { class: "scrim" });
    var modal = h("div", { class: "modal", role: "dialog", "aria-modal": "true", "aria-labelledby": "rv-t" });
    function close() { scrim.remove(); modal.remove(); }
    scrim.addEventListener("click", close);
    var go = h("button", { class: "btn btn--danger" }, icon("ban"), "Revoke permanently");
    go.addEventListener("click", function () {
      go.disabled = true;
      api("/console/certificates/" + cert.jti + "/revoke", { method: "POST" }).then(function () {
        close(); toast("Certificate revoked. Payments stop at once; other actions within 15 seconds.");
        if (after) after();
      }).catch(function (err) { go.disabled = false; toast(err.message, true); });
    });
    append(modal, [h("h3", { id: "rv-t", text: "Revoke " + (cert.agentName || cert.agentId) + "?" }),
      h("p", { text: "The agent loses this authority immediately and every later action is blocked and recorded. A revoked certificate cannot be switched back on; issue a new one instead." }),
      h("div", { class: "modal__actions" }, h("button", { class: "btn", onclick: close, text: "Cancel" }), go)]);
    document.body.appendChild(scrim); document.body.appendChild(modal);
    go.focus();
  }

  function drawer(title, sub, bodyNodes, footNodes) {
    var scrim = h("div", { class: "scrim" });
    var panel = h("aside", { class: "drawer", role: "dialog", "aria-modal": "true", "aria-label": title });
    function close() { scrim.remove(); panel.remove(); document.removeEventListener("keydown", esc); }
    function esc(ev) { if (ev.key === "Escape") close(); }
    document.addEventListener("keydown", esc);
    scrim.addEventListener("click", close);
    append(panel, [h("div", { class: "drawer__head" }, h("div", null, h("h3", { text: title }), sub ? h("p", { text: sub }) : null), h("button", { class: "btn btn--ghost btn--sm", "aria-label": "Close", onclick: close }, icon("x"))),
      h("div", { class: "drawer__body" }, bodyNodes), footNodes ? h("div", { class: "drawer__foot" }, footNodes) : null]);
    document.body.appendChild(scrim); document.body.appendChild(panel);
    return { close: close, panel: panel };
  }

  function sealSvg() {
    var ns = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 100 100");
    svg.setAttribute("aria-hidden", "true");
    var defs = document.createElementNS(ns, "defs");
    var path = document.createElementNS(ns, "path");
    path.setAttribute("id", "seal-path"); path.setAttribute("d", "M50,50 m-38,0 a38,38 0 1,1 76,0 a38,38 0 1,1 -76,0");
    defs.appendChild(path); svg.appendChild(defs);
    var ring = document.createElementNS(ns, "circle");
    ring.setAttribute("cx", "50"); ring.setAttribute("cy", "50"); ring.setAttribute("r", "47"); ring.setAttribute("fill", "rgba(157,124,255,0.08)"); ring.setAttribute("stroke", "rgba(157,124,255,0.55)"); ring.setAttribute("stroke-width", "1");
    svg.appendChild(ring);
    var g = document.createElementNS(ns, "g"); g.setAttribute("class", "rotor");
    var text = document.createElementNS(ns, "text");
    text.setAttribute("fill", "#b9a4ff"); text.setAttribute("font-size", "8.4"); text.setAttribute("font-family", "JetBrains Mono, monospace"); text.setAttribute("letter-spacing", "1.6");
    var tp = document.createElementNS(ns, "textPath"); tp.setAttribute("href", "#seal-path");
    tp.textContent = "ML-DSA-65 · NIST FIPS 204 · POST-QUANTUM · ";
    text.appendChild(tp); g.appendChild(text); svg.appendChild(g);
    var inner = document.createElementNS(ns, "circle");
    inner.setAttribute("cx", "50"); inner.setAttribute("cy", "50"); inner.setAttribute("r", "24"); inner.setAttribute("fill", "rgba(7,10,18,0.9)"); inner.setAttribute("stroke", "rgba(255,153,51,0.6)");
    svg.appendChild(inner);
    var img = document.createElementNS(ns, "image");
    img.setAttribute("href", "/rs-logo.svg"); img.setAttribute("x", "34"); img.setAttribute("y", "33"); img.setAttribute("width", "32"); img.setAttribute("height", "34");
    svg.appendChild(img);
    return svg;
  }

  function certificateCard(c) {
    return h("div", { class: "cert" + (c.status === "revoked" ? " is-revoked" : "") },
      h("div", { class: "cert__seal" }, sealSvg()),
      h("div", { class: "cert__kicker", text: "Authority certificate" }),
      h("div", { class: "cert__title", text: c.agentName || c.agentId }),
      h("div", { class: "cert__sub" }, "Issued to agent ", h("span", { class: "mono", text: c.agentId }), (state.me && state.me.organization) ? " by " + state.me.organization.name : ""),
      h("dl", { class: "cert__grid" },
        h("div", { class: "full" }, h("dt", { text: "May do" }), h("dd", null, h("div", { class: "perm-list" }, (c.permissions || ["—"]).map(function (p) { return h("span", { class: "chip", text: p }); })))),
        h("div", null, h("dt", { text: "Limits" }), h("dd", { text: limitsText(c.limits) })),
        h("div", null, h("dt", { text: "Status" }), h("dd", null, h("span", { class: "pill pill--" + (c.status || "active"), text: c.status || "active" }))),
        h("div", null, h("dt", { text: "Issued" }), h("dd", { text: date(c.issuedAt) })),
        h("div", null, h("dt", { text: "Expires" }), h("dd", { text: date(c.expiresAt) })),
        h("div", { class: "full" }, h("dt", { text: "Certificate id" }), h("dd", { class: "mono", style: "font-size:12px", text: c.jti }))));
  }

  function openCertDrawer(c, after) {
    var checks = h("ul", { class: "verify-list" });
    var tokenBox = h("div");
    function row(ok, label, detail) {
      return h("li", { class: ok === null ? "wait" : ok ? "ok" : "bad" }, icon(ok === null ? "loader" : ok ? "check" : "x", ok === null ? "spin" : null), h("span", { text: label }), detail ? h("small", { text: detail }) : null);
    }
    append(checks, [row(null, "Checking signature with Authority Atlas…")]);
    var foot = [];
    if (c.status === "active") foot.push(h("button", { class: "btn btn--danger", onclick: function () { d.close(); confirmRevoke(c, after); } }, icon("ban"), "Revoke"));
    foot.push(h("button", { class: "btn", onclick: function () { d.close(); } , text: "Close" }));
    var d = drawer(c.agentName || c.agentId, "Authority certificate · issued " + date(c.issuedAt), [
      certificateCard(c),
      h("div", null, h("div", { class: "nav__label", style: "margin:0 0 10px", text: "Independent verification" }), checks),
      tokenBox,
    ], foot);
    api("/console/certificates/" + c.jti + "/verify").then(function (r) {
      var v = r.verification || {};
      var a = v.assurance || {};
      clear(checks);
      append(checks, [
        row(v.valid === true || v.reason === "revoked", "ES256 signature and SHA-512 registry binding", a.registryBinding || v.reason),
        row(a.pqSignature === "valid", "ML-DSA-65 post-quantum countersignature", a.pqSignature || "not supplied"),
        row(v.valid === true, v.valid ? "Currently valid in Authority Atlas" : "Not currently valid", v.reason || "valid"),
      ]);
      append(tokenBox, [h("div", { class: "nav__label", style: "margin:0 0 10px", text: "For your agent runtime" }),
        h("div", { class: "secret" }, h("input", { class: "input mono", readonly: true, value: r.certificate, "aria-label": "Certificate token" }),
          h("button", { class: "btn", onclick: function () { copy(r.certificate, "Certificate"); } }, icon("copy"), "Copy")),
        h("p", { class: "faint", style: "font-size:12px;margin:8px 0 0", text: "Your agent sends this certificate with every action it reports to Trust Proof (see Settings → Connect your agent)." })]);
    }).catch(function (err) {
      clear(checks);
      append(checks, [row(false, err.status === 404 ? "Issued outside this console: no stored copy to verify" : err.message)]);
    });
  }

  function openIssueDrawer() {
    var perms = [];
    var chipBox = h("div", { class: "chips-input" });
    var permInput = h("input", { placeholder: "invoices:read  ↵", "aria-label": "Add permission" });
    var preview = h("div");
    var f = {
      agentName: h("input", { class: "input", placeholder: "Payments assistant", maxlength: "100" }),
      agentId: h("input", { class: "input mono", placeholder: "payments-bot", maxlength: "100" }),
      maxAmountUsd: h("input", { class: "input", type: "number", min: "1", step: "any", placeholder: "500" }),
      maxActionsPerDay: h("input", { class: "input", type: "number", min: "1", step: "1", placeholder: "200" }),
    };
    var days = 30;
    var daySeg = h("div", { class: "segmented", role: "group", "aria-label": "Valid for" });
    [7, 30, 90, 365].forEach(function (n) {
      daySeg.appendChild(h("button", { type: "button", "aria-pressed": String(n === days), text: n === 365 ? "1 year" : n + " days", onclick: function () { days = n; Array.from(daySeg.children).forEach(function (b, i) { b.setAttribute("aria-pressed", String([7, 30, 90, 365][i] === n)); }); update(); } }));
    });
    f.agentName.addEventListener("input", function () {
      if (!f.agentId.dataset.touched) f.agentId.value = f.agentName.value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
      update();
    });
    f.agentId.addEventListener("input", function () { f.agentId.dataset.touched = "1"; update(); });
    [f.maxAmountUsd, f.maxActionsPerDay].forEach(function (i) { i.addEventListener("input", update); });
    function addPerm(p) {
      p = String(p || "").trim();
      if (!p || perms.indexOf(p) >= 0) return;
      if (!/^[A-Za-z0-9_.:*/-]{1,100}$/.test(p)) { toast('Permissions look like "invoices:read" (no spaces)', true); return; }
      perms.push(p); paintChips(); update();
    }
    function paintChips() {
      clear(chipBox);
      perms.forEach(function (p) { chipBox.appendChild(h("span", { class: "chip" }, p, h("button", { type: "button", "aria-label": "Remove " + p, onclick: function () { perms.splice(perms.indexOf(p), 1); paintChips(); update(); }, text: "×" }))); });
      chipBox.appendChild(permInput);
    }
    permInput.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" || ev.key === "," || ev.key === " ") { ev.preventDefault(); addPerm(permInput.value); permInput.value = ""; }
      if (ev.key === "Backspace" && !permInput.value && perms.length) { perms.pop(); paintChips(); update(); }
    });
    paintChips();
    function limits() {
      var l = {};
      if (f.maxAmountUsd.value) l.maxAmountUsd = Number(f.maxAmountUsd.value);
      if (f.maxActionsPerDay.value) l.maxActionsPerDay = Math.round(Number(f.maxActionsPerDay.value));
      return l;
    }
    function update() {
      clear(preview).appendChild(certificateCard({
        agentName: f.agentName.value || "Your agent", agentId: f.agentId.value || "agent-id", permissions: perms.length ? perms : ["—"],
        limits: limits(), status: "active", issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + days * 864e5).toISOString(), jti: "assigned when issued",
      }));
    }
    update();
    var issueBtn = h("button", { class: "btn btn--primary" }, icon("lock"), "Sign & issue");
    var d = drawer("Issue a certificate", "Define exactly what this agent may do. Atlas signs it (ES256 + ML-DSA-65).", [
      h("div", { class: "form-grid" },
        h("div", { class: "two" }, field("Agent name", f.agentName), field("Agent id", f.agentId, "Your runtime's identifier for it.")),
        h("div", { class: "field" }, h("label", { text: "Permissions" }), chipBox,
          h("div", { class: "suggest" }, ["invoices:read", "invoices:pay", "email:send", "contracts:sign", "refunds:issue", "crm:*"].map(function (p) { return h("button", { type: "button", text: "+ " + p, onclick: function () { addPerm(p); } }); })),
          h("small", { text: "resource:action — a * matches any action, e.g. invoices:*" })),
        h("div", { class: "two" }, field("Max per action (USD)", f.maxAmountUsd, "Optional"), field("Max actions per day", f.maxActionsPerDay, "Optional")),
        h("div", { class: "field" }, h("label", { text: "Valid for" }), daySeg)),
      h("div", null, h("div", { class: "nav__label", style: "margin:0 0 10px", text: "Preview" }), preview),
    ], [h("button", { class: "btn", onclick: function () { d.close(); }, text: "Cancel" }), issueBtn]);
    issueBtn.addEventListener("click", function () {
      if (!f.agentName.value.trim() || !f.agentId.value.trim()) return toast("Give the agent a name and id", true);
      if (!perms.length) return toast("Add at least one permission", true);
      issueBtn.disabled = true;
      api("/console/certificates", { method: "POST", body: { agentName: f.agentName.value.trim(), agentId: f.agentId.value.trim(), permissions: perms, limits: limits(), expiresInDays: days } })
        .then(function (res) {
          d.close();
          toast("Certificate signed and issued");
          if (state.route === "agents" && state.refreshAgents) state.refreshAgents(); else location.hash = "#/agents";
          setTimeout(function () {
            openCertDrawer({ jti: res.jti, agentId: res.agentId, agentName: f.agentName.value.trim(), permissions: perms, limits: limits(), status: "active", issuedAt: new Date().toISOString(), expiresAt: res.expiresAt }, state.refreshAgents);
          }, 250);
        })
        .catch(function (err) {
          issueBtn.disabled = false;
          toast(err.message, true);
          if (err.code === "PLAN_LIMIT_REACHED") { d.close(); location.hash = "#/settings"; }
        });
    });
    f.agentName.focus();
  }

  // ----- ledger -----
  function viewLedger(content) {
    var verdict = "";
    var agent = "";
    var body = h("tbody");
    var countEl = h("span", { class: "faint", style: "font-size:12.5px" });
    var seg = h("div", { class: "segmented", role: "group", "aria-label": "Filter by verdict" });
    [["", "All"], ["within_authority", "Allowed"], ["outside_authority", "Blocked"]].forEach(function (o) {
      seg.appendChild(h("button", { type: "button", "aria-pressed": String(o[0] === verdict), text: o[1], onclick: function () { verdict = o[0]; Array.from(seg.children).forEach(function (b, i) { b.setAttribute("aria-pressed", String(i === ["", "within_authority", "outside_authority"].indexOf(verdict))); }); load(); } }));
    });
    var agentInput = h("input", { class: "input mono", placeholder: "Filter by agent id", style: "width:220px;height:36px", "aria-label": "Agent id filter" });
    var t;
    agentInput.addEventListener("input", function () { clearTimeout(t); t = setTimeout(function () { agent = agentInput.value.trim(); load(); }, 350); });
    var integrityHost = h("div");
    content.appendChild(h("div", { class: "toolbar" }, seg, agentInput, countEl, h("div", { class: "spacer" }), h("button", { class: "btn", onclick: load }, icon("refresh"), "Refresh")));
    content.appendChild(h("div", { class: "grid grid--2" },
      h("div", { class: "panel" }, h("div", { class: "table-wrap" }, h("table", { class: "data cards cards--ledger" },
        h("thead", null, h("tr", null, ["Action", "Agent", "Amount", "Verdict", "When"].map(function (x) { return h("th", { text: x }); }))), body))),
      h("div", { class: "panel", style: "align-self:start" }, h("div", { class: "panel__head" }, h("div", null, h("h3", { text: "Chain integrity" }), h("p", { text: "Tamper evidence for this whole ledger." }))), integrityHost)));
    renderIntegrity(integrityHost, null);
    function load() {
      clear(body).appendChild(h("tr", null, h("td", { colspan: "5" }, h("div", { class: "skeleton" }))));
      var q = "?limit=300" + (verdict ? "&verdict=" + verdict : "") + (agent ? "&agentId=" + encodeURIComponent(agent) : "");
      api("/console/ledger" + q).then(function (r) {
        clear(body);
        countEl.textContent = r.actions.length + " of " + r.count + " shown";
        if (!r.actions.length) {
          body.appendChild(h("tr", null, h("td", { colspan: "5" }, h("div", { class: "empty" }, icon("ledger"), h("h4", { text: "No actions recorded" }), h("p", { text: "Connect your agent runtime in Settings; every action it reports is checked and appended here." })))));
          return;
        }
        r.actions.forEach(function (a) {
          var within = a.verdict === "within_authority";
          body.appendChild(h("tr", { class: "verdict-row" + (within ? " is-within" : "") },
            h("td", { class: "c-action" }, h("div", { class: "mono", style: "color:var(--cream)", text: a.action }), a.resource ? h("div", { class: "faint mono", style: "font-size:11.5px", text: short(a.resource, 40) }) : null,
              !within ? h("div", { style: "margin-top:4px" }, (a.reasons || []).map(function (x) { return h("span", { class: "reason", text: x.replace(/_/g, " ") }); })) : null),
            h("td", { class: "mono muted c-agentid", text: a.agentId }),
            h("td", { class: "muted c-amount", text: money(a.amountUsd) || "—" }),
            h("td", { class: "c-verdict" }, h("span", { class: "pill pill--" + (within ? "within" : "outside"), text: within ? "allowed" : "blocked" })),
            h("td", { class: "faint mono c-when", style: "font-size:12px;white-space:nowrap", title: a.occurredAt, text: ago(a.occurredAt) })));
        });
      }).catch(function (err) { clear(body); toast(err.message, true); });
    }
    load();
  }

  // ----- approvals: named people sign with their own keys -----
  var STATUS_LABEL = { pending: "waiting", partially_signed: "partly signed", fully_signed: "approved", declined: "declined" };
  function statusPill(status) {
    var tone = status === "fully_signed" ? "within" : status === "declined" ? "outside" : "pq";
    return h("span", { class: "pill pill--" + tone, text: STATUS_LABEL[status] || status });
  }

  function viewApprovals(content) {
    var data = null;
    var filter = "all";
    var body = h("tbody");
    var setupHost = h("div");
    var seg = h("div", { class: "segmented", role: "group", "aria-label": "Filter approvals" });
    [["all", "All"], ["open", "Waiting"], ["fully_signed", "Approved"], ["declined", "Declined"]].forEach(function (o) {
      seg.appendChild(h("button", { type: "button", "aria-pressed": String(o[0] === filter), text: o[1], onclick: function () {
        filter = o[0]; Array.from(seg.children).forEach(function (b, i) { b.setAttribute("aria-pressed", String(["all", "open", "fully_signed", "declined"][i] === filter)); }); paint();
      } }));
    });
    var newBtn = h("button", { class: "btn btn--primary", onclick: function () { if (data) openRequestDrawer(data, load); } }, icon("plus"), "Request approval");
    content.appendChild(setupHost);
    content.appendChild(h("div", { class: "toolbar" }, seg, h("div", { class: "spacer" }), h("button", { class: "btn", onclick: load }, icon("refresh"), "Refresh"), newBtn));
    content.appendChild(h("div", { class: "panel" }, h("div", { class: "table-wrap" }, h("table", { class: "data cards cards--approvals" },
      h("thead", null, h("tr", null, ["Request", "Signers", "Status", "Raised"].map(function (x) { return h("th", { text: x }); }))), body))));

    function nameFor(email) {
      var m = data && data.team.find(function (t) { return t.email.toLowerCase() === String(email).toLowerCase(); });
      return m ? m.name : email;
    }
    function paint() {
      clear(body);
      var rows = (data ? data.decisions : []).filter(function (d) {
        return filter === "all" || (filter === "open" ? d.status === "pending" || d.status === "partially_signed" : d.status === filter);
      });
      if (!rows.length) {
        body.appendChild(h("tr", null, h("td", { colspan: "4" }, h("div", { class: "empty" }, icon("approvals"),
          h("h4", { text: data && data.decisions.length ? "Nothing in this view" : "No approval requests yet" }),
          h("p", { text: "Ask a named colleague to approve a high-stakes change, such as raising an agent's spending limit or accepting an Assurance Pack. Their signature is bound to them and verifiable by anyone." })))));
        return;
      }
      rows.forEach(function (d) {
        body.appendChild(h("tr", { class: "clickable", tabindex: "0", onclick: function () { openDecisionDrawer(d.id, data, load); }, onkeydown: function (ev) { if (ev.key === "Enter") openDecisionDrawer(d.id, data, load); } },
          h("td", { class: "c-title" }, h("strong", { style: "color:var(--cream)", text: d.decisionType }), h("div", { class: "faint", style: "font-size:12px", text: short(typeof d.content === "string" ? d.content : "", 90) })),
          h("td", { class: "muted c-signers", text: (d.requiredSigners || []).map(nameFor).join(", ") }),
          h("td", { class: "c-status" }, statusPill(d.status)),
          h("td", { class: "faint mono c-when", style: "font-size:12px;white-space:nowrap", text: ago(d.createdAt) })));
      });
    }
    function paintSetup() {
      clear(setupHost);
      if (!data || !data.me || data.me.canSign) return;
      var p1 = h("input", { class: "input", type: "password", minlength: "10", autocomplete: "new-password", placeholder: "At least 10 characters" });
      var p2 = h("input", { class: "input", type: "password", minlength: "10", autocomplete: "new-password" });
      var go = h("button", { class: "btn btn--primary" }, icon("lock"), "Create my signing key");
      go.addEventListener("click", function () {
        if (p1.value.length < 10) return toast("Use at least 10 characters", true);
        if (p1.value !== p2.value) return toast("The two passphrases do not match", true);
        go.disabled = true;
        api("/console/signing-key", { method: "POST", body: { passphrase: p1.value } }).then(function () {
          p1.value = ""; p2.value = ""; toast("Your signing key is ready"); load();
        }).catch(function (err) { go.disabled = false; toast(err.message, true); });
      });
      setupHost.appendChild(h("div", { class: "panel", style: "margin-bottom:18px" },
        h("div", { class: "panel__head" }, h("div", null, h("h3", { text: "Set up your signing key" }), h("p", { text: "Creates your personal key pair (ECDSA + ML-DSA-65) in Trust Proof, locked with a passphrase only you know. RootSystems never stores it: if you forget it, a new key must be issued." }))),
        h("div", { class: "panel__body" }, h("div", { class: "form-grid" }, h("div", { class: "two" }, field("Signing passphrase", p1), field("Repeat it", p2)), h("div", null, go)))));
    }
    function load() {
      clear(body).appendChild(h("tr", null, h("td", { colspan: "4" }, h("div", { class: "skeleton" }))));
      api("/console/approvals").then(function (r) { data = r; paintSetup(); paint(); }).catch(function (err) { clear(body); toast(err.message, true); });
    }
    load();
  }

  function askPassphrase(title, text, confirmLabel, withReason, onSubmit) {
    var scrim = h("div", { class: "scrim" });
    var modal = h("div", { class: "modal", role: "dialog", "aria-modal": "true", "aria-labelledby": "pp-t" });
    function close() { scrim.remove(); modal.remove(); }
    scrim.addEventListener("click", close);
    var pass = h("input", { class: "input", type: "password", autocomplete: "current-password", "aria-label": "Signing passphrase" });
    var reason = withReason ? h("input", { class: "input", placeholder: "Reason (shared with the requester)", maxlength: "500" }) : null;
    var go = h("button", { class: withReason ? "btn btn--danger" : "btn btn--primary" }, icon(withReason ? "ban" : "lock"), confirmLabel);
    function submit() {
      if (!pass.value) return;
      go.disabled = true;
      onSubmit(pass.value, reason ? reason.value : "").then(close).catch(function (err) { go.disabled = false; pass.value = ""; toast(err.message, true); });
    }
    go.addEventListener("click", submit);
    pass.addEventListener("keydown", function (ev) { if (ev.key === "Enter") submit(); });
    append(modal, [h("h3", { id: "pp-t", text: title }), h("p", { text: text }),
      h("div", { class: "form-grid", style: "margin-bottom:18px" }, field("Your signing passphrase", pass), reason ? field("Reason", reason) : null),
      h("div", { class: "modal__actions" }, h("button", { class: "btn", onclick: close, text: "Cancel" }), go)]);
    document.body.appendChild(scrim); document.body.appendChild(modal);
    pass.focus();
  }

  function openDecisionDrawer(id, data, after) {
    var host = h("div", { class: "form-grid" }, h("div", { class: "skeleton" }));
    var foot = h("div", { style: "display:flex;gap:10px" });
    var d = drawer("Approval request", "Signed with each person's own key.", [host], [foot]);
    api("/console/approvals/" + id).then(function (x) {
      clear(host);
      var mine = data.me && (x.requiredSigners || []).some(function (e) { return e.toLowerCase() === data.me.email.toLowerCase(); });
      var signedBy = (x.signatures || []).map(function (s) { return (s.signer && s.signer.email || "").toLowerCase(); });
      var open = x.status === "pending" || x.status === "partially_signed";
      append(host, [
        h("div", null, statusPill(x.status)),
        h("div", { class: "cert__title", style: "font-size:24px", text: x.decisionType }),
        h("div", { class: "codeblock", style: "white-space:pre-wrap;font-family:var(--sans);font-size:13.5px", text: typeof x.content === "string" ? x.content : JSON.stringify(x.content, null, 2) }),
        h("dl", { class: "cert__grid", style: "margin-top:0" },
          h("div", null, h("dt", { text: "Requested by" }), h("dd", { text: x.proposedBy || "—" })),
          h("div", null, h("dt", { text: "Raised" }), h("dd", { text: date(x.createdAt) })),
          x.externalRef ? h("div", { class: "full" }, h("dt", { text: "Reference" }), h("dd", { class: "mono", style: "font-size:12px", text: x.externalRef })) : null,
          h("div", { class: "full" }, h("dt", { text: "Content fingerprint (SHA-256)" }), h("dd", { class: "mono", style: "font-size:11.5px", text: x.contentHash }))),
        h("div", null, h("div", { class: "nav__label", style: "margin:0 0 10px", text: "Signers" }), h("ul", { class: "verify-list" }, (x.requiredSigners || []).map(function (email) {
          var sig = (x.signatures || []).find(function (s) { return (s.signer && s.signer.email || "").toLowerCase() === email.toLowerCase(); });
          var member = data.team.find(function (t) { return t.email.toLowerCase() === email.toLowerCase(); });
          var state = !sig ? "wait" : sig.action === "declined" ? "bad" : "ok";
          return h("li", { class: state }, icon(state === "ok" ? "check" : state === "bad" ? "x" : "loader"),
            h("span", { text: (member ? member.name : email) + (sig ? (sig.action === "declined" ? " declined" + (sig.reason ? ": " + sig.reason : "") : " signed") : " — waiting") }),
            sig ? h("small", { text: (sig.pqAlgorithm ? sig.signatureAlgorithm + " + " + sig.pqAlgorithm : sig.signatureAlgorithm) + " · " + ago(sig.signedAt) }) : null);
        }))),
      ]);
      clear(foot);
      if (mine && open && signedBy.indexOf(data.me.email.toLowerCase()) < 0) {
        if (!data.me.canSign) {
          foot.appendChild(h("span", { class: "faint", style: "font-size:12.5px", text: "Set up your signing key first (top of Approvals)." }));
        } else {
          foot.appendChild(h("button", { class: "btn btn--danger", onclick: function () {
            askPassphrase("Decline this request?", "Your decline is signed with your key and recorded permanently.", "Decline", true, function (p, reason) {
              return api("/console/approvals/" + id + "/decline", { method: "POST", body: { passphrase: p, reason: reason || undefined } }).then(function () { toast("Declined and recorded"); d.close(); after(); });
            });
          } }, icon("ban"), "Decline"));
          foot.appendChild(h("button", { class: "btn btn--primary", onclick: function () {
            askPassphrase("Sign this approval?", "Your signature binds you, by name, to exactly this content. It cannot be undone.", "Sign", false, function (p) {
              return api("/console/approvals/" + id + "/sign", { method: "POST", body: { passphrase: p } }).then(function () { toast("Signed with your key"); d.close(); after(); });
            });
          } }, icon("lock"), "Sign"));
        }
      }
      foot.appendChild(h("button", { class: "btn", onclick: function () { d.close(); }, text: "Close" }));
    }).catch(function (err) { clear(host); toast(err.message, true); });
  }

  function openRequestDrawer(data, after) {
    var title = h("input", { class: "input", maxlength: "200", placeholder: "Raise Payments Bot limit to $1,000" });
    var details = h("textarea", { class: "input", rows: "6", maxlength: "20000", style: "height:auto;padding:12px;line-height:1.5", placeholder: "What exactly is being approved, and why." });
    var reference = h("input", { class: "input mono", maxlength: "200", placeholder: "Optional: certificate id, ticket, Assurance Pack hash" });
    var picks = {};
    var others = data.team.filter(function (t) { return !data.me || t.userId !== data.me.userId; });
    var list = h("ul", { class: "verify-list" }, others.length ? others.map(function (t) {
      var box = h("button", { class: "switch", role: "switch", "aria-checked": "false", "aria-label": "Require " + t.name, disabled: t.canSign ? null : true });
      box.addEventListener("click", function () { picks[t.userId] = !picks[t.userId]; box.setAttribute("aria-checked", String(!!picks[t.userId])); });
      return h("li", { class: t.canSign ? "ok" : "wait" }, box, h("span", { text: t.name + " · " + t.role }), h("small", { text: t.canSign ? "can sign" : "no signing key yet" }));
    }) : h("li", { class: "wait" }, icon("alert"), h("span", { text: "Add a teammate in Settings first. You cannot approve your own request." })));
    var send = h("button", { class: "btn btn--primary" }, icon("approvals"), "Send request");
    var dr = drawer("Request approval", "Named signers approve with their own keys. You cannot sign your own request.", [
      h("div", { class: "form-grid" }, field("What needs approval", title), field("Details", details), field("Reference", reference),
        h("div", null, h("div", { class: "nav__label", style: "margin:0 0 10px", text: "Required signers" }), list)),
    ], [h("button", { class: "btn", onclick: function () { dr.close(); }, text: "Cancel" }), send]);
    send.addEventListener("click", function () {
      var ids = Object.keys(picks).filter(function (k) { return picks[k]; });
      if (title.value.trim().length < 3 || details.value.trim().length < 3) return toast("Add a title and the details", true);
      if (!ids.length) return toast("Choose at least one signer", true);
      send.disabled = true;
      api("/console/approvals", { method: "POST", body: { title: title.value.trim(), details: details.value.trim(), signerUserIds: ids, reference: reference.value.trim() || undefined } })
        .then(function () { dr.close(); toast("Approval requested"); after(); })
        .catch(function (err) { send.disabled = false; toast(err.message, true); });
    });
    title.focus();
  }

  var ATTENTION = { low_attention: ["low", "within"], moderate_attention: ["moderate", "pq"], high_attention: ["high", "outside"], critical_review: ["critical", "outside"] };
  function viewCoverage(content) {
    var host = h("div", { class: "grid" }, h("div", { class: "panel" }, h("div", { class: "panel__body" }, h("div", { class: "skeleton" }))));
    content.appendChild(h("div", { class: "toolbar" }, h("p", { class: "muted", style: "margin:0", text: "Where your agents' authority may outrun your contracts and insurance." }), h("div", { class: "spacer" }),
      h("a", { class: "btn btn--primary", href: "/" }, icon("plus"), "New analysis")));
    content.appendChild(host);
    api("/console/coverage").then(function (c) {
      clear(host);
      if (!c.projects.length) {
        host.appendChild(h("div", { class: "panel activate" },
          h("div", { class: "pill pill--pq", text: "Agent Contract Gap" }),
          h("h2", { style: "margin-top:16px" }, "Does your insurance cover what your agents can do?"),
          h("p", { text: "Compare each agent's authority with your contracts and insurance, including the AI exclusions insurers added in 2026, and produce a signed Assurance Pack for your broker. Start your first project in the coverage workspace (same sign-in)." }),
          h("a", { class: "btn btn--primary btn--lg", href: "/" }, "Start a coverage analysis", icon("arrow"))));
        return;
      }
      c.projects.forEach(function (p) {
        var rows = h("tbody");
        if (!p.analyses.length) rows.appendChild(h("tr", null, h("td", { colspan: "4", class: "muted", text: "No analyses yet in this project." })));
        p.analyses.forEach(function (a) {
          var done = a.state === "completed" || a.state === "completed_with_warnings";
          var at = a.attention ? ATTENTION[a.attention.label] : null;
          var pack = done ? h("button", { class: "btn btn--sm" }, icon("download"), "Signed Assurance Pack") : null;
          if (pack) pack.addEventListener("click", function () {
            pack.disabled = true;
            api("/analyses/" + a.id + "/assurance-pack", { method: "POST", body: {} }).then(function (res) {
              pack.disabled = false;
              downloadJson(res, "assurance-pack-" + a.id.slice(0, 8) + ".json");
              toast(res.signature && res.signature.status === "signed" ? "Assurance Pack signed (ML-DSA-65) and downloaded" : "Assurance Pack downloaded");
            }).catch(function (err) { pack.disabled = false; toast(err.message, true); });
          });
          rows.appendChild(h("tr", null,
            h("td", null, h("strong", { style: "color:var(--cream)", text: a.agentName }), h("div", { class: "faint mono", style: "font-size:11.5px", text: a.state.replace(/_/g, " ") })),
            h("td", null, at ? h("span", { class: "pill pill--" + at[1], text: at[0] + " · " + a.attention.score }) : h("span", { class: "faint", text: "—" })),
            h("td", { class: "faint mono", style: "font-size:12px", text: ago(a.completedAt || a.createdAt) }),
            h("td", { style: "text-align:right" }, pack)));
        });
        host.appendChild(h("div", { class: "panel" },
          h("div", { class: "panel__head" }, h("div", null, h("h3", { text: p.name }), h("p", { text: p.analyses.length + " analysis" + (p.analyses.length === 1 ? "" : "es") })), h("div", { class: "actions" }, h("a", { class: "btn btn--sm", href: "/" }, "Open project", icon("arrow")))),
          h("div", { class: "table-wrap" }, h("table", { class: "data" }, h("thead", null, h("tr", null, ["Agent", "Attention", "Updated", ""].map(function (x) { return h("th", { text: x }); }))), rows))));
      });
    }).catch(function (err) { clear(host); toast(err.message, true); });
  }

  function viewSettings(content) {
    var keyInput = h("input", { class: "input mono", readonly: true, value: "••••••••••••••••••••••••••••••", "aria-label": "Trust Proof API key" });
    var tpUrl = (state.status && state.status.trustProofUrl) || "";
    var urlText = h("span", { class: "mono", text: tpUrl || "not configured" });
    var revealed = null;
    var reveal = h("button", { class: "btn" }, icon("eye"), "Reveal");
    var copyBtn = h("button", { class: "btn", disabled: true }, icon("copy"), "Copy");
    var code = h("pre", { class: "codeblock" });
    function paintCode(url) {
      clear(code);
      append(code, [h("span", { class: "c", text: "// Before your agent acts, ask Trust Proof. Blocked actions are recorded too.\n" }),
        "const res = await fetch(", h("span", { class: "s", text: '"' + url + '/api/v1/agent-actions"' }), ", {\n",
        "  method: ", h("span", { class: "s", text: '"POST"' }), ",\n",
        "  headers: { Authorization: ", h("span", { class: "s", text: '"Bearer " + process.env.TRUST_PROOF_KEY' }), ", ", h("span", { class: "s", text: '"Content-Type"' }), ": ", h("span", { class: "s", text: '"application/json"' }), " },\n",
        "  body: JSON.stringify({ ", h("span", { class: "k", text: "certificate" }), ", ", h("span", { class: "k", text: "action" }), ": ", h("span", { class: "s", text: '"invoices:pay"' }), ", ", h("span", { class: "k", text: "amountUsd" }), ": 120 }),\n",
        "});\n",
        "const { allowed, reasons } = await res.json();\n",
        h("span", { class: "c", text: "// allowed === false → do not act. Our agent-guard SDK wraps this and fails closed." })]);
    }
    paintCode(tpUrl || "https://trust-proof.example");
    var isAdmin = state.me && (state.me.role === "owner" || state.me.role === "admin");
    reveal.addEventListener("click", function () {
      if (revealed) { keyInput.value = "••••••••••••••••••••••••••••••"; revealed = null; reveal.lastChild.textContent = "Reveal"; copyBtn.disabled = true; return; }
      reveal.disabled = true;
      api("/console/connection").then(function (r) {
        revealed = r; keyInput.value = r.apiKey; urlText.textContent = r.trustProofUrl; paintCode(r.trustProofUrl);
        reveal.disabled = false; reveal.lastChild.textContent = "Hide"; copyBtn.disabled = false;
      }).catch(function (err) { reveal.disabled = false; toast(err.message, true); });
    });
    copyBtn.addEventListener("click", function () { if (revealed) copy(revealed.apiKey, "API key"); });
    var billingHost = h("div", { class: "panel__body" }, h("div", { class: "skeleton" }));
    loadBilling(billingHost, isAdmin);
    var teamHost = h("div", { class: "panel__body" }, h("div", { class: "skeleton" }));
    loadTeam(teamHost, isAdmin);
    var alertsHost = h("div", { class: "panel__body" }, h("div", { class: "skeleton" }));
    loadAlerts(alertsHost, isAdmin, Boolean(state.me && state.me.role !== "viewer"));
    var teamPanel = h("div", { class: "panel" },
      h("div", { class: "panel__head" }, h("div", null, h("h3", { text: "Team" }), h("p", { text: "Everyone here shares this workspace. Approvers sign with their own keys." }))),
      teamHost);
    content.appendChild(h("div", { class: "grid", style: "max-width:980px" },
      h("div", { class: "panel" },
        h("div", { class: "panel__head" }, h("div", null, h("h3", { text: "Plan & billing" }), h("p", { text: "Priced per workspace. Payments by Dodo Payments; cancel any time." }))),
        billingHost),
      teamPanel,
      h("div", { class: "panel" },
        h("div", { class: "panel__head" }, h("div", null, h("h3", { text: "Connect your agent" }), h("p", { text: "Your runtime reports each action with this workspace's Trust Proof key and the agent's certificate." }))),
        h("div", { class: "panel__body", style: "display:grid;gap:16px" },
          h("div", { class: "field" }, h("label", { text: "Trust Proof endpoint" }), h("div", { class: "muted" }, urlText)),
          h("div", { class: "field" }, h("label", { text: "Workspace API key" }),
            isAdmin ? h("div", { class: "secret" }, keyInput, reveal, copyBtn) : h("p", { class: "muted", text: "Only workspace owners and admins can view the key." }),
            h("small", { text: "Keep it in your runtime's secret store. Viewing it is recorded in the audit log." })),
          code)),
      h("div", { class: "panel" },
        h("div", { class: "panel__head" }, h("div", null, h("h3", { text: "Alerts" }), h("p", { text: "Trust Proof calls your HTTPS address whenever an agent tries something outside its authority." }))),
        alertsHost),
      h("div", { class: "panel" },
        h("div", { class: "panel__head" }, h("div", null, h("h3", { text: "Signing & evidence" }), h("p", { text: "How the evidence from this workspace can be checked." }))),
        h("div", { class: "panel__body" }, h("ul", { class: "verify-list" },
          h("li", { class: "ok" }, icon("check"), h("span", { text: "Certificates signed with ES256 and countersigned with ML-DSA-65" }), h("small", { text: "Authority Atlas" })),
          h("li", { class: "ok" }, icon("check"), h("span", { text: "Each certificate bound by SHA-512 in the Atlas registry" }), h("small", { text: "rejects re-signed forgeries" })),
          h("li", { class: "ok" }, icon("check"), h("span", { text: "Ledger checkpoints signed with ML-DSA-65" }), h("small", { text: "Trust Proof" })),
          h("li", { class: "ok" }, icon("check"), h("span", { text: "Linked-service credentials sealed with AES-256-GCM" }), h("small", { text: "never shown to anyone" }))))),
      h("div", { class: "panel" },
        h("div", { class: "panel__head" }, h("div", null, h("h3", { text: "Workspace" }), h("p", { text: (state.me && state.me.organization && state.me.organization.name) || "" }))),
        h("div", { class: "panel__body", style: "display:flex;gap:10px;flex-wrap:wrap" },
          h("a", { class: "btn", href: "https://rootsystems.app/dpa", target: "_blank", rel: "noopener" }, "Data Processing Agreement"),
          h("a", { class: "btn", href: "https://rootsystems.app/privacy", target: "_blank", rel: "noopener" }, "Privacy"),
          h("button", { class: "btn btn--ghost", onclick: function () { signOut(false); } }, icon("logout"), "Sign out")))));
  }

  function loadTeam(host, isAdmin) {
    api("/console/team").then(function (team) {
      clear(host);
      host.appendChild(h("ul", { class: "verify-list" }, team.map(function (m) {
        return h("li", { class: m.canSign ? "ok" : "wait" }, h("div", { class: "who__avatar", style: "width:28px;height:28px;font-size:12px", text: m.name.slice(0, 1).toUpperCase() }),
          h("span", null, h("strong", { style: "color:var(--cream);font-weight:600", text: m.name }), " ", h("span", { class: "faint", text: m.email })),
          h("small", { text: m.role + (m.canSign ? " · can sign" : "") }));
      })));
      if (!isAdmin) return;
      var name = h("input", { class: "input", placeholder: "Sam Rivera", maxlength: "100" });
      var email = h("input", { class: "input", type: "email", placeholder: "sam@company.com" });
      var role = h("select", { class: "select" }, h("option", { value: "analyst", text: "Analyst: issue certificates, request approvals" }), h("option", { value: "admin", text: "Admin: also revoke, billing, keys" }), h("option", { value: "viewer", text: "Viewer: read only" }));
      var add = h("button", { class: "btn" }, icon("plus"), "Add teammate");
      add.addEventListener("click", function () {
        if (name.value.trim().length < 2 || !email.value.includes("@")) return toast("Add a name and a work email", true);
        add.disabled = true;
        api("/console/team", { method: "POST", body: { name: name.value.trim(), email: email.value.trim(), role: role.value } }).then(function (r) {
          add.disabled = false; name.value = ""; email.value = "";
          showOneTimePassword(r.email, r.temporaryPassword);
          loadTeam(host, isAdmin);
        }).catch(function (err) { add.disabled = false; toast(err.message, true); });
      });
      host.appendChild(h("div", { class: "form-grid", style: "margin-top:16px" }, h("div", { class: "two" }, field("Name", name), field("Work email", email)), field("Role", role), h("div", null, add)));
    }).catch(function (err) { clear(host); toast(err.message, true); });
  }
  function showOneTimePassword(email, password) {
    var scrim = h("div", { class: "scrim" });
    var modal = h("div", { class: "modal", role: "dialog", "aria-modal": "true", "aria-labelledby": "otp-t" });
    function close() { scrim.remove(); modal.remove(); }
    append(modal, [h("h3", { id: "otp-t", text: "Teammate added" }),
      h("p", { text: "Send " + email + " this one-time password privately (not in the same message as the email). It is shown only now." }),
      h("div", { class: "secret", style: "margin-bottom:18px" }, h("input", { class: "input mono", readonly: true, value: password, "aria-label": "One-time password" }), h("button", { class: "btn", onclick: function () { copy(password, "Password"); } }, icon("copy"), "Copy")),
      h("div", { class: "modal__actions" }, h("button", { class: "btn btn--primary", onclick: close, text: "Done" }))]);
    document.body.appendChild(scrim); document.body.appendChild(modal);
  }

  var MAX_ALERTS = 5; // Trust Proof's per-organization webhook limit
  function loadAlerts(host, isAdmin, canTest) {
    api("/console/alerts").then(function (hooks) {
      clear(host);
      if (!hooks.length) {
        host.appendChild(h("p", { class: "muted", style: "margin:0", text: "No alerts yet." + (isAdmin ? " Add an address below." : " A workspace admin can add one.") }));
      } else {
        host.appendChild(h("ul", { class: "verify-list" }, hooks.map(function (w) {
          var status = h("small", { text: "added " + date(w.createdAt) });
          var test = canTest ? h("button", { class: "btn btn--sm" }, "Send test") : null;
          if (test) test.addEventListener("click", function () {
            test.disabled = true;
            api("/console/alerts/" + w.id + "/test", { method: "POST" }).then(function (r) {
              test.disabled = false;
              status.textContent = r.delivered ? "test delivered (" + r.status + ")" : "test failed: " + (r.error || "no answer");
              toast(r.delivered ? "Test alert delivered" : "Test alert was not delivered", !r.delivered);
            }).catch(function (err) { test.disabled = false; toast(err.message, true); });
          });
          var del = isAdmin ? h("button", { class: "btn btn--ghost btn--sm", "aria-label": "Delete alert " + w.url }, icon("x")) : null;
          if (del) del.addEventListener("click", function () {
            if (!window.confirm("Stop sending alerts to " + w.url + "?")) return;
            del.disabled = true;
            api("/console/alerts/" + w.id, { method: "DELETE" }).then(function () {
              toast("Alert deleted");
              loadAlerts(host, isAdmin, canTest);
            }).catch(function (err) { del.disabled = false; toast(err.message, true); });
          });
          return h("li", { class: "ok alert-row" }, icon("bolt"), h("span", { class: "mono alert-row__url", text: w.url, title: w.url }), status, test, del);
        })));
      }
      if (isAdmin) {
        var url = h("input", { class: "input mono", type: "url", placeholder: "https://hooks.example.com/rootsystems", maxlength: "2000", "aria-label": "Alert address (HTTPS)" });
        var add = h("button", { class: "btn" }, icon("plus"), "Add alert");
        var full = hooks.length >= MAX_ALERTS;
        if (full) { url.disabled = true; add.disabled = true; }
        add.addEventListener("click", function () {
          var value = url.value.trim();
          if (value.indexOf("https://") !== 0) return toast("The address must start with https://", true);
          add.disabled = true;
          api("/console/alerts", { method: "POST", body: { url: value } }).then(function (r) {
            url.value = "";
            showWebhookSecret(r.webhook.url, r.secret);
            loadAlerts(host, isAdmin, canTest);
          }).catch(function (err) { add.disabled = false; toast(err.message, true); });
        });
        host.appendChild(h("div", { class: "secret", style: "margin-top:16px" }, url, add));
        if (full) host.appendChild(h("small", { class: "faint", text: "Workspaces can have up to " + MAX_ALERTS + " alerts. Delete one to add another." }));
      }
      host.appendChild(h("p", { class: "faint", style: "margin:14px 0 0;font-size:12.5px", text: "Alerts are best-effort: a failed delivery is retried briefly, and retries still waiting when the server restarts are dropped. The ledger always has the full record." }));
    }).catch(function (err) {
      clear(host);
      host.appendChild(h("p", { class: "muted", style: "margin:0", text: err.message }));
    });
  }
  function showWebhookSecret(url, secret) {
    var scrim = h("div", { class: "scrim" });
    var modal = h("div", { class: "modal", role: "dialog", "aria-modal": "true", "aria-labelledby": "whs-t" });
    function close() { scrim.remove(); modal.remove(); }
    append(modal, [h("h3", { id: "whs-t", text: "Alert added" }),
      h("p", { text: "Store this signing secret now. You will not see it again. Use it to check the X-RootSystems-Signature header on each call to " + url + "." }),
      h("div", { class: "secret", style: "margin-bottom:18px" }, h("input", { class: "input mono", readonly: true, value: secret, "aria-label": "Signing secret" }), h("button", { class: "btn", onclick: function () { copy(secret, "Secret"); } }, icon("copy"), "Copy")),
      h("div", { class: "modal__actions" }, h("button", { class: "btn btn--primary", onclick: close, text: "I have stored it" }))]);
    document.body.appendChild(scrim); document.body.appendChild(modal);
  }

  function loadBilling(host, isAdmin) {
    api("/console/billing").then(function (b) {
      clear(host);
      var statusNote = b.status === "on_hold" ? "Your last payment did not go through. Dodo is retrying; update your card to keep your plan."
        : b.renewsAt ? "Renews " + date(b.renewsAt) + "." : b.plan.id === "free" ? "You are on the free trial." : "";
      host.appendChild(h("div", { class: "plans" }, b.plans.map(function (p) {
        var current = p.id === b.plan.id;
        var action = null;
        if (!current && p.id !== "free") {
          if (!b.checkoutAvailable) action = h("a", { class: "btn btn--sm", href: "https://rootsystems.app/contact", target: "_blank", rel: "noopener" }, "Talk to us");
          else if (!isAdmin) action = h("span", { class: "faint", style: "font-size:12px", text: "Ask a workspace admin to upgrade" });
          else {
            action = h("button", { class: "btn btn--primary btn--sm" }, "Upgrade to " + p.name);
            action.addEventListener("click", function () {
              action.disabled = true;
              api("/console/billing/checkout", { method: "POST", body: { plan: p.id } })
                .then(function (r) { location.href = r.url; })
                .catch(function (err) { action.disabled = false; toast(err.message, true); });
            });
          }
        }
        return h("div", { class: "plan" + (current ? " is-current" : "") },
          h("div", { class: "plan__name" }, p.name, current ? h("span", { class: "pill pill--active", text: "current" }) : null),
          h("div", { class: "plan__price" }, p.priceUsdMonthly ? "$" + p.priceUsdMonthly : "Free", p.priceUsdMonthly ? h("span", { text: " / month" }) : null),
          h("div", { class: "plan__limit", text: "Up to " + p.activeCertificates + " active agents" }),
          h("p", { class: "plan__summary", text: p.summary }),
          action);
      })));
      if (statusNote) host.appendChild(h("p", { class: "faint", style: "margin:14px 0 0;font-size:12.5px", text: statusNote }));
    }).catch(function (err) { clear(host); toast(err.message, true); });
  }

  // ---------- command palette ----------
  function openPalette() {
    if (document.querySelector(".palette")) return;
    var commands = [
      { label: "Go to Overview", icon: "overview", run: function () { location.hash = "#/overview"; } },
      { label: "Go to Agents & certificates", icon: "agents", run: function () { location.hash = "#/agents"; } },
      { label: "Go to Action ledger", icon: "ledger", run: function () { location.hash = "#/ledger"; } },
      { label: "Go to Coverage", icon: "coverage", run: function () { location.hash = "#/coverage"; } },
      { label: "Go to Settings", icon: "settings", run: function () { location.hash = "#/settings"; } },
      { label: "Issue a certificate", icon: "plus", hint: "new", run: function () { openIssueDrawer(); } },
      { label: "Verify the ledger chain", icon: "shield", run: function () { location.hash = "#/ledger"; toast("Use “Verify now” on the Chain integrity panel"); } },
      { label: "Sign out", icon: "logout", run: function () { signOut(false); } },
    ];
    var scrim = h("div", { class: "scrim" });
    var input = h("input", { placeholder: "Type a command…", "aria-label": "Command" });
    var list = h("ul", { role: "listbox" });
    var box = h("div", { class: "palette", role: "dialog", "aria-modal": "true", "aria-label": "Command palette" }, input, list);
    var sel = 0, shown = commands;
    function close() { scrim.remove(); box.remove(); }
    function paint() {
      var q = input.value.toLowerCase();
      shown = commands.filter(function (c) { return c.label.toLowerCase().indexOf(q) >= 0; });
      sel = Math.min(sel, Math.max(shown.length - 1, 0));
      clear(list);
      shown.forEach(function (c, i) { list.appendChild(h("li", { role: "option", "aria-selected": String(i === sel), onclick: function () { close(); c.run(); }, onmousemove: function () { if (sel !== i) { sel = i; paint(); } } }, icon(c.icon), c.label, c.hint ? h("small", { text: c.hint }) : null)); });
    }
    input.addEventListener("input", function () { sel = 0; paint(); });
    input.addEventListener("keydown", function (ev) {
      if (ev.key === "ArrowDown") { ev.preventDefault(); sel = Math.min(sel + 1, shown.length - 1); paint(); }
      if (ev.key === "ArrowUp") { ev.preventDefault(); sel = Math.max(sel - 1, 0); paint(); }
      if (ev.key === "Enter" && shown[sel]) { close(); shown[sel].run(); }
      if (ev.key === "Escape") close();
    });
    scrim.addEventListener("click", close);
    document.body.appendChild(scrim); document.body.appendChild(box);
    paint(); input.focus();
  }
  document.addEventListener("keydown", function (ev) {
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "k" && state.me && state.status && state.status.linked) { ev.preventDefault(); openPalette(); }
  });

  boot();
})();
