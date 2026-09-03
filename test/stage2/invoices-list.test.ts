import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { auth, createHarness, type Harness } from "../support/harness.ts";

/** Stage 2 — the invoice list foundation: new filters + the richer serialized shape. */

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());
beforeEach(() => h.reload());

async function shape() {
  await h.db.privileged(async (q) => {
    const acme = h.ids.tenants.acme;
    await q.query(`UPDATE invoices SET status='sent', payment_status='unpaid', due_on = current_date - 3 WHERE tenant_id=$1 AND number='ACME-0001'`, [acme]);
    await q.query(`UPDATE invoices SET status='sent', payment_status='pending' WHERE tenant_id=$1 AND number='ACME-0002'`, [acme]);
    await q.query(
      `INSERT INTO invoices (tenant_id, number, client_name, amount_cents, subtotal_cents, total_cents, currency, status, payment_status, paid_at, issued_on)
       VALUES ($1,'ACME-0003','C',10000,10000,10000,'EUR','paid','paid', now(), current_date),
              ($1,'ACME-0004','D',20000,20000,20000,'EUR','draft','unpaid', null, current_date)`,
      [acme]);
  });
}

describe("serialized shape", () => {
  it("carries paymentStatus, overdue, customerName and totalCents", async () => {
    await shape();
    const { invoices } = (await h.api.get("/api/invoices").set(...auth(h.tokens.alice))).body;
    const byNum = Object.fromEntries(invoices.map((i: any) => [i.number, i]));

    expect(byNum["ACME-0001"]).toMatchObject({ status: "sent", paymentStatus: "unpaid", overdue: true });
    expect(byNum["ACME-0002"]).toMatchObject({ paymentStatus: "pending", overdue: false });
    expect(byNum["ACME-0003"]).toMatchObject({ status: "paid", paymentStatus: "paid" });
    expect(byNum["ACME-0004"]).toMatchObject({ status: "draft" });
    for (const i of invoices) {
      expect(typeof i.totalCents).toBe("number");
      expect(i).toHaveProperty("customerName");
      expect(i).not.toHaveProperty("password_hash");
    }
  });
});

describe("filters", () => {
  beforeEach(shape);

  it("status=draft returns only drafts", async () => {
    const { invoices } = (await h.api.get("/api/invoices?status=draft").set(...auth(h.tokens.alice))).body;
    expect(invoices.map((i: any) => i.number)).toEqual(["ACME-0004"]);
  });

  it("paymentStatus=paid returns only paid invoices", async () => {
    const { invoices } = (await h.api.get("/api/invoices?paymentStatus=paid").set(...auth(h.tokens.alice))).body;
    expect(invoices.map((i: any) => i.number)).toEqual(["ACME-0003"]);
  });

  it("paymentStatus=unpaid excludes drafts (only issued & unpaid)", async () => {
    const { invoices } = (await h.api.get("/api/invoices?paymentStatus=unpaid").set(...auth(h.tokens.alice))).body;
    expect(invoices.map((i: any) => i.number)).toEqual(["ACME-0001"]);
  });

  it("paymentStatus=pending returns pending", async () => {
    const { invoices } = (await h.api.get("/api/invoices?paymentStatus=pending").set(...auth(h.tokens.alice))).body;
    expect(invoices.map((i: any) => i.number)).toEqual(["ACME-0002"]);
  });

  it("search matches invoice number", async () => {
    const { invoices } = (await h.api.get("/api/invoices?search=ACME-0003").set(...auth(h.tokens.alice))).body;
    expect(invoices.map((i: any) => i.number)).toEqual(["ACME-0003"]);
  });

  it("rejects an unknown filter value", async () => {
    expect((await h.api.get("/api/invoices?status=bogus").set(...auth(h.tokens.alice))).status).toBe(400);
    expect((await h.api.get("/api/invoices?paymentStatus=bogus").set(...auth(h.tokens.alice))).status).toBe(400);
  });
});

describe("tenant isolation is unchanged", () => {
  it("filters never leak another tenant's invoices", async () => {
    await shape();
    for (const q of ["", "?status=draft", "?paymentStatus=paid", "?paymentStatus=unpaid", "?search=ACME"]) {
      const { invoices } = (await h.api.get(`/api/invoices${q}`).set(...auth(h.tokens.alice))).body;
      expect(invoices.every((i: any) => i.tenantId === h.ids.tenants.acme), q).toBe(true);
    }
    // Bob still sees only Smith
    const bob = (await h.api.get("/api/invoices").set(...auth(h.tokens.bob))).body;
    expect(bob.invoices.every((i: any) => i.tenantId === h.ids.tenants.smith)).toBe(true);
  });
});
