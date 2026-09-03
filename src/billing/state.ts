/**
 * The billing state machine — one place for every legal transition, so status
 * checks are not scattered through routes and jobs.
 */

export const INVOICE_STATES = ["draft", "issued", "payment_pending", "paid", "cancelled"] as const;
export type InvoiceState = (typeof INVOICE_STATES)[number];

/**
 *   draft ──issue──► issued ──pay-now──► payment_pending ──confirmed──► paid
 *     │                │                       │
 *     └──cancel────► cancelled ◄──cancel───────┘
 *                                              │
 *                    issued ◄──payment failed/expired
 *
 * `paid` and `cancelled` are terminal. A failed payment attempt returns the
 * invoice to `issued` (still owed). OVERDUE is derived, never a stored state.
 */
const INVOICE_TRANSITIONS: Record<InvoiceState, readonly InvoiceState[]> = {
  draft: ["issued", "cancelled"],
  issued: ["payment_pending", "paid", "cancelled"],
  payment_pending: ["paid", "issued", "cancelled"],
  paid: [],
  cancelled: [],
};

export function canTransitionInvoice(from: InvoiceState, to: InvoiceState): boolean {
  return INVOICE_TRANSITIONS[from].includes(to);
}

export function assertInvoiceTransition(from: InvoiceState, to: InvoiceState): void {
  if (!canTransitionInvoice(from, to)) {
    throw new BillingStateError(`invoice cannot move from ${from} to ${to}`);
  }
}

export class BillingStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BillingStateError";
  }
}

/** OVERDUE is derived: an unsettled invoice whose due date (+ grace) has passed. */
export function isInvoiceOverdue(
  inv: { status: InvoiceState; due_date: string | Date },
  graceDays = 0,
  now: Date = new Date(),
): boolean {
  if (inv.status !== "issued" && inv.status !== "payment_pending") return false;
  const due = inv.due_date instanceof Date ? inv.due_date : new Date(inv.due_date);
  const cutoff = new Date(due);
  cutoff.setUTCDate(cutoff.getUTCDate() + graceDays);
  return now > endOfDayUTC(cutoff);
}

function endOfDayUTC(d: Date): Date {
  const e = new Date(d);
  e.setUTCHours(23, 59, 59, 999);
  return e;
}

// ---------------------------------------------------------------------------
// Account state — derived from tenants.status + tenants.suspension_reason.
// ---------------------------------------------------------------------------

export type AccountState = "ACTIVE" | "SUSPENDED_UNPAID" | "SUSPENDED_OTHER";

export function accountState(t: {
  status: "active" | "suspended";
  suspension_reason?: "unpaid" | "other" | null;
}): AccountState {
  if (t.status === "active") return "ACTIVE";
  return t.suspension_reason === "unpaid" ? "SUSPENDED_UNPAID" : "SUSPENDED_OTHER";
}

/** Auto-reactivation on confirmed payment is allowed only for unpaid suspensions. */
export function mayAutoReactivate(state: AccountState): boolean {
  return state === "SUSPENDED_UNPAID";
}
