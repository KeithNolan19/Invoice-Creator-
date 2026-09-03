import { describe, expect, it } from "vitest";
import {
  accountState,
  assertInvoiceTransition,
  BillingStateError,
  canTransitionInvoice,
  type InvoiceState,
  isInvoiceOverdue,
  mayAutoReactivate,
} from "../../src/billing/state.ts";
import { periodEnd, resolveAmountCents } from "../../src/billing/pricing.ts";

describe("invoice state machine", () => {
  const legal: [InvoiceState, InvoiceState][] = [
    ["draft", "issued"],
    ["draft", "cancelled"],
    ["issued", "payment_pending"],
    ["issued", "paid"],
    ["issued", "cancelled"],
    ["payment_pending", "paid"],
    ["payment_pending", "issued"],
  ];
  const illegal: [InvoiceState, InvoiceState][] = [
    ["draft", "paid"],
    ["draft", "payment_pending"],
    ["paid", "issued"],
    ["paid", "cancelled"],
    ["cancelled", "issued"],
    ["issued", "draft"],
  ];

  it.each(legal)("allows %s -> %s", (from, to) => {
    expect(canTransitionInvoice(from, to)).toBe(true);
    expect(() => assertInvoiceTransition(from, to)).not.toThrow();
  });

  it.each(illegal)("rejects %s -> %s", (from, to) => {
    expect(canTransitionInvoice(from, to)).toBe(false);
    expect(() => assertInvoiceTransition(from, to)).toThrow(BillingStateError);
  });
});

describe("overdue derivation", () => {
  const now = new Date("2026-06-15T12:00:00Z");
  it("an issued invoice past its due date is overdue", () => {
    expect(isInvoiceOverdue({ status: "issued", due_date: "2026-06-10" }, 0, now)).toBe(true);
  });
  it("respects the grace period", () => {
    expect(isInvoiceOverdue({ status: "issued", due_date: "2026-06-10" }, 7, now)).toBe(false);
    expect(isInvoiceOverdue({ status: "issued", due_date: "2026-06-01" }, 7, now)).toBe(true);
  });
  it("paid / cancelled / future invoices are never overdue", () => {
    expect(isInvoiceOverdue({ status: "paid", due_date: "2026-01-01" }, 0, now)).toBe(false);
    expect(isInvoiceOverdue({ status: "cancelled", due_date: "2026-01-01" }, 0, now)).toBe(false);
    expect(isInvoiceOverdue({ status: "issued", due_date: "2026-12-31" }, 0, now)).toBe(false);
  });
  it("payment_pending can be overdue too", () => {
    expect(isInvoiceOverdue({ status: "payment_pending", due_date: "2026-06-01" }, 0, now)).toBe(true);
  });
});

describe("account state", () => {
  it("maps status + reason to the three states", () => {
    expect(accountState({ status: "active" })).toBe("ACTIVE");
    expect(accountState({ status: "suspended", suspension_reason: "unpaid" })).toBe("SUSPENDED_UNPAID");
    expect(accountState({ status: "suspended", suspension_reason: "other" })).toBe("SUSPENDED_OTHER");
    expect(accountState({ status: "suspended", suspension_reason: null })).toBe("SUSPENDED_OTHER");
  });
  it("only an unpaid suspension may auto-reactivate", () => {
    expect(mayAutoReactivate("SUSPENDED_UNPAID")).toBe(true);
    expect(mayAutoReactivate("SUSPENDED_OTHER")).toBe(false);
    expect(mayAutoReactivate("ACTIVE")).toBe(false);
  });
});

describe("pricing", () => {
  it("monthly is the plan price", () => {
    expect(resolveAmountCents(1500, "month", 5)).toBe(1500);
  });
  it("yearly is 12 months minus the discount", () => {
    expect(resolveAmountCents(1000, "year", 5)).toBe(11400); // 12000 - 5%
    expect(resolveAmountCents(1500, "year", 5)).toBe(17100);
    expect(resolveAmountCents(2000, "year", 5)).toBe(22800);
    expect(resolveAmountCents(1000, "year", 0)).toBe(12000);
  });
  it("period end is one interval later, inclusive", () => {
    expect(periodEnd(new Date("2026-01-01"), "month").toISOString().slice(0, 10)).toBe("2026-01-31");
    expect(periodEnd(new Date("2026-01-01"), "year").toISOString().slice(0, 10)).toBe("2026-12-31");
  });
});
