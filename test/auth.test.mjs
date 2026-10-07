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
//      core/auth.js, and the same database).
//   5. Sign-out kills the session.
//   6. Deny by default: an unknown cookie, a foreign database, and a
//      deployment with no auth at all all read as signed out.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { getAuthTables } from "better-auth/db";
import { getMigrations } from "better-auth/db/migration";
import { magicLink, twoFactor } from "better-auth/plugins";
import {
  authFor,
  createAuth,
  IGNORING_SENTENCE,
  SIGNIN_LINK_PATH,
  sessionAccount,
  signinDeviceName,
  signinLinkEmail,
} from "../core/auth.js";
import { createMemoryStore } from "../core/files.js";
import worker, { TEST_FILES_STORE } from "../src/index.js";
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

/** The planner instance both schema pins read: the shipped files, the plugin set. */
function schemaPinInstance() {
  const database = createTestD1({
    // The two files that hold the sign-in flow's schema, plus the
    // second-factor file: 0005 has the core tables (already applied by every
    // deployment, so the two-factor columns land as an ALTER in 0034), 0011
    // the rateLimit table, and 0034 what the second-factor and passkey
    // plugins read.
    migrations: [
      "drive/0005_better_auth.sql",
      "drive/0011_rate_limit.sql",
      "drive/0034_two_factor_passkey.sql",
    ],
  });
  const instance = betterAuth({
    database,
    secret: SECRET,
    baseURL: TEST_BASE_URL,
    emailAndPassword: { enabled: false },
    appName: "drive",
    // Mirrors the option in core/auth.js: the rate-limit counters are stored
    // in D1, so the planner expects the rateLimit table too.
    rateLimit: { storage: "database" },
    // The whole plugin set the Worker mounts, in the same order: magic-link
    // and two-factor from core/auth.js, passkey from core/auth-passkey.js. A
    // drift in this list makes the planner expect a schema the migration
    // files do not carry, which is exactly what these tests exist to catch.
    plugins: [
      magicLink({ sendMagicLink: async () => {} }),
      twoFactor({ allowPasswordless: true }),
      passkey({ rpID: "drive.test", rpName: "drive", origin: TEST_BASE_URL }),
    ],
  });
  return { database, instance };
}

test("no shipped table or column sits outside the planner's model", async () => {
  // The reverse of the pin below: the planner finding nothing to create proves
  // the files carry everything the library needs, not that they carry nothing
  // else. A table or column a migration adds that no plugin reads (a plugin
  // dropped from core/auth.js, a column renamed in the library) fails here.
  const { database, instance } = schemaPinInstance();
  const model = getAuthTables(
    /** @type {Parameters<typeof getAuthTables>[0]} */ (/** @type {unknown} */ (instance.options)),
  );
  /** @type {Map<string, Set<string>>} */
  const expected = new Map();
  for (const [key, table] of Object.entries(model)) {
    const columns = new Set(["id"]);
    for (const [fieldKey, field] of Object.entries(table.fields)) {
      columns.add(/** @type {{fieldName?: string}} */ (field).fieldName ?? fieldKey);
    }
    expected.set(table.modelName ?? key, columns);
  }
  const db = /** @type {any} */ (database);
  const tables = (
    await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
  ).results.map((/** @type {{name: string}} */ row) => row.name);
  assert.ok(tables.length > 0, "the shipped files created tables");
  for (const name of tables) {
    const columns = expected.get(name);
    assert.ok(columns, `shipped table ${name} is not in the planner's model`);
    const shipped = (await db.prepare(`PRAGMA table_info("${name}")`).all()).results.map(
      (/** @type {{name: string}} */ row) => row.name,
    );
    for (const column of shipped) {
      assert.ok(
        columns.has(column),
        `shipped column ${name}.${column} is not in the planner's model`,
      );
    }
  }
});

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
  const { instance } = schemaPinInstance();
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
  // A new isolate is a new instance of core/auth.js over the same database:
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
    [TEST_FILES_STORE]: createMemoryStore(),
  };
  const { cookie } = await signIn(made, "gated@example.com");
  for (const path of ["/api/files", "/api/usage", "/api/first-run-status", "/api/devices"]) {
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

// ------------------------------------- the mail says who asked, and when (drive#550)

/**
 * The sign-in mail as the mailer renders it, at a fixed second so the line
 * that names the time is the same string every run. sendSigninLink renders
 * exactly this, from the same URL and the same header it was handed, so a
 * change here is a change the customer reads.
 * @param {string} url
 * @param {unknown} [userAgent]
 * @param {Date} [when]
 */
function authEmails(url, userAgent = null, when = new Date("2026-10-05T09:30:00.000Z")) {
  return signinLinkEmail(url, userAgent, when);
}

test("signinDeviceName names only the browsers and platforms the tables carry", () => {
  // The header comes from the caller, so the mail can only ever repeat words
  // this repo owns: the name is assembled out of two frozen tables and the
  // header is read as letter runs matched against them whole. Anything else
  // is not echoed, it is unknown, and the caller's own words never travel.
  /** @type {Array<[unknown, string|null]>} */
  const cases = [
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0",
      "Edge on Windows",
    ],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Chrome on Windows",
    ],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 OPR/106.0.0.0",
      "Opera on Windows",
    ],
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:121.0) Gecko/20100101 Firefox/121.0",
      "Firefox on macOS",
    ],
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      "Safari on iPhone",
    ],
    [
      "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      "Safari on iPad",
    ],
    [
      "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
      "Chrome on Android",
    ],
    [
      "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Chrome on ChromeOS",
    ],
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.6099.119 Mobile/15E148 Safari/604.1",
      "Chrome on iPhone",
    ],
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/121.0 Mobile/15E148 Safari/605.1.15",
      "Firefox on iPhone",
    ],
    [
      "Mozilla/5.0 (Linux; Android 13; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36",
      "Samsung Internet on Android",
    ],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/70.0.3538.102 Safari/537.36 Edge/18.19041",
      "Edge on Windows",
    ],
    // No platform the table names, but a browser it does: half a name is
    // still a name, and it is still the table's word.
    ["Chrome/120.0.0.0", "Chrome"],
    // Nothing the tables hold: unknown, never the caller's text.
    ["curl/8.4.0", null],
    ["", null],
    [null, null],
    [17, null],
    [{}, null],
    ['<script>alert("Chrome")</script>', "Chrome"],
  ];
  for (const [raw, expected] of cases) {
    const name = signinDeviceName(raw);
    assert.equal(name, expected, `signinDeviceName(${JSON.stringify(raw)})`);
    if (expected === null) {
      assert.equal(name, null, "an unrecognised header is unknown, not echoed");
    }
  }
  // The one case above whose shape matters most: a header carrying script
  // tags matched Chrome as a letter run, and the tags themselves are nowhere.
  assert.equal(
    signinDeviceName('<script>alert("Chrome")</script>'),
    "Chrome",
    "the table's word is the only word out",
  );
});

test("a sign-in link mailed to a browser names that browser and the time in UTC", async () => {
  const made = createTestAuth();
  const userAgent =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
  await made.auth.api.signInMagicLink({
    body: { email: "device@example.com" },
    headers: new Headers({ origin: TEST_BASE_URL, "user-agent": userAgent }),
  });
  const sent = made.sent[0];
  assert.equal(sent.userAgent, userAgent, "the request's own header reached the mailer");
  // The mail is rendered from the same URL and the same header the mailer was
  // handed, so this is the text the customer reads, not a second copy of it.
  const email = authEmails(sent.url, sent.userAgent);
  assert.match(email.text, /Requested from Chrome on Windows at 5 Oct 2026, 09:30 UTC\./);
  assert.ok(
    email.text.includes(IGNORING_SENTENCE),
    "the mail says a request nobody made can be ignored",
  );
  for (const part of [email.text, email.html]) {
    assert.ok(
      part.includes("Requested from Chrome on Windows"),
      "the device line is in both parts",
    );
    assert.ok(part.includes("5 Oct 2026, 09:30 UTC"), "the time line is in both parts");
  }
});

test("a sign-in link asked for without a browser still names a time and the way out", async () => {
  // A script that never sets a user-agent is the shape an attacker uses
  // most, and it gets the same mail as anybody: an unknown device, a real
  // time, and the sentence that says the link can be ignored.
  const made = createTestAuth();
  await made.auth.api.signInMagicLink({
    body: { email: "quiet@example.com" },
    headers: headers(),
  });
  const sent = made.sent[0];
  assert.equal(sent.userAgent, null, "no header, no device");
  const email = authEmails(sent.url);
  assert.match(email.text, /Requested from an unknown device at /);
  assert.ok(
    email.text.includes(IGNORING_SENTENCE),
    "the unknown-device mail still says the link can be ignored",
  );
  assert.match(email.text, /\d{1,2} \w{3} \d{4}, \d{2}:\d{2} UTC\./);
});

test("the link's own sentences do not change when the device does", () => {
  // The two new sentences sit beside the existing promise, and the promise
  // is the link's; a device line that quietly replaced it would be a change
  // to how long the link lasts, which is Better Auth's own setting.
  const url = `${TEST_BASE_URL}${SIGNIN_LINK_PATH}?token=abc`;
  const unknown = authEmails(url).text;
  const known = authEmails(
    url,
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:121.0) Gecko/20100101 Firefox/121.0",
  ).text;
  for (const text of [unknown, known]) {
    assert.ok(text.includes("good for 10 minutes and works once"), "the link's promise is intact");
    assert.ok(text.includes(IGNORING_SENTENCE), "the way out is in every mail");
    assert.match(text, /Requested from .+ at \d{1,2} \w{3} \d{4}, \d{2}:\d{2} UTC\./);
  }
  assert.ok(known.includes("Firefox on macOS"), "a known device is named");
  assert.ok(unknown.includes("an unknown device"), "an unknown one is called unknown");
});

test("the Worker auth entry does not pull Kysely or the plugins barrel", () => {
  const source = readFileSync(new URL("../core/auth.js", import.meta.url), "utf8");
  assert.match(source, /from "better-auth\/minimal"/);
  assert.match(source, /from "better-auth\/plugins\/magic-link"/);
  assert.match(source, /from "better-auth\/plugins\/two-factor"/);
  assert.match(source, /d1Adapter/);
  assert.doesNotMatch(source, /from "better-auth";/);
  assert.doesNotMatch(source, /from "better-auth\/plugins";/);
  assert.doesNotMatch(
    source,
    /from "@better-auth\/passkey"/,
    "the passkey plugin must load on demand from core/auth-passkey.js, not the Worker entry",
  );
  assert.match(
    source,
    /await import\("\.\/auth-passkey\.js"\)/,
    "passkey auth must load through a dynamic import so the bundler can split it",
  );
});

test("the built Worker entry no longer contains the passkey stack", (t) => {
  // drive#846: @simplewebauthn/server (and the asn1/x509 stack it pulls) must
  // sit in a chunk loaded only for /api/auth/passkey/*, not in the isolate
  // script every request parses. CI runs `npm run build` before `npm test`;
  // a local run without a build has nothing to pin.
  const entry = fileURLToPath(
    new URL("../.cloudflare/output/v0/workers/default/bundle/index.js", import.meta.url),
  );
  if (!existsSync(entry)) {
    t.skip("no Worker build output; CI runs npm run build before npm test");
    return;
  }
  const source = readFileSync(entry, "utf8");
  assert.equal(
    source.includes("//#region node_modules/@simplewebauthn/server"),
    false,
    "the passkey stack must not sit in the Worker entry chunk",
  );
});
