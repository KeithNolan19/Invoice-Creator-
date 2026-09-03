import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SEED_PASSWORD } from "../../src/db/seed.ts";
import { isOnline } from "../../src/modules/users/users.repo.ts";
import { auth, createHarness, type Harness } from "../support/harness.ts";

/** Admin presence — "is this user currently signed in?" */

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());
beforeEach(() => h.reload());

const admin = () => auth(h.tokens.admin);

async function acmeUsers() {
  const res = await h.api.get(`/api/admin/tenants/${h.ids.tenants.acme}`).set(...admin());
  expect(res.status).toBe(200);
  return res.body.users as Array<Record<string, any>>;
}

/** The presence write is fire-and-forget; give it a moment to commit. The VPS
 *  runs PGlite through swap, so be patient (still well under the test timeout). */
async function eventually<T>(fn: () => Promise<T>, pred: (v: T) => boolean, tries = 150): Promise<T> {
  let v = await fn();
  for (let i = 0; i < tries && !pred(v); i++) {
    await new Promise((r) => setTimeout(r, 100));
    v = await fn();
  }
  return v;
}

describe("isOnline", () => {
  const now = Date.now();
  const ago = (ms: number) => new Date(now - ms).toISOString();

  it("is true only for a recent sighting", () => {
    expect(isOnline(ago(30_000))).toBe(true);
    expect(isOnline(ago(10 * 60_000))).toBe(false);
    expect(isOnline(null)).toBe(false);
  });

  it("is false when the last sighting predates a sign-out / revocation", () => {
    expect(isOnline(ago(60_000), ago(30_000))).toBe(false); // signed out 30s ago
    expect(isOnline(ago(30_000), ago(60_000))).toBe(true); // seen since last sign-out
    expect(isOnline(ago(30_000), null)).toBe(true);
  });
});

describe("user presence", () => {
  it("a freshly seeded user has never been seen", async () => {
    const alice = (await acmeUsers()).find((u) => u.email === "alice@acme.test")!;
    expect(alice.lastSeenAt).toBeNull();
    expect(alice.online).toBe(false);
  });

  it("an authenticated request marks the user online", async () => {
    await h.api.get("/api/dashboard").set(...auth(h.tokens.alice));

    const alice = await eventually(
      async () => (await acmeUsers()).find((u) => u.email === "alice@acme.test")!,
      (u) => u.online === true,
    );
    expect(alice.online).toBe(true);
    expect(alice.lastSeenAt).not.toBeNull();
    expect(Date.now() - new Date(alice.lastSeenAt).getTime()).toBeLessThan(60_000);
  });

  it("signing out drops the user offline immediately", async () => {
    await h.api.get("/api/dashboard").set(...auth(h.tokens.alice));
    let alice = await eventually(
      async () => (await acmeUsers()).find((u) => u.email === "alice@acme.test")!,
      (u) => u.online === true,
    );
    expect(alice.online).toBe(true);

    await h.api.post("/api/auth/logout").set(...auth(h.tokens.alice));

    alice = await eventually(
      async () => (await acmeUsers()).find((u) => u.email === "alice@acme.test")!,
      (u) => u.online === false,
    );
    expect(alice.online).toBe(false);
    // still shows when they were last around
    expect(alice.lastSeenAt).not.toBeNull();
  });

  it("login records lastLoginAt", async () => {
    const res = await h.api
      .post("/api/auth/login")
      .send({ email: "alice@acme.test", password: SEED_PASSWORD });
    expect(res.status).toBe(200);

    const alice = await eventually(
      async () => (await acmeUsers()).find((u) => u.email === "alice@acme.test")!,
      (u) => u.lastLoginAt != null,
    );
    expect(alice.lastLoginAt).not.toBeNull();
  });

  it("the dashboard counts who is online", async () => {
    // The admin request itself marks the admin online, so start from that.
    const before = (await h.api.get("/api/admin/dashboard").set(...admin())).body.stats.users.online;

    await h.api.get("/api/dashboard").set(...auth(h.tokens.alice));
    await h.api.get("/api/team/members").set(...auth(h.tokens.bob));

    const stats = await eventually(
      async () => (await h.api.get("/api/admin/dashboard").set(...admin())).body.stats,
      (s) => s.users.online >= before + 2,
    );
    expect(stats.users.online).toBe(before + 2);
  });
});
