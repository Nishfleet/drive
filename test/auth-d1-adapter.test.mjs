// Behavioural proofs for the D1 Better Auth adapter (drive#758). The sign-in
// tests already walk create / find / consume / increment through the Worker.
// These hit the operators and guards those paths do not.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createTestAuth, signIn } from "./harness.mjs";

/** @param {string} path */
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("the D1 adapter keeps the Kysely sqlite serialization flags", () => {
  const ours = read("core/auth-d1-adapter.js");
  const kysely = read("node_modules/@better-auth/kysely-adapter/dist/index.mjs");
  assert.match(ours, /supportsBooleans:\s*false/);
  assert.match(ours, /supportsDates:\s*false/);
  assert.match(ours, /supportsJSON:\s*false/);
  assert.match(
    kysely,
    /supportsBooleans:\s*config\?\.type === "sqlite"/,
    "kysely-adapter still treats sqlite booleans as 0/1",
  );
  assert.match(
    kysely,
    /supportsDates:\s*config\?\.type === "sqlite"/,
    "kysely-adapter still treats sqlite dates as strings",
  );
});

test("a session row reads back as the account the link minted", async () => {
  const made = createTestAuth();
  const { cookie, account } = await signIn(made, "map@example.com");
  const found = await made.auth.api.getSession({ headers: new Headers({ cookie }) });
  assert.ok(found);
  assert.equal(found.user.email, "map@example.com");
  assert.equal(found.user.id, account.id);
  assert.equal(found.user.emailVerified, true);
  const stored =
    /** @type {{email: string, emailVerified: number, createdAt: string} | undefined} */ (
      made.db.sqlite
        .prepare("SELECT email, emailVerified, createdAt FROM user WHERE id = ?")
        .get(account.id)
    );
  assert.ok(stored);
  assert.equal(stored.email, "map@example.com");
  // What the two `supports*` flags above are for, proved on the row rather
  // than on the package's source: the column is the 0/1 the shipped migration
  // declares, and the date is the ISO string D1 stores, both read back as the
  // types the browser side of a sign-in expects.
  assert.equal(stored.emailVerified, 1);
  assert.match(stored.createdAt, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
});

test("contains treats % as a literal and offset skips the first row", async () => {
  const made = createTestAuth();
  const ctx = await made.auth.$context;
  const now = new Date();
  for (const email of ["alpha@example.com", "100%@example.com", "beta@example.com"]) {
    await ctx.adapter.create({
      model: "user",
      data: { name: email, email, emailVerified: false, createdAt: now, updatedAt: now },
    });
  }
  const percents = await ctx.adapter.findMany({
    model: "user",
    where: [{ field: "email", value: "100%", operator: "contains" }],
  });
  assert.deepEqual(
    percents.map((row) => row.email),
    ["100%@example.com"],
  );
  const page = await ctx.adapter.findMany({
    model: "user",
    where: [{ field: "email", value: "@example.com", operator: "contains" }],
    sortBy: { field: "email", direction: "asc" },
    limit: 1,
    offset: 1,
  });
  assert.equal(page.length, 1);
  assert.equal(page[0].email, "alpha@example.com");
});

test("an empty deleteMany leaves every user row", async () => {
  const made = createTestAuth();
  await signIn(made, "keep@example.com");
  const ctx = await made.auth.$context;
  const removed = await ctx.adapter.deleteMany({ model: "user", where: [] });
  assert.equal(removed, 0);
  assert.equal(await ctx.adapter.count({ model: "user" }), 1);
});

test("an empty filter on consumeOne and incrementOne changes no row", async () => {
  const made = createTestAuth();
  await signIn(made, "rows@example.com");
  const ctx = await made.auth.$context;
  const now = new Date();
  // The rows the two methods touch on a real request: consumeOne spends a
  // one-time sign-in link out of `verification`, and incrementOne counts the
  // rate-limit row. Both pick their row through an id subquery, so an empty
  // filter would pick the oldest row in the table instead of the one the
  // caller named — here, somebody else's sign-in link.
  await ctx.adapter.create({
    model: "verification",
    data: {
      identifier: "rows@example.com",
      value: "a-link-token",
      expiresAt: now,
      createdAt: now,
      updatedAt: now,
    },
  });
  await ctx.adapter.create({
    model: "rateLimit",
    data: { key: "rows@example.com", count: 1, lastRequest: 1 },
  });
  assert.equal(await ctx.adapter.consumeOne({ model: "verification", where: [] }), null);
  assert.equal(
    await ctx.adapter.incrementOne({ model: "rateLimit", where: [], increment: { count: 41 } }),
    null,
  );
  assert.equal(
    await ctx.adapter.incrementOne({
      model: "rateLimit",
      where: [],
      increment: {},
      set: { key: "someone-else" },
    }),
    null,
  );
  assert.equal(await ctx.adapter.count({ model: "verification" }), 1);
  const link = /** @type {{value: string} | undefined} */ (
    made.db.sqlite.prepare("SELECT value FROM verification").get()
  );
  assert.equal(link?.value, "a-link-token");
  const rate = /** @type {{key: string, count: number} | undefined} */ (
    made.db.sqlite.prepare("SELECT key, count FROM rateLimit").get()
  );
  assert.equal(rate?.key, "rows@example.com");
  assert.equal(rate?.count, 1);
  // The same call with a filter still counts, so the guard refuses the empty
  // one rather than turning the whole method off.
  const counted = await ctx.adapter.incrementOne({
    model: "rateLimit",
    where: [{ field: "key", value: "rows@example.com" }],
    increment: { count: 1 },
  });
  assert.equal(counted?.count, 2);
});

test("a join answers in the shape its relation names", async () => {
  const made = createTestAuth();
  const { account } = await signIn(made, "join@example.com");
  const ctx = await made.auth.$context;
  const now = new Date();
  await ctx.adapter.create({
    model: "account",
    data: {
      accountId: "credential-1",
      providerId: "credential",
      userId: account.id,
      createdAt: now,
      updatedAt: now,
    },
  });
  // Both joins go through Better Auth's own factory (`join: {user: true}` is
  // what the session lookup in internal-adapter.mjs sends), and the factory
  // writes `relation: isUnique ? "one-to-one" : "one-to-many"`
  // (@better-auth/core db/adapter/factory.ts) — the value the adapter checks.
  // A session's user is the one-to-one case, and it has to come back as the
  // object sign-in reads `.email` off; a user's accounts are the collection
  // case, and it has to come back as the array a caller iterates.
  const withUser = await ctx.adapter.findOne({
    model: "session",
    where: [{ field: "userId", value: account.id }],
    join: { user: true },
  });
  assert.equal(typeof withUser.user, "object");
  assert.equal(withUser.user.email, "join@example.com");
  const withAccounts = await ctx.adapter.findOne({
    model: "user",
    where: [{ field: "id", value: account.id }],
    join: { account: true },
  });
  assert.ok(Array.isArray(withAccounts.account));
  assert.equal(withAccounts.account.length, 1);
  assert.equal(withAccounts.account[0].providerId, "credential");
});
