"use strict";

/* Sign-in page for the customer application. On success it stores the bearer
   token and navigates (full page load) into the app. Holds no privileges of its
   own — every /api call is authenticated and RLS-scoped server-side. */

const TOKEN_KEY = "ic_app_token";

function storeToken(t) {
  try { localStorage.setItem(TOKEN_KEY, t); return true; } catch { return false; }
}
function haveToken() {
  try { return Boolean(localStorage.getItem(TOKEN_KEY)); } catch { return false; }
}
function safeNext() {
  const raw = new URLSearchParams(location.search).get("next") || "";
  return /^\/app\/[A-Za-z0-9/_-]*$/.test(raw) ? raw : "/app/dashboard";
}

// Already signed in? Skip the form.
if (haveToken()) location.replace(safeNext());

const form = document.getElementById("login-form");
const errEl = document.getElementById("login-error");

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  errEl.hidden = true;
  const submit = form.querySelector("button[type=submit]");
  submit.disabled = true;
  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value;
  try {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(body?.error?.message || "Sign in failed. Check your email and password.");
    }
    if (body.user?.role !== "user") {
      errEl.innerHTML =
        'This account is a platform administrator. Use the <a href="/admin/">Admin Control Centre</a>.';
      errEl.hidden = false;
      submit.disabled = false;
      return;
    }
    let dest = safeNext();
    // If localStorage is unavailable (private mode), hand the token over in the
    // URL fragment; app.js picks it up, keeps it in memory, and strips it.
    if (!storeToken(body.token)) dest += `#t=${encodeURIComponent(body.token)}`;
    location.replace(dest);
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
    submit.disabled = false;
  }
});
