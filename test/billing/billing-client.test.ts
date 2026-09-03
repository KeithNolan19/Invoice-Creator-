import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SYSTEM_CONTEXT } from "../../src/db/system-context.ts";
import { getPlanByCode } from "../../src/modules/billing/plans.repo.ts";
import { setSubscription } from "../../src/modules/billing/subscriptions.repo.ts";
import {
  allocatePlatformInvoiceNumber,
  insertPlatformInvoice,
  setPlatformInvoiceStatus,
} from "../../src/modules/billing/platform-invoices.repo.ts";
import { auth, createHarness, type Harness } from "../support/harness.ts";

/** The tenant-facing view of their own platform subscription + invoices. */

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());
beforeEach(() => h.reload());

async function giveAcmeAnIssuedInvoice(amountCents = 1000) {
  return h.db.withContext(SYSTEM_CONTEXT, async (q) => {
    const plan = await getPlanByCode(q, "starter");
    await setSubscription(q, {
      tenantId: h.ids.tenants.acme,
      planId: plan!.id,
      billingInterval: "month",
      createdBy: h.ids.users.admin,
    });
    const number = await allocatePlatformInvoiceNumber(q);
    const inv = await insertPlatformInvoice(q, {
      tenantId: h.ids.tenants.acme,
      number,
      subscriptionId: null,
      kind: "adhoc",
      dueDate: "2026-01-01",
      description: "Subscription — January",
      currency: "EUR",
      amountCents,
      createdBy: h.ids.users.admin,
    });
    await setPlatformInvoiceStatus(q, inv!.id, "issued");
    return inv!.id;
  });
}

describe("client billing — access control", () => {
  it("needs a tenant user; the platform admin is refused", async () => {
    expect((await h.api.get("/api/billing")).status).toBe(401);
    expect((await h.api.get("/api/billing").set(...auth(h.tokens.admin))).status).toBe(403);
    expect((await h.api.get("/api/billing").set(...auth(h.tokens.alice))).status).toBe(200);
  });
});

describe("client billing — own data only", () => {
  it("returns the caller's subscription + invoices, not another tenant's", async () => {
    const invId = await giveAcmeAnIssuedInvoice(1500);

    const acme = await h.api.get("/api/billing").set(...auth(h.tokens.alice));
    expect(acme.status).toBe(200);
    expect(acme.body.subscription.plan.code).toBe("starter");
    expect(acme.body.invoices.map((i: any) => i.id)).toContain(invId);
    expect(acme.body.amountDueCents).toBe(1500);

    const smith = await h.api.get("/api/billing").set(...auth(h.tokens.bob));
    expect(smith.status).toBe(200);
    expect(smith.body.subscription).toBeNull();
    expect(smith.body.invoices).toHaveLength(0);
    expect(smith.body.amountDueCents).toBe(0);
  });

  it("a member of the tenant can view billing", async () => {
    await giveAcmeAnIssuedInvoice();
    const carol = await h.createUser({ tenant: "acme", tenantRole: "member" });
    const res = await h.api.get("/api/billing").set(...auth(carol.token));
    expect(res.status).toBe(200);
    expect(res.body.invoices).toHaveLength(1);
  });
});

describe("client billing — pay link", () => {
  it("404s for an invoice that isn't the tenant's", async () => {
    const invId = await giveAcmeAnIssuedInvoice();
    const res = await h.api
      .post(`/api/billing/invoices/${invId}/payment-link`)
      .set(...auth(h.tokens.bob));
    expect(res.status).toBe(404);
  });

  it("returns a helpful error when Fire.com isn't configured", async () => {
    const invId = await giveAcmeAnIssuedInvoice();
    const res = await h.api
      .post(`/api/billing/invoices/${invId}/payment-link`)
      .set(...auth(h.tokens.alice));
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/contact support/i);
  });
});
