# Platform Billing — Design Proposal

**Status: proposal. No code written yet.** This document is the inspection
findings + proposed architecture for platform→tenant subscription billing,
Open Banking payment collection, renewals, suspension, and an admin notification
centre. Nothing here is implemented until you approve it and the open decisions
in §14 are settled.

---

## 1. What you're asking for vs. what exists

Your request repeatedly says "client". There are **two distinct billing
relationships** in this product and they must not be conflated:

| | Who bills whom | Where it lives today |
| --- | --- | --- |
| **Tenant billing** (the product) | A tenant invoices *their own customers* | `invoices`, `customers`, `invoice_line_items` (built); Fire.com collection **designed but not built** |
| **Platform billing** (this project) | **You** (the platform) invoice *each tenant* for their Invoice Creator subscription | **Nothing exists** |

This proposal builds **platform billing** as its own subsystem. It does **not**
touch or reuse the tenant `invoices` table — that table is tenant-scoped, uses
tenant-controlled numbering, and represents a completely different document.

### 1.1 Inspection findings — what actually exists

| Area | Reality |
| --- | --- |
| **Tenant model** | `tenants(id, name, slug, status)`. `status` is `active \| suspended` (migration 004). RLS via `app_current_tenant()`. |
| **Auth / roles** | Platform `role` (`user` \| `admin`; admin = you, `tenant_id` NULL). Tenant `tenant_role` (`admin` \| `member`). Resolved from the DB row every request, never the token. Middleware: `requireAdmin`, `requireTenantUser`, `requireTenantAdmin`. |
| **Suspension today** | `POST /api/admin/tenants/:id/suspend` flips `tenants.status`. `ensureAccountActive()` then returns 403 `tenant_suspended` for that tenant's users. **No reason, no timestamp, no notification.** |
| **Invoice / PDF** | Tenant `invoices` table with `payment_status` (`unpaid\|pending\|paid`), `payment_provider`, `payment_reference`, `fire_payment_code`, `qr_generated_at`, snapshots — all **columns only, unused**. **No PDF generation anywhere.** `pdfkit`, `puppeteer` — not installed. |
| **Fire.com / Open Banking** | **Not implemented.** `tenant_payment_integrations` table has `*_ciphertext bytea` columns and a status enum — structure only, nothing decrypts, no API client, no webhook route. The Fire.com API contract was researched (see §9) but never coded. |
| **Encryption** | **No crypto helper exists.** The ciphertext columns have nothing to write or read them. |
| **Outlook / email** | **Nothing.** No `nodemailer`, no Graph, no SMTP config, no `mailto` anywhere. |
| **Notifications** | **None.** There is `audit_logs` (append-only, admin-only, immutable trigger) — an audit trail, not a notification centre. No read/unread, no UI. |
| **Background jobs / scheduler** | **None.** `src/server.ts` is `app.listen()` and signal handlers. No `node-cron`, no systemd timer, no job ledger. Migrations already run as an explicit deploy step. |
| **Webhooks** | **None.** No unauthenticated inbound route of any kind. |
| **Admin UI** | `web/admin/` vanilla SPA, hash-routed (`#/tenants`, `#/audit`). Nav: Dashboard, Tenants, Audit. |
| **Client UI** | `web/app/` vanilla SPA, now History-API routed (`/app/dashboard`, …). Nav locked to 4 items: Dashboard, Invoices, Customers, Settings. Settings sub-tabs: Business, Payments, Integrations, Team (last three admin-only). |
| **Deployment** | Single 512 MB droplet, Node via `tsx` (no build), systemd service, nginx+TLS, PostgreSQL localhost. `scripts/deploy.sh` (manual). |

### 1.2 What this project therefore has to build from zero

1. An **AES-256-GCM secret box** (`APP_ENCRYPTION_KEY`) — reused later by tenant integrations.
2. A **real Fire.com API client** (auth, payment requests, status, webhook verify).
3. **QR generation** (`qrcode` npm — pure JS, ~50 KB).
4. A **platform billing data model** (7 new tables).
5. An explicit **billing state machine** module.
6. A **webhook receiver** with signature verification + idempotency.
7. A **scheduled job runner** (systemd timer + idempotent CLI).
8. An **admin notification centre** (table + UI + mark-read).
9. A **`mailto:` dunning-email builder** (opens Outlook, you send).
10. Client + admin **billing UI**.

---

## 2. Proposed architecture (overview)

```
                        ┌───────────────────────────────────────────────┐
                        │                 vibedev.ie                     │
                        │                                               │
  Tenant admin ───────► │  /app/settings/billing   (see plan, pay now)  │
                        │        │                                       │
                        │        ▼  POST /api/billing/invoices/:id/pay   │
   You (platform) ────► │  /admin/billing          (all tenants)        │
                        │  /admin/notifications    (what needs you)     │
                        │        │                                       │
                        │        ▼                                       │
                        │  ┌──────────────┐   encrypted creds   ┌──────┐ │
                        │  │ billing core │◄──────────────────► │ Fire │ │
                        │  │ + state mgr  │   create pay req    │ .com │ │
                        │  └──────┬───────┘   poll status       └───┬──┘ │
                        │         │                                 │    │
   systemd timer ─────► │  billing-tick CLI (hourly, idempotent)    │    │
   (renewals, overdue,  │         │                                 │    │
    reconciliation)     │         ▼                                 │    │
                        │  PostgreSQL (RLS)                          │    │
                        │  platform_invoices / _payments / _events  │    │
                        │  admin_notifications / audit_logs         │    │
                        └───────────────────────────────────────────┼────┘
                                                                    │
                        Fire.com  ──── POST /api/webhooks/fire ──────┘
                        (HS256-signed payment events)
```

**Money is only ever marked received by one function**, `applyConfirmedPayment()`,
called from either (a) a signature-verified webhook, (b) the reconciliation poll
of Fire's real API, or (c) an explicit, audited admin "record external payment"
action. A browser click never marks anything paid.

---

## 3. Database changes

New migration `009_platform_billing.sql` (additive, forward-only). New tables all
get RLS; grants added to `invoice_app`.

### 3.1 New tables

| Table | Purpose | Key columns |
| --- | --- | --- |
| `subscription_plans` | Catalogue of packages you sell | `code`, `name`, `amount_cents`, `currency`, `interval` (`month`\|`year`), `active` |
| `tenant_subscriptions` | One per tenant | `tenant_id` UNIQUE, `plan_id`, `status` (`active`\|`cancelled`), `current_period_start`, `current_period_end`, `renewal_date`, `cancel_at_period_end` |
| `platform_invoices` | Your invoice to a tenant | `tenant_id`, `number` UNIQUE, `subscription_id`, `period_start`, `period_end`, `issue_date`, `due_date`, `description`, `amount_cents`, `currency`, `status` (see §5), `payment_reference` UNIQUE, `fire_payment_code`, `hosted_payment_url`, `paid_at`, `paid_amount_cents`, `platform_snapshot` jsonb, `tenant_snapshot` jsonb. **UNIQUE `(tenant_id, subscription_id, period_start)`** ⇐ renewal idempotency |
| `platform_payments` | Confirmed money-received ledger | `invoice_id` UNIQUE, `tenant_id`, `provider`, `provider_payment_id`, `amount_cents`, `currency`, `confirmed_at`, `raw` jsonb. **UNIQUE `(invoice_id)`** ⇐ one confirmed payment per invoice |
| `platform_payment_events` | Every webhook + poll result | `provider`, `event_key` UNIQUE, `event_type`, `invoice_id`, `tenant_id`, `payload` jsonb, `signature_verified` bool, `processed_at`, `processing_error`, `received_at`. **UNIQUE `(provider, event_key)`** ⇐ webhook dedupe |
| `admin_notifications` | The notification centre | `type`, `tenant_id`, `invoice_id`, `payment_id`, `title`, `body`, `severity` (`info`\|`attention`), `dedupe_key` UNIQUE-nullable, `read_at`, `created_at` |
| `platform_billing_config` | Single row. Your business identity + Fire platform creds + timings | `business_name`, `business_address`, `business_tax_number`, `default_currency`, `renewal_reminder_days` (default 7), `overdue_grace_days` (default 0), `invoice_number_prefix`, `fire_client_id_ciphertext`, `fire_client_key_ciphertext`, `fire_refresh_token_ciphertext`, `fire_webhook_secret_ciphertext`, `fire_collection_ican`, `key_version` |

### 3.2 Changed table: `tenants`

```sql
ALTER TABLE tenants
  ADD COLUMN suspension_reason text CHECK (suspension_reason IN ('unpaid','other')),
  ADD COLUMN suspended_at      timestamptz,
  ADD COLUMN suspended_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN reactivated_at    timestamptz,
  ADD COLUMN reactivation_note text;
```

`tenants.status` stays `active | suspended` (changing that enum ripples through
`ensureAccountActive`, the admin UI, and every existing test). The three
**account states** in your §9 are derived, not a new column — see §5.2.

### 3.3 Platform invoice numbering

A dedicated Postgres sequence `platform_invoice_seq` + `invoice_number_prefix`
from config (e.g. `VD-2026-0001`). Only admin/system context ever allocates one,
so a plain `nextval()` is safe (no SECURITY DEFINER needed, unlike the tenant
`allocate_invoice_number`).

### 3.4 RLS policies

| Table | SELECT | INSERT / UPDATE / DELETE |
| --- | --- | --- |
| `subscription_plans` | any authenticated user | `app_is_admin()` |
| `tenant_subscriptions` | `app_is_admin() OR tenant_id = app_current_tenant()` | `app_is_admin()` |
| `platform_invoices` | `app_is_admin() OR tenant_id = app_current_tenant()` | `app_is_admin()` |
| `platform_payments` | `app_is_admin() OR tenant_id = app_current_tenant()` | `app_is_admin()` |
| `platform_payment_events` | `app_is_admin()` | `app_is_admin()` |
| `admin_notifications` | `app_is_admin()` | `app_is_admin()` |
| `platform_billing_config` | `app_is_admin()` | `app_is_admin()` |

A tenant can **read its own** subscription, invoices and payments; it can never
write any of them and never sees another tenant's rows, the raw event log, the
notification centre, or the config. Same fail-closed guarantee as the rest of the
app: no context ⇒ zero rows.

### 3.5 System context for webhooks & jobs

The webhook handler and the scheduler have no logged-in user. They must not use
`db.privileged()` (that bypasses RLS entirely and is reserved for
migrations/tests). New helper:

```ts
db.withSystemContext(fn)   // SET LOCAL ROLE invoice_app;
                           // app.is_admin = true; app.current_tenant = '';
                           // app.current_user_id = ''   (audit actor = null)
```

RLS stays **on**, scoped to admin. Writes are still policy-checked. `audit_logs`
rows from these paths have `actor_user_id = NULL` and `metadata.source =
'webhook' | 'scheduler'`.

---

## 4. Fire.com integration (`src/integrations/fire/`)

Built for the first time here, at the **platform** level (your Fire account, one
set of credentials). Separate from the tenant-level `tenant_payment_integrations`
(which stays dormant).

### 4.1 Verified API contract (from docs.fire.com research)

| Step | Call |
| --- | --- |
| **Auth** | `POST https://api.fire.com/business/v1/apps/accesstokens` with `{clientId, clientSecret: SHA256(nonce + clientKey), grantType:"AccessToken"}` → `{accessToken, expiry}`. Token lives ~15 min; minted per operation, never stored. |
| **Create payment request** | `POST /business/v1/paymentrequests` `{type:"OTHER", icanTo:<collection_ican>, currency, amount:<minor units int>, myRef:<our payment_reference>, description:<=18 chars, expiry, returnUrl}` → `{code}`. Hosted page: `https://payments.fire.com/{code}` — **this URL is what the QR encodes.** |
| **Status (detail)** | `GET /business/v1/paymentrequests/{code}` → `{status, totalAmountPaid, countTimesPaid}` |
| **Status (payments)** | `GET /business/v2/paymentrequests/{code}/payments` → per-payment `{status, dateFundsReceived, endToEndId, paymentUuid}`. Terminal "money landed" status assumed **`SETTLED`** (confirm in §14). |
| **Webhooks** | Configured in the Fire portal (Profile → Webhooks). Delivered as **HS256 JWT** with a `kid`, signed with the portal "private token". JSON array of events. Retried 3–5× at ~1 min. Event types include `PAYMENT_REQUEST_PAYMENT_RECEIVED`, `PAYMENT_REQUEST_PAYMENT_AUTHORISED`. |

### 4.2 Client module surface

```ts
fire.mintAccessToken()                         // internal, cached to expiry-30s
fire.createPaymentRequest({ amountMinor, currency, myRef, description, expiry })
fire.getPaymentRequest(code)                   // reconciliation poll
fire.getPaymentRequestPayments(code)
fire.verifyWebhook(rawBody, headers) -> Event[] // HS256 verify, throws on bad sig
```

No official SDK; thin `fetch` wrapper. All calls server-side only. Credentials
decrypted in memory for the duration of one call, never logged (`description`,
`myRef`, `amount` are safe to log; tokens and `clientKey` are redacted).

### 4.3 QR codes

`qrcode` npm (pure JS). `GET /api/billing/invoices/:id/qr` renders an SVG (or PNG
data-URI) of `https://payments.fire.com/{code}` **on demand**, after RLS confirms
the invoice belongs to the caller (or admin). Never a file on disk, never a
predictable public URL.

---

## 5. Billing state machine (`src/billing/state.ts`)

One module owns every transition. No status `if`s scattered through routes.

### 5.1 Platform invoice

```
        create              issue            pay-now clicked
  ─────────────► DRAFT ───────────► ISSUED ───────────────► PAYMENT_PENDING
                   │                  │                          │
                   │ cancel           │ cancel      confirmed ────┤
                   ▼                  ▼             payment       ▼
               CANCELLED          CANCELLED                     PAID
                                      ▲                          
                          Fire reports NOT_AUTHORISED / expiry   
                                      │                          
   PAYMENT_PENDING ──────────────────►┘  → back to ISSUED, event logged, 
                     payment failed      admin_notification "payment failed"
```

Stored `status`: `draft | issued | payment_pending | paid | cancelled`.
`failed` is **not** a resting invoice state — a failed attempt returns the
invoice to `issued` and raises a notification; the invoice is still owed.

`OVERDUE` is **derived**, never stored (mirrors the existing `invoices.overdue`
pattern):

```
overdue  =  status IN ('issued','payment_pending')
        AND due_date < current_date - (overdue_grace_days || ' days')::interval
```

Legal transitions (enforced by `state.ts`, rejected otherwise):

| From | To | Trigger |
| --- | --- | --- |
| — | `draft` | renewal job / admin creates |
| `draft` | `issued` | job issues it / admin issues |
| `draft` | `cancelled` | admin |
| `issued` | `payment_pending` | Fire payment request created (Pay Now, or job) |
| `issued` | `cancelled` | admin |
| `payment_pending` | `paid` | `applyConfirmedPayment()` only |
| `payment_pending` | `issued` | Fire reports failure/expiry (reopen) |
| `issued` / `payment_pending` | `paid` | admin "record external payment" (audited) |

### 5.2 Account state (derived from `tenants`)

```ts
accountState(tenant):
  status='active'                                          → ACTIVE
  status='suspended' AND suspension_reason='unpaid'        → SUSPENDED_UNPAID
  status='suspended' AND suspension_reason IN ('other',NULL)→ SUSPENDED_OTHER
```

| Transition | Trigger |
| --- | --- |
| `ACTIVE → SUSPENDED_UNPAID` | admin suspends, picks reason **Unpaid** |
| `ACTIVE → SUSPENDED_OTHER` | admin suspends, picks reason **Other** |
| `SUSPENDED_UNPAID → ACTIVE` | **automatic**, when the blocking invoice is confirmed paid |
| `SUSPENDED_OTHER → ACTIVE` | **admin only**, manual reactivate |
| `SUSPENDED_UNPAID → ACTIVE` | admin may also reactivate manually |

Auto-reactivation **never** fires for `SUSPENDED_OTHER`.

---

## 6. Payment confirmation flow (webhook + reconciliation)

### 6.1 `POST /api/webhooks/fire` (no auth middleware)

```
1. Read raw body (needed for signature). Respond 200 fast after step 4;
   heavy work is idempotent and safe to repeat on Fire's retries.
2. fire.verifyWebhook(raw, headers)  → throws → log event (signature_verified=false),
   return 401. Never process an unverified event.
3. For each event:
   a. event_key = paymentUuid (or endToEndId).  INSERT into platform_payment_events
      ON CONFLICT (provider,event_key) DO NOTHING.  0 rows ⇒ duplicate ⇒ skip.
   b. Match invoice by our myRef == platform_invoices.payment_reference
      (and fire_payment_code == code). No match ⇒ log processing_error,
      admin_notification "payment requires attention", return 200.
   c. Cross-check amount + currency against the invoice. Mismatch ⇒ do NOT mark
      paid; admin_notification "payment requires attention".
   d. tenant_id comes from the matched invoice — NEVER from the payload.
   e. If event is a confirmed-funds event (SETTLED / PAYMENT_RECEIVED):
      applyConfirmedPayment(invoice, evidence)
4. Mark event processed_at, return 200.
```

### 6.2 `applyConfirmedPayment(invoice, evidence)` — the single money path

One transaction (`db.withSystemContext`):

```
INSERT platform_payments (invoice_id, …) ON CONFLICT (invoice_id) DO NOTHING
  → 0 rows ⇒ already applied ⇒ return (idempotent)
UPDATE platform_invoices SET status='paid', paid_at=…, paid_amount_cents=…
IF accountState(tenant) == SUSPENDED_UNPAID AND invoice was the blocking one:
    UPDATE tenants SET status='active', reactivated_at=now(),
           reactivation_note='auto: invoice <number> paid'
    admin_notification "tenant reactivated (paid)"  [attention]
    audit: tenant.reactivated (source=webhook)
recompute tenant_subscriptions.renewal_date / current_period_* (advance one interval)
admin_notification "client paid"  [info]
audit: invoice.paid, payment.confirmed
```

### 6.3 Reconciliation (belt & braces)

The hourly `billing-tick` polls `fire.getPaymentRequest(code)` for every
`payment_pending` invoice older than ~15 min. If Fire says paid and we missed the
webhook, it calls the **same** `applyConfirmedPayment()` — the unique constraints
make double-application impossible. Fire API errors → `admin_notification`
"payment provider error", retried next tick.

---

## 7. Scheduled jobs (`src/jobs/billing-tick.ts` + systemd timer)

**Not** in-process `setInterval` (lost on restart, and the app should not do
time-based work). A CLI, run hourly:

```
deploy/invoice-billing.service   (oneshot: node --import tsx/esm src/jobs/billing-tick.ts)
deploy/invoice-billing.timer     (OnCalendar=hourly, Persistent=true)
```

`provision.sh` installs and enables both. `Persistent=true` catches up a missed
run after downtime.

Each tick, inside `pg_advisory_xact_lock(hashtext('billing-tick'))` (one at a
time) and `db.withSystemContext`:

| Job | Idempotency guard |
| --- | --- |
| **Renewal prep** — for subscriptions with `renewal_date <= now() + reminder_days`: create `platform_invoice` (draft→issued), create Fire payment request, `admin_notification` "renewal invoice generated", client sees it in their billing UI | `UNIQUE (tenant_id, subscription_id, period_start)` — a second run inserts nothing |
| **Overdue sweep** — invoices now past `due_date + grace`: `admin_notification` "payment overdue" | `admin_notifications.dedupe_key = 'overdue:' || invoice_id` |
| **Reconciliation** — poll Fire for `payment_pending` invoices (§6.3) | `platform_payments UNIQUE (invoice_id)` |
| **Provider health** — surface repeated Fire errors as one notification | `dedupe_key` with a date bucket |

Every job logs start/finish/counts and writes `audit_logs` entries. A job failure
is logged and does not block the others; the tick exits non-zero so systemd
records it.

Config (`platform_billing_config`, editable in the admin UI, not hard-coded):
`renewal_reminder_days` (7), `overdue_grace_days` (0), `default_currency`.
Suspension stays **manual** per your brief.

---

## 8. Suspension & the dunning email (Outlook)

### 8.1 Suspend with reason

`POST /api/admin/tenants/:id/suspend` gains a body:
`{ reason: 'unpaid' | 'other', note?: string }`.

On **Unpaid**:
1. `tenants.status='suspended'`, `suspension_reason='unpaid'`, `suspended_at`, `suspended_by`.
2. `audit_logs`: `tenant.suspended` `{reason:'unpaid', note}`.
3. Identify the current outstanding invoice (oldest `issued`/`payment_pending`/overdue).
4. Return `{ tenant, outstandingInvoice, dunningEmail: { mailtoUrl, to, subject, body } }`.
5. Admin UI immediately does `window.location.href = mailtoUrl` → **Outlook opens**
   with a pre-filled draft. Admin reviews, edits, hits Send. **We never send it.**

`admin_notification` "client account suspended" `[attention]`.

### 8.2 The `mailto:` builder (`src/billing/dunning.ts`)

```
to      = tenant_settings.contact_email  (fallback: tenant admin user's email)
subject = "Action needed: your <business_name> subscription is overdue"
body    = greeting
        + invoice number, amount, currency, due date
        + "Pay securely by bank transfer: https://payments.fire.com/<code>"
        + short plain-text summary
        + your sign-off (from platform_billing_config)
mailtoUrl = "mailto:" + to + "?subject=" + enc(subject) + "&body=" + enc(body)
```

Plain text, kept well under ~1800 chars (browser/OS `mailto` limit). This is the
"existing/appropriate Outlook integration" — a `mailto:` link **is** how you open
Outlook with a prepared message without a server-side mail system. `audit_logs`:
`billing.dunning_email_prepared`.

> **Richer option** (open decision §14): Microsoft Graph "create draft" instead —
> HTML body, PDF attached, draft lands in your Outlook. Needs an Azure app
> registration + delegated `Mail.ReadWrite` + OAuth. More setup, more moving
> parts. `mailto:` is the recommended default.

### 8.3 Automatic reactivation

Handled entirely inside `applyConfirmedPayment()` (§6.2). Only for
`SUSPENDED_UNPAID`, only when the blocking invoice is genuinely confirmed paid by
Fire. Records `reactivated_at`, writes the audit trail, raises the
"tenant reactivated (paid)" notification.

---

## 9. Notification centre (admin)

New table `admin_notifications` (§3.1), new admin nav item **Notifications**, new
API:

| Endpoint | |
| --- | --- |
| `GET /api/admin/notifications?unread=1&limit=` | list, newest first |
| `GET /api/admin/notifications/unread-count` | badge |
| `POST /api/admin/notifications/:id/read` | mark one |
| `POST /api/admin/notifications/read-all` | mark all |

Notification `type` values (all raised by the flows above):
`client_paid`, `renewal_upcoming`, `renewal_invoice_generated`,
`payment_overdue`, `account_suspended`, `account_reactivated_auto`,
`payment_failed`, `payment_requires_attention`, `provider_error`.

Each carries `tenant_id` + (`invoice_id` | `payment_id`), so the UI row links to
`/admin/billing/tenants/:id` or the invoice. `severity` `attention` items get a
badge/highlight. `dedupe_key` stops duplicates from repeated job runs.

The **audit log stays separate** — it's the immutable legal record (every event
in your §10, append-only, never marked "read"). Notifications are the
dismissible "what needs you now" view. Both are written in the same transaction
as the event.

---

## 10. Audit trail

Reuse `audit_logs` (append-only, immutable trigger already in place). New action
strings, all with `tenant_id` + `metadata` carrying `{invoiceId, paymentId,
amountCents, currency, …}`:

`billing.subscription_set`, `billing.invoice_created`, `billing.invoice_issued`,
`billing.payment_link_created`, `billing.qr_generated`, `billing.payment_initiated`,
`billing.payment_confirmed`, `billing.invoice_paid`, `billing.invoice_cancelled`,
`billing.external_payment_recorded`, `billing.renewal_generated`,
`tenant.suspended` (+`reason`), `tenant.reactivated` (+`auto` flag),
`billing.dunning_email_prepared`, `billing.notification_created`,
`billing.webhook_received`, `billing.webhook_failed`, `billing.job_run`.

`audit.ts`'s `AuditAction` union type is extended accordingly.

---

## 11. Frontend changes

### 11.1 Client (`web/app/`)

- **New Settings tab: Billing** (`/app/settings/billing`, tenant-admin only —
  consistent with Payments/Team/Integrations). Shows: current plan, billing
  period, renewal date, amount due, payment status, outstanding invoices,
  payment history, and for the current outstanding invoice a **Pay Now** button
  + **QR code** + a **View invoice** (printable HTML) link.
- **Pay-due banner** in the app shell (all pages) when the tenant has an
  outstanding/overdue platform invoice or is `SUSPENDED_UNPAID`:
  *"Your subscription payment is due — Pay now →"*. This is the "clear Pay Now
  action when payment is due" without adding a 5th nav item.
- **Pay Now** → `POST /api/billing/invoices/:id/pay` → `{hostedUrl}` → open
  `https://payments.fire.com/{code}` in a new tab. Returns the existing link if
  one was already created (idempotent). The button shows "Payment in progress"
  once `payment_pending`; it flips to "Paid" only when the backend confirms.
- Printable invoice at `/app/settings/billing/invoices/:id` — styled HTML,
  "Print / Save as PDF" (zero-dependency). A real PDF file is a §14 decision.

### 11.2 Admin (`web/admin/`)

- **New nav: Billing** → table of all tenants: account state, plan, amount due,
  next renewal, current invoice status, last payment, outstanding balance.
  Row → **tenant billing detail**: subscription (change plan / renewal date),
  invoice list, payment history, actions (create ad-hoc invoice, cancel invoice,
  record external payment, suspend/reactivate).
- **New nav: Notifications** → the centre from §9, unread badge in the nav.
- **Suspend modal**: reason dropdown (`Unpaid` / `Other`) + optional note.
  On `Unpaid` submit → suspend, then open the `mailto:` (§8).
- **Dashboard additions** (§12).
- **Plans**: small admin screen to CRUD `subscription_plans`.
- **Billing config**: your business identity, Fire platform credentials
  (write-only — secrets never rendered back, just "configured ✓"), timings.

Admin UI stays hash-routed (not converting it this pass).

---

## 12. Admin dashboard additions

`GET /api/admin/billing/summary` → tiles, added to the existing admin dashboard:

- Total **active** clients
- Clients **due for renewal** (within `reminder_days`)
- **Outstanding payments** — count + total amount
- **Recently paid** invoices (last 30 days)
- **Suspended** accounts (split: unpaid / other)
- **Recent billing notifications** (last 5, links through)

Kept to a strip of tiles + a short list — not a general ledger.

---

## 13. API surface (new)

### Client — `requireTenantAdmin`, tenant `withContext`
```
GET  /api/billing/overview
GET  /api/billing/invoices
GET  /api/billing/invoices/:id
GET  /api/billing/invoices/:id/qr           (SVG; RLS-checked)
GET  /api/billing/invoices/:id/view         (printable HTML)
GET  /api/billing/payments
POST /api/billing/invoices/:id/pay          → { hostedUrl, code }  (idempotent; never marks paid)
```

### Admin — `requireAdmin`
```
GET  /api/admin/billing/summary
GET  /api/admin/billing/tenants
GET  /api/admin/billing/tenants/:id
POST /api/admin/billing/tenants/:id/subscription      { planId, renewalDate? }
POST /api/admin/billing/tenants/:id/invoices          { description, amountCents, currency, dueDate }
POST /api/admin/billing/invoices/:id/issue
POST /api/admin/billing/invoices/:id/cancel
POST /api/admin/billing/invoices/:id/record-payment   { amountCents, currency, reference, paidAt }  (audited external payment)
GET  /api/admin/billing/tenants/:id/dunning-email     → { mailtoUrl, to, subject, body }
GET  /api/admin/plans                 POST /api/admin/plans     PATCH /api/admin/plans/:id
GET  /api/admin/billing/config        PUT  /api/admin/billing/config
GET  /api/admin/notifications         GET  /api/admin/notifications/unread-count
POST /api/admin/notifications/:id/read     POST /api/admin/notifications/read-all
```
`POST /api/admin/tenants/:id/suspend` — **modified**: now takes `{reason, note?}`.

### Webhook — no auth middleware
```
POST /api/webhooks/fire
```

---

## 14. Decisions

| # | Decision | Resolved |
| --- | --- | --- |
| D1 | **Outlook** | ✅ **`mailto:` link** — server builds the pre-filled draft, admin reviews & sends. No Graph, no Azure app. |
| D2 | **Invoice PDF** | ✅ **Printable HTML now**, real PDF file (`pdfkit`) deferred to a later phase if an attachable file is needed. |
| D3 | **Client renewal notification** | ✅ **In-app only** (pay-due banner + billing tab). Admin may still send a `mailto` manually. No outbound email system. |
| D4 | **Fire.com sandbox** | Open — confirm in the Fire portal during Phase 0; if none, verify Phase 4 with one small real payment. |
| D5 | **"Funds landed" status** | Open — confirm `SETTLED` against a real Fire payment during Phase 0. |
| D6 | **Plans** (names, prices, monthly/annual) | **Needed from you before Phase 2.** Seeded via the admin Plans screen. |
| D7 | **Who at the tenant sees Billing** | ✅ Tenant admin only (consistent with the other Settings tabs). |
| D8 | **Encryption key** | ✅ `APP_ENCRYPTION_KEY` in `/etc/invoice-creator/app.env`, generated by `provision.sh`, required in production. Rotation via `key_version`. |

---

## 15. Proposed implementation phases

Each phase is independently reviewable, ends green (tests + typecheck), deploys,
and **breaks nothing existing**. Isolation, idempotency, state-transition and
webhook-dedupe tests every phase.

| Phase | Deliverable | Gates |
| --- | --- | --- |
| **0 — Foundations** | `secretbox.ts` (AES-256-GCM), `APP_ENCRYPTION_KEY` wiring, `src/integrations/fire/` client, `qrcode` dep, `withSystemContext`, `platform_billing_config` table + admin "Billing config" screen, `POST /api/webhooks/fire` with signature verify (logs only) | Fire auth works against your real account; bad-signature webhook rejected |
| **1 — Data model** | migration `009`, all 7 tables + `tenants` columns + RLS, repos, `state.ts` state machine | RLS isolation tests; state-machine unit tests; no existing test breaks |
| **2 — Admin billing** | Plans CRUD, per-tenant subscription mgmt, ad-hoc invoice create/issue/cancel, admin Billing list + detail, dashboard tiles | Admin-only enforcement tests |
| **3 — Client billing UI** | Settings→Billing tab, pay-due banner, invoice view, payment history, Pay Now (creates Fire request → `payment_pending`, returns hosted URL), QR endpoint | Tenant sees only own rows; Pay Now never marks paid |
| **4 — Payment confirmation** | Full webhook processing → `applyConfirmedPayment`, reconciliation poll, invoice→paid + payment recorded + audit + "client paid" notification | Duplicate webhook = no-op; wrong-amount = flagged not paid; wrong-tenant impossible |
| **5 — Suspension & dunning** | suspend-with-reason, `mailto` dunning builder, auto-reactivation on confirmed payment | Auto-reactivate only for `SUSPENDED_UNPAID`; `SUSPENDED_OTHER` never auto-reactivates |
| **6 — Renewal automation** | `billing-tick` CLI, systemd timer, `provision.sh` install, renewal invoice generation, overdue sweep | Idempotent: running the tick 3× makes exactly one invoice per period |
| **7 — Notification centre** | `admin_notifications` UI, mark-read, unread badge, wired to every event | — |
| **8 — Polish** | Audit completeness pass, dashboard, `docs/PLATFORM_BILLING.md` runbook, DEPLOYMENT.md updates | Full suite green; deploy |

---

## 16. Explicit non-goals / guardrails (from your brief)

- No mock/simulated payment confirmations in production code. Reconciliation uses
  the real Fire API.
- A frontend success response is never treated as proof of payment.
- No automatic sending of the dunning email.
- No automatic reactivation of `SUSPENDED_OTHER`.
- No automatic suspension (manual, admin-controlled).
- No duplicate invoices — enforced by DB unique constraints, not job discipline.
- No change to the tenant `invoices` / `customers` tables or the existing tenant
  isolation model.
- No 5th item in the client nav (Billing lives under Settings + a banner).
