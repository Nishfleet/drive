// The sign-in stack on Better Auth, over the customer database (drive issue
// #181, split from #161 after that issue timed out at 55 minutes with nothing
// pushed). Six proofs, each against a real SQLite engine with the shipped
// migrations applied — D1 is SQLite, so the SQL these tests run is the SQL the
// Worker runs:
//
//   1. The shipped migrations are the schema Better Auth's own planner expects.
//   2. A link works once.
//   3. A link expires.
//   4. A session survives a Worker restart (a new isolate, a new instance of
//      src/auth.js, and the same database).
//   5. Sign-out kills the session.
//   6. Deny by default: an unknown cookie, a foreign database, and a
//      deployment with no auth at all all read as signed out.

import assert from "node:assert/strict";
import { test } from "node:test";
import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { magicLink, twoFactor } from "better-auth/plugins";
import { authFor, createAuth, SIGNIN_LINK_PATH, sessionAccount } from "../src/auth.js";
import worker from "../src/index.js";
import {
  createTestAuth,
  createTestD1,
  DRIVE_SCHEMA_MIGRATIONS,
  signIn,
  TEST_BASE_URL,
} from "./harness.mjs";

/** The ExportedHandler type makes fetch optional and declares the runtime's
 * three arguments. Tests drive the Worker directly, so one wrapper supplies
 * the no-op execution context the platform would and keeps those facts out
 * of every call site; `worker.fetch` is optional and carries the runtime's
 * strict Request generic, which a `new Request(...)` literal cannot express.
 * @type {(request: Request, env?: unknown, ctx?: {waitUntil(promise: Promise<unknown>): void, passThroughOnException(): void}) => Promise<Response>}
 */
const workerFetch =
  /** @type {(request: Request, env?: unknown, ctx?: {waitUntil(promise: Promise<unknown>): void, passThroughOnException(): void}) => Promise<Response>} */ (
    /** @type {unknown} */ (worker.fetch)
  );

const SECRET = "drive-test-secret-not-used-outside-the-test-suite";

const headers = () => new Headers({ origin: TEST_BASE_URL });

// --------------------------------------------------------------- the schema

test("the shipped migrations are the schema Better Auth's own planner expects", async () => {
  // Better Auth resolves the schema its plugins demand against the database's
  // own tables — a Kysely introspection of the real SQLite file the shim holds
  // — and the library refuses to answer at all (SCHEMA_MISMATCH) when a table
  // or column it needs is missing. That reflection is the pin: the shipped
  // migration files, applied the way `wrangler d1 migrations apply` applies
  // them, must leave the planner with nothing to do. A library upgrade that
  // changes the schema fails here, at the migration, rather than at the first
  // sign-in or the first rate-limited send (drive#200: the rateLimit table
  // when storage is "database"; drive#524: `twoFactor` and `passkey`, and the
  // user.twoFactorEnabled column).
  const instance = betterAuth({
    database: createTestD1({
      // The two files that hold the sign-in flow's schema, plus the
      // second-factor file, are the set the library's model covers: 0005 has
      // the core tables (already applied by every deployment, so the
      // two-factor columns land as an ALTER in 0026 instead), 0011 the
      // rateLimit table, and 0026 what the second-factor and passkey plugins
      // read.
      migrations: [
        "drive/0005_better_auth.sql",
        "drive/0011_rate_limit.sql",
        "drive/0026_two_factor_passkey.sql",
      ],
    }),
    secret: SECRET,
    baseURL: TEST_BASE_URL,
    emailAndPassword: { enabled: false },
    appName: "drive",
    // Mirrors the option in src/auth.js: the rate-limit counters are stored
    // in D1, so the planner expects the rateLimit table too.
    rateLimit: { storage: "database" },
    // The whole plugin set src/auth.js mounts, in the same order: a drift in
    // this list makes the planner expect a schema the migration files do not
    // carry, which is exactly what this test exists to catch.
    plugins: [
      magicLink({ sendMagicLink: async () => {} }),
      twoFactor({ allowPasswordless: true }),
      passkey({ rpID: "drive.test", rpName: "drive", origin: TEST_BASE_URL }),
    ],
  });
  const plan = await getMigrations(
    /** @type {Parameters<typeof getMigrations>[0]} */ (/** @type {unknown} */ (instance.options)),
  );
  assert.deepEqual(
    {
      created: plan.toBeCreated,
      added: plan.toBeAdded,
      addedIndexes: plan.toBeAddedIndexes,
    },
    { created: [], added: [], addedIndexes: [] },
    "a shipped migration file drifted from what the plugin set expects",
  );
});

// ------------------------------------------------------------- a link works

test("a sign-in link works once", async () => {
  const made = createTestAuth();
  await made.auth.api.signInMagicLink({ body: { email: "once@example.com" }, headers: headers() });
  const token = new URL(made.sent[0].url).searchParams.get("token");
  assert.ok(token, "a token is a single opaque string");
  assert.match(token, /^[A-Za-z0-9]+$/, "a token is a single opaque string");
  assert.equal(
    made.sent[0].to,
    "once@example.com",
    "the link is addressed to the person who asked",
  );

  const first = await made.auth.api.magicLinkVerify({
    query: { token },
    headers: headers(),
    asResponse: true,
  });
  assert.equal(first.status, 200, "the first follow of the link signs the person in");
  const cookie = first.headers.getSetCookie()[0];
  assert.ok(cookie, "the first follow sets a session cookie");
  const found = await made.auth.api.getSession({ headers: new Headers({ cookie }) });
  assert.ok(found);
  assert.equal(
    found.user.email,
    "once@example.com",
    "the session names the account the link was for",
  );

  // The second follow of the same link is the spent one: the token was
  // consumed on the first verification, so there is no second session to
  // mint and no way to replay a forwarded email into an account.
  const second = await made.auth.api.magicLinkVerify({
    query: { token },
    headers: headers(),
    asResponse: true,
  });
  assert.notEqual(second.status, 200, "the second follow must not sign in");
  assert.equal(second.headers.getSetCookie().length, 0, "the second follow mints no session");
  // The first person keeps the session the first follow gave them; the replay
  // does not mint a second one, which is what stops a forwarded email being
  // used to hold two live sessions against one account (this is the one
  // session that exists below, verified next).
  const kept = await made.auth.api.getSession({ headers: new Headers({ cookie }) });
  assert.ok(kept);
  assert.equal(
    kept.user.email,
    "once@example.com",
    "the first session still belongs to the person",
  );
  const rows = made.db.sqlite.prepare("select count(*) c from session").all();
  assert.equal(rows[0].c, 1, "exactly one session exists in the database");
});

// ------------------------------------------------------------------ expiry

test("a link expires", async () => {
  const made = createTestAuth();
  await made.auth.api.signInMagicLink({ body: { email: "slow@example.com" }, headers: headers() });
  const token = new URL(made.sent[0].url).searchParams.get("token");
  assert.ok(token);
  // The link's own timestamp is what Better Auth reads, and the row is what
  // the database holds, so expiry is a database fact the test moves rather
  // than a fake clock: makesignin worked, then the link grew old.
  const expired = await made.db
    .prepare("update verification set expiresAt = ? where identifier = ?")
    .bind("2020-01-01T00:00:00.000Z", `magic-link:${token}`)
    .run();
  assert.ok(expired, "the link's row is in the database");
  const late = await made.auth.api.magicLinkVerify({
    query: { token },
    headers: headers(),
    asResponse: true,
  });
  assert.notEqual(late.status, 200, "an expired link must not sign in");
  assert.equal(late.headers.getSetCookie().length, 0, "an expired link mints no session");
  assert.equal(made.db.sqlite.prepare("select count(*) c from session").all()[0].c, 0);
});

// ----------------------------------------------- a session survives a restart

test("a session survives a Worker restart", async () => {
  // A new isolate is a new instance of src/auth.js over the same database:
  // the session lives in the database, not in the object, which is the whole
  // reason the hand-written store would not do.
  const made = createTestAuth();
  const { cookie, account } = await signIn(made, "persisting@example.com");
  const before = await sessionAccount(
    new Request(`${TEST_BASE_URL}/api/first-run-status`, { headers: { cookie } }),
    made.auth,
  );
  assert.ok(before);
  assert.equal(before.email, "persisting@example.com");

  // The "restart": the same database, a brand new auth built from scratch, and
  // the fresh one still recognizes the cookie.
  const restarted = createAuth({
    database: made.db,
    secret: SECRET,
    baseURL: TEST_BASE_URL,
    sendLink: async () => {},
  });
  const after = await sessionAccount(
    new Request(`${TEST_BASE_URL}/api/first-run-status`, { headers: { cookie } }),
    restarted,
  );
  assert.ok(after, "the session is still valid after the restart");
  assert.equal(after.id, account.id, "it is the same account");
  assert.equal(after.email, "persisting@example.com");

  // And the session rows are really on disk, not in a Map the old instance
  // happened to hold: the new auth read them from the table.
  const rows = made.db.sqlite.prepare("select count(*) c from session").all();
  assert.equal(rows[0].c, 1);
});

// ------------------------------------------------------------------ sign-out

test("sign-out kills the session", async () => {
  const made = createTestAuth();
  const { cookie } = await signIn(made, "leaver@example.com");
  const before = await sessionAccount(
    new Request(`${TEST_BASE_URL}/api/first-run-status`, { headers: { cookie } }),
    made.auth,
  );
  assert.ok(before);
  assert.equal(before.email, "leaver@example.com", "the session works before signing out");
  const out = await made.auth.api.signOut({ headers: new Headers({ cookie }), asResponse: true });
  assert.equal(out.status, 200, "sign-out answers ok");
  const cleared = out.headers.getSetCookie().join("\n");
  assert.match(cleared, /__Secure-drive\.session_token=;/, "sign-out clears the session cookie");
  const after = await sessionAccount(
    new Request(`${TEST_BASE_URL}/api/first-run-status`, { headers: { cookie } }),
    made.auth,
  );
  assert.equal(after, null, "the old cookie is not a session after sign-out");
  const rows = made.db.sqlite.prepare("select count(*) c from session").all();
  assert.equal(rows[0].c, 0, "the session row is gone from the database, not just unread");
});

// ------------------------------------------------------------ deny by default

test("no session is a session: unknown cookies, foreign databases and no auth all read signed out", async () => {
  const made = createTestAuth();
  const request = new Request(`${TEST_BASE_URL}/api/first-run-status`, {
    headers: { cookie: "__Secure-drive.session_token=made-up" },
  });
  assert.equal(await sessionAccount(request, made.auth), null, "a made-up cookie proves nothing");
  assert.equal(await sessionAccount(request, null), null, "no auth, no account");

  // A session only proves an account in the database that minted it: the
  // same signed cookie against a different customer database is signed out,
  // which is what keeps one drive's session from opening another's files.
  const otherDatabase = createTestAuth();
  const { cookie } = await signIn(made, "only-here@example.com");
  const foreign = await sessionAccount(
    new Request(`${TEST_BASE_URL}/api/first-run-status`, { headers: { cookie } }),
    otherDatabase.auth,
  );
  assert.equal(foreign, null, "a session belongs to the database that minted it");
});

test("the Worker's gate reads Better Auth's session, not a cookie the browser chose", async () => {
  // The route of record: the same request through the Worker's own dispatch.
  // The full schema, because the gate test reads /api/usage and that route now
  // reads the account's metered month (drive#496), a month living in
  // 0005_meter's usage_minutes. On the short list the route 500s on a table
  // production has.
  const made = createTestAuth({ migrations: DRIVE_SCHEMA_MIGRATIONS });
  const env = {
    ASSETS: { fetch: () => new Response("asset", { status: 200 }) },
    DRIVE_DB: made.db,
    BETTER_AUTH_SECRET: SECRET,
    BETTER_AUTH_URL: TEST_BASE_URL,
    /** @param {{to: string, url: string}} link */
    SIGNIN_MAIL: (link) => {
      made.sent.push(link);
    },
  };
  const { cookie } = await signIn(made, "gated@example.com");
  for (const path of ["/api/files", "/api/usage", "/api/first-run-status"]) {
    const allowed = await workerFetch(
      new Request(`${TEST_BASE_URL}${path}`, { headers: { cookie } }),
      env,
    );
    assert.equal(allowed.status, 200, `a signed-in account reaches ${path}`);
    const denied = await workerFetch(new Request(`${TEST_BASE_URL}${path}`), env);
    assert.equal(denied.status, 401, `an anonymous caller is locked out of ${path}`);
  }
});

test("the deployment's auth comes from one binding, one secret and one address", () => {
  // authFor() is the one place the three meet, so a deployment cannot be
  // half-configured: any missing piece answers null and the gate denies.
  const made = createTestD1();
  const base = { DRIVE_DB: made };
  assert.equal(authFor(base), null, "no secret, no auth");
  assert.equal(
    authFor({ ...base, BETTER_AUTH_SECRET: SECRET }),
    null,
    "no public address, no auth",
  );
  const first = authFor({ ...base, BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: TEST_BASE_URL });
  const again = authFor({ ...base, BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: TEST_BASE_URL });
  assert.ok(first, "all three set: the auth instance exists");
  assert.equal(first, again, "the same env twice is the same auth instance");
  const built = authFor({ ...base, BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: TEST_BASE_URL });
  assert.ok(built, "all three set: the auth instance exists");
  // Missing the database is the closed door, not an error a request pays for.
  assert.equal(authFor({ BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: TEST_BASE_URL }), null);
  assert.equal(SIGNIN_LINK_PATH, "/api/signin/verify");
});
