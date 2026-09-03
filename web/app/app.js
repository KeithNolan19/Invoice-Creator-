"use strict";

/* Invoice Creator — customer application (vanilla JS SPA).
   Talks to /api/* with a bearer token. Holds no privileges of its own — the
   server enforces authentication, tenant RLS and tenant-admin checks on every
   call. UI hiding of admin controls is convenience only, not a security boundary. */

const TOKEN_KEY = "ic_app_token";
const gate = document.getElementById("gate");
const app = document.getElementById("app");
const view = document.getElementById("view");
const sidebar = document.getElementById("sidebar");

let token = readToken();
let me = null; // { user: { id, email, name, role, tenantId, tenantRole } }

function readToken() {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}
function setToken(next) {
  token = next;
  try {
    if (next) localStorage.setItem(TOKEN_KEY, next);
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* private mode — session only */ }
}

/* ---------------- helpers ---------------- */

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const fmtDay = (s) => (s ? new Date(s).toLocaleDateString(undefined, { dateStyle: "medium" }) : "—");
const fmtDateTime = (s) => (s ? new Date(s).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—");

function fmtMoney(cents, currency) {
  const amount = (Number(cents) || 0) / 100;
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: currency || "EUR" }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency || ""}`.trim();
  }
}

const INVOICE_STATUS = { draft: "Draft", sent: "Issued", paid: "Issued", void: "Void" };
function invoiceStatusLabel(inv) {
  return `<span class="status ${esc(inv.status)}">${esc(INVOICE_STATUS[inv.status] || inv.status)}</span>`;
}
function paymentStatusLabel(inv) {
  if (inv.status === "draft" || inv.status === "void") return `<span class="status">—</span>`;
  if (inv.overdue) return `<span class="status overdue">OVERDUE</span>`;
  const map = { unpaid: "UNPAID", pending: "PENDING", paid: "PAID" };
  return `<span class="status ${esc(inv.paymentStatus)}">${esc(map[inv.paymentStatus] || inv.paymentStatus)}</span>`;
}

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function api(path, options = {}) {
  const { base = "/api", raw, ...rest } = options;
  let res;
  try {
    res = await fetch(`${base}${path}`, {
      ...rest,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...(rest.headers || {}),
      },
    });
  } catch {
    throw new ApiError(0, "Can’t reach the server. Check your connection and try again.");
  }
  if (res.status === 401) {
    setToken(null);
    me = null;
    render();
    throw new ApiError(401, "Your session has ended. Please sign in again.");
  }
  const body = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(res.status, body?.error?.message || friendlyStatus(res.status));
  }
  return raw ? res : body;
}

function friendlyStatus(status) {
  if (status === 403) return "You don’t have access to that.";
  if (status === 404) return "Not found.";
  if (status === 409) return "That conflicts with the current state.";
  if (status >= 500) return "Something went wrong. Please try again.";
  return `Request failed (${status}).`;
}

const qs = (obj) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : "";
};
const hashQuery = () => new URLSearchParams((location.hash.split("?")[1] || ""));
const isAdmin = () => me?.user?.tenantRole === "admin";

/* ---------------- login ---------------- */

document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errEl = document.getElementById("login-error");
  errEl.hidden = true;
  const submit = e.target.querySelector("button[type=submit]");
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
    if (!res.ok) throw new Error(body?.error?.message || "Sign in failed. Check your email and password.");
    if (body.user?.role !== "user") {
      throw new Error("This account is not a tenant user. Platform administrators use the Admin Control Centre.");
    }
    setToken(body.token);
    me = { user: body.user };
    location.hash = "#/";
    render();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
  } finally {
    submit.disabled = false;
  }
});

document.getElementById("signout").addEventListener("click", async () => {
  try { await api("/auth/logout", { method: "POST" }); } catch { /* best effort */ }
  setToken(null);
  me = null;
  location.hash = "#/";
  render();
});

/* mobile nav */
const navToggle = document.getElementById("nav-toggle");
navToggle.addEventListener("click", () => {
  const open = sidebar.classList.toggle("open");
  navToggle.setAttribute("aria-expanded", String(open));
});
document.getElementById("nav").addEventListener("click", (e) => {
  if (e.target.tagName === "A") {
    sidebar.classList.remove("open");
    navToggle.setAttribute("aria-expanded", "false");
  }
});

/* ---------------- router ---------------- */

const routes = [
  { re: /^#\/$/, view: viewDashboard, nav: "dashboard" },
  { re: /^#\/invoices$/, view: viewInvoices, nav: "invoices" },
  { re: /^#\/invoices\/new$/, view: viewInvoiceNew, nav: "invoices" },
  { re: /^#\/invoices\/([0-9a-f-]{36})$/, view: viewInvoiceDetail, nav: "invoices" },
  { re: /^#\/customers$/, view: viewCustomers, nav: "customers" },
  { re: /^#\/customers\/new$/, view: viewCustomerForm, nav: "customers" },
  { re: /^#\/customers\/([0-9a-f-]{36})$/, view: viewCustomerDetail, nav: "customers" },
  { re: /^#\/customers\/([0-9a-f-]{36})\/edit$/, view: viewCustomerForm, nav: "customers" },
  { re: /^#\/settings$/, view: () => { location.replace("#/settings/business"); }, nav: "settings" },
  { re: /^#\/settings\/business$/, view: viewSettingsBusiness, nav: "settings" },
  { re: /^#\/settings\/payments$/, view: viewSettingsPayments, nav: "settings" },
  { re: /^#\/settings\/team$/, view: viewSettingsTeam, nav: "settings" },
];

async function render() {
  if (!token) {
    gate.hidden = false;
    app.hidden = true;
    return;
  }
  if (!me) {
    try {
      me = await api("/auth/me");
    } catch {
      setToken(null);
      gate.hidden = false;
      app.hidden = true;
      return;
    }
  }
  if (me.user.role !== "user") {
    gate.hidden = true;
    app.hidden = false;
    view.innerHTML = `<div class="firstrun"><h2>Wrong application</h2>
      <p>This is the customer application. Platform administrators should use the Admin Control Centre.</p>
      <button class="ghost" onclick="location.href='/admin'">Go to Admin</button></div>`;
    return;
  }

  gate.hidden = true;
  app.hidden = false;
  document.getElementById("who").textContent = me.user.email;
  document.getElementById("role").textContent = isAdmin() ? "Tenant admin" : "Member";

  const path = (location.hash || "#/").split("?")[0];
  const match = routes.map((r) => [r, r.re.exec(path)]).find(([, m]) => m);
  const [route, m] = match || [routes[0], ["#/"]];

  document.querySelectorAll("[data-nav]").forEach((a) =>
    a.classList.toggle("active", a.dataset.nav === route.nav));

  view.innerHTML = `<p class="loading">Loading…</p>`;
  try {
    await route.view(m);
  } catch (err) {
    view.innerHTML = `<div class="view-head"><h1>Something went wrong</h1></div>
      <p class="error">${esc(err.message || "Unexpected error.")}</p>
      <button class="ghost" onclick="location.reload()">Reload</button>`;
  }
}

window.addEventListener("hashchange", render);

/* ---------------- Dashboard ---------------- */

async function viewDashboard() {
  const d = await api("/dashboard");

  if (d.totals.invoices === 0) {
    view.innerHTML = `
      <div class="view-head"><div><h1>Dashboard</h1></div></div>
      <div class="firstrun">
        <h2>Create your first invoice</h2>
        <p>Add a customer, enter the details, and send a professional invoice.</p>
        <a class="btn" href="#/invoices/new">Create invoice</a>
      </div>
      ${fireNudge(d)}`;
    return;
  }

  view.innerHTML = `
    <div class="view-head">
      <div><h1>Dashboard</h1><p class="lede">What needs your attention.</p></div>
      <a class="btn" href="#/invoices/new">Create invoice</a>
    </div>

    ${fireNudge(d)}

    <div class="summary">
      <a class="cell${d.outstanding.count ? " attn" : ""}" href="#/invoices?filter=unpaid">
        <div class="n">${fmtMoney(d.outstanding.totalCents, "EUR")} <span class="sub">· ${d.outstanding.count}</span></div>
        <div class="k">Outstanding</div>
      </a>
      <a class="cell${d.overdue.count ? " attn" : ""}" href="#/invoices?filter=unpaid">
        <div class="n">${d.overdue.count}</div>
        <div class="k">Overdue</div>
      </a>
      <a class="cell" href="#/invoices?filter=pending">
        <div class="n">${d.pending.count}</div>
        <div class="k">Pending payment</div>
      </a>
      <a class="cell" href="#/invoices?filter=paid">
        <div class="n">${fmtMoney(d.paidLast30Days.totalCents, "EUR")}</div>
        <div class="k">Paid · last 30 days</div>
      </a>
    </div>

    <div class="block">
      <h3>Recent invoices</h3>
      ${invoiceMiniTable(d.recentInvoices, "No invoices yet.")}
    </div>

    <div class="block">
      <h3>Recent payments</h3>
      ${d.recentPayments.length
        ? invoiceMiniTable(d.recentPayments, "")
        : `<p class="muted">No payments recorded yet.</p>`}
    </div>`;
}

function fireNudge(d) {
  if (!d.paymentIntegration || d.paymentIntegration.status === "connected") return "";
  if (!d.paymentIntegration.manageable) return "";
  return `<div class="notice">
    <strong>Payments are not set up.</strong> Connecting Fire.com Open Banking lets your
    invoices carry a pay-by-bank QR code. <a href="#/settings/payments">Set up payments →</a>
  </div>`;
}

function invoiceMiniTable(rows, emptyMsg) {
  if (!rows.length) return `<p class="muted">${esc(emptyMsg)}</p>`;
  return `<div class="table-scroll"><table>
    <thead><tr><th>Number</th><th>Customer</th><th>Date</th><th class="num">Amount</th><th>Payment</th></tr></thead>
    <tbody>
      ${rows.map((i) => `
        <tr class="clickable" data-href="#/invoices/${esc(i.id)}">
          <td class="mono">${esc(i.number)}</td>
          <td>${esc(i.customerName)}</td>
          <td>${esc(fmtDay(i.paymentStatus === "paid" ? i.paidAt : i.issuedOn))}</td>
          <td class="num">${fmtMoney(i.totalCents, i.currency)}</td>
          <td>${paymentStatusLabel(i)}</td>
        </tr>`).join("")}
    </tbody></table></div>`;
}

/* ---------------- Invoices ---------------- */

const FILTERS = [
  ["all", "All"], ["unpaid", "Unpaid"], ["pending", "Pending"], ["paid", "Paid"], ["draft", "Draft"],
];

async function viewInvoices() {
  const q = hashQuery();
  const filter = q.get("filter") || "all";
  const search = q.get("search") || "";

  const params = {};
  if (filter === "draft") params.status = "draft";
  else if (filter !== "all") params.paymentStatus = filter;
  if (search) params.search = search;

  const { invoices } = await api(`/invoices${qs(params)}`);

  view.innerHTML = `
    <div class="view-head">
      <div><h1>Invoices</h1><p class="lede">${invoices.length} shown</p></div>
      <a class="btn" href="#/invoices/new">Create invoice</a>
    </div>

    <div class="toolbar">
      <div class="tabs">
        ${FILTERS.map(([k, label]) =>
          `<button data-filter="${k}" class="${filter === k ? "active" : ""}">${label}</button>`).join("")}
      </div>
      <input type="search" id="inv-search" placeholder="Search number or customer" value="${esc(search)}">
    </div>

    ${invoices.length ? `<div class="table-scroll"><table>
      <thead><tr>
        <th>Number</th><th>Customer</th><th>Issued</th><th>Due</th>
        <th class="num">Amount</th><th>Invoice</th><th>Payment</th><th></th>
      </tr></thead>
      <tbody>
        ${invoices.map((i) => `
          <tr class="clickable" data-href="#/invoices/${esc(i.id)}">
            <td class="mono">${esc(i.number)}</td>
            <td>${esc(i.customerName)}</td>
            <td>${esc(fmtDay(i.issuedOn))}</td>
            <td>${esc(fmtDay(i.dueOn))}</td>
            <td class="num">${fmtMoney(i.totalCents, i.currency)}</td>
            <td>${invoiceStatusLabel(i)}</td>
            <td>${paymentStatusLabel(i)}</td>
            <td class="num"><span class="rowactions"><a class="mono" href="#/invoices/${esc(i.id)}">View</a></span></td>
          </tr>`).join("")}
      </tbody></table></div>`
      : emptyState(
          filter === "all" ? "No invoices yet" : `No ${esc(filter)} invoices`,
          filter === "all" ? "Create your first invoice to get started." : "Try a different filter.",
          filter === "all" ? { href: "#/invoices/new", label: "Create invoice" } : null,
        )}`;

  view.querySelectorAll("[data-filter]").forEach((b) =>
    b.addEventListener("click", () => {
      location.hash = `#/invoices${qs({ filter: b.dataset.filter === "all" ? "" : b.dataset.filter, search })}`;
    }));
  const s = document.getElementById("inv-search");
  s.addEventListener("change", () => {
    location.hash = `#/invoices${qs({ filter: filter === "all" ? "" : filter, search: s.value.trim() })}`;
  });
  wireRowLinks();
}

async function viewInvoiceNew() {
  const q = hashQuery();
  const customerId = q.get("customer");
  let customerName = "";
  if (customerId) {
    try { customerName = (await api(`/customers/${customerId}`)).customer.name; } catch { /* ignore */ }
  }
  view.innerHTML = `
    <a class="back" href="#/invoices">← Invoices</a>
    <div class="view-head"><div><h1>New invoice</h1></div></div>
    <div class="firstrun" style="margin:20px 0">
      <h2>The invoice builder is coming next</h2>
      <p>The full invoice creation workflow — customer, line items, totals, tax and the
      Fire.com payment QR — arrives in the next stage.${customerName ? ` This invoice will be for <strong>${esc(customerName)}</strong>.` : ""}</p>
      <a class="btn ghost" href="#/invoices">Back to invoices</a>
    </div>`;
}

async function viewInvoiceDetail(m) {
  const { invoice } = await api(`/invoices/${m[1]}`);
  view.innerHTML = `
    <a class="back" href="#/invoices">← Invoices</a>
    <div class="view-head">
      <div><h1>${esc(invoice.number)}</h1>
      <p class="lede">${invoiceStatusLabel(invoice)} &nbsp; ${paymentStatusLabel(invoice)}</p></div>
    </div>
    <div class="card">
      <dl class="dl">
        <dt>Customer</dt><dd>${esc(invoice.customerName)}</dd>
        <dt>Amount</dt><dd>${fmtMoney(invoice.totalCents, invoice.currency)}</dd>
        <dt>Invoice status</dt><dd>${invoiceStatusLabel(invoice)}</dd>
        <dt>Payment status</dt><dd>${paymentStatusLabel(invoice)}</dd>
        <dt>Issued</dt><dd>${esc(fmtDay(invoice.issuedOn))}</dd>
        <dt>Due</dt><dd>${esc(fmtDay(invoice.dueOn))}</dd>
        ${invoice.paymentStatus === "paid" ? `<dt>Paid</dt><dd>${esc(fmtDateTime(invoice.paidAt))}</dd>` : ""}
        <dt>Created</dt><dd>${esc(fmtDateTime(invoice.createdAt))}</dd>
      </dl>
    </div>
    <p class="muted">Line items, the downloadable PDF and the Fire.com payment QR code are part of a later stage.</p>`;
}

/* ---------------- Customers ---------------- */

async function viewCustomers() {
  const search = hashQuery().get("search") || "";
  const { customers } = await api(`/customers${qs({ search })}`);

  view.innerHTML = `
    <div class="view-head">
      <div><h1>Customers</h1><p class="lede">${customers.length} ${customers.length === 1 ? "customer" : "customers"}</p></div>
      <a class="btn" href="#/customers/new">Add customer</a>
    </div>
    <div class="toolbar">
      <input type="search" id="cust-search" placeholder="Search name or email" value="${esc(search)}">
    </div>
    ${customers.length ? `<div class="table-scroll"><table>
      <thead><tr><th>Name</th><th>Email</th><th>Location</th><th class="num">Invoices</th><th></th></tr></thead>
      <tbody>
        ${customers.map((c) => `
          <tr class="clickable" data-href="#/customers/${esc(c.id)}">
            <td>${esc(c.name)} ${c.archived ? `<span class="pill archived">archived</span>` : ""}</td>
            <td>${esc(c.email || "—")}</td>
            <td>${esc([c.address.city, c.address.country].filter(Boolean).join(", ") || "—")}</td>
            <td class="num">${c.invoiceCount}</td>
            <td class="num"><span class="rowactions"><a class="mono" href="#/customers/${esc(c.id)}">Open</a></span></td>
          </tr>`).join("")}
      </tbody></table></div>`
      : emptyState(
          search ? "No customers match" : "No customers yet",
          search ? "Try a different search." : "Add a customer before creating an invoice.",
          search ? null : { href: "#/customers/new", label: "Add customer" },
        )}`;

  const s = document.getElementById("cust-search");
  s.addEventListener("change", () => { location.hash = `#/customers${qs({ search: s.value.trim() })}`; });
  wireRowLinks();
}

async function viewCustomerForm(m) {
  const id = m[1];
  const editing = Boolean(id);
  let c = null;
  if (editing) c = (await api(`/customers/${id}`)).customer;

  const val = (k) => esc((editing ? deep(c, k) : "") ?? "");
  view.innerHTML = `
    <a class="back" href="${editing ? `#/customers/${id}` : "#/customers"}">← Back</a>
    <div class="view-head"><div><h1>${editing ? "Edit customer" : "New customer"}</h1></div></div>
    <form class="form-card" id="cust-form">
      <div class="field">
        <label for="c-name">Name<span aria-hidden="true"> *</span></label>
        <input id="c-name" required maxlength="200" value="${val("name")}">
      </div>
      <div class="field">
        <label for="c-email">Email</label>
        <input id="c-email" type="email" maxlength="200" value="${val("email")}">
      </div>
      <div class="form-row">
        <div class="field"><label for="c-l1">Address line 1</label><input id="c-l1" maxlength="200" value="${val("address.line1")}"></div>
        <div class="field"><label for="c-l2">Address line 2</label><input id="c-l2" maxlength="200" value="${val("address.line2")}"></div>
      </div>
      <div class="form-row">
        <div class="field"><label for="c-city">City</label><input id="c-city" maxlength="120" value="${val("address.city")}"></div>
        <div class="field"><label for="c-region">Region / county</label><input id="c-region" maxlength="120" value="${val("address.region")}"></div>
      </div>
      <div class="form-row">
        <div class="field"><label for="c-post">Postal code</label><input id="c-post" maxlength="32" value="${val("address.postalCode")}"></div>
        <div class="field"><label for="c-country">Country</label><input id="c-country" maxlength="120" value="${val("address.country")}"></div>
      </div>
      <div class="field"><label for="c-tax">Tax / VAT number</label><input id="c-tax" maxlength="64" value="${val("taxNumber")}"></div>
      <div class="field"><label for="c-notes">Notes</label><textarea id="c-notes" maxlength="2000">${val("notes")}</textarea></div>
      <p class="error" id="c-error" hidden></p>
      <div class="form-actions">
        <button type="submit" id="c-submit">${editing ? "Save changes" : "Create customer"}</button>
        <a class="btn ghost" href="${editing ? `#/customers/${id}` : "#/customers"}">Cancel</a>
      </div>
    </form>`;

  document.getElementById("cust-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = document.getElementById("c-error");
    err.hidden = true;
    const btn = document.getElementById("c-submit");
    btn.disabled = true;
    const g = (id2) => {
      const v = document.getElementById(id2).value.trim();
      return v === "" ? null : v;
    };
    const payload = {
      name: g("c-name"),
      email: g("c-email"),
      addressLine1: g("c-l1"),
      addressLine2: g("c-l2"),
      city: g("c-city"),
      region: g("c-region"),
      postalCode: g("c-post"),
      country: g("c-country"),
      taxNumber: g("c-tax"),
      notes: g("c-notes"),
    };
    try {
      if (editing) {
        await api(`/customers/${id}`, { method: "PATCH", body: JSON.stringify(payload) });
        location.hash = `#/customers/${id}`;
      } else {
        const { customer } = await api("/customers", { method: "POST", body: JSON.stringify(payload) });
        location.hash = `#/customers/${customer.id}`;
      }
    } catch (e2) {
      err.textContent = e2.message;
      err.hidden = false;
      btn.disabled = false;
    }
  });
}

async function viewCustomerDetail(m) {
  const id = m[1];
  const { customer, invoices, stats } = await api(`/customers/${id}`);
  const addr = [customer.address.line1, customer.address.line2, customer.address.city,
    customer.address.region, customer.address.postalCode, customer.address.country].filter(Boolean).join(", ");

  view.innerHTML = `
    <a class="back" href="#/customers">← Customers</a>
    <div class="view-head">
      <div><h1>${esc(customer.name)}</h1>
        ${customer.archived ? `<p class="lede"><span class="pill archived">Archived</span></p>` : ""}</div>
      <div class="section-actions" style="margin-top:0">
        <a class="btn" href="#/invoices/new?customer=${esc(id)}">Create invoice</a>
        <a class="btn ghost" href="#/customers/${esc(id)}/edit">Edit</a>
        ${customer.archived ? "" : `<button class="danger" id="c-archive">Archive</button>`}
      </div>
    </div>

    <div class="card">
      <dl class="dl">
        <dt>Email</dt><dd>${esc(customer.email || "—")}</dd>
        <dt>Address</dt><dd>${esc(addr || "—")}</dd>
        <dt>Tax / VAT number</dt><dd>${esc(customer.taxNumber || "—")}</dd>
        ${customer.notes ? `<dt>Notes</dt><dd>${esc(customer.notes)}</dd>` : ""}
        <dt>Added</dt><dd>${esc(fmtDay(customer.createdAt))}</dd>
      </dl>
    </div>

    <div class="summary" style="margin-bottom:28px">
      <div class="cell"><div class="n">${stats.invoiceCount}</div><div class="k">Invoices</div></div>
      <div class="cell"><div class="n">${fmtMoney(stats.totalCents, "EUR")}</div><div class="k">Total invoiced</div></div>
      <div class="cell"><div class="n">${fmtMoney(stats.paidCents, "EUR")}</div><div class="k">Paid</div></div>
      <div class="cell${stats.outstandingCents ? " attn" : ""}"><div class="n">${fmtMoney(stats.outstandingCents, "EUR")}</div><div class="k">Outstanding</div></div>
    </div>

    <div class="block">
      <h3>Invoices for this customer</h3>
      ${invoices.length ? invoiceMiniTable(invoices, "") : `<p class="muted">No invoices for this customer yet.</p>`}
    </div>`;

  const arch = document.getElementById("c-archive");
  if (arch) arch.addEventListener("click", async () => {
    if (!confirm(`Archive ${customer.name}? They stay on past invoices but won’t appear in the active list.`)) return;
    try {
      await api(`/customers/${id}/archive`, { method: "POST" });
      render();
    } catch (e) {
      arch.insertAdjacentHTML("afterend", `<p class="error">${esc(e.message)}</p>`);
    }
  });
  wireRowLinks();
}

/* ---------------- Settings ---------------- */

function settingsNav(active) {
  const items = [["business", "Business", "#/settings/business"]];
  if (isAdmin()) {
    items.push(["payments", "Payments", "#/settings/payments"]);
    items.push(["team", "Team", "#/settings/team"]);
  }
  return `<nav class="settings-nav">
    ${items.map(([k, label, href]) =>
      `<a href="${href}" class="${active === k ? "active" : ""}">${label}</a>`).join("")}
  </nav>`;
}

async function viewSettingsBusiness() {
  const { settings } = await api("/settings/business");
  const admin = isAdmin();
  const d = settings.invoiceDefaults;
  const dis = admin ? "" : "disabled";

  view.innerHTML = `
    <div class="view-head"><div><h1>Settings</h1></div></div>
    ${settingsNav("business")}
    ${admin ? "" : `<div class="notice">You can view your business details. Only a tenant admin can change them.</div>`}
    <form class="form-card" id="biz-form">
      <div class="field"><label for="b-name">Business name</label><input id="b-name" ${dis} maxlength="200" value="${esc(settings.businessName || "")}"></div>
      <div class="form-row">
        <div class="field"><label for="b-l1">Address line 1</label><input id="b-l1" ${dis} value="${esc(settings.address.line1 || "")}"></div>
        <div class="field"><label for="b-l2">Address line 2</label><input id="b-l2" ${dis} value="${esc(settings.address.line2 || "")}"></div>
      </div>
      <div class="form-row">
        <div class="field"><label for="b-city">City</label><input id="b-city" ${dis} value="${esc(settings.address.city || "")}"></div>
        <div class="field"><label for="b-region">Region</label><input id="b-region" ${dis} value="${esc(settings.address.region || "")}"></div>
      </div>
      <div class="form-row">
        <div class="field"><label for="b-post">Postal code</label><input id="b-post" ${dis} value="${esc(settings.address.postalCode || "")}"></div>
        <div class="field"><label for="b-country">Country</label><input id="b-country" ${dis} value="${esc(settings.address.country || "")}"></div>
      </div>
      <div class="form-row">
        <div class="field"><label for="b-email">Contact email</label><input id="b-email" type="email" ${dis} value="${esc(settings.contactEmail || "")}"></div>
        <div class="field"><label for="b-phone">Contact phone</label><input id="b-phone" ${dis} value="${esc(settings.contactPhone || "")}"></div>
      </div>
      <div class="form-row">
        <div class="field"><label for="b-tax">Tax / VAT number</label><input id="b-tax" ${dis} value="${esc(settings.taxNumber || "")}"></div>
        <div class="field"><label for="b-scheme">Tax scheme</label><input id="b-scheme" ${dis} value="${esc(settings.taxScheme || "")}"></div>
      </div>

      <h3 style="margin:22px 0 12px">Invoice defaults</h3>
      <div class="form-row">
        <div class="field"><label for="b-ccy">Default currency</label><input id="b-ccy" ${dis} maxlength="3" value="${esc(d.currency)}"></div>
        <div class="field"><label for="b-due">Default payment terms (days)</label><input id="b-due" type="number" min="0" max="365" ${dis} value="${esc(d.dueDays)}"></div>
        <div class="field"><label for="b-prefix">Invoice number prefix</label><input id="b-prefix" ${dis} maxlength="16" value="${esc(d.numberPrefix)}"></div>
      </div>
      <div class="field"><label for="b-notes">Default invoice notes</label><textarea id="b-notes" ${dis}>${esc(d.notes || "")}</textarea></div>
      <div class="field"><label for="b-terms">Default payment terms text</label><textarea id="b-terms" ${dis}>${esc(d.paymentTerms || "")}</textarea></div>

      ${admin ? `
        <p class="error" id="b-error" hidden></p>
        <p class="ok-msg" id="b-ok" hidden>Saved.</p>
        <div class="form-actions"><button type="submit" id="b-submit">Save changes</button></div>` : ""}
    </form>`;

  if (!admin) return;
  document.getElementById("biz-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = document.getElementById("b-error");
    const ok = document.getElementById("b-ok");
    err.hidden = true; ok.hidden = true;
    const btn = document.getElementById("b-submit");
    btn.disabled = true;
    const g = (id2) => { const v = document.getElementById(id2).value.trim(); return v === "" ? null : v; };
    const payload = {
      businessName: g("b-name"),
      addressLine1: g("b-l1"), addressLine2: g("b-l2"),
      city: g("b-city"), region: g("b-region"), postalCode: g("b-post"), country: g("b-country"),
      contactEmail: g("b-email"), contactPhone: g("b-phone"),
      taxNumber: g("b-tax"), taxScheme: g("b-scheme"),
      defaultCurrency: (g("b-ccy") || "EUR").toUpperCase(),
      defaultDueDays: Number(document.getElementById("b-due").value || 0),
      invoiceNumberPrefix: g("b-prefix") || "INV-",
      defaultNotes: g("b-notes"), defaultPaymentTerms: g("b-terms"),
    };
    try {
      await api("/settings/business", { method: "PUT", body: JSON.stringify(payload) });
      ok.hidden = false;
    } catch (e2) {
      err.textContent = e2.message;
      err.hidden = false;
    } finally {
      btn.disabled = false;
    }
  });
}

async function viewSettingsPayments() {
  if (!isAdmin()) { renderNoAccess("Payments"); return; }
  const data = await api("/settings/payment-integration");
  const connected = data.integration.status === "connected";
  view.innerHTML = `
    <div class="view-head"><div><h1>Settings</h1></div></div>
    ${settingsNav("payments")}
    <div class="card">
      <dl class="dl">
        <dt>Provider</dt><dd>Fire.com — Open Banking (pay by bank)</dd>
        <dt>Status</dt><dd><span class="status ${connected ? "paid" : ""}">${connected ? "Connected" : "Not connected"}</span></dd>
      </dl>
      <p class="muted" style="margin-top:16px">
        When connected, each finalised invoice will carry a Fire.com payment QR code so the
        recipient can pay directly from their banking app, and payments are confirmed
        automatically.
      </p>
    </div>
    <div class="notice">
      <strong>Coming in the integration stage.</strong> ${esc(data.note || "")}
      Your API credentials will be encrypted and stored on the server — they are never
      placed in the browser, in an invoice, or in a PDF.
    </div>
    <div class="section-actions">
      <button class="disabled" disabled title="Available in the integration stage">Connect Fire.com</button>
    </div>`;
}

async function viewSettingsTeam() {
  if (!isAdmin()) { renderNoAccess("Team"); return; }
  const { members } = await api("/team/members");

  view.innerHTML = `
    <div class="view-head"><div><h1>Settings</h1></div></div>
    ${settingsNav("team")}
    <div class="notice">
      New team members are provisioned by your platform administrator. Once they have an
      account you can change their role here.
    </div>
    <div id="team-msg"></div>
    <div class="table-scroll"><table>
      <thead><tr><th>Name</th><th>Email</th><th>Role</th><th></th></tr></thead>
      <tbody>
        ${members.map((u) => `
          <tr>
            <td>${esc(u.name)}${u.id === me.user.id ? ' <span class="muted">(you)</span>' : ""}</td>
            <td class="mono">${esc(u.email)}</td>
            <td>${u.tenantRole === "admin" ? `<span class="pill admin">Admin</span>` : `<span class="pill">Member</span>`}</td>
            <td class="num">${u.id === me.user.id ? "" : (u.tenantRole === "admin"
              ? `<button class="link" data-demote="${esc(u.id)}">Make member</button>`
              : `<button class="link" data-promote="${esc(u.id)}">Make admin</button>`)}</td>
          </tr>`).join("")}
      </tbody></table></div>`;

  const change = (id, role) => async () => {
    try {
      await api(`/team/members/${id}`, { method: "PATCH", body: JSON.stringify({ tenantRole: role }) });
      render();
    } catch (e) {
      document.getElementById("team-msg").innerHTML = `<p class="error">${esc(e.message)}</p>`;
    }
  };
  view.querySelectorAll("[data-promote]").forEach((b) => b.addEventListener("click", change(b.dataset.promote, "admin")));
  view.querySelectorAll("[data-demote]").forEach((b) => b.addEventListener("click", change(b.dataset.demote, "member")));
}

function renderNoAccess(section) {
  view.innerHTML = `
    <div class="view-head"><div><h1>Settings</h1></div></div>
    ${settingsNav("")}
    <div class="notice"><strong>${esc(section)} is for tenant admins.</strong>
    Ask a tenant admin in your organisation if you need access.</div>`;
}

/* ---------------- shared ---------------- */

function emptyState(title, body, action) {
  return `<div class="firstrun">
    <h2>${esc(title)}</h2>
    <p>${esc(body)}</p>
    ${action ? `<a class="btn" href="${esc(action.href)}">${esc(action.label)}</a>` : ""}
  </div>`;
}

function wireRowLinks() {
  view.querySelectorAll("tr[data-href]").forEach((tr) =>
    tr.addEventListener("click", (e) => {
      if (e.target.tagName === "A") return;
      location.hash = tr.dataset.href;
    }));
}

function deep(obj, path) {
  return path.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
}

/* ---------------- boot ---------------- */
render();
