import { describe, expect, it } from "vitest";
import { summariseFireSettlement } from "../../src/integrations/fire/reconcile.ts";

/** Verified live shape: v2 `/payments` → { total, pisPaymentRequestPayments: [...] }. */
const settled = (over: Record<string, unknown> = {}) => ({
  paymentUuid: "pay-1",
  status: "SETTLED",
  currency: { code: "EUR", description: "Euro" },
  amountBeforeCharges: 100,
  myRef: "VD-000001",
  dateCreated: "2026-09-03T21:17:09.973Z",
  dateFundsReceived: "2026-09-03T21:17:27.623Z",
  ...over,
});

describe("summariseFireSettlement", () => {
  it("sums payments that have landed", () => {
    const s = summariseFireSettlement({
      total: 2,
      pisPaymentRequestPayments: [settled(), settled({ paymentUuid: "pay-2", amountBeforeCharges: 50 })],
    });
    expect(s.amountReceivedMinor).toBe(150);
    expect(s.providerPaymentId).toBe("pay-1");
    expect(s.currency).toBe("EUR");
    expect(s.payments).toHaveLength(2);
  });

  it("ignores a payment with no dateFundsReceived (still in flight)", () => {
    const s = summariseFireSettlement({
      total: 1,
      pisPaymentRequestPayments: [settled({ dateFundsReceived: undefined, status: "AWAITING_AUTHORISATION" })],
    });
    expect(s.amountReceivedMinor).toBe(0);
    expect(s.providerPaymentId).toBeNull();
  });

  it("ignores rejected / failed / returned payments even if a funds date slipped through", () => {
    for (const status of ["REJECTED", "FAILED", "RETURNED", "REFUNDED"]) {
      const s = summariseFireSettlement({
        total: 1,
        pisPaymentRequestPayments: [settled({ status })],
      });
      expect(s.amountReceivedMinor, status).toBe(0);
    }
  });

  it("handles an empty / missing response", () => {
    expect(summariseFireSettlement(null).amountReceivedMinor).toBe(0);
    expect(summariseFireSettlement({ total: 0, pisPaymentRequestPayments: [] }).providerPaymentId).toBeNull();
  });

  it("accepts a bare currency string", () => {
    const s = summariseFireSettlement({
      total: 1,
      pisPaymentRequestPayments: [settled({ currency: "GBP" })],
    });
    expect(s.currency).toBe("GBP");
  });
});
