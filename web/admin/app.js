"use strict";

/* Invoice Creator — Admin Control Centre (vanilla JS SPA).
   Talks to /api/admin/* with a bearer token. Holds no privileges of its own;
   the server enforces requireAdmin + RLS on every call.

   Routing is on real paths under /admin (History API): /admin/tenants,
   /admin/support/<id>, etc. The server serves this shell for any /admin/*
   path so deep links work. Sign-in is its own page at /admin/login. */

const BASE = "/admin";
const LOGIN_URL = "/admin/login";
const TOKEN_KEY = "ic_admin_token";

const app = document.getElementById("app");
const view = document.getElementById("view");

/* ---------------- token ---------------- */

let memoryToken = null;
(function adoptFragmentToken() {
  const m = /(?:^|#|&)t=([^&]+)/.exec(location.hash || "");
  if (!m) return;
  memoryToken = decodeURIComponent(m[1]);
  try { localStorage.setItem(TOKEN_KEY, memoryToken); } catch { /* memory only */ }
  history.replaceState({}, "", location.pathname + location.search);
})();

function readToken() {
  try { const v = localStorage.getItem(TOKEN_KEY); if (v) return v; } catch { /* private */ }
  return memoryToken;
}
function setToken(next) {
  memoryToken = next;
  try {
    if (next) localStorage.setItem(TOKEN_KEY, next);
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* ignore */ }
}
function toLogin() {
  const next = encodeURIComponent(location.pathname + location.search);
  location.replace(`${LOGIN_URL}?next=${next}`);
}

let token = readToken();

/* ---------------- helpers ---------------- */

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtDate = (s) => (s ? new Date(s).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—");
const fmtDay = (s) => (s ? new Date(s).toLocaleDateString(undefined, { dateStyle: "medium" }) : "—");

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

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
    toLogin();
    throw new ApiError(401, "Session expired — sign in again");
  }
  const body = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body?.error?.message || `Request failed (${res.status})`);
  return body;
}

/* ---------------- navigation ---------------- */

function currentPath() {
  let p = location.pathname;
  if (p.startsWith(BASE)) p = p.slice(BASE.length);
  return p || "/";
}
function navigate(to, { replace = false } = {}) {
  const url = to.startsWith(BASE) ? to : BASE + to;
  history[replace ? "replaceState" : "pushState"]({}, "", url);
  render();
}
document.addEventListener("click", (e) => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = e.target.closest("a");
  if (!a) return;
  const href = a.getAttribute("href");
  if (!href || a.target === "_blank" || a.hasAttribute("download")) return;
  if (href !== BASE && !href.startsWith(BASE + "/")) return;
  e.preventDefault();
  navigate(href);
});
window.addEventListener("popstate", render);

document.getElementById("signout").addEventListener("click", async () => {
  try { await api("/logout", { method: "POST", base: "/api/auth" }); } catch { /* best effort */ }
  setToken(null);
  location.assign(LOGIN_URL);
});

/* ---------------- router ---------------- */

const routes = [
  { re: /^\/dashboard$/, view: dashboardView, nav: "dashboard" },
  { re: /^\/tenants$/, view: tenantsView, nav: "tenants" },
  { re: /^\/tenants\/([0-9a-f-]{36})$/, view: tenantDetailView, nav: "tenants" },
  { re: /^\/billing$/, view: billingConfigView, nav: "billing" },
  { re: /^\/notifications$/, view: notificationsView, nav: "notifications" },
  { re: /^\/support$/, view: supportListView, nav: "support" },
  { re: /^\/support\/([0-9a-f-]{36})$/, view: supportTicketView, nav: "support" },
  { re: /^\/audit$/, view: auditView, nav: "audit" },
];

async function render() {
  clearInterval(supportPollTimer);
  clearInterval(notifPollTimer);
  token = readToken();
  if (!token) return toLogin();

  if (!verified) {
    try {
      const me = await (await fetch("/api/auth/me", { headers: { Authorization: `Bearer ${token}` } })).json();
      if (me.user?.role !== "admin") { setToken(null); return toLogin(); }
      verified = true;
      document.getElementById("who").textContent = me.user.email || "";
      refreshSupportBadge();
      refreshNotifBadge();
      if (!badgeTimer) badgeTimer = setInterval(() => { refreshSupportBadge(); refreshNotifBadge(); }, 20000);
    } catch { setToken(null); return toLogin(); }
  }

  app.hidden = false;

  const path = currentPath();
  if (path === "/" || path === "" || path === "/login") return navigate("/dashboard", { replace: true });

  const match = routes.map((r) => [r, r.re.exec(path)]).find(([, m]) => m);
  document.querySelectorAll("[data-nav]").forEach((a) =>
    a.classList.toggle("active", match && a.dataset.nav === match[0].nav));

  if (!match) {
    view.innerHTML = `<div class="view-head"><h1>Page not found</h1></div>
      <p class="muted">That address doesn’t match anything.</p>
      <a class="back" href="/admin/dashboard">← Dashboard</a>`;
    return;
  }

  view.innerHTML = `<p class="muted">Loading…</p>`;
  match[0].view(match[1]).catch((err) => {
    view.innerHTML = `<p class="error">${esc(err.message)}</p>`;
  });
}

let verified = false;
let badgeTimer = null;

/* ---------------- Views ---------------- */

async function dashboardView() {
  const [{ stats }, billing] = await Promise.all([
    api("/dashboard"),
    api("/summary", { base: "/api/admin/billing" }).catch(() => null),
  ]);
  view.innerHTML = `
    <div class="view-head"><div><h1>Dashboard</h1><p class="lede">Platform overview across all tenants.</p></div></div>
    ${billing ? `<div class="tile-group">
      <h3>Billing</h3>
      <div class="tiles">
        ${tile(billing.activeSubscriptions, "Active subs")}
        ${tile(billing.renewingWithin7Days, "Renewing ≤7d")}
        ${tile(billing.outstanding.count, "Outstanding")}
        ${tile(money(billing.outstanding.totalCents, "EUR"), "Owed")}
        ${tile(billing.paidLast30Days, "Paid · 30d")}
        ${tile(billing.suspendedUnpaid, "Suspended (unpaid)")}
      </div>
    </div>` : ""}
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
  const params = new URLSearchParams(location.search);
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
      <thead><tr><th>Name</th><th>Slug</th><th>Status</th><th>Plan</th><th>Renews</th><th>Created</th></tr></thead>
      <tbody>
        ${tenants.map((t) => `
          <tr class="clickable" data-id="${esc(t.id)}">
            <td>${esc(t.name)}</td>
            <td><span class="mono">${esc(t.slug)}</span></td>
            <td>${statusPill(t.status)}</td>
            <td>${t.subscription ? esc(t.subscription.planName) + (t.subscription.billingInterval ? ` <span class="muted">(${esc(t.subscription.billingInterval)})</span>` : "") : '<span class="muted">—</span>'}</td>
            <td>${t.subscription?.renewalDate ? esc(t.subscription.renewalDate) : '<span class="muted">—</span>'}</td>
            <td>${esc(fmtDay(t.createdAt))}</td>
          </tr>`).join("") || `<tr><td colspan="6" class="muted">No tenants match.</td></tr>`}
      </tbody>
    </table>`;

  const applyFilters = () => {
    const s = document.getElementById("t-search").value.trim();
    const st = document.getElementById("t-status").value;
    const q = new URLSearchParams();
    if (s) q.set("search", s);
    if (st) q.set("status", st);
    navigate(`/tenants${q.toString() ? `?${q}` : ""}`);
  };
  document.getElementById("t-search").addEventListener("change", applyFilters);
  document.getElementById("t-status").addEventListener("change", applyFilters);
  view.querySelectorAll("tr[data-id]").forEach((tr) =>
    tr.addEventListener("click", () => navigate(`/tenants/${tr.dataset.id}`)));
  document.getElementById("new-tenant-btn").addEventListener("click", showNewTenantForm);
}

async function showNewTenantForm() {
  const slot = document.getElementById("new-tenant-slot");
  let plans = [];
  try { plans = (await api("/plans", { base: "/api/admin/billing" })).plans.filter((p) => p.active); } catch { /* plans optional */ }

  slot.innerHTML = `
    <form class="inline-form" id="new-tenant-form">
      <h3>New tenant</h3>
      <div class="row">
        <div class="field"><label for="nt-name">Company name</label><input id="nt-name" required></div>
        <div class="field"><label for="nt-slug">Slug (optional)</label><input id="nt-slug" placeholder="auto from name" pattern="[a-z0-9-]+"></div>
      </div>
      <div class="row">
        <div class="field"><label for="nt-plan">Package</label>
          <select id="nt-plan">
            <option value="">No package yet</option>
            ${plans.map((p) => `<option value="${esc(p.id)}" data-interval="${esc(p.baseInterval)}">${esc(p.name)} · ${money(p.baseAmountCents, p.currency)}/${esc(p.baseInterval)}${p.isTest ? " · TEST" : ""}</option>`).join("")}
          </select></div>
        <div class="field"><label for="nt-interval">Billing</label>
          <select id="nt-interval"><option value="day">day</option><option value="month" selected>month</option><option value="year">year</option></select></div>
      </div>
      <p class="muted" style="font-size:12px">Picking a package starts the subscription today and generates the first invoice now.</p>
      <p class="error" id="nt-error" hidden></p>
      <div class="actions"><button type="submit">Create tenant</button><button type="button" class="ghost" id="nt-cancel">Cancel</button></div>
    </form>`;
  const g = (id) => document.getElementById(id);
  g("nt-cancel").addEventListener("click", () => { slot.innerHTML = ""; });
  g("nt-plan").addEventListener("change", () => {
    const opt = g("nt-plan").selectedOptions[0];
    if (opt && opt.dataset.interval === "day") g("nt-interval").value = "day";
  });
  g("new-tenant-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = g("nt-error");
    err.hidden = true;
    const name = g("nt-name").value.trim();
    const slug = g("nt-slug").value.trim();
    const planId = g("nt-plan").value;
    const payload = { name };
    if (slug) payload.slug = slug;
    if (planId) { payload.planId = planId; payload.billingInterval = g("nt-interval").value; }
    try {
      const { tenant, firstInvoice } = await api("/tenants", { method: "POST", body: JSON.stringify(payload) });
      if (firstInvoice) {
        alert(`Tenant created.\nFirst invoice: ${firstInvoice.number}` + (firstInvoice.hostedUrl ? `\nPay link: ${firstInvoice.hostedUrl}` : ""));
      }
      navigate(`/tenants/${tenant.id}`);
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
    <a class="back" href="/admin/tenants">← All tenants</a>
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
    </form>

    <div id="tenant-billing-slot" style="margin-top:28px"></div>`;

  renderTenantBilling(id, "tenant-billing-slot").catch((e) => {
    const el = document.getElementById("tenant-billing-slot");
    if (el) el.innerHTML = `<h2>Billing</h2><p class="error">${esc(e.message)}</p>`;
  });

  const suspendBtn = document.getElementById("suspend");
  const reactivateBtn = document.getElementById("reactivate");
  if (suspendBtn) suspendBtn.addEventListener("click", () => statusAction(id, "suspend"));
  if (reactivateBtn) reactivateBtn.addEventListener("click", () => statusAction(id, "reactivate"));

  const userAction = (uid, verb, confirmMsg) => async () => {
    if (confirmMsg && !confirm(confirmMsg)) return;
    try {
      await api(`/users/${uid}/${verb}`, { method: "POST" });
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

async function billingConfigView() {
  const { config: c } = await api("/billing/config");
  const secretField = (id, label, has, hint) => `
    <div class="field">
      <label for="${id}">${esc(label)} ${has ? '<span class="pill">configured</span>' : ""}</label>
      <input id="${id}" type="password" autocomplete="off" placeholder="${has ? "leave blank to keep current" : (hint || "")}">
    </div>`;

  view.innerHTML = `
    <div class="view-head"><div><h1>Billing configuration</h1>
      <p class="lede">Your business identity for the invoices you issue to tenants, and the platform Fire.com credentials.</p></div></div>

    <form class="inline-form" id="billing-form" style="max-width:640px">
      <h3>Your business (invoice header)</h3>
      <div class="field"><label for="b-name">Business name</label><input id="b-name" maxlength="200" value="${esc(c.businessName || "")}"></div>
      <div class="field"><label for="b-addr">Address</label><textarea id="b-addr" maxlength="2000">${esc(c.businessAddress || "")}</textarea></div>
      <div class="field"><label for="b-tax">Tax / VAT number</label><input id="b-tax" maxlength="64" value="${esc(c.businessTaxNumber || "")}"></div>
      <div class="field"><label for="b-email">Billing contact email</label><input id="b-email" type="email" maxlength="200" value="${esc(c.businessContactEmail || "")}"></div>

      <h3 style="margin-top:22px">Billing behaviour</h3>
      <div class="field"><label for="b-ccy">Default currency</label>
        <select id="b-ccy">
          <option value="EUR"${c.defaultCurrency === "EUR" ? " selected" : ""}>EUR</option>
          <option value="GBP"${c.defaultCurrency === "GBP" ? " selected" : ""}>GBP</option>
        </select></div>
      <div class="field"><label for="b-prefix">Invoice number prefix</label><input id="b-prefix" maxlength="16" value="${esc(c.invoiceNumberPrefix)}"></div>
      <div class="field"><label for="b-remind">Renewal reminder (days before)</label><input id="b-remind" type="number" min="0" max="90" value="${esc(c.renewalReminderDays)}"></div>
      <div class="field"><label for="b-grace">Overdue grace period (days)</label><input id="b-grace" type="number" min="0" max="90" value="${esc(c.overdueGraceDays)}"></div>

      <h3 style="margin-top:22px">Fire.com — platform Open Banking account</h3>
      <p class="muted">The account <strong>your tenants pay into</strong>. Credentials are encrypted at rest and never shown again. From Fire for Business → Profile → API / Webhooks.</p>
      ${secretField("f-cid", "Client ID", c.fire.hasClientId)}
      ${secretField("f-ckey", "Client Key", c.fire.hasClientKey)}
      ${secretField("f-refresh", "Refresh Token", c.fire.hasRefreshToken)}
      ${secretField("f-wh", "Webhook private token", c.fire.hasWebhookPrivate)}
      <div class="field"><label for="f-kid">Webhook public token (kid)</label><input id="f-kid" maxlength="200" value="${esc(c.fireWebhookKid || "")}"></div>
      <div class="field"><label for="f-ican">Collection account ICAN</label><input id="f-ican" type="number" value="${esc(c.fireCollectionIcan || "")}"></div>

      <p class="muted">
        Status: ${c.fire.configured ? '<span class="pill">complete</span>' : '<span class="pill">incomplete</span>'}
        ${c.fireBusinessId ? ` · Fire business ID ${esc(c.fireBusinessId)}` : ""}
        ${c.fireLastVerifiedAt ? ` · verified ${esc(fmtDate(c.fireLastVerifiedAt))}` : ""}
        ${c.fireLastError ? ` · <span class="error">last error: ${esc(c.fireLastError)}</span>` : ""}
      </p>

      <p class="error" id="billing-error" hidden></p>
      <p class="ok-msg" id="billing-ok" hidden>Saved.</p>
      <div class="actions">
        <button type="submit" id="billing-submit">Save</button>
        <button type="button" id="billing-verify" class="ghost">Verify Fire.com connection</button>
      </div>
      <p class="muted">Webhook URL to configure in the Fire portal: <span class="mono">${location.origin}/api/webhooks/fire</span></p>
    </form>`;

  const err = document.getElementById("billing-error");
  const ok = document.getElementById("billing-ok");
  const val = (id) => document.getElementById(id).value.trim();
  const secretVal = (id) => { const v = document.getElementById(id).value; return v === "" ? undefined : v; };

  document.getElementById("billing-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    err.hidden = true; ok.hidden = true;
    const btn = document.getElementById("billing-submit");
    btn.disabled = true;
    const payload = {
      businessName: val("b-name") || null,
      businessAddress: val("b-addr") || null,
      businessTaxNumber: val("b-tax") || null,
      businessContactEmail: val("b-email") || null,
      defaultCurrency: val("b-ccy"),
      invoiceNumberPrefix: val("b-prefix") || "VD-",
      renewalReminderDays: Number(val("b-remind") || 7),
      overdueGraceDays: Number(val("b-grace") || 0),
    };
    const cid = secretVal("f-cid"), ckey = secretVal("f-ckey"), refresh = secretVal("f-refresh"), wh = secretVal("f-wh");
    if (cid !== undefined) payload.fireClientId = cid;
    if (ckey !== undefined) payload.fireClientKey = ckey;
    if (refresh !== undefined) payload.fireRefreshToken = refresh;
    if (wh !== undefined) payload.fireWebhookPrivateToken = wh;
    payload.fireWebhookKid = val("f-kid") || null;
    payload.fireCollectionIcan = val("f-ican") ? Number(val("f-ican")) : null;
    try {
      await api("/billing/config", { method: "PUT", body: JSON.stringify(payload) });
      ok.hidden = false;
      setTimeout(render, 600);
    } catch (e2) {
      err.textContent = e2.message; err.hidden = false;
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById("billing-verify").addEventListener("click", async () => {
    err.hidden = true; ok.hidden = true;
    try {
      const r = await api("/billing/config/verify-fire", { method: "POST" });
      ok.textContent = `Connected — Fire business ID ${r.businessId}.`;
      ok.hidden = false;
      setTimeout(render, 900);
    } catch (e2) {
      err.textContent = e2.message; err.hidden = false;
    }
  });
}

/* ---------------- Support ---------------- */

let supportPollTimer = null;

async function refreshSupportBadge() {
  const badge = document.getElementById("support-nav-badge");
  if (!badge || !token) return;
  try {
    const s = await api("/support/summary");
    if (s.ticketsWithUnread > 0) {
      badge.textContent = s.ticketsWithUnread;
      badge.hidden = false;
    } else {
      badge.hidden = true;
    }
  } catch { /* ignore */ }
}

async function supportListView() {
  clearInterval(supportPollTimer);
  const q = new URLSearchParams(location.search);
  const status = q.get("status") || "open";
  const { tickets } = await api(`/support/tickets${status === "all" ? "" : `?status=${status}`}`);

  view.innerHTML = `
    <div class="view-head"><div><h1>Support</h1><p class="lede">${tickets.length} ${status === "all" ? "" : status} ${tickets.length === 1 ? "ticket" : "tickets"}</p></div></div>
    <div class="tabs" style="margin-bottom:16px">
      <button data-s="open" class="${status === "open" ? "active" : ""}">Open</button>
      <button data-s="closed" class="${status === "closed" ? "active" : ""}">Closed</button>
      <button data-s="all" class="${status === "all" ? "active" : ""}">All</button>
    </div>
    <table>
      <thead><tr><th>Tenant</th><th>Subject</th><th>Last message</th><th>Status</th><th></th></tr></thead>
      <tbody>
        ${tickets.map((t) => `
          <tr class="clickable" data-id="${esc(t.id)}">
            <td>${esc(t.tenantName || "—")}</td>
            <td>${t.unreadForAdmin > 0 ? '<span class="dot" title="unread"></span> ' : ""}${esc(t.subject)}
              <div class="muted" style="font-size:12px">${esc((t.lastPreview || "").slice(0, 80))}</div></td>
            <td>${esc(fmtDate(t.lastMessageAt))}</td>
            <td><span class="pill ${t.status === "open" ? "active" : ""}">${t.status}</span></td>
            <td><a class="mono" href="/admin/support/${esc(t.id)}">Open</a></td>
          </tr>`).join("") || `<tr><td colspan="5" class="muted">No ${status === "all" ? "" : status} tickets.</td></tr>`}
      </tbody>
    </table>`;

  view.querySelectorAll("[data-s]").forEach((b) =>
    b.addEventListener("click", () => navigate(`/support?status=${b.dataset.s}`)));
  view.querySelectorAll("tr[data-id]").forEach((tr) =>
    tr.addEventListener("click", (e) => { if (e.target.tagName !== "A") navigate(`/support/${tr.dataset.id}`); }));
  supportPollTimer = setInterval(() => { if (currentPath() === "/support") supportListView(); }, 15000);
  refreshSupportBadge();
}

async function supportTicketView(m) {
  clearInterval(supportPollTimer);
  const id = m[1];
  const paint = async () => {
    if (currentPath() !== `/support/${id}`) return;
    let data;
    try { data = await api(`/support/tickets/${id}`); }
    catch (e) { view.innerHTML = `<p class="error">${esc(e.message)}</p>`; return; }
    const { ticket, messages } = data;
    const closed = ticket.status === "closed";
    view.innerHTML = `
      <a class="back" href="/admin/support">← Support</a>
      <div class="view-head">
        <div><h1>${esc(ticket.subject)}</h1>
          <p class="lede">${esc(ticket.tenantName || "")} · ${esc(ticket.openedBy?.email || "—")} · <span class="pill ${closed ? "" : "active"}">${ticket.status}</span></p></div>
        <div class="section-actions" style="margin-top:0">
          ${closed
            ? `<button id="sup-reopen">Reopen</button>`
            : `<button id="sup-close" class="danger">Mark as closed</button>`}
        </div>
      </div>
      <div class="support-thread admin" id="sup-thread">
        ${messages.map((msg) => `
          <div class="msg ${msg.authorKind === "admin" ? "me" : "them"}">
            <div class="msg-body">${esc(msg.body).replace(/\n/g, "<br>")}</div>
            <div class="msg-meta">${msg.authorKind === "admin" ? "You" : esc(msg.authorEmail || "Client")} · ${esc(fmtDate(msg.createdAt))}</div>
          </div>`).join("")}
      </div>
      ${closed
        ? `<p class="muted">This ticket is closed. Reopen it to reply.</p>`
        : `<form id="sup-reply" class="inline-form" style="margin-top:14px">
             <textarea id="sup-body" rows="3" maxlength="4000" placeholder="Reply to the client…" required></textarea>
             <div class="actions"><button type="submit">Send reply</button></div>
           </form>`}`;
    const thread = document.getElementById("sup-thread");
    if (thread) thread.scrollTop = thread.scrollHeight;

    const closeBtn = document.getElementById("sup-close");
    if (closeBtn) closeBtn.addEventListener("click", async () => {
      if (!confirm("Mark this ticket as closed?")) return;
      try { await api(`/support/tickets/${id}/close`, { method: "POST" }); paint(); }
      catch (e) { alert(e.message); }
    });
    const reopenBtn = document.getElementById("sup-reopen");
    if (reopenBtn) reopenBtn.addEventListener("click", async () => {
      try { await api(`/support/tickets/${id}/reopen`, { method: "POST" }); paint(); }
      catch (e) { alert(e.message); }
    });
    const form = document.getElementById("sup-reply");
    if (form) form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const ta = document.getElementById("sup-body");
      const value = ta.value.trim();
      if (!value) return;
      ta.disabled = true;
      try { await api(`/support/tickets/${id}/messages`, { method: "POST", body: JSON.stringify({ body: value }) }); await paint(); }
      catch (e2) { ta.disabled = false; alert(e2.message); }
    });
  };
  await paint();
  supportPollTimer = setInterval(paint, 6000);
  refreshSupportBadge();
}

/* ---------------- Billing (per tenant) ---------------- */

const money = (cents, ccy) => {
  try { return new Intl.NumberFormat(undefined, { style: "currency", currency: ccy || "EUR" }).format((Number(cents) || 0) / 100); }
  catch { return `${((Number(cents) || 0) / 100).toFixed(2)} ${ccy || ""}`.trim(); }
};

async function renderTenantBilling(tenantId, slotId) {
  const slot = document.getElementById(slotId);
  if (!slot) return;
  const [detail, { plans }] = await Promise.all([
    api(`/billing/tenants/${tenantId}`, { base: "/api/admin/billing" }),
    api(`/plans`, { base: "/api/admin/billing" }),
  ]);
  const s = detail.subscription;
  const planOpts = plans.filter((p) => p.active).map((p) =>
    `<option value="${esc(p.id)}" data-interval="${esc(p.baseInterval)}">${esc(p.name)} · ${money(p.baseAmountCents, p.currency)}/${esc(p.baseInterval)}${p.isTest ? " · TEST" : ""}</option>`).join("");

  slot.innerHTML = `
    <h2>Billing</h2>
    ${detail.outgrown ? `<div class="notice"><strong>Outgrown plan.</strong> ${detail.activeUserCount} active users exceed this plan's limit.</div>` : ""}
    <div class="card">
      ${s ? `<dl class="dl">
        <dt>Plan</dt><dd>${esc(s.plan.name)} <span class="muted">(${esc(s.billingInterval)}${s.plan.isTest ? ", test" : ""})</span></dd>
        <dt>Amount</dt><dd>${money(s.amountCents, s.currency)} / ${esc(s.billingInterval)}</dd>
        <dt>Current period</dt><dd>${esc(s.currentPeriodStart)} → ${esc(s.currentPeriodEnd)}</dd>
        <dt>Renews</dt><dd>${esc(s.renewalDate)}</dd>
        <dt>Status</dt><dd><span class="pill ${s.status === "active" ? "active" : ""}">${esc(s.status)}</span></dd>
      </dl>` : `<p class="muted">No subscription.</p>`}
      <form class="inline-form" id="sub-form" style="margin-top:12px">
        <div class="row">
          <div class="field"><label for="sub-plan">${s ? "Change plan" : "Assign plan"}</label>
            <select id="sub-plan">${planOpts}</select></div>
          <div class="field"><label for="sub-interval">Interval</label>
            <select id="sub-interval"><option value="day">day</option><option value="month" selected>month</option><option value="year">year</option></select></div>
        </div>
        <p class="error" id="sub-err" hidden></p>
        <div class="actions"><button type="submit">Save subscription</button>
          ${s ? `<button type="button" class="ghost" id="sub-cancel">Cancel subscription</button>` : ""}</div>
      </form>
    </div>

    <h3 style="margin-top:20px">Platform invoices</h3>
    <table>
      <thead><tr><th>Number</th><th>Description</th><th>Due</th><th class="num">Amount</th><th>Status</th><th></th></tr></thead>
      <tbody>
        ${detail.invoices.map((i) => `
          <tr>
            <td class="mono">${esc(i.number)}</td>
            <td>${esc(i.description)}</td>
            <td>${esc(i.dueDate)}${i.overdue ? ' <span class="pill disabled">overdue</span>' : ""}</td>
            <td class="num">${money(i.amountCents, i.currency)}</td>
            <td><span class="pill ${i.status === "paid" ? "active" : ""}">${esc(i.status)}</span></td>
            <td>${invoiceActions(i)}</td>
          </tr>`).join("") || `<tr><td colspan="6" class="muted">No platform invoices.</td></tr>`}
      </tbody>
    </table>
    <div class="actions" style="margin-top:12px">
      <button type="button" class="ghost" id="inv-adhoc">Create ad-hoc invoice</button>
    </div>
    <div id="adhoc-slot"></div>`;

  const g = (id) => document.getElementById(id);
  g("sub-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = g("sub-err"); err.hidden = true;
    try {
      await api(`/billing/tenants/${tenantId}/subscription`, {
        base: "/api/admin/billing",
        method: "PUT",
        body: JSON.stringify({ planId: g("sub-plan").value, billingInterval: g("sub-interval").value }),
      });
      renderTenantBilling(tenantId, slotId);
    } catch (e2) { err.textContent = e2.message; err.hidden = false; }
  });
  const cancelBtn = g("sub-cancel");
  if (cancelBtn) cancelBtn.addEventListener("click", async () => {
    if (!confirm("Cancel this tenant's subscription?")) return;
    await api(`/billing/tenants/${tenantId}/subscription`, { base: "/api/admin/billing", method: "DELETE" });
    renderTenantBilling(tenantId, slotId);
  });

  const doAction = async (fn) => { try { await fn(); renderTenantBilling(tenantId, slotId); } catch (e) { alert(e.message); } };
  slot.querySelectorAll("[data-issue]").forEach((b) => b.addEventListener("click", () =>
    doAction(() => api(`/billing/invoices/${b.dataset.issue}/issue`, { base: "/api/admin/billing", method: "POST" }))));
  slot.querySelectorAll("[data-cancel]").forEach((b) => b.addEventListener("click", () =>
    doAction(() => api(`/billing/invoices/${b.dataset.cancel}/cancel`, { base: "/api/admin/billing", method: "POST" }))));
  slot.querySelectorAll("[data-link]").forEach((b) => b.addEventListener("click", () =>
    doAction(async () => {
      const r = await api(`/billing/invoices/${b.dataset.link}/payment-link`, { base: "/api/admin/billing", method: "POST" });
      if (r.hostedUrl) window.open(r.hostedUrl, "_blank");
    })));
  slot.querySelectorAll("[data-record]").forEach((b) => b.addEventListener("click", () => {
    const amt = prompt("Amount received in cents (external payment):");
    if (!amt) return;
    doAction(() => api(`/billing/invoices/${b.dataset.record}/record-payment`, {
      base: "/api/admin/billing", method: "POST",
      body: JSON.stringify({ amountCents: Number(amt), currency: "EUR", reference: "admin-recorded" }),
    }));
  }));

  g("inv-adhoc").addEventListener("click", () => {
    g("adhoc-slot").innerHTML = `
      <form class="inline-form" id="adhoc-form" style="margin-top:10px">
        <div class="row">
          <div class="field"><label>Description</label><input id="ah-desc" required></div>
          <div class="field"><label>Amount (cents)</label><input id="ah-amt" type="number" min="0" required></div>
          <div class="field"><label>Due date</label><input id="ah-due" type="date" required></div>
        </div>
        <div class="actions"><button type="submit">Create</button></div>
      </form>`;
    g("adhoc-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      await doAction(() => api(`/billing/tenants/${tenantId}/invoices`, {
        base: "/api/admin/billing", method: "POST",
        body: JSON.stringify({ description: g("ah-desc").value, amountCents: Number(g("ah-amt").value), currency: "EUR", dueDate: g("ah-due").value }),
      }));
    });
  });
}

function invoiceActions(i) {
  const B = (attr, id, label, cls = "link") => `<button class="${cls}" data-${attr}="${esc(id)}">${label}</button>`;
  if (i.status === "draft") return B("issue", i.id, "Issue") + " " + B("cancel", i.id, "Cancel");
  if (i.status === "issued") return B("link", i.id, "Pay link") + " " + B("record", i.id, "Record payment") + " " + B("cancel", i.id, "Cancel");
  if (i.status === "payment_pending") return B("link", i.id, "Open pay link") + " " + B("record", i.id, "Record payment");
  return "";
}

/* ---------------- Notifications ---------------- */

let notifPollTimer = null;

async function refreshNotifBadge() {
  const badge = document.getElementById("notif-nav-badge");
  if (!badge || !token) return;
  try {
    const { count } = await api("/notifications/unread-count", { base: "/api/admin" });
    if (count > 0) { badge.textContent = count > 99 ? "99+" : count; badge.hidden = false; }
    else badge.hidden = true;
  } catch { /* ignore */ }
}

async function notificationsView() {
  clearInterval(notifPollTimer);
  const q = new URLSearchParams(location.search);
  const unread = q.get("unread") === "1";
  const { notifications } = await api(`/notifications${unread ? "?unread=1" : ""}`, { base: "/api/admin" });

  view.innerHTML = `
    <div class="view-head"><div><h1>Notifications</h1><p class="lede">${notifications.length} ${unread ? "unread" : "recent"}</p></div>
      <div class="section-actions" style="margin-top:0">
        <button class="ghost" id="run-tick" title="Run the billing job now">Run billing tick</button>
        <button class="ghost" id="mark-all">Mark all read</button>
      </div></div>
    <div class="tabs" style="margin-bottom:14px">
      <button data-u="0" class="${unread ? "" : "active"}">All</button>
      <button data-u="1" class="${unread ? "active" : ""}">Unread</button>
    </div>
    <div id="tick-out"></div>
    <table>
      <thead><tr><th>When</th><th>Type</th><th>Tenant</th><th>Notification</th><th></th></tr></thead>
      <tbody>
        ${notifications.map((n) => `
          <tr class="${n.read ? "" : "clickable"}">
            <td>${esc(fmtDate(n.createdAt))}</td>
            <td><span class="pill ${n.severity === "attention" ? "disabled" : ""}">${esc(n.type)}</span></td>
            <td>${n.tenant ? `<a href="/admin/tenants/${esc(n.tenant.id)}">${esc(n.tenant.name)}</a>` : "—"}</td>
            <td>${n.read ? "" : '<span class="dot"></span> '}${esc(n.title)}${n.body ? `<div class="muted" style="font-size:12px">${esc(n.body)}</div>` : ""}</td>
            <td>${n.read ? "" : `<button class="link" data-read="${esc(n.id)}">Mark read</button>`}</td>
          </tr>`).join("") || `<tr><td colspan="5" class="muted">Nothing here.</td></tr>`}
      </tbody>
    </table>`;

  view.querySelectorAll("[data-u]").forEach((b) => b.addEventListener("click", () =>
    navigate(b.dataset.u === "1" ? "/notifications?unread=1" : "/notifications")));
  view.querySelectorAll("[data-read]").forEach((b) => b.addEventListener("click", async () => {
    await api(`/notifications/${b.dataset.read}/read`, { base: "/api/admin", method: "POST" });
    notificationsView(); refreshNotifBadge();
  }));
  document.getElementById("mark-all").addEventListener("click", async () => {
    await api("/notifications/read-all", { base: "/api/admin", method: "POST" });
    notificationsView(); refreshNotifBadge();
  });
  document.getElementById("run-tick").addEventListener("click", async () => {
    const out = document.getElementById("tick-out");
    out.innerHTML = `<p class="muted">Running…</p>`;
    try {
      const r = await api("/billing/tick", { base: "/api/admin/billing", method: "POST" });
      out.innerHTML = `<p class="ok-msg">Tick done: ${esc(JSON.stringify(r))}</p>`;
      setTimeout(() => { notificationsView(); refreshNotifBadge(); }, 400);
    } catch (e) { out.innerHTML = `<p class="error">${esc(e.message)}</p>`; }
  });

  notifPollTimer = setInterval(() => { if (currentPath() === "/notifications") { notificationsView(); } }, 20000);
  refreshNotifBadge();
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
render();
