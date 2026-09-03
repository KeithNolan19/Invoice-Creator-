import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { auth, createHarness, type Harness } from "../support/harness.ts";

/**
 * Cross-tenant attack matrix. Every case is run in BOTH directions
 * (Acme -> Smith and Smith -> Acme) so requirement 7 is covered by construction.
 *
 * Covers: 1, 2, 3, 4, 5, 6, 7, 15.
 */

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());
beforeEach(() => h.reload());

type Slug = "acme" | "smith";
interface Direction {
  name: string;
  atk: "alice" | "bob";
  vic: "alice" | "bob";
  atkTenant: Slug;
  vicTenant: Slug;
}

const DIRECTIONS: Direction[] = [
  { name: "Acme user -> Smith data", atk: "alice", vic: "bob", atkTenant: "acme", vicTenant: "smith" },
  { name: "Smith user -> Acme data", atk: "bob", vic: "alice", atkTenant: "smith", vicTenant: "acme" },
];

describe.each(DIRECTIONS)("$name", (dir) => {
  const atkTok = () => h.tokens[dir.atk];
  const vicTok = () => h.tokens[dir.vic];
  const victimInvoices = () => h.ids.invoices[dir.vicTenant];
  const ownInvoices = () => h.ids.invoices[dir.atkTenant];
  const victimTenantId = () => h.ids.tenants[dir.vicTenant];
  const ownTenantId = () => h.ids.tenants[dir.atkTenant];

  // --- 1 / 2 : a tenant user can only read their own tenant's data ---------

  it("invoice list contains only the caller's own tenant", async () => {
    const res = await h.api.get("/api/invoices").set(...auth(atkTok()));
    expect(res.status).toBe(200);
    expect(res.body.invoices.length).toBeGreaterThan(0);
    expect(res.body.invoices.every((i: any) => i.tenantId === ownTenantId())).toBe(true);
  });

  it("user list contains only the caller's own tenant, never the victim's users", async () => {
    const res = await h.api.get("/api/users").set(...auth(atkTok()));
    expect(res.status).toBe(200);
    expect(res.body.users.every((u: any) => u.tenantId === ownTenantId())).toBe(true);
    expect(res.body.users.some((u: any) => u.id === h.ids.users[dir.vic])).toBe(false);
    // password material must never be serialised
    expect(res.body.users.every((u: any) => !("passwordHash" in u) && !("password_hash" in u))).toBe(true);
  });

  it("tenant list contains only the caller's own tenant", async () => {
    const res = await h.api.get("/api/tenants").set(...auth(atkTok()));
    expect(res.status).toBe(200);
    expect(res.body.tenants.map((t: any) => t.id)).toEqual([ownTenantId()]);
  });

  // --- 3 / 15 : cannot reach victim rows by id, path or query param --------

  it("GET /api/invoices/:id on every known victim invoice returns 404", async () => {
    for (const id of victimInvoices()) {
      const res = await h.api.get(`/api/invoices/${id}`).set(...auth(atkTok()));
      expect(res.status).toBe(404);
    }
  });

  it("a victim invoice id stays 404 even with ?tenantId spoofing", async () => {
    const id = victimInvoices()[0]!;
    for (const qs of ["", `?tenantId=${ownTenantId()}`, `?tenantId=${victimTenantId()}`]) {
      const res = await h.api.get(`/api/invoices/${id}${qs}`).set(...auth(atkTok()));
      expect(res.status).toBe(404);
    }
  });

  it("?tenantId=<victim> on the list endpoint is ignored for tenant users", async () => {
    const res = await h.api
      .get(`/api/invoices?tenantId=${victimTenantId()}`)
      .set(...auth(atkTok()));
    expect(res.status).toBe(200);
    expect(res.body.invoices.every((i: any) => i.tenantId === ownTenantId())).toBe(true);

    const users = await h.api.get(`/api/users?tenantId=${victimTenantId()}`).set(...auth(atkTok()));
    expect(users.status).toBe(200);
    expect(users.body.users.every((u: any) => u.tenantId === ownTenantId())).toBe(true);
  });

  it("garbage / injection ids are rejected as 404, not evaluated", async () => {
    for (const raw of ["' OR '1'='1", "1 OR 1=1", "00000000-0000-0000-0000-00000000000X", "..%2f..", "null"]) {
      const res = await h.api
        .get(`/api/invoices/${encodeURIComponent(raw)}`)
        .set(...auth(atkTok()));
      expect(res.status).toBe(404);
    }
  });

  // --- 4 : cannot create an invoice owned by the victim -------------------

  it("POST with tenantId=<victim> in the body is refused and creates nothing", async () => {
    const res = await h.api
      .post("/api/invoices")
      .set(...auth(atkTok()))
      .send({ number: "INJ-1", clientName: "Injected", amountCents: 100, tenantId: victimTenantId() });
    expect(res.status).toBe(400);

    const victimList = await h.api.get("/api/invoices").set(...auth(vicTok()));
    expect(victimList.body.invoices.some((i: any) => i.number === "INJ-1")).toBe(false);
    const ownList = await h.api.get("/api/invoices").set(...auth(atkTok()));
    expect(ownList.body.invoices.some((i: any) => i.number === "INJ-1")).toBe(false);
  });

  it("POST with an unknown key (snake_case tenant_id mass-assignment) is refused", async () => {
    const res = await h.api
      .post("/api/invoices")
      .set(...auth(atkTok()))
      .send({ number: "INJ-2", clientName: "x", amountCents: 1, tenant_id: victimTenantId() });
    expect(res.status).toBe(400);
  });

  it("a legitimate POST is always stamped with the caller's own tenant", async () => {
    const res = await h.api
      .post("/api/invoices")
      .set(...auth(atkTok()))
      .send({ number: "OWN-1", clientName: "Legit", amountCents: 100 });
    expect(res.status).toBe(201);
    expect(res.body.invoice.tenantId).toBe(ownTenantId());
  });

  // --- 5 : cannot modify a victim invoice --------------------------------

  it("PATCH on a victim invoice returns 404 and leaves it untouched", async () => {
    const target = victimInvoices()[0]!;
    const before = await h.api.get(`/api/invoices/${target}`).set(...auth(vicTok()));
    expect(before.status).toBe(200);

    const attack = await h.api
      .patch(`/api/invoices/${target}`)
      .set(...auth(atkTok()))
      .send({ clientName: "PWNED", amountCents: 999_999_99, status: "void" });
    expect(attack.status).toBe(404);

    const after = await h.api.get(`/api/invoices/${target}`).set(...auth(vicTok()));
    expect(after.body.invoice.clientName).toBe(before.body.invoice.clientName);
    expect(after.body.invoice.amountCents).toBe(before.body.invoice.amountCents);
    expect(after.body.invoice.status).toBe(before.body.invoice.status);
  });

  it("PATCH cannot move the caller's own invoice into the victim tenant", async () => {
    const own = ownInvoices()[0]!;
    const res = await h.api
      .patch(`/api/invoices/${own}`)
      .set(...auth(atkTok()))
      .send({ tenantId: victimTenantId() });
    expect(res.status).toBe(400); // unknown key rejected before it reaches SQL

    const after = await h.api.get(`/api/invoices/${own}`).set(...auth(atkTok()));
    expect(after.body.invoice.tenantId).toBe(ownTenantId());
  });

  // --- 6 : cannot delete a victim invoice --------------------------------

  it("DELETE on a victim invoice returns 404 and the row survives", async () => {
    const target = victimInvoices()[0]!;
    const attack = await h.api.delete(`/api/invoices/${target}`).set(...auth(atkTok()));
    expect(attack.status).toBe(404);

    const stillThere = await h.api.get(`/api/invoices/${target}`).set(...auth(vicTok()));
    expect(stillThere.status).toBe(200);
  });

  it("DELETE on every known victim invoice id fails", async () => {
    for (const id of victimInvoices()) {
      const res = await h.api.delete(`/api/invoices/${id}`).set(...auth(atkTok()));
      expect(res.status).toBe(404);
    }
    const victimList = await h.api.get("/api/invoices").set(...auth(vicTok()));
    expect(victimList.body.invoices.length).toBe(victimInvoices().length);
  });
});
