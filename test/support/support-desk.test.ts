import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { auth, createHarness, type Harness } from "./harness.ts";

/** Support chat + ticketing — tenant isolation, the open→reply→close flow, and access control. */

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());
beforeEach(() => h.reload());

async function openTicket(token: string, subject = "Help please", message = "Something is broken") {
  const res = await h.api.post("/api/support/tickets").set(...auth(token)).send({ subject, message });
  expect(res.status).toBe(201);
  return res.body.ticket;
}

describe("access control", () => {
  it("client support API is tenant-users only; platform admin is refused", async () => {
    for (const ep of [
      { m: "get", p: "/api/support/tickets" },
      { m: "get", p: "/api/support/summary" },
      { m: "post", p: "/api/support/tickets", b: { subject: "x", message: "y" } },
    ] as const) {
      expect((await (h.api as any)[ep.m](ep.p)).status, ep.p).toBe(401);
      const admin = await (h.api as any)[ep.m](ep.p).set(...auth(h.tokens.admin)).send((ep as any).b);
      expect(admin.status, ep.p).toBe(403);
    }
  });

  it("admin support API requires the platform admin", async () => {
    expect((await h.api.get("/api/admin/support/tickets")).status).toBe(401);
    expect((await h.api.get("/api/admin/support/tickets").set(...auth(h.tokens.alice))).status).toBe(403);
    expect((await h.api.get("/api/admin/support/tickets").set(...auth(h.tokens.admin))).status).toBe(200);
  });

  it("any tenant user (member included) can open a ticket", async () => {
    const carol = await h.createUser({ tenant: "acme", tenantRole: "member" });
    const t = await openTicket(carol.token);
    expect(t.subject).toBe("Help please");
  });
});

describe("tenant isolation", () => {
  it("Tenant B cannot see, read, or reply to Tenant A's ticket", async () => {
    const t = await openTicket(h.tokens.alice, "ACME only");

    // not in Smith's list
    const bobList = await h.api.get("/api/support/tickets").set(...auth(h.tokens.bob));
    expect(bobList.body.tickets).toHaveLength(0);

    // cannot fetch or post
    expect((await h.api.get(`/api/support/tickets/${t.id}`).set(...auth(h.tokens.bob))).status).toBe(404);
    expect(
      (await h.api.post(`/api/support/tickets/${t.id}/messages`).set(...auth(h.tokens.bob)).send({ body: "peek" })).status,
    ).toBe(404);

    // direct DB: Smith's context sees no ACME ticket rows
    const rows = await h.db.withContext(
      { userId: h.ids.users.bob, tenantId: h.ids.tenants.smith, isAdmin: false, tenantRole: "admin" },
      (q) => q.query("SELECT id FROM support_tickets"),
    );
    expect(rows.rows).toHaveLength(0);
  });

  it("the admin sees every tenant's tickets", async () => {
    await openTicket(h.tokens.alice, "from acme");
    await openTicket(h.tokens.bob, "from smith");
    const all = await h.api.get("/api/admin/support/tickets").set(...auth(h.tokens.admin));
    expect(all.body.tickets.map((t: any) => t.subject).sort()).toEqual(["from acme", "from smith"]);
  });
});

describe("open → reply → close flow", () => {
  it("full lifecycle with unread tracking", async () => {
    const t = await openTicket(h.tokens.alice, "Cannot log in", "help");

    // admin sees 1 unread ticket
    let sum = await h.api.get("/api/admin/support/summary").set(...auth(h.tokens.admin));
    expect(sum.body).toMatchObject({ openCount: 1, ticketsWithUnread: 1 });

    // admin opens it (marks read) then replies
    await h.api.get(`/api/admin/support/tickets/${t.id}`).set(...auth(h.tokens.admin));
    sum = await h.api.get("/api/admin/support/summary").set(...auth(h.tokens.admin));
    expect(sum.body.ticketsWithUnread).toBe(0);

    const reply = await h.api
      .post(`/api/admin/support/tickets/${t.id}/messages`)
      .set(...auth(h.tokens.admin))
      .send({ body: "Try resetting your password." });
    expect(reply.status).toBe(201);

    // tenant now has an unread reply
    const tsum = await h.api.get("/api/support/summary").set(...auth(h.tokens.alice));
    expect(tsum.body.unreadCount).toBe(1);

    // fetching the thread clears it for the tenant
    const thread = await h.api.get(`/api/support/tickets/${t.id}`).set(...auth(h.tokens.alice));
    expect(thread.body.messages).toHaveLength(2);
    expect(thread.body.messages[1].authorKind).toBe("admin");
    expect((await h.api.get("/api/support/summary").set(...auth(h.tokens.alice))).body.unreadCount).toBe(0);

    // admin closes; tenant can no longer post
    const closed = await h.api.post(`/api/admin/support/tickets/${t.id}/close`).set(...auth(h.tokens.admin));
    expect(closed.body.ticket.status).toBe("closed");
    expect(
      (await h.api.post(`/api/support/tickets/${t.id}/messages`).set(...auth(h.tokens.alice)).send({ body: "still there?" })).status,
    ).toBe(409);

    // audit row recorded for the close
    const audit = await h.db.privileged((q) =>
      q.query<{ action: string }>("SELECT action FROM audit_logs WHERE action = 'support.ticket_closed'"),
    );
    expect(audit.rows).toHaveLength(1);

    // reopen lets the conversation continue
    await h.api.post(`/api/admin/support/tickets/${t.id}/reopen`).set(...auth(h.tokens.admin));
    expect(
      (await h.api.post(`/api/support/tickets/${t.id}/messages`).set(...auth(h.tokens.alice)).send({ body: "thanks!" })).status,
    ).toBe(201);
  });

  it("a closed ticket never counts toward the admin badge, even with an unseen message", async () => {
    const t = await openTicket(h.tokens.alice, "Quick question", "is this on?");
    // admin closes straight from the list without opening the thread
    await h.api.post(`/api/admin/support/tickets/${t.id}/close`).set(...auth(h.tokens.admin));

    const sum = await h.api.get("/api/admin/support/summary").set(...auth(h.tokens.admin));
    expect(sum.body).toMatchObject({ openCount: 0, unreadCount: 0, ticketsWithUnread: 0 });
  });

  it("rejects empty / oversized input", async () => {
    for (const b of [{ subject: "", message: "x" }, { subject: "x", message: "" }, { subject: "x", message: "x", extra: 1 }]) {
      expect((await h.api.post("/api/support/tickets").set(...auth(h.tokens.alice)).send(b)).status).toBe(400);
    }
  });
});
