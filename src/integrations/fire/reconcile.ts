import type { FirePayment, FirePaymentRequestPayments } from "./types.ts";

/**
 * Fire PIS payment statuses that mean the money is NOT (or no longer) with us.
 * Anything else that also carries `dateFundsReceived` is treated as received.
 */
const NOT_RECEIVED = new Set([
  "REJECTED",
  "FAILED",
  "CANCELLED",
  "CANCELED",
  "EXPIRED",
  "RETURNED",
  "REFUNDED",
  "VOID",
  "DECLINED",
  "ERROR",
]);

export interface FireSettlement {
  /** Minor units actually received against the request. */
  amountReceivedMinor: number;
  /** The individual payments that make up the received total. */
  payments: FirePayment[];
  /** A stable id for the settlement (first payment UUID) — for idempotency. */
  providerPaymentId: string | null;
  currency: string | null;
}

function currencyCode(c: FirePayment["currency"] | undefined): string | null {
  if (!c) return null;
  return typeof c === "string" ? c : (c.code ?? null);
}

/**
 * Reduce the `/payments` sub-resource to "how much actually landed". A payment
 * counts when it has a `dateFundsReceived` and its status is not a terminal
 * failure. Verified statuses seen live: `SETTLED`.
 */
export function summariseFireSettlement(res: FirePaymentRequestPayments | null | undefined): FireSettlement {
  const list = res?.pisPaymentRequestPayments ?? [];
  const received = list.filter(
    (p) => Boolean(p.dateFundsReceived) && !NOT_RECEIVED.has(String(p.status ?? "").toUpperCase()),
  );
  return {
    amountReceivedMinor: received.reduce((sum, p) => sum + (Number(p.amountBeforeCharges) || 0), 0),
    payments: received,
    providerPaymentId: received[0]?.paymentUuid ?? null,
    currency: currencyCode(received[0]?.currency),
  };
}
