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

/** GET /v1/paymentrequests/{code} — the fields we use for reconciliation. */
export interface FirePaymentRequestDetail {
  code: string;
  status: string; // ACTIVE | EXPIRED | CLOSED | ...
  currency: string;
  amount: number; // minor units
  totalAmountPaid: number; // minor units actually received
  totalAmountAuthorised?: number;
  countTimesPaid: number;
  [key: string]: unknown;
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
