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
  const stored = /** @type {{email: string, emailVerified: number} | undefined} */ (
    made.db.sqlite.prepare("SELECT email, emailVerified FROM user WHERE id = ?").get(account.id)
  );
  assert.ok(stored);
  assert.equal(stored.email, "map@example.com");
  assert.equal(stored.emailVerified, 1);
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
