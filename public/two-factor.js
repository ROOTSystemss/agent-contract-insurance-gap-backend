// Two-factor sign-in, the code step (knock-out 2026-11-16). Every page that signs people in (console, coverage
// workspace, OAuth authorize) calls window.rsTwoFactorStep(pendingToken) when /auth/login answers
// { twoFactorRequired: true, pendingToken }. Resolves with the same data a normal sign-in returns (accessToken),
// rejects when the person cancels or the sign-in expired.
(function () {
  "use strict";
  function el(tag, props, children) {
    var node = document.createElement(tag);
    Object.keys(props || {}).forEach(function (k) {
      if (k === "text") node.textContent = props[k];
      else if (k === "style") Object.keys(props.style).forEach(function (s) { node.style[s] = props.style[s]; });
      else node.setAttribute(k, props[k]);
    });
    (children || []).forEach(function (c) { node.appendChild(c); });
    return node;
  }
  window.rsTwoFactorStep = function (pendingToken) {
    return new Promise(function (resolve, reject) {
      var input = el("input", { id: "twofa-code", name: "code", inputmode: "numeric", autocomplete: "one-time-code", maxlength: "20", required: "required", "aria-label": "Code", style: { width: "100%", fontSize: "20px", padding: "10px", letterSpacing: "3px", boxSizing: "border-box", margin: "8px 0" } });
      var message = el("p", { role: "alert", id: "twofa-message", style: { color: "#b42318", minHeight: "1.2em", margin: "4px 0" } });
      var submit = el("button", { type: "submit", class: "button button-primary", text: "Sign in" });
      var cancel = el("button", { type: "button", class: "button button-secondary", text: "Cancel", style: { marginLeft: "8px" } });
      var form = el("form", { id: "twofa-step" }, [
        el("h2", { text: "Enter your sign-in code", style: { margin: "0 0 6px" } }),
        el("p", { text: "Two-factor sign-in is on for this account. Enter the 6-digit code from your authenticator app, or one of your recovery codes.", style: { margin: "0 0 6px" } }),
        input, message, el("div", {}, [submit, cancel]),
      ]);
      var box = el("div", { role: "dialog", "aria-modal": "true", style: { background: "#fff", color: "#16202b", maxWidth: "420px", width: "calc(100% - 32px)", margin: "15vh auto 0", padding: "22px", borderRadius: "12px", boxShadow: "0 10px 40px rgba(0,0,0,.3)", fontFamily: "inherit" } }, [form]);
      var overlay = el("div", { id: "twofa-overlay", style: { position: "fixed", inset: "0", background: "rgba(10,15,20,.55)", zIndex: "9999" } }, [box]);
      function close() { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }
      cancel.addEventListener("click", function () { close(); reject(new Error("Sign-in cancelled.")); });
      form.addEventListener("submit", function (ev) {
        ev.preventDefault();
        submit.disabled = true;
        message.textContent = "";
        fetch("/api/v1/auth/login/2fa", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ pendingToken: pendingToken, code: input.value.trim() }) })
          .then(function (r) { return r.json().catch(function () { return {}; }).then(function (p) { return { status: r.status, p: p }; }); })
          .then(function (res) {
            submit.disabled = false;
            if (res.status === 200 && res.p.data && res.p.data.accessToken) { close(); resolve(res.p.data); return; }
            var msg = (res.p.error && res.p.error.message) || "That code did not work.";
            if (res.status === 401) { close(); reject(new Error(msg)); return; }
            message.textContent = msg;
            input.select();
          })
          .catch(function () { submit.disabled = false; message.textContent = "Could not reach the server. Try again."; });
      });
      document.body.appendChild(overlay);
      input.focus();
    });
  };
})();
