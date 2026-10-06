import assert from "node:assert/strict";
import { test } from "node:test";
import { createIdriveKeyProvider, IdriveKeyError } from "../../../core/idrive-keys.js";
import {
  ACCOUNT_BUCKET_PREFIX,
  bucketForAccount,
  bucketForTeam,
  scopeFor,
  TEAM_BUCKET_PREFIX,
  teamScopeFor,
} from "../../../core/keyprovider.js";
import { createS3Client, provisionBucket, readBucketEncryption } from "../../../core/s3.js";

/**
 * One reseller API call as it was made.
 * @typedef {{url: string, auth: string|undefined, body: Record<string, unknown>}} VendorCall
 */

/**
 * A reseller API that records what it was asked and answers what a vendor
 * answer looks like. `calls` is the proof: one POST to the named action, the
 * token in a header, the body the mint sent.
 * @param {VendorCall[]} calls
 * @param {Record<string, unknown>} answer
 */
function vendorAnswer(calls, answer) {
  return async (
    /** @type {URL | RequestInfo} */ input,
    /** @type {RequestInit|undefined} */ init,
  ) => {
    const url =
      input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
    calls.push({
      url: String(url),
      auth: /** @type {string|undefined} */ (
        /** @type {Record<string, string>|undefined} */ (init?.headers)?.token
      ),
      body: JSON.parse(String(init?.body ?? "{}")),
    });
    return Response.json(answer);
  };
}

/**
 * A real signed S3 client whose transport answers 200 with the body it is
 * handed: the provisioning calls are the real stock shape, signed the way
 * `s3.js` signs them, and the stand-in only stands in for the server.
 * @param {Array<{method: string, url: string, query: string, body: string}>} calls
 * @param {string} answer the XML the GET ?encryption answer carries back
 */
function s3Stand(calls, answer) {
  return createS3Client({
    endpoint: "https://storage.example.test",
    region: "eu-west-3",
    credentials: { accessKeyId: "AK", secretAccessKey: "SK" },
    fetchImpl: async (
      /** @type {URL | RequestInfo} */ input,
      /** @type {RequestInit|undefined} */ init,
    ) => {
      // `s3.js` signs a `Request` and hands the whole thing to fetch, so the
      // stand-in reads the signed request back.
      const signed = input instanceof Request ? input : new Request(String(input), init);
      const target = new URL(signed.url);
      calls.push({
        method: signed.method,
        url: target.pathname,
        query: target.search,
        body: await signed.clone().text(),
      });
      return new Response(answer, {
        status: 200,
        headers: { "content-type": "application/xml" },
      });
    },
  });
}

test("one bucket per customer, and the name is built once", () => {
  assert.equal(bucketForAccount("acct_a1"), `${ACCOUNT_BUCKET_PREFIX}acct-a1`);
  assert.equal(bucketForTeam("team_t1"), `${TEAM_BUCKET_PREFIX}team-t1`);
  // A sign-in id is mixed case; a bucket name cannot be (MinIO: InvalidBucketName).
  assert.equal(bucketForAccount("v7Bp7HwejiE6XHOT"), "drv-v7bp7hwejie6xhot");
  assert.match(bucketForAccount("v7Bp7HwejiE6XHOTv7Bp7HwejiE6XHOT"), /^[a-z0-9][a-z0-9-]{2,62}$/);
  // An id that would be refused as a prefix is refused as a bucket too, so the
  // boundary cannot be built from an id the rest of the api rejects.
  assert.throws(() => bucketForAccount("../x"), /account id/);
  assert.throws(() => bucketForTeam("t/../x"), /team id/);
});

test("every scope names its own bucket", () => {
  // The bucket is the boundary on the vendor that cannot scope a key to a
  // folder (iDrive e2, measured drive#173), and the prefix is still the layout
  // inside it, so a scope carries both and the two cannot name different
  // customers.
  assert.equal(scopeFor("device", "acct_a1").bucket, "drv-acct-a1");
  assert.equal(scopeFor("agent", "acct_a1").bucket, "drv-acct-a1");
  assert.equal(scopeFor("branch", "acct_a1", { name: "x" }).bucket, "drv-acct-a1");
  assert.equal(teamScopeFor("read_write", "team_t1").bucket, "drv-t-team-t1");
  assert.equal(teamScopeFor("read_write", "team_t1").prefix, "t/team_t1/");
});

test("a mint names one bucket and the switches that make a delete safe", async () => {
  /** @type {VendorCall[]} */
  const calls = [];
  const provider = createIdriveKeyProvider({
    apiEndpoint: "https://api.example.test/api/reseller/v1",
    apiToken: "test-token",
    fetchImpl: vendorAnswer(calls, {
      access_key_id: "AKIA1",
      secret_access_key: "SHOWN-ONCE",
    }),
  });
  const minted = await provider.mint(scopeFor("device", "a1"));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.example.test/api/reseller/v1/create_access_key");
  assert.equal(calls[0].auth, "test-token");
  assert.deepEqual(calls[0].body, {
    buckets: ["drv-a1"],
    permissions: 2,
    disable_delete_object: false,
    // A person's device key keeps delete, so it can also lift a version
    // (drive#371: that is the one key a person can use to restore).
    disable_delete_version: false,
    // Every key gets it, on every mint: no customer key removes a bucket.
    disable_delete_bucket: true,
  });
  assert.equal(minted.accessKeyId, "AKIA1");
  assert.equal(minted.secret, "SHOWN-ONCE");
  // A vendor key is a long-lived pair, not a bounded session, so there is no
  // token half and no clock to carry.
  assert.equal(minted.sessionToken, null);
  assert.equal(minted.expiresIn, null);
  assert.equal(minted.bucket, "drv-a1");
});

test("an agent key cannot destroy the version behind a delete marker", async () => {
  /** @type {VendorCall[]} */
  const calls = [];
  const provider = createIdriveKeyProvider({
    apiEndpoint: "https://api.example.test/api/reseller/v1",
    apiToken: "test-token",
    fetchImpl: vendorAnswer(calls, { accessKeyId: "AKIA2", secretAccessKey: "s2" }),
  });
  await provider.mint(scopeFor("agent", "a1"));
  assert.equal(calls[0].body.disable_delete_version, true);
  assert.equal(calls[0].body.disable_delete_bucket, true);
});

test("a write with an expiry sends the epoch second the vendor takes", async () => {
  /** @type {VendorCall[]} */
  const calls = [];
  const provider = createIdriveKeyProvider({
    apiEndpoint: "https://api.example.test/api/reseller/v1",
    apiToken: "test-token",
    fetchImpl: vendorAnswer(calls, { access_key_id: "AKIA3", secret_access_key: "s3" }),
  });
  const minted = await provider.mint(scopeFor("s3", "a1"), { expiresAt: 1767225600 });
  assert.equal(minted.accessKeyId, "AKIA3");
  assert.equal(calls[0].body.expiry_on, 1767225600);
});

test("a bucket is provisioned with versioning, the one-day rule and encryption", async () => {
  /** @type {Array<{method: string, url: string, query: string, body: string}>} */
  const s3Calls = [];
  const client = s3Stand(
    s3Calls,
    "<ServerSideEncryptionConfiguration><Rule>" +
      "<ApplyServerSideEncryptionWithS3EncryptionByDefault><SSEAlgorithm>AES256</SSEAlgorithm>" +
      "</ApplyServerSideEncryptionWithS3EncryptionByDefault></Rule></ServerSideEncryptionConfiguration>",
  );
  const answer = await provisionBucket(client, { bucket: "drv-a1", sse: "AES256" });
  // The stock S3 shape, four PUTs: create the bucket, versioning, the one-day
  // hidden-version rule, then SSE. One bucket per customer (drive#371), and the
  // bucket is the customer's own.
  assert.equal(s3Calls.length, 4);
  assert.equal(s3Calls[0].method, "PUT");
  assert.equal(s3Calls[0].url, "/drv-a1");
  // Creating the bucket is the only call with no query at all.
  assert.equal(s3Calls[0].query, "");
  assert.equal(s3Calls[1].method, "PUT");
  assert.equal(s3Calls[1].query, "?versioning=");
  // The one-day hidden-version rule.
  assert.equal(s3Calls[2].query, "?lifecycle=");
  assert.ok(s3Calls[2].body.includes("<NoncurrentDays>1</NoncurrentDays>"));
  assert.ok(s3Calls[2].body.includes("ExpiredObjectDeleteMarker"));
  assert.equal(s3Calls[3].query, "?encryption=");
  assert.ok(s3Calls[3].body.includes("<SSEAlgorithm>AES256</SSEAlgorithm>"));
  assert.equal(answer.encryption?.status, 200);
  // Read back rather than taken from the PUT, the same rule readBucketConfig
  // follows.
  assert.equal(await readBucketEncryption(client, { bucket: "drv-a1" }), "AES256");
  // The call the read-back makes is the stock GET ?encryption on that bucket.
  assert.equal(s3Calls[4].method, "GET");
  assert.equal(s3Calls[4].query, "?encryption=");
});

test("a deployment that names no encryption sends no encryption call", async () => {
  /** @type {Array<{method: string, url: string, query: string, body: string}>} */
  const s3Calls = [];
  await provisionBucket(s3Stand(s3Calls, ""), { bucket: "stand-in" });
  // The stock stand-in refuses SSE-S3 without a KMS (501, measured 2026-10-01),
  // so the stand-in deployment names nothing and sends nothing.
  assert.equal(s3Calls.length, 3);
});

test("a revoke is the vendor's remove_access_key, on the key it was handed", async () => {
  /** @type {VendorCall[]} */
  const calls = [];
  const provider = createIdriveKeyProvider({
    apiEndpoint: "https://api.example.test/api/reseller/v1",
    apiToken: "test-token",
    fetchImpl: vendorAnswer(calls, {}),
  });
  await provider.revoke("AKIA1");
  assert.equal(calls[0].url, "https://api.example.test/api/reseller/v1/remove_access_key");
  assert.deepEqual(calls[0].body, { access_key_id: "AKIA1" });
});

test("a scope with no bucket is refused, not minted against everything", async () => {
  const provider = createIdriveKeyProvider({
    apiEndpoint: "https://api.example.test/api/reseller/v1",
    apiToken: "test-token",
    fetchImpl: async () => new Response("{}", { status: 200 }),
  });
  // A scope from a provider that scopes to a prefix only: the STS path, where
  // the boundary is the session policy rather than a bucket.
  const prefixOnly = /** @type {import("../../../core/keyprovider.js").KeyScope} */ (
    /** @type {unknown} */ ({ prefix: "u/a1/", capabilities: ["list", "read"] })
  );
  await assert.rejects(() => provider.mint(prefixOnly), /names its bucket/);
});

test("a vendor refusal is the named failure it is", async () => {
  const provider = createIdriveKeyProvider({
    apiEndpoint: "https://api.example.test/api/reseller/v1",
    apiToken: "test-token",
    fetchImpl: async () => Response.json({ message: "invalid token" }, { status: 401 }),
  });
  await assert.rejects(() => provider.mint(scopeFor("device", "a1")), IdriveKeyError);
  await assert.rejects(() => provider.mint(scopeFor("device", "a1")), /invalid token/);
});

test("a 200 that is not a credential is refused, not handed back half-built", async () => {
  const provider = createIdriveKeyProvider({
    apiEndpoint: "https://api.example.test/api/reseller/v1",
    apiToken: "test-token",
    fetchImpl: async () => Response.json({ ok: true }),
  });
  await assert.rejects(() => provider.mint(scopeFor("device", "a1")), /missing/);
});

test("a provider without the credential to provision is refused at construction", () => {
  assert.throws(
    () =>
      createIdriveKeyProvider({
        apiEndpoint: "https://api.example.test/api/reseller/v1",
        apiToken: "test-token",
        provisionBuckets: true,
      }),
    /master credential/,
  );
});
