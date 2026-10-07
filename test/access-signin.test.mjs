// "Continue as <email>" on the live test address (drive#342): a verified
// Cloudflare Access JWT signs a person in, and nothing else does.
//
// The JWTs here are real RS256 tokens signed with a key made for the test, and
// the team's certs endpoint is answered by a stubbed fetch, so the verify path
// is the one the Worker runs (jose's remote key set), not a seam.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { accessConfig, accessIdentity } from "../src/access.js";
import { ACCESS_SIGNIN_PATH } from "../src/access-signin.js";
import worker from "../src/index.js";
import { failureMessage } from "../src/messages.js";
import { SIGNIN_COPY } from "../src/signin.js";
import { createTestAuth, TEST_BASE_URL } from "./harness.mjs";

/** @type {(request: Request, env?: unknown) => Promise<Response>} */
const workerFetch = /** @type {any} */ (worker.fetch);

const TEAM = "https://drive-test-team.cloudflareaccess.com";
const AUD = "a".repeat(64);
const KID = "drive-test-kid";

/** @type {CryptoKey} */
let teamKey;
/** @type {CryptoKey} */
let strangerKey;
const realFetch = globalThis.fetch;
let certFetches = 0;

before(async () => {
  const team = await generateKeyPair("RS256", { extractable: true });
  const stranger = await generateKeyPair("RS256", { extractable: true });
  teamKey = team.privateKey;
  strangerKey = stranger.privateKey;
  const jwk = { ...(await exportJWK(team.publicKey)), kid: KID, alg: "RS256", use: "sig" };
  globalThis.fetch = /** @type {typeof fetch} */ (
    async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === `${TEAM}/cdn-cgi/access/certs`) {
        certFetches += 1;
        return new Response(JSON.stringify({ keys: [jwk] }), {
          headers: { "content-type": "application/json" },
        });
      }
      return realFetch(input, init);
    }
  );
});

after(() => {
  globalThis.fetch = realFetch;
});

/**
 * @param {{email?: string|null, aud?: string, iss?: string, key?: CryptoKey, exp?: number, nbf?: number, alg?: string}} [claims]
 */
async function accessJwt(claims = {}) {
  const now = Math.floor(Date.now() / 1000);
  const {
    email = "nish@example.com",
    aud = AUD,
    iss = TEAM,
    key = teamKey,
    exp = now + 600,
    nbf = now - 10,
  } = claims;
  const payload = email === null ? { type: "app" } : { email, type: "app" };
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setAudience(aud)
    .setIssuer(iss)
    .setIssuedAt(now - 10)
    .setNotBefore(nbf)
    .setExpirationTime(exp)
    .sign(key);
}

function accessEnv(extra = {}) {
  const made = createTestAuth();
  const limiter = { limit: async () => ({ success: true }) };
  return {
    made,
    env: {
      ASSETS: { fetch: () => new Response("asset", { status: 200 }) },
      DRIVE_DB: made.db,
      BETTER_AUTH_SECRET: "drive-test-secret-not-used-outside-the-test-suite",
      BETTER_AUTH_URL: TEST_BASE_URL,
      SIGNIN_RATE_LIMITER: limiter,
      SIGNIN_GLOBAL_RATE_LIMITER: limiter,
      ACCESS_AUD: AUD,
      ACCESS_TEAM_DOMAIN: TEAM,
      ...extra,
    },
  };
}

/**
 * @param {string} method
 * @param {string|null} jwt
 * @param {unknown} [body]
 * @param {Record<string, string>} [headers]
 */
function accessRequest(method, jwt, body, headers = {}) {
  if (method === "GET") {
    body = undefined;
  }
  return new Request(`${TEST_BASE_URL}${ACCESS_SIGNIN_PATH}`, {
    method,
    headers: {
      ...(jwt === null ? {} : { "cf-access-jwt-assertion": jwt }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("the feature is off unless both Access settings are set, and then the route does not exist", async () => {
  assert.equal(accessConfig({}), null);
  assert.equal(accessConfig({ ACCESS_AUD: AUD }), null);
  assert.equal(accessConfig({ ACCESS_TEAM_DOMAIN: TEAM }), null);
  assert.equal(accessConfig({ ACCESS_AUD: AUD, ACCESS_TEAM_DOMAIN: "http://plain.example" }), null);
  assert.deepEqual(accessConfig({ ACCESS_AUD: AUD, ACCESS_TEAM_DOMAIN: `${TEAM}/` }), {
    aud: AUD,
    issuer: TEAM,
  });

  const jwt = await accessJwt();
  for (const missing of ["ACCESS_AUD", "ACCESS_TEAM_DOMAIN"]) {
    const { env } = accessEnv({ [missing]: undefined });
    for (const method of ["GET", "POST"]) {
      const answer = await workerFetch(accessRequest(method, jwt, { card: true }), env);
      assert.equal(answer.status, 404, `${method} with ${missing} unset is the unknown-path 404`);
      assert.deepEqual(await answer.json(), { error: "Not found." });
      assert.equal(answer.headers.getSetCookie().length, 0, "no session without the feature");
    }
  }
});

test("forged, expired, not-yet-valid, wrong-aud, wrong-team and email-less tokens are refused", async () => {
  const config = /** @type {NonNullable<ReturnType<typeof accessConfig>>} */ (
    accessConfig({ ACCESS_AUD: AUD, ACCESS_TEAM_DOMAIN: TEAM })
  );
  const now = Math.floor(Date.now() / 1000);
  const bad = {
    forged: await accessJwt({ key: strangerKey }),
    expired: await accessJwt({ exp: now - 60, nbf: now - 1200 }),
    "not yet valid": await accessJwt({ nbf: now + 600, exp: now + 1200 }),
    "wrong aud": await accessJwt({ aud: "b".repeat(64) }),
    "wrong team": await accessJwt({ iss: "https://someone-else.cloudflareaccess.com" }),
    "no email": await accessJwt({ email: null }),
    "not a jwt": "not.a.jwt",
  };
  const { env, made } = accessEnv();
  for (const [name, jwt] of Object.entries(bad)) {
    const request = accessRequest("GET", jwt);
    assert.equal(await accessIdentity(request, config), null, `${name} is not an identity`);
    for (const method of ["GET", "POST"]) {
      const answer = await workerFetch(accessRequest(method, jwt, { card: true }), env);
      assert.equal(answer.status, 401, `${name} ${method} is refused`);
      assert.deepEqual(await answer.json(), { error: failureMessage("unauthorized") });
      assert.equal(answer.headers.getSetCookie().length, 0, `${name} mints no session`);
    }
  }
  // A header-less request is refused the same way.
  const none = await workerFetch(accessRequest("POST", null, { card: true }), env);
  assert.equal(none.status, 401);
  const users = made.db.prepare('SELECT count(*) AS n FROM "user"');
  assert.equal((await users.first())?.n, 0, "no refused token made an account");
});

test("a good token shows who you are, then signs you in with the normal session cookie", async () => {
  const { env } = accessEnv();
  const jwt = await accessJwt({ email: "Nish@Example.com" });

  const shown = await workerFetch(accessRequest("GET", jwt), env);
  assert.equal(shown.status, 200);
  assert.deepEqual(await shown.json(), { email: "nish@example.com", hasAccount: false });

  const signed = await workerFetch(
    accessRequest("POST", jwt, { card: true }, { origin: TEST_BASE_URL }),
    env,
  );
  assert.equal(signed.status, 200);
  assert.deepEqual(await signed.json(), {
    ok: true,
    email: "nish@example.com",
    redirect: "/files",
  });
  const cookie = signed.headers.getSetCookie()[0];
  assert.match(cookie, /^__Secure-drive\.session_token=/, "Better Auth's own session cookie");
  assert.match(cookie, /HttpOnly/);

  // The cookie is a real session: an account route answers it.
  const status = await workerFetch(
    new Request(`${TEST_BASE_URL}/api/first-run-status`, {
      headers: { cookie: cookie.split(";")[0] },
    }),
    env,
  );
  assert.equal(status.status, 200, "the session opens the account gate");

  // The second time the address is an account, so no card is asked for.
  const again = await workerFetch(accessRequest("POST", jwt, {}), env);
  assert.equal(again.status, 200, "a returning account signs in without the card box");
  const shownAgain = await workerFetch(accessRequest("GET", jwt), env);
  assert.deepEqual(await shownAgain.json(), { email: "nish@example.com", hasAccount: true });
  assert.ok(certFetches >= 1, "the team's certs were fetched to verify");
});

test("a new address without the card box is refused with the email path's sentence (drive#387)", async () => {
  const { env, made } = accessEnv();
  const jwt = await accessJwt({ email: "nocard@example.com" });
  for (const body of [{}, { card: false }, { card: "off" }]) {
    const answer = await workerFetch(accessRequest("POST", jwt, body), env);
    assert.equal(answer.status, 400);
    assert.deepEqual(await answer.json(), { error: SIGNIN_COPY.needCard });
    assert.equal(answer.headers.getSetCookie().length, 0);
  }
  const users = made.db.prepare('SELECT count(*) AS n FROM "user"');
  assert.equal((await users.first())?.n, 0, "no account without a card");
});

test("the no-JavaScript form post signs in and lands on the drive", async () => {
  const { env } = accessEnv();
  const jwt = await accessJwt({ email: "form@example.com" });
  const answer = await workerFetch(
    new Request(`${TEST_BASE_URL}${ACCESS_SIGNIN_PATH}`, {
      method: "POST",
      headers: {
        "cf-access-jwt-assertion": jwt,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "card=on",
    }),
    env,
  );
  assert.equal(answer.status, 302);
  assert.equal(answer.headers.get("location"), "/files");
  assert.match(answer.headers.getSetCookie()[0], /^__Secure-drive\.session_token=/);
});

test("a post another site made is refused before the token is read", async () => {
  const { env } = accessEnv();
  const jwt = await accessJwt();
  const answer = await workerFetch(
    accessRequest("POST", jwt, { card: true }, { origin: "https://evil.example" }),
    env,
  );
  assert.equal(answer.status, 403);
  assert.equal(answer.headers.getSetCookie().length, 0);
});

test("with no signing secret the route is the closed door, not a session", async () => {
  const { env } = accessEnv({ BETTER_AUTH_SECRET: undefined });
  const jwt = await accessJwt();
  const answer = await workerFetch(accessRequest("POST", jwt, { card: true }), env);
  assert.equal(answer.status, 503);
  assert.deepEqual(await answer.json(), { error: failureMessage("sign-in-closed") });
});

test("the session endpoint is not on Better Auth's HTTP router", async () => {
  const { made } = accessEnv();
  const answer = await made.auth.handler(
    new Request(`${TEST_BASE_URL}/api/auth/sign-in-with-access`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: TEST_BASE_URL },
      body: JSON.stringify({ email: "x@example.com" }),
    }),
  );
  assert.equal(answer.status, 404, "only server code can call it, after the JWT check");
});
