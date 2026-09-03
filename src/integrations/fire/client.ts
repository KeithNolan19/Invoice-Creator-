import { createHash } from "node:crypto";
import { config } from "../../config.ts";
import {
  type CreatePaymentRequestInput,
  type FireAccessToken,
  FireApiError,
  type FireCredentials,
  type FirePaymentRequestDetail,
  type FirePaymentRequestPayments,
  type PaymentRequestCreated,
} from "./types.ts";

/**
 * Thin Fire.com Business API client. One instance per set of credentials
 * (the platform holds exactly one set — see platform_billing_config).
 *
 * All calls are server-side. Access tokens are minted per instance and cached
 * until ~30s before expiry; they are never persisted. `clientKey` and access
 * tokens are never logged.
 *
 * Verified endpoints — all under /business (the docs show some paths relative
 * to a `https://api.fire.com/business` server base; probed against the live API):
 *   auth:    POST {api}/business/v1/apps/accesstokens
 *   create:  POST {api}/business/v1/paymentrequests
 *   detail:  GET  {api}/business/v1/paymentrequests/{code}  -> { status, amount, totalAmountPaid, countTimesPaid, ... }
 *   payments:GET  {api}/business/v2/paymentrequests/{code}/payments
 */
export class FireClient {
  private token?: { value: string; expiresAtMs: number };
  private lastNonce = 0;

  constructor(
    private readonly creds: FireCredentials,
    private readonly apiBaseUrl: string = config.fire.apiBaseUrl,
  ) {}

  private nextNonce(): string {
    // Must be non-repeating and increasing. Unix millis, bumped if called twice
    // within the same millisecond.
    const now = Date.now();
    this.lastNonce = now > this.lastNonce ? now : this.lastNonce + 1;
    return String(this.lastNonce);
  }

  async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAtMs > Date.now() + 30_000) {
      return this.token.value;
    }
    const nonce = this.nextNonce();
    const clientSecret = createHash("sha256").update(nonce + this.creds.clientKey).digest("hex");

    const res = await fetch(`${this.apiBaseUrl}/business/v1/apps/accesstokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        clientId: this.creds.clientId,
        refreshToken: this.creds.refreshToken,
        nonce,
        clientSecret,
        grantType: "AccessToken",
      }),
    });
    if (!res.ok) throw new FireApiError(res.status, await safeText(res));
    const body = (await res.json()) as FireAccessToken;
    const expiresAtMs = Date.parse(body.expiry) || Date.now() + 15 * 60 * 1000;
    this.token = { value: body.accessToken, expiresAtMs };
    return body.accessToken;
  }

  /** Verifies the credentials work; returns the safe parts of the token response. */
  async verifyCredentials(): Promise<Pick<FireAccessToken, "businessId" | "apiApplicationId" | "permissions" | "expiry">> {
    const nonce = this.nextNonce();
    const clientSecret = createHash("sha256").update(nonce + this.creds.clientKey).digest("hex");
    const res = await fetch(`${this.apiBaseUrl}/business/v1/apps/accesstokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        clientId: this.creds.clientId,
        refreshToken: this.creds.refreshToken,
        nonce,
        clientSecret,
        grantType: "AccessToken",
      }),
    });
    if (!res.ok) throw new FireApiError(res.status, await safeText(res));
    const body = (await res.json()) as FireAccessToken;
    this.token = {
      value: body.accessToken,
      expiresAtMs: Date.parse(body.expiry) || Date.now() + 15 * 60 * 1000,
    };
    return {
      businessId: body.businessId,
      apiApplicationId: body.apiApplicationId,
      permissions: body.permissions,
      expiry: body.expiry,
    };
  }

  private async authed(path: string, init: RequestInit = {}): Promise<unknown> {
    const token = await this.accessToken();
    const res = await fetch(`${this.apiBaseUrl}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) throw new FireApiError(res.status, await safeText(res));
    return res.status === 204 ? {} : res.json();
  }

  createPaymentRequest(input: CreatePaymentRequestInput): Promise<PaymentRequestCreated> {
    return this.authed("/business/v1/paymentrequests", {
      method: "POST",
      body: JSON.stringify({
        type: "OTHER",
        icanTo: input.icanTo,
        currency: input.currency,
        amount: input.amountMinor,
        myRef: input.myRef,
        description: input.description.slice(0, 18),
        maxNumberPayments: 1,
        ...(input.expiry ? { expiry: input.expiry } : {}),
        ...(input.returnUrl ? { returnUrl: input.returnUrl } : {}),
      }),
    }) as Promise<PaymentRequestCreated>;
  }

  /** Reconciliation poll — payment-request summary (`status: "PAID"` when done). */
  getPaymentRequest(code: string): Promise<FirePaymentRequestDetail> {
    return this.authed(`/business/v1/paymentrequests/${encodeURIComponent(code)}`) as Promise<FirePaymentRequestDetail>;
  }

  /** Reconciliation poll — the individual payments made against a request. */
  getPaymentRequestPayments(code: string): Promise<FirePaymentRequestPayments> {
    return this.authed(
      `/business/v2/paymentrequests/${encodeURIComponent(code)}/payments`,
    ) as Promise<FirePaymentRequestPayments>;
  }

  hostedUrlFor(code: string): string {
    return `${config.fire.paymentsBaseUrl}/${code}`;
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
