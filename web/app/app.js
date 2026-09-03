"use strict";

/* Invoice Creator — customer application (vanilla JS SPA).
   Talks to /api/* with a bearer token. Holds no privileges of its own — the
   server enforces authentication, tenant RLS and tenant-admin checks on every
   call. UI hiding of admin controls is convenience only, not a security boundary.

   Routing uses real paths under /app (History API), e.g. /app/invoices/<id>.
   The server serves this shell for any /app/* path so deep links work. */

const BASE = "/app";
const LOGIN_URL = "/app/login";
const TOKEN_KEY = "ic_app_token";

const app = document.getElementById("app");
const view = document.getElementById("view");
const sidebar = document.getElementById("sidebar");

let me = null; // { user: { id, email, name, role, tenantId, tenantRole } }

/* ---------------- token ---------------- */

// Private-mode fallback: login.js may hand the token over in the URL fragment.
let memoryToken = null;
(function adoptFragmentToken() {
  const m = /(?:^|#|&)t=([^&]+)/.exec(location.hash || "");
  if (!m) return;
  memoryToken = decodeURIComponent(m[1]);
  try { localStorage.setItem(TOKEN_KEY, memoryToken); } catch { /* stays in memory */ }
  history.replaceState({}, "", location.pathname + location.search);
})();

function readToken() {
  try {
    const v = localStorage.getItem(TOKEN_KEY);
    if (v) return v;
  } catch { /* private mode */ }
  return memoryToken;
}
function setToken(next) {
  memoryToken = next;
  try {
    if (next) localStorage.setItem(TOKEN_KEY, next);
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* private mode — memory only */ }
}
function toLogin() {
  const next = encodeURIComponent(location.pathname + location.search);
  location.replace(`${LOGIN_URL}?next=${next}`);
}

let token = readToken();

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
    toLogin();
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
const query = () => new URLSearchParams(location.search);
const isAdmin = () => me?.user?.tenantRole === "admin";

/* ---------------- navigation ---------------- */

/** Path within the app, e.g. "/invoices/<id>" (no /app prefix, no query). */
function currentPath() {
  let p = location.pathname;
  if (p.startsWith(BASE)) p = p.slice(BASE.length);
  return p || "/";
}

/** Go to an in-app location. Accepts "/invoices" or "/app/invoices" (+ ?query). */
function navigate(to, { replace = false } = {}) {
  const url = to.startsWith(BASE) ? to : BASE + to;
  history[replace ? "replaceState" : "pushState"]({}, "", url);
  render();
}

// Intercept clicks on in-app links so they route without a full reload.
document.addEventListener("click", (e) => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = e.target.closest("a");
  if (!a) return;
  const href = a.getAttribute("href");
  if (!href || a.target === "_blank" || a.hasAttribute("download")) return;
  // Route only the customer app's own paths; let /admin, mailto:, etc. through.
  if (href !== BASE && !href.startsWith(BASE + "/")) return;
  e.preventDefault();
  navigate(href);
});

window.addEventListener("popstate", render);

document.getElementById("signout").addEventListener("click", async () => {
  try { await api("/auth/logout", { method: "POST" }); } catch { /* best effort */ }
  setToken(null);
  me = null;
  location.assign(LOGIN_URL);
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

/* ---------------- account menu ---------------- */

function initials(name, email) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return String(email || "?").slice(0, 2).toUpperCase();
}

function fillAccount() {
  const u = me.user;
  document.getElementById("avatar").textContent = initials(u.name, u.email);
  document.getElementById("acct-name").textContent = u.name || "—";
  document.getElementById("acct-email").textContent = u.email;
  document.getElementById("acct-role").textContent = isAdmin() ? "Tenant admin" : "Member";
}

const accountBtn = document.getElementById("account-btn");
const accountMenu = document.getElementById("account-menu");
function setAccountMenu(open) {
  accountMenu.hidden = !open;
  accountBtn.setAttribute("aria-expanded", String(open));
}
accountBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  setAccountMenu(accountMenu.hidden);
});
document.addEventListener("click", (e) => {
  if (!accountMenu.hidden && !accountMenu.contains(e.target) && e.target !== accountBtn) setAccountMenu(false);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { setAccountMenu(false); setSupportPanel(false); }
});

/* ---------------- support widget ---------------- */

const supportBtn = document.getElementById("support-btn");
const supportPanel = document.getElementById("support-panel");
const supportBadge = document.getElementById("support-badge");
let supportState = { started: false, open: false, ticketId: null, summaryTimer: null, threadTimer: null };

function startSupport() {
  supportBtn.hidden = false;
  if (supportState.started) return;
  supportState.started = true;
  supportBtn.addEventListener("click", () => setSupportPanel(supportPanel.hidden));
  refreshSupportSummary();
  supportState.summaryTimer = setInterval(refreshSupportSummary, 20000);
}

async function refreshSupportSummary() {
  try {
    const s = await api("/support/summary");
    if (s.unreadCount > 0) {
      supportBadge.textContent = s.unreadCount > 9 ? "9+" : String(s.unreadCount);
      supportBadge.hidden = false;
    } else {
      supportBadge.hidden = true;
    }
  } catch { /* ignore transient */ }
}

function setSupportPanel(open) {
  supportPanel.hidden = !open;
  supportState.open = open;
  supportBtn.setAttribute("aria-expanded", String(open));
  clearInterval(supportState.threadTimer);
  if (open) {
    renderSupportPanel();
  }
}

async function renderSupportPanel() {
  supportPanel.innerHTML = `<div class="support-head"><strong>Support</strong>
    <button type="button" class="link" id="sp-close">Close</button></div>
    <div class="support-body"><p class="loading">Loading…</p></div>`;
  supportPanel.querySelector("#sp-close").addEventListener("click", () => setSupportPanel(false));
  const bodyEl = supportPanel.querySelector(".support-body");

  let tickets = [];
  try {
    tickets = (await api("/support/tickets")).tickets;
  } catch (e) {
    bodyEl.innerHTML = `<p class="error">${esc(e.message)}</p>`;
    return;
  }
  const openTicket = tickets.find((t) => t.status === "open");
  supportState.ticketId = openTicket ? openTicket.id : null;

  if (!openTicket) {
    bodyEl.innerHTML = `
      <p class="muted">Start a conversation with our team.</p>
      <form id="sp-new">
        <label for="sp-subject">Subject</label>
        <input id="sp-subject" maxlength="200" required placeholder="What do you need help with?">
        <label for="sp-message">Message</label>
        <textarea id="sp-message" maxlength="4000" required rows="3"></textarea>
        <p class="error" id="sp-err" hidden></p>
        <button type="submit">Send</button>
      </form>
      ${tickets.length ? `<p class="muted" style="margin-top:14px">Past conversations</p>
        <ul class="support-list">${tickets.filter((t) => t.status === "closed").slice(0, 5).map((t) =>
          `<li><button type="button" class="link" data-ticket="${esc(t.id)}">${esc(t.subject)} · closed</button></li>`).join("")}</ul>` : ""}`;
    bodyEl.querySelector("#sp-new").addEventListener("submit", async (e) => {
      e.preventDefault();
      const err = bodyEl.querySelector("#sp-err");
      err.hidden = true;
      try {
        const { ticket } = await api("/support/tickets", {
          method: "POST",
          body: JSON.stringify({
            subject: bodyEl.querySelector("#sp-subject").value.trim(),
            message: bodyEl.querySelector("#sp-message").value.trim(),
          }),
        });
        supportState.ticketId = ticket.id;
        openThread(ticket.id);
      } catch (e2) { err.textContent = e2.message; err.hidden = false; }
    });
    bodyEl.querySelectorAll("[data-ticket]").forEach((b) =>
      b.addEventListener("click", () => openThread(b.dataset.ticket, true)));
    return;
  }

  openThread(openTicket.id);
}

async function openThread(ticketId, readOnly = false) {
  supportState.ticketId = ticketId;
  const bodyEl = supportPanel.querySelector(".support-body");
  const paint = async () => {
    let data;
    try { data = await api(`/support/tickets/${ticketId}`); }
    catch (e) { bodyEl.innerHTML = `<p class="error">${esc(e.message)}</p>`; return; }
    const closed = data.ticket.status === "closed";
    bodyEl.innerHTML = `
      <p class="support-subject">${esc(data.ticket.subject)}${closed ? ' <span class="pill">closed</span>' : ""}</p>
      <div class="support-thread" id="sp-thread">
        ${data.messages.map((m) => `
          <div class="msg ${m.authorKind === "admin" ? "them" : "me"}">
            <div class="msg-body">${esc(m.body).replace(/\n/g, "<br>")}</div>
            <div class="msg-meta">${m.authorKind === "admin" ? "Support" : "You"} · ${fmtDateTime(m.createdAt)}</div>
          </div>`).join("")}
      </div>
      ${closed || readOnly
        ? `<p class="muted">${closed ? "This conversation is closed." : ""} <button type="button" class="link" id="sp-back">← Back</button></p>`
        : `<form id="sp-reply"><textarea id="sp-rbody" rows="2" maxlength="4000" placeholder="Type a message…" required></textarea>
           <button type="submit">Send</button></form>`}`;
    const thread = bodyEl.querySelector("#sp-thread");
    if (thread) thread.scrollTop = thread.scrollHeight;
    const back = bodyEl.querySelector("#sp-back");
    if (back) back.addEventListener("click", () => renderSupportPanel());
    const form = bodyEl.querySelector("#sp-reply");
    if (form) form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const ta = bodyEl.querySelector("#sp-rbody");
      const val = ta.value.trim();
      if (!val) return;
      ta.disabled = true;
      try {
        await api(`/support/tickets/${ticketId}/messages`, { method: "POST", body: JSON.stringify({ body: val }) });
        await paint();
      } catch (e2) {
        ta.disabled = false;
        bodyEl.insertAdjacentHTML("beforeend", `<p class="error">${esc(e2.message)}</p>`);
      }
    });
  };
  await paint();
  clearInterval(supportState.threadTimer);
  if (!readOnly) supportState.threadTimer = setInterval(() => { if (supportState.open) paint(); }, 6000);
  refreshSupportSummary();
}

/* ---------------- router ---------------- */

const routes = [
  { re: /^\/dashboard$/, view: viewDashboard, nav: "dashboard" },
  { re: /^\/invoices$/, view: viewInvoices, nav: "invoices" },
  { re: /^\/invoices\/new$/, view: viewInvoiceNew, nav: "invoices" },
  { re: /^\/invoices\/([0-9a-f-]{36})$/, view: viewInvoiceDetail, nav: "invoices" },
  { re: /^\/customers$/, view: viewCustomers, nav: "customers" },
  { re: /^\/customers\/new$/, view: viewCustomerForm, nav: "customers" },
  { re: /^\/customers\/([0-9a-f-]{36})$/, view: viewCustomerDetail, nav: "customers" },
  { re: /^\/customers\/([0-9a-f-]{36})\/edit$/, view: viewCustomerForm, nav: "customers" },
  { re: /^\/billing$/, view: viewBilling, nav: "billing" },
  { re: /^\/settings\/business$/, view: viewSettingsBusiness, nav: "settings" },
  { re: /^\/settings\/payments$/, view: viewSettingsPayments, nav: "settings" },
  { re: /^\/settings\/integrations$/, view: viewSettingsIntegrations, nav: "settings" },
  { re: /^\/settings\/team$/, view: viewSettingsTeam, nav: "settings" },
];

async function render() {
  token = readToken();
  if (!token) return toLogin();

  if (!me) {
    try {
      me = await api("/auth/me");
    } catch {
      setToken(null);
      return toLogin();
    }
  }

  if (me.user.role !== "user") {
    app.hidden = false;
    view.innerHTML = `<div class="firstrun"><h2>Wrong application</h2>
      <p>This is the customer application. Platform administrators use the Admin Control Centre.</p>
      <a class="btn ghost" href="/admin/">Go to the Admin Control Centre</a></div>`;
    return;
  }

  app.hidden = false;
  fillAccount();
  startSupport();

  const path = currentPath();
  if (path === "/" || path === "") return navigate("/dashboard", { replace: true });
  if (path === "/settings") return navigate("/settings/business", { replace: true });
  if (path === "/login") return navigate("/dashboard", { replace: true });

  const match = routes.map((r) => [r, r.re.exec(path)]).find(([, m]) => m);
  if (!match) {
    document.querySelectorAll("[data-nav]").forEach((a) => a.classList.remove("active"));
    view.innerHTML = `<div class="firstrun"><h2>Page not found</h2>
      <p>That address doesn’t match anything in the app.</p>
      <a class="btn" href="/app/dashboard">Go to dashboard</a></div>`;
    return;
  }
  const [route, m] = match;

  document.querySelectorAll("[data-nav]").forEach((a) =>
    a.classList.toggle("active", a.dataset.nav === route.nav));

  view.innerHTML = `<p class="loading">Loading…</p>`;
  try {
    await route.view(m);
  } catch (err) {
    const btn = `<button class="ghost" id="err-reload">Reload</button>`;
    view.innerHTML = `<div class="view-head"><h1>Something went wrong</h1></div>
      <p class="error">${esc(err.message || "Unexpected error.")}</p>${btn}`;
    const r = document.getElementById("err-reload");
    if (r) r.addEventListener("click", () => location.reload());
  }
}

/* ---------------- Dashboard ---------------- */

async function viewDashboard() {
  const [d, billing] = await Promise.all([
    api("/dashboard"),
    api("/billing").catch(() => null),
  ]);
  const subBanner = subscriptionDuePanel(billing);

  if (d.totals.invoices === 0) {
    view.innerHTML = `
      <div class="view-head"><div><h1>Dashboard</h1></div></div>
      ${subBanner}
      <div class="firstrun">
        <h2>Create your first invoice</h2>
        <p>Add a customer, enter the details, and send a professional invoice.</p>
        <a class="btn" href="/app/invoices/new">Create invoice</a>
      </div>
      ${fireNudge(d)}`;
    return;
  }

  view.innerHTML = `
    <div class="view-head">
      <div><h1>Dashboard</h1><p class="lede">What needs your attention.</p></div>
      <a class="btn" href="/app/invoices/new">Create invoice</a>
    </div>

    ${subBanner}
    ${fireNudge(d)}

    <div class="summary">
      <a class="cell${d.outstanding.count ? " attn" : ""}" href="/app/invoices?filter=unpaid">
        <div class="n">${fmtMoney(d.outstanding.totalCents, "EUR")} <span class="sub">· ${d.outstanding.count}</span></div>
        <div class="k">Outstanding</div>
      </a>
      <a class="cell${d.overdue.count ? " attn" : ""}" href="/app/invoices?filter=unpaid">
        <div class="n">${d.overdue.count}</div>
        <div class="k">Overdue</div>
      </a>
      <a class="cell" href="/app/invoices?filter=pending">
        <div class="n">${d.pending.count}</div>
        <div class="k">Pending payment</div>
      </a>
      <a class="cell" href="/app/invoices?filter=paid">
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

/** Dashboard "pay your subscription" panel — shows the pay-by-bank QR inline. */
function subscriptionDuePanel(billing) {
  if (!billing || !(billing.amountDueCents > 0)) return "";
  const ccy = billing.subscription ? billing.subscription.currency : "EUR";
  const due = (billing.invoices || []).filter(
    (i) => i.status === "issued" || i.status === "payment_pending",
  );
  const payable = due.find((i) => i.hostedPaymentUrl && i.paymentQrSvg);
  const heading = `${fmtMoney(billing.amountDueCents, ccy)} due for your subscription${
    billing.hasOverdue ? " — overdue" : ""
  }`;

  return `<div class="notice sub-due${billing.hasOverdue ? " danger" : ""}">
    <strong>${heading}.</strong>
    ${payable
      ? `<div class="pay-box">
          <img class="pay-qr" alt="Payment QR code" src="${esc(payable.paymentQrSvg)}">
          <div class="pay-actions">
            <p class="muted">Scan with your banking app to pay ${esc(payable.number)}, or</p>
            <a class="btn" href="${esc(payable.hostedPaymentUrl)}" target="_blank" rel="noopener">Open secure payment page</a>
            <p class="muted" style="margin-top:8px">Payment is confirmed automatically once your bank completes it.
              &nbsp;<a href="/app/billing">All billing →</a></p>
          </div>
        </div>`
      : `<p style="margin-top:6px"><a href="/app/billing">Go to Billing to pay by bank →</a></p>`}
  </div>`;
}

function fireNudge(d) {
  if (!d.paymentIntegration || d.paymentIntegration.status === "connected") return "";
  if (!d.paymentIntegration.manageable) return "";
  return `<div class="notice">
    <strong>Payments are not set up.</strong> Connecting Fire.com Open Banking lets your
    invoices carry a pay-by-bank QR code. <a href="/app/settings/payments">Set up payments →</a>
  </div>`;
}

function invoiceMiniTable(rows, emptyMsg) {
  if (!rows.length) return `<p class="muted">${esc(emptyMsg)}</p>`;
  return `<div class="table-scroll"><table>
    <thead><tr><th>Number</th><th>Customer</th><th>Date</th><th class="num">Amount</th><th>Payment</th></tr></thead>
    <tbody>
      ${rows.map((i) => `
        <tr class="clickable" data-href="/app/invoices/${esc(i.id)}">
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
  const q = query();
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
      <a class="btn" href="/app/invoices/new">Create invoice</a>
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
          <tr class="clickable" data-href="/app/invoices/${esc(i.id)}">
            <td class="mono">${esc(i.number)}</td>
            <td>${esc(i.customerName)}</td>
            <td>${esc(fmtDay(i.issuedOn))}</td>
            <td>${esc(fmtDay(i.dueOn))}</td>
            <td class="num">${fmtMoney(i.totalCents, i.currency)}</td>
            <td>${invoiceStatusLabel(i)}</td>
            <td>${paymentStatusLabel(i)}</td>
            <td class="num"><span class="rowactions"><a class="mono" href="/app/invoices/${esc(i.id)}">View</a></span></td>
          </tr>`).join("")}
      </tbody></table></div>`
      : emptyState(
          filter === "all" ? "No invoices yet" : `No ${esc(filter)} invoices`,
          filter === "all" ? "Create your first invoice to get started." : "Try a different filter.",
          filter === "all" ? { href: "/app/invoices/new", label: "Create invoice" } : null,
        )}`;

  view.querySelectorAll("[data-filter]").forEach((b) =>
    b.addEventListener("click", () => {
      navigate(`/invoices${qs({ filter: b.dataset.filter === "all" ? "" : b.dataset.filter, search })}`);
    }));
  const s = document.getElementById("inv-search");
  s.addEventListener("change", () => {
    navigate(`/invoices${qs({ filter: filter === "all" ? "" : filter, search: s.value.trim() })}`);
  });
  wireRowLinks();
}

async function viewInvoiceNew() {
  const customerId = query().get("customer");
  let customerName = "";
  if (customerId) {
    try { customerName = (await api(`/customers/${customerId}`)).customer.name; } catch { /* ignore */ }
  }
  view.innerHTML = `
    <a class="back" href="/app/invoices">← Invoices</a>
    <div class="view-head"><div><h1>New invoice</h1></div></div>
    <div class="firstrun" style="margin:20px 0">
      <h2>The invoice builder is coming next</h2>
      <p>The full invoice creation workflow — customer, line items, totals, tax and the
      Fire.com payment QR — arrives in the next stage.${customerName ? ` This invoice will be for <strong>${esc(customerName)}</strong>.` : ""}</p>
      <a class="btn ghost" href="/app/invoices">Back to invoices</a>
    </div>`;
}

async function viewInvoiceDetail(m) {
  const { invoice } = await api(`/invoices/${m[1]}`);
  view.innerHTML = `
    <a class="back" href="/app/invoices">← Invoices</a>
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
  const search = query().get("search") || "";
  const { customers } = await api(`/customers${qs({ search })}`);

  view.innerHTML = `
    <div class="view-head">
      <div><h1>Customers</h1><p class="lede">${customers.length} ${customers.length === 1 ? "customer" : "customers"}</p></div>
      <a class="btn" href="/app/customers/new">Add customer</a>
    </div>
    <div class="toolbar">
      <input type="search" id="cust-search" placeholder="Search name or email" value="${esc(search)}">
    </div>
    ${customers.length ? `<div class="table-scroll"><table>
      <thead><tr><th>Name</th><th>Email</th><th>Location</th><th class="num">Invoices</th><th></th></tr></thead>
      <tbody>
        ${customers.map((c) => `
          <tr class="clickable" data-href="/app/customers/${esc(c.id)}">
            <td>${esc(c.name)} ${c.archived ? `<span class="pill archived">archived</span>` : ""}</td>
            <td>${esc(c.email || "—")}</td>
            <td>${esc([c.address.city, c.address.country].filter(Boolean).join(", ") || "—")}</td>
            <td class="num">${c.invoiceCount}</td>
            <td class="num"><span class="rowactions"><a class="mono" href="/app/customers/${esc(c.id)}">Open</a></span></td>
          </tr>`).join("")}
      </tbody></table></div>`
      : emptyState(
          search ? "No customers match" : "No customers yet",
          search ? "Try a different search." : "Add a customer before creating an invoice.",
          search ? null : { href: "/app/customers/new", label: "Add customer" },
        )}`;

  const s = document.getElementById("cust-search");
  s.addEventListener("change", () => { navigate(`/customers${qs({ search: s.value.trim() })}`); });
  wireRowLinks();
}

async function viewCustomerForm(m) {
  const id = m[1];
  const editing = Boolean(id);
  let c = null;
  if (editing) c = (await api(`/customers/${id}`)).customer;

  const backHref = editing ? `/app/customers/${id}` : "/app/customers";
  const val = (k) => esc((editing ? deep(c, k) : "") ?? "");
  view.innerHTML = `
    <a class="back" href="${backHref}">← Back</a>
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
        <a class="btn ghost" href="${backHref}">Cancel</a>
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
        navigate(`/customers/${id}`);
      } else {
        const { customer } = await api("/customers", { method: "POST", body: JSON.stringify(payload) });
        navigate(`/customers/${customer.id}`);
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
    <a class="back" href="/app/customers">← Customers</a>
    <div class="view-head">
      <div><h1>${esc(customer.name)}</h1>
        ${customer.archived ? `<p class="lede"><span class="pill archived">Archived</span></p>` : ""}</div>
      <div class="section-actions" style="margin-top:0">
        <a class="btn" href="/app/invoices/new?customer=${esc(id)}">Create invoice</a>
        <a class="btn ghost" href="/app/customers/${esc(id)}/edit">Edit</a>
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

/* ---------------- Billing (our subscription) ---------------- */

const PLATFORM_INVOICE_STATUS = {
  draft: "Draft",
  issued: "Awaiting payment",
  payment_pending: "Awaiting payment",
  paid: "Paid",
  cancelled: "Cancelled",
};

function platformStatusLabel(i) {
  if (i.status === "paid") return `<span class="status paid">PAID</span>`;
  if (i.status === "cancelled") return `<span class="status">CANCELLED</span>`;
  if (i.overdue) return `<span class="status overdue">OVERDUE</span>`;
  if (i.status === "issued" || i.status === "payment_pending") return `<span class="status unpaid">DUE</span>`;
  return `<span class="status">${esc(PLATFORM_INVOICE_STATUS[i.status] || i.status)}</span>`;
}

async function viewBilling() {
  const b = await api("/billing");
  const s = b.subscription;
  const due = b.invoices.filter((i) => i.status === "issued" || i.status === "payment_pending");
  const history = b.invoices.filter((i) => i.status === "paid" || i.status === "cancelled");

  view.innerHTML = `
    <div class="view-head">
      <div><h1>Billing</h1><p class="lede">Your ${esc(b.businessName || "subscription")} plan and invoices.</p></div>
    </div>

    ${s ? `<div class="card">
      <dl class="dl">
        <dt>Plan</dt><dd>${esc(s.plan.name)}${s.plan.isTest ? ' <span class="pill">test</span>' : ""}</dd>
        <dt>Price</dt><dd>${fmtMoney(s.amountCents, s.currency)} / ${esc(s.billingInterval)}</dd>
        <dt>Current period</dt><dd>${esc(fmtDay(s.currentPeriodStart))} – ${esc(fmtDay(s.currentPeriodEnd))}</dd>
        <dt>Renews</dt><dd>${esc(fmtDay(s.renewalDate))}${s.cancelAtPeriodEnd ? " (cancels at period end)" : ""}</dd>
        <dt>Status</dt><dd><span class="status ${s.status === "active" ? "paid" : ""}">${esc(s.status.toUpperCase())}</span></dd>
      </dl>
    </div>` : `<div class="notice">No subscription is set up for your account yet. Your provider will assign a plan.</div>`}

    ${b.amountDueCents > 0 ? `<div class="notice${b.hasOverdue ? " danger" : ""}" style="margin-top:20px">
      <strong>${fmtMoney(b.amountDueCents, s ? s.currency : "EUR")} due${b.hasOverdue ? " — overdue" : ""}.</strong>
      Pay by bank below to keep your account active.
    </div>` : ""}

    <div class="block">
      <h3>Amounts due</h3>
      ${due.length ? due.map(platformInvoiceCard).join("") : `<p class="muted">Nothing due. You're all paid up.</p>`}
    </div>

    <div class="block">
      <h3>Payment history</h3>
      ${history.length ? `<div class="table-scroll"><table>
        <thead><tr><th>Invoice</th><th>Description</th><th>Issued</th><th class="num">Amount</th><th>Status</th></tr></thead>
        <tbody>
          ${history.map((i) => `<tr>
            <td class="mono">${esc(i.number)}</td>
            <td>${esc(i.description)}</td>
            <td>${esc(fmtDay(i.issueDate))}</td>
            <td class="num">${fmtMoney(i.amountCents, i.currency)}</td>
            <td>${platformStatusLabel(i)}</td>
          </tr>`).join("")}
        </tbody></table></div>` : `<p class="muted">No past invoices yet.</p>`}
    </div>`;

  view.querySelectorAll("[data-pay]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const id = btn.dataset.pay;
      const slot = document.getElementById(`pay-slot-${id}`);
      btn.disabled = true;
      btn.textContent = "Preparing…";
      try {
        const r = await api(`/billing/invoices/${id}/payment-link`, { method: "POST" });
        slot.innerHTML = paymentBox(r.hostedUrl, r.paymentQrSvg);
      } catch (e) {
        btn.disabled = false;
        btn.textContent = "Pay by bank";
        slot.innerHTML = `<p class="error">${esc(e.message)}</p>`;
      }
    }));
}

function platformInvoiceCard(i) {
  return `<div class="card" style="margin-bottom:14px">
    <dl class="dl">
      <dt>Invoice</dt><dd class="mono">${esc(i.number)}</dd>
      <dt>Description</dt><dd>${esc(i.description)}</dd>
      <dt>Amount</dt><dd>${fmtMoney(i.amountCents, i.currency)}</dd>
      <dt>Due</dt><dd>${esc(fmtDay(i.dueDate))} ${platformStatusLabel(i)}</dd>
    </dl>
    <div id="pay-slot-${esc(i.id)}">
      ${i.hostedPaymentUrl && i.paymentQrSvg
        ? paymentBox(i.hostedPaymentUrl, i.paymentQrSvg)
        : `<button data-pay="${esc(i.id)}">Pay by bank</button>`}
    </div>
  </div>`;
}

function paymentBox(hostedUrl, qrSvg) {
  return `<div class="pay-box">
    ${qrSvg ? `<img class="pay-qr" alt="Payment QR code" src="${esc(qrSvg)}">` : ""}
    <div class="pay-actions">
      <p class="muted">Scan with your banking app, or</p>
      <a class="btn" href="${esc(hostedUrl)}" target="_blank" rel="noopener">Open secure payment page</a>
      <p class="muted" style="margin-top:8px">Payment is confirmed automatically once your bank completes it.</p>
    </div>
  </div>`;
}

/* ---------------- Settings ---------------- */

function settingsNav(active) {
  const items = [["business", "Business", "/app/settings/business"]];
  if (isAdmin()) {
    items.push(["payments", "Payments", "/app/settings/payments"]);
    items.push(["integrations", "Integrations", "/app/settings/integrations"]);
    items.push(["team", "Team", "/app/settings/team"]);
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

const ACCOUNTING_PROVIDERS = [
  {
    key: "xero",
    name: "Xero",
    blurb: "Push finalised invoices and payments to Xero so your accounts stay in sync.",
  },
  {
    key: "quickbooks",
    name: "QuickBooks",
    blurb: "Send invoices and payments to QuickBooks Online automatically.",
  },
];

async function viewSettingsIntegrations() {
  if (!isAdmin()) { renderNoAccess("Integrations"); return; }
  view.innerHTML = `
    <div class="view-head"><div><h1>Settings</h1></div></div>
    ${settingsNav("integrations")}
    <p class="lede">Connect your accounting software. These are placeholders — the
    connection flow is being designed.</p>
    ${ACCOUNTING_PROVIDERS.map((p) => `
      <div class="card">
        <dl class="dl">
          <dt>Provider</dt><dd>${esc(p.name)}</dd>
          <dt>Status</dt><dd><span class="status">Not connected</span></dd>
        </dl>
        <p class="muted" style="margin-top:16px">${esc(p.blurb)}</p>
        <div class="section-actions">
          <button class="disabled" disabled data-provider="${esc(p.key)}"
            title="The ${esc(p.name)} connection flow is coming soon">Connect ${esc(p.name)}</button>
        </div>
      </div>`).join("")}`;
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
      navigate(tr.dataset.href);
    }));
}

function deep(obj, path) {
  return path.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
}

/* ---------------- boot ---------------- */
render();
