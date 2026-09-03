"use strict";

/* Sign-in page for the Admin Control Centre. On success it stores the bearer
   token and navigates (full page load) into the console. */

const TOKEN_KEY = "ic_admin_token";

function haveToken() {
  try { return Boolean(localStorage.getItem(TOKEN_KEY)); } catch { return false; }
}
function storeToken(t) {
  try { localStorage.setItem(TOKEN_KEY, t); return true; } catch { return false; }
}
function safeNext() {
  const raw = new URLSearchParams(location.search).get("next") || "";
  return /^\/admin\/[A-Za-z0-9/_-]*$/.test(raw) ? raw : "/admin/dashboard";
}

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
    if (!res.ok) throw new Error(body?.error?.message || "Sign in failed");
    if (body.user?.role !== "admin") {
      errEl.innerHTML = 'This account is not a platform administrator. Tenant users sign in at <a href="/app/login">/app</a>.';
      errEl.hidden = false;
      submit.disabled = false;
      return;
    }
    let dest = safeNext();
    if (!storeToken(body.token)) dest += `#t=${encodeURIComponent(body.token)}`;
    location.replace(dest);
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
    submit.disabled = false;
  }
});
