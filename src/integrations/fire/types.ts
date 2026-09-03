/** Fire.com Business API — the subset this application uses. */

export interface FireCredentials {
  clientId: string;
  clientKey: string;
  refreshToken: string;
}

/** POST /business/v1/apps/accesstokens response. */
export interface FireAccessToken {
  accessToken: string;
  expiry: string; // ISO timestamp; ~15 minute window
  businessId: number;
  apiApplicationId: number;
  permissions: string[];
}

export interface CreatePaymentRequestInput {
  /** Minor units (cents). */
  amountMinor: number;
  currency: "EUR" | "GBP";
  /** Our internal reference — echoed back on webhooks/status. Maps to our payment_reference. */
  myRef: string;
  /** Shown to the payer. Fire recommends <= 18 characters. */
  description: string;
  /** Fire account ICAN that receives the funds. */
  icanTo: number;
  /** ISO timestamp. */
  expiry?: string;
  returnUrl?: string;
}

/** POST /v1/paymentrequests response. */
export interface PaymentRequestCreated {
  code: string;
  type: string;
}

/**
 * GET /business/v1/paymentrequests/{code} — verified against the live API.
 * A completed request reports `status: "PAID"`; there is no `totalAmountPaid`
 * field on this endpoint, so the actual received amount comes from the
 * `/payments` sub-resource below.
 */
export interface FirePaymentRequestDetail {
  code: string;
  status: string; // ACTIVE | PAID | EXPIRED | CLOSED | ...
  currency: string;
  amount: number; // minor units — the amount requested
  myRef?: string;
  description?: string;
  countTimesAuthorised?: number;
  countTimesConsented?: number;
  [key: string]: unknown;
}

/** One payment made against a payment request (v2 `/payments`). */
export interface FirePayment {
  paymentUuid: string;
  status: string; // SETTLED | PAID | RECEIVED | REJECTED | FAILED | ...
  currency: { code: string; description?: string } | string;
  amountBeforeCharges: number; // minor units
  myRef?: string;
  dateCreated?: string;
  dateFundsReceived?: string; // set once the money has actually landed
  [key: string]: unknown;
}

/** GET /business/v2/paymentrequests/{code}/payments — verified shape. */
export interface FirePaymentRequestPayments {
  total: number;
  pisPaymentRequestPayments: FirePayment[];
}

/** A single decoded webhook event. Field names are provisional — confirm against
 *  a real Fire delivery before Phase 4 relies on them (see billing design D4/D5). */
export interface FireWebhookEvent {
  type: string;
  [key: string]: unknown;
}

export class FireApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`Fire API ${status}: ${body.slice(0, 300)}`);
    this.name = "FireApiError";
  }
}

export class FireWebhookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FireWebhookError";
  }
}
