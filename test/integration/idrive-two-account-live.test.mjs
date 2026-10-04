// The two-account proof on the real iDrive e2 account, which is the finish
// line drive#462 was measured from (the real Mac run of 2026-10-04, and the
// owner's top-priority addition: "not done until a two-account proof passes
// on real iDrive e2").
//
// What it proves, and why it is the proof and not another one: the S3
// stand-in (`test/step1-storage.test.mjs`) proves the same boundary against a
// stock server, and `workers/api/test/s3-keys.test.js` proves every mint path
// against a recording endpoint. Neither is the vendor. iDrive e2 cannot scope
// a key to a folder and its STS refuses `AssumeRole` (measured 2026-10-03,
// drive#173), so the ONLY thing that decides whether one account's key can
// reach another account's files on the primary vendor is what iDrive e2's own
// reseller API hands out — and that is exactly what this test asks the real
// account, once, with two real accounts' real keys:
//
//   1. account A's key is REFUSED a listing of account B's bucket
//   2. account A's key is REFUSED a read of an object in B's bucket
//   3. account A's key is REFUSED a write into B's bucket
//   4. an AGENT key (no `delete` capability) is REFUSED a delete in its own
//      bucket, so an agent can never destroy a hidden version
//
// Every assertion reads a refusal off the real endpoint's own answer. A
// refusal is a refusal only if the vendor says so, so a 200 where a 403 is
// promised fails here rather than being read as a pass.
//
// The credentials are the reseller token and the S3 master credential for the
// bucket provisioning, both of which are the owner's. This proof therefore
// runs only when they are in the environment and is skipped, loudly, when they
// are not — which is why drive#462 could not be closed by a worker run: the
// token is not on this host. Set them and the whole proof is one command (see
// the run line at the top of the header below). It is opt-in for the same
// reason `test/standin-search.test.mjs` is: it spends real money on a real
// paid bucket, and a CI run and every other worker's run must not do that
// without being asked to.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createIdriveKeyProvider } from "../../workers/api/src/idrive-keys.js";
import { bucketForAccount, scopeFor } from "../../workers/api/src/keyprovider.js";
import { createS3Client, ok, provisionBucket } from "../../workers/api/src/s3.js";

// Run it with the owner's credentials in the environment:
//
//   IDRIVE_E2_API_TOKEN=<reseller token> \
//   IDRIVE_S3_ACCESS_KEY_ID=<master id> \
//   IDRIVE_S3_SECRET_ACCESS_KEY=<master secret> \
//   node --test test/integration/idrive-two-account-live.test.mjs
//
// The endpoint and region default to the real ones measured on 2026-10-03
// (drive#173) and can be overridden for a reseller-hosted endpoint. The two
// account ids are two real, distinct accounts; they are separate so the test
// cleans up after itself and never touches a customer's bucket.
const API_TOKEN = process.env.IDRIVE_E2_API_TOKEN ?? "";
const S3_ENDPOINT = process.env.IDRIVE_S3_ENDPOINT ?? "https://s3.eu-west-3.idrivee2.com";
const S3_REGION = process.env.IDRIVE_S3_REGION ?? "eu-west-3";
const API_ENDPOINT =
  process.env.IDRIVE_E2_API_ENDPOINT ?? "https://api.idrivee2.com/api/reseller/v1";
const MASTER_ID = process.env.IDRIVE_S3_ACCESS_KEY_ID ?? "";
const MASTER_SECRET = process.env.IDRIVE_S3_SECRET_ACCESS_KEY ?? "";

// Two throwaway account ids for the run. bucketForAccount folds them the same
// way it folds a real id (lower case, `_` to `-`), so the buckets are real
// bucket names on the real account and are removed at the end.
const ACCOUNT_A = `drive462a${randomSuffix()}`;
const ACCOUNT_B = `drive462b${randomSuffix()}`;

/**
 * A short random suffix so two runs (or two workers) never collide on a
 * bucket name that outlives the run.
 * @returns {string}
 */
function randomSuffix() {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 8);
}

// The reason the whole proof is skipped, or null when the credentials are all
// present. Kept as one string so the skip says exactly which one is missing
// rather than a bare "skipped".
const MISSING = [
  ["IDRIVE_E2_API_TOKEN", API_TOKEN],
  ["IDRIVE_S3_ACCESS_KEY_ID", MASTER_ID],
  ["IDRIVE_S3_SECRET_ACCESS_KEY", MASTER_SECRET],
]
  .filter(([, value]) => value === "")
  .map(([name]) => name);

/**
 * The master S3 client, the one the buckets are provisioned with.
 * @returns {ReturnType<typeof createS3Client>}
 */
function masterClient() {
  return createS3Client({
    endpoint: S3_ENDPOINT,
    region: S3_REGION,
    credentials: { accessKeyId: MASTER_ID, secretAccessKey: MASTER_SECRET },
  });
}

/**
 * An S3 client built from a minted key, so the calls below are signed with
 * the very credential the vendor handed out and the vendor's own answer is
 * what is read.
 * @param {{accessKeyId: string, secret: string}} minted
 * @returns {ReturnType<typeof createS3Client>}
 */
function clientFor(minted) {
  return createS3Client({
    endpoint: S3_ENDPOINT,
    region: S3_REGION,
    credentials: { accessKeyId: minted.accessKeyId, secretAccessKey: minted.secret },
  });
}

/**
 * One call, and whether the vendor refused it. A refusal is what the proof
 * asserts, so the helper returns the answer rather than throwing: the
 * assertion reads the status and the vendor's own code off it.
 * @param {ReturnType<typeof createS3Client>} client
 * @param {string} method
 * @param {{bucket?: string, key?: string, query?: Record<string,string>, body?: string}} target
 * @returns {Promise<{status: number, code: string|null, text: string}>}
 */
async function attempt(client, method, target) {
  const answer = await client.send(method, target);
  return {
    status: answer.status,
    code: /<Code>([^<]+)<\/Code>/.exec(answer.text)?.[1] ?? null,
    text: answer.text,
  };
}

/**
 * Assert a call was refused by the vendor and that the refusal names access,
 * not a malformed request: a 403 alone could be a bad signature, so the code
 * has to be an access one.
 * @param {{status: number, code: string|null, text: string}} answer
 * @param {string} what the operation, for the assertion message
 */
function assertRefused(answer, what) {
  assert.equal(
    answer.status,
    403,
    `${what} should be refused 403 by the real endpoint, got ${answer.status}: ${answer.text.slice(0, 200)}`,
  );
  assert.ok(
    answer.code === "AccessDenied" ||
      answer.code === "AllAccessDisabled" ||
      answer.code === "InvalidAccessKeyId" ||
      answer.code === "SignatureDoesNotMatch" ||
      (answer.code !== null && /access|denied|forbidden/i.test(answer.code)),
    `${what} should be refused for access, not for a bad request; the code was ${answer.code}: ${answer.text.slice(0, 200)}`,
  );
}

test("two accounts' keys cannot reach each other on the real iDrive e2", async (t) => {
  if (MISSING.length > 0) {
    // The owner's credential is not on this host (drive#462: the reseller
    // token is Nish's, and the account itself is a paid reseller contract).
    // The proof is skipped rather than faked, and the skip says which
    // values are absent.
    return t.skip(
      `the real iDrive e2 proof needs the owner's credentials, absent here: ${MISSING.join(", ")}. See the run line at the top of this file.`,
    );
  }

  const provider = createIdriveKeyProvider({
    apiEndpoint: API_ENDPOINT,
    apiToken: API_TOKEN,
    provisionBuckets: true,
    storage: {
      endpoint: S3_ENDPOINT,
      region: S3_REGION,
      credentials: { accessKeyId: MASTER_ID, secretAccessKey: MASTER_SECRET },
    },
  });
  const master = masterClient();

  // The two accounts, each with its own bucket and its own agent key. The
  // keys are minted through the real reseller API, so the credential the
  // rest of the proof uses is the one a real customer would be handed.
  const bucketA = bucketForAccount(ACCOUNT_A);
  const bucketB = bucketForAccount(ACCOUNT_B);
  /** @type {Array<() => Promise<unknown>>} */
  const cleanup = [];
  /** @type {{client: ReturnType<typeof clientFor>, accessKeyId: string}} */
  let keyA;
  /** @type {{client: ReturnType<typeof clientFor>, accessKeyId: string}} */
  let keyB;

  try {
    // Each bucket is provisioned by the master (the real `provisionBucket`,
    // versioning + SSE + the one-day hidden-version rule), exactly as the
    // api Worker does on a mint that needs one.
    await provisionBucket(master, { bucket: bucketA, sse: "AES256" });
    await provisionBucket(master, { bucket: bucketB, sse: "AES256" });

    const scopeA = scopeFor("agent", ACCOUNT_A);
    const scopeB = scopeFor("agent", ACCOUNT_B);
    assert.equal(scopeA.bucket, bucketA);
    assert.equal(scopeB.bucket, bucketB);

    const mintedA = await provider.mint(scopeA);
    const mintedB = await provider.mint(scopeB);
    cleanup.push(() => provider.revoke(mintedA.accessKeyId));
    cleanup.push(() => provider.revoke(mintedB.accessKeyId));
    keyA = { client: clientFor(mintedA), accessKeyId: mintedA.accessKeyId };
    keyB = { client: clientFor(mintedB), accessKeyId: mintedB.accessKeyId };

    // A real object in B's bucket, written by the master, so B's key has
    // something of its own to read (and A has something of B's to fail on).
    const objectKey = `${scopeB.prefix}proof-object.txt`;
    await ok(
      "the master writes B's proof object",
      await master.send("PUT", {
        bucket: bucketB,
        key: objectKey,
        body: "drive#462 two-account proof",
      }),
    );

    // 1. account A's key is refused a LISTING of B's bucket.
    assertRefused(
      await attempt(keyA.client, "GET", { bucket: bucketB, query: { "list-type": "2" } }),
      "A's key listing B's bucket",
    );

    // 2. account A's key is refused a READ of B's object.
    assertRefused(
      await attempt(keyA.client, "GET", { bucket: bucketB, key: objectKey }),
      "A's key reading B's object",
    );

    // 3. account A's key is refused a WRITE into B's bucket.
    assertRefused(
      await attempt(keyA.client, "PUT", {
        bucket: bucketB,
        key: `${scopeB.prefix}intruder.txt`,
        body: "should never land",
      }),
      "A's key writing into B's bucket",
    );

    // The other direction too: a boundary that only holds one way is not a
    // boundary, and a per-account bucket that leaked B->A would still pass
    // the three above.
    assertRefused(
      await attempt(keyB.client, "GET", { bucket: bucketA, query: { "list-type": "2" } }),
      "B's key listing A's bucket",
    );

    // And A's own key still WORKS in A's own bucket, so the three refusals
    // above are the boundary and not a key that simply cannot reach storage.
    // This is the control the proof needs: a key refused everywhere proves
    // nothing.
    await ok(
      "A's key writes in A's own bucket",
      await keyA.client.send("PUT", {
        bucket: bucketA,
        key: `${scopeA.prefix}control.txt`,
        body: "A's own key, its own bucket",
      }),
    );
    await ok(
      "A's key reads back what it wrote",
      await keyA.client.send("GET", {
        bucket: bucketA,
        key: `${scopeA.prefix}control.txt`,
      }),
    );
    await ok(
      "A's key lists its own bucket",
      await keyA.client.send("GET", { bucket: bucketA, query: { "list-type": "2" } }),
    );

    // 4. an AGENT key is refused a DELETE in its OWN bucket. The agent
    // capability is list/read/write (keyprovider.js CAPABILITIES_BY_KIND),
    // and the mint turned that into `disable_delete_version` (idrive-keys.js),
    // so the vendor refuses the delete. This is the assertion that an agent
    // can never destroy the hidden version a delete left behind.
    await ok(
      "the master seeds A's bucket with a deletable object",
      await master.send("PUT", {
        bucket: bucketA,
        key: `${scopeA.prefix}seed.txt`,
        body: "seed",
      }),
    );
    assertRefused(
      await attempt(keyA.client, "DELETE", { bucket: bucketA, key: `${scopeA.prefix}seed.txt` }),
      "an agent key deleting in its own bucket",
    );
  } finally {
    // The proof leaves the account as it found it: every key it minted is
    // withdrawn at the vendor, so no live credential outlives the run.
    for (const revoke of cleanup.reverse()) {
      await revoke().catch(() => {
        // A revoke that fails is reported, never swallowed: a credential
        // that is still live at the vendor is a real finding.
        console.error("idrive two-account proof: a key revoke failed");
      });
    }
  }
});
