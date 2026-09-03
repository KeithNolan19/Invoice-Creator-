"use strict";

/* Invoice Creator — Admin Control Centre (vanilla JS SPA).
   Talks to /api/admin/* with a bearer token. Holds no privileges of its own;
   the server enforces requireAdmin + RLS on every call. */

const TOKEN_KEY = "ic_admin_token";
const gate = document.getElementById("gate");
const app = document.getElementById("app");
const view = document.getElementById("view");

let token = null;
try { token = localStorage.getItem(TOKEN_KEY); } catch { token = null; }

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtDate = (s) => (s ? new Date(s).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—");
const fmtDay = (s) => (s ? new Date(s).toLocaleDateString(undefined, { dateStyle: "medium" }) : "—");

async function api(path, options = {}) {
  const { base = "/api/admin", ...rest } = options;
  const res = await fetch(`${base}${path}`, {
    ...rest,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(rest.headers || {}),
    },
  });
  if (res.status === 401) {
    setToken(null);
    render();
    throw new ApiError(401, "Session expired — sign in again");
  }
  const body = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body?.error?.message || `Request failed (${res.status})`);
  return body;
}

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function setToken(next) {
  token = next;
  try {
    if (next) localStorage.setItem(TOKEN_KEY, next);
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* ignore */ }
}

/* ---------------- Login ---------------- */

document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errEl = document.getElementById("login-error");
  errEl.hidden = true;
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
    if (body.user?.role !== "admin") throw new Error("This account is not a platform administrator");
    setToken(body.token);
    location.hash = "#/";
    render();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
  }
});

document.getElementById("signout").addEventListener("click", async () => {
  try { await api("/logout", { method: "POST", base: "/api/auth" }); } catch { /* best effort */ }
  setToken(null);
  location.hash = "#/";
  render();
});

/* ---------------- Router ---------------- */

const routes = [
  { re: /^#\/$/, view: dashboardView },
  { re: /^#\/tenants$/, view: tenantsView },
  { re: /^#\/tenants\/([0-9a-f-]{36})$/, view: tenantDetailView },
  { re: /^#\/audit$/, view: auditView },
];

function render() {
  if (!token) {
    gate.hidden = false;
    app.hidden = true;
    return;
  }
  gate.hidden = true;
  app.hidden = false;

  const hash = location.hash || "#/";
  const path = hash.split("?")[0];
  const match = routes.map((r) => [r, r.re.exec(path)]).find(([, m]) => m);
  const navKey = path.startsWith("#/tenants") ? "tenants" : path.startsWith("#/audit") ? "audit" : "dashboard";
  document.querySelectorAll("[data-nav]").forEach((a) => a.classList.toggle("active", a.dataset.nav === navKey));

  view.innerHTML = `<p class="muted">Loading…</p>`;
  const [route, m] = match || [routes[0], ["#/"]];
  route.view(m).catch((err) => {
    view.innerHTML = `<p class="error">${esc(err.message)}</p>`;
  });
}

window.addEventListener("hashchange", render);

async function loadWho() {
  try {
    const me = await (await fetch("/api/auth/me", { headers: { Authorization: `Bearer ${token}` } })).json();
    document.getElementById("who").textContent = me.user?.email || "";
  } catch { /* ignore */ }
}

/* ---------------- Views ---------------- */

async function dashboardView() {
  const { stats } = await api("/dashboard");
  view.innerHTML = `
    <div class="view-head"><div><h1>Dashboard</h1><p class="lede">Platform overview across all tenants.</p></div></div>
    <div class="tile-group">
      <h3>Tenants</h3>
      <div class="tiles">
        ${tile(stats.tenants.total, "Total")}
        ${tile(stats.tenants.active, "Active")}
        ${tile(stats.tenants.suspended, "Suspended")}
      </div>
    </div>
    <div class="tile-group">
      <h3>Users</h3>
      <div class="tiles">
        ${tile(stats.users.total, "Total")}
        ${tile(stats.users.active, "Active")}
        ${tile(stats.users.disabled, "Disabled")}
      </div>
    </div>
    <div class="tile-group">
      <h3>Activity</h3>
      <div class="tiles">
        ${tile(stats.activity.totalInvoices, "Invoices")}
        ${tile(stats.activity.adminActions, "Admin actions")}
        ${tile(stats.activity.adminActionsLast7Days, "Admin actions · 7d")}
      </div>
    </div>`;
}

const tile = (n, k) => `<div class="tile"><div class="n">${esc(n)}</div><div class="k">${esc(k)}</div></div>`;

function statusPill(status) {
  return `<span class="pill ${esc(status)}">${esc(status)}</span>`;
}

async function tenantsView() {
  const params = new URLSearchParams(location.hash.split("?")[1] || "");
  const search = params.get("search") || "";
  const status = params.get("status") || "";
  const qs = new URLSearchParams();
  if (search) qs.set("search", search);
  if (status) qs.set("status", status);

  const { tenants } = await api(`/tenants${qs.toString() ? `?${qs}` : ""}`);
  view.innerHTML = `
    <div class="view-head">
      <div><h1>Tenants</h1><p class="lede">${tenants.length} shown.</p></div>
      <button id="new-tenant-btn" class="ghost">New tenant</button>
    </div>
    <div id="new-tenant-slot"></div>
    <div class="toolbar">
      <input id="t-search" type="search" placeholder="Search name or slug" value="${esc(search)}">
      <select id="t-status">
        <option value="">All statuses</option>
        <option value="active" ${status === "active" ? "selected" : ""}>Active</option>
        <option value="suspended" ${status === "suspended" ? "selected" : ""}>Suspended</option>
      </select>
    </div>
    <table>
      <thead><tr><th>Name</th><th>Slug</th><th>Status</th><th>Created</th></tr></thead>
      <tbody>
        ${tenants.map((t) => `
          <tr class="clickable" data-id="${esc(t.id)}">
            <td>${esc(t.name)}</td>
            <td><span class="mono">${esc(t.slug)}</span></td>
            <td>${statusPill(t.status)}</td>
            <td>${esc(fmtDay(t.createdAt))}</td>
          </tr>`).join("") || `<tr><td colspan="4" class="muted">No tenants match.</td></tr>`}
      </tbody>
    </table>`;

  const applyFilters = () => {
    const s = document.getElementById("t-search").value.trim();
    const st = document.getElementById("t-status").value;
    const q = new URLSearchParams();
    if (s) q.set("search", s);
    if (st) q.set("status", st);
    location.hash = `#/tenants${q.toString() ? `?${q}` : ""}`;
  };
  document.getElementById("t-search").addEventListener("change", applyFilters);
  document.getElementById("t-status").addEventListener("change", applyFilters);
  view.querySelectorAll("tr[data-id]").forEach((tr) =>
    tr.addEventListener("click", () => { location.hash = `#/tenants/${tr.dataset.id}`; }));
  document.getElementById("new-tenant-btn").addEventListener("click", showNewTenantForm);
}

function showNewTenantForm() {
  const slot = document.getElementById("new-tenant-slot");
  slot.innerHTML = `
    <form class="inline-form" id="new-tenant-form">
      <h3>New tenant</h3>
      <div class="row">
        <div class="field"><label for="nt-name">Company name</label><input id="nt-name" required></div>
        <div class="field"><label for="nt-slug">Slug (optional)</label><input id="nt-slug" placeholder="auto from name" pattern="[a-z0-9-]+"></div>
      </div>
      <p class="error" id="nt-error" hidden></p>
      <div class="actions"><button type="submit">Create tenant</button><button type="button" class="ghost" id="nt-cancel">Cancel</button></div>
    </form>`;
  document.getElementById("nt-cancel").addEventListener("click", () => { slot.innerHTML = ""; });
  document.getElementById("new-tenant-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = document.getElementById("nt-error");
    err.hidden = true;
    const name = document.getElementById("nt-name").value.trim();
    const slug = document.getElementById("nt-slug").value.trim();
    try {
      const { tenant } = await api("/tenants", {
        method: "POST",
        body: JSON.stringify(slug ? { name, slug } : { name }),
      });
      location.hash = `#/tenants/${tenant.id}`;
    } catch (e2) {
      err.textContent = e2.message;
      err.hidden = false;
    }
  });
}

async function tenantDetailView(m) {
  const id = m[1];
  const { tenant, usage, users } = await api(`/tenants/${id}`);
  const suspended = tenant.status === "suspended";
  view.innerHTML = `
    <a class="back" href="#/tenants">← All tenants</a>
    <div class="view-head"><div><h1>${esc(tenant.name)}</h1><p class="lede">${statusPill(tenant.status)}</p></div></div>

    <div class="card">
      <dl class="dl">
        <dt>Company name</dt><dd>${esc(tenant.name)}</dd>
        <dt>Tenant ID</dt><dd><span class="mono">${esc(tenant.id)}</span></dd>
        <dt>Slug</dt><dd><span class="mono">${esc(tenant.slug)}</span></dd>
        <dt>Status</dt><dd>${statusPill(tenant.status)}</dd>
        <dt>Created</dt><dd>${esc(fmtDate(tenant.createdAt))}</dd>
        <dt>Users</dt><dd>${esc(usage.userCount)} (${esc(usage.activeUserCount)} active)</dd>
        <dt>Invoices</dt><dd>${esc(usage.invoiceCount)}</dd>
        <dt>Last invoice</dt><dd>${esc(fmtDate(usage.lastInvoiceAt))}</dd>
        <dt>Last admin action</dt><dd>${esc(fmtDate(usage.lastAdminActionAt))}</dd>
      </dl>
      <div class="section-actions">
        ${suspended
          ? `<button id="reactivate">Reactivate tenant</button>`
          : `<button id="suspend" class="danger">Suspend tenant</button>`}
      </div>
    </div>

    <h2>Users</h2>
    <div id="user-msg"></div>
    <table>
      <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th></th></tr></thead>
      <tbody>
        ${users.map((u) => `
          <tr>
            <td>${esc(u.name)}</td>
            <td><span class="mono">${esc(u.email)}</span></td>
            <td>${esc(u.role)}</td>
            <td>${u.disabled ? `<span class="pill disabled">disabled</span>` : `<span class="pill active">active</span>`}</td>
            <td>${
              u.role === "admin"
                ? ""
                : u.disabled
                  ? `<button class="link" data-enable="${esc(u.id)}">Enable</button>`
                  : `<button class="link" data-disable="${esc(u.id)}">Disable</button>`
            }</td>
          </tr>`).join("") || `<tr><td colspan="5" class="muted">No users yet.</td></tr>`}
      </tbody>
    </table>

    <form class="inline-form" id="new-user-form" style="margin-top:24px">
      <h3>Add a user to ${esc(tenant.name)}</h3>
      <div class="row">
        <div class="field"><label for="nu-name">Name</label><input id="nu-name" required></div>
        <div class="field"><label for="nu-email">Email</label><input id="nu-email" type="email" required></div>
        <div class="field"><label for="nu-pass">Password (optional)</label><input id="nu-pass" type="text" placeholder="auto-generate" minlength="8"></div>
      </div>
      <p class="error" id="nu-error" hidden></p>
      <div class="actions"><button type="submit">Create user</button></div>
    </form>`;

  const suspendBtn = document.getElementById("suspend");
  const reactivateBtn = document.getElementById("reactivate");
  if (suspendBtn) suspendBtn.addEventListener("click", () => statusAction(id, "suspend"));
  if (reactivateBtn) reactivateBtn.addEventListener("click", () => statusAction(id, "reactivate"));

  const userAction = (id, verb, confirmMsg) => async () => {
    if (confirmMsg && !confirm(confirmMsg)) return;
    try {
      await api(`/users/${id}/${verb}`, { method: "POST" });
      render();
    } catch (e) {
      document.getElementById("user-msg").innerHTML = `<p class="error">${esc(e.message)}</p>`;
    }
  };
  view.querySelectorAll("[data-disable]").forEach((btn) =>
    btn.addEventListener("click", userAction(btn.dataset.disable, "disable", "Disable this user? They will lose access immediately.")));
  view.querySelectorAll("[data-enable]").forEach((btn) =>
    btn.addEventListener("click", userAction(btn.dataset.enable, "enable", "Re-enable this user? Their tenant is unchanged; they will need to sign in again.")));

  document.getElementById("new-user-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = document.getElementById("nu-error");
    err.hidden = true;
    const name = document.getElementById("nu-name").value.trim();
    const email = document.getElementById("nu-email").value.trim();
    const password = document.getElementById("nu-pass").value;
    try {
      const body = password ? { name, email, password } : { name, email };
      const res = await api(`/tenants/${id}/users`, { method: "POST", body: JSON.stringify(body) });
      if (res.temporaryPassword) {
        alert(`User created.\n\nTemporary password for ${email}:\n${res.temporaryPassword}\n\nShare it securely — it is shown only once.`);
      }
      render();
    } catch (e2) {
      err.textContent = e2.message;
      err.hidden = false;
    }
  });
}

async function statusAction(id, action) {
  try {
    await api(`/tenants/${id}/${action}`, { method: "POST" });
    render();
  } catch (e) {
    view.querySelector(".section-actions").insertAdjacentHTML("afterend", `<p class="error">${esc(e.message)}</p>`);
  }
}

async function auditView() {
  const { auditLogs } = await api("/audit-logs?limit=200");
  view.innerHTML = `
    <div class="view-head"><div><h1>Audit log</h1><p class="lede">${auditLogs.length} most recent administrative actions.</p></div></div>
    <table>
      <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Tenant</th><th>Target</th></tr></thead>
      <tbody>
        ${auditLogs.map((e) => `
          <tr>
            <td>${esc(fmtDate(e.createdAt))}</td>
            <td><span class="mono">${esc(e.actor?.email || "—")}</span></td>
            <td>${esc(e.action)}</td>
            <td>${esc(e.tenant?.name || "—")}</td>
            <td><span class="mono">${esc(e.targetUser?.email || "—")}</span></td>
          </tr>`).join("") || `<tr><td colspan="5" class="muted">No admin actions recorded yet.</td></tr>`}
      </tbody>
    </table>`;
}

/* ---------------- Boot ---------------- */
if (token) loadWho();
render();
