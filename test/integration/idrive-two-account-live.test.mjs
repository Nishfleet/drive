// The two-account proof on the real iDrive e2 account, which is the finish
// line drive#462 was measured from (the real Mac run of 2026-10-04, and the
// owner's top-priority addition: "not done until a two-account proof passes on
// real iDrive e2").
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
// Every assertion reads a refusal off the real endpoint's own answer, and a
// refusal is accepted only when the vendor's own code names ACCESS (not a bad
// signature or an unknown key id), so a broken credential cannot pass as a
// boundary. A 200 where a 403 is promised fails here rather than being read as
// a pass, and a control proves each key still works in its OWN bucket, so a
// key refused everywhere cannot pass as a boundary either.
//
// The credentials are the reseller token and the S3 master credential for the
// bucket provisioning, both of which are the owner's, and the run spends real
// money on a real paid bucket. So it is double-gated: it runs only when the
// credentials are in the environment AND `IDRIVE_LIVE_PROOF=1` says the money
// is approved, and it skips — naming exactly what is missing — otherwise. This
// is why drive#462 could not be closed by a worker run: the token is not on
// this host. Set the credentials and the flag and the whole proof is one
// command (run line below). See the header for the exact invocation.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createIdriveKeyProvider } from "../../workers/api/src/idrive-keys.js";
import { bucketForAccount, scopeFor } from "../../workers/api/src/keyprovider.js";
import { createS3Client, ok, provisionBucket } from "../../workers/api/src/s3.js";

// Run it with the owner's credentials already in the environment, and with the
// explicit go-ahead, because it spends real money on a real paid bucket:
//
//   IDRIVE_LIVE_PROOF=1 node --test test/integration/idrive-two-account-live.test.mjs
//
// with `IDRIVE_E2_API_TOKEN`, `IDRIVE_S3_ACCESS_KEY_ID` and
// `IDRIVE_S3_SECRET_ACCESS_KEY` exported. They are read from the environment
// rather than written on the command line on purpose: a token in argv sits in
// `/proc/<pid>/cmdline`, world-readable for the life of the call, and in the
// shell's history. Put them in a 0600 env file and load it (the host keeps the
// stand-in's the same way, `~/workspaces/agent-state/drive-145-idrive.env`):
//
//   set -a; . /path/to/idrive-e2.env; set +a
//   IDRIVE_LIVE_PROOF=1 node --test test/integration/idrive-two-account-live.test.mjs
//
// `IDRIVE_LIVE_PROOF=1` is required ON TOP OF the credentials, and that is the
// point: having a vendor token on a machine is not consent to spend money on
// it. A run with the token set and the flag unset skips and says so, so no CI
// job and no worker's run can provision a paid bucket by accident.
//
// The endpoint and region default to the real ones measured on 2026-10-03
// (drive#173) and can be overridden for a reseller-hosted endpoint. The two
// account ids are two throwaway accounts; the buckets and keys they get are
// removed at the end of the run.
const LIVE_PROOF = process.env.IDRIVE_LIVE_PROOF === "1";
const API_TOKEN = process.env.IDRIVE_E2_API_TOKEN ?? "";
const S3_ENDPOINT = process.env.IDRIVE_S3_ENDPOINT ?? "https://s3.eu-west-3.idrivee2.com";
const S3_REGION = process.env.IDRIVE_S3_REGION ?? "eu-west-3";
const API_ENDPOINT =
  process.env.IDRIVE_E2_API_ENDPOINT ?? "https://api.idrivee2.com/api/reseller/v1";
const MASTER_ID = process.env.IDRIVE_S3_ACCESS_KEY_ID ?? "";
const MASTER_SECRET = process.env.IDRIVE_S3_SECRET_ACCESS_KEY ?? "";

/**
 * A short random suffix so two runs (or two workers) never collide on a
 * bucket name that outlives the run.
 * @returns {string}
 */
function randomSuffix() {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 8);
}

// Two throwaway account ids for the run. bucketForAccount folds them the same
// way it folds a real id (lower case, `_` to `-`), so the buckets are real
// bucket names on the real account and are removed at the end.
const ACCOUNT_A = `drive462a${randomSuffix()}`;
const ACCOUNT_B = `drive462b${randomSuffix()}`;

// Why the whole proof is skipped, or null when it is cleared to run. Kept as
// one list so the skip names every missing piece rather than a bare "skipped".
const MISSING = [
  ...(LIVE_PROOF ? [] : ["IDRIVE_LIVE_PROOF=1 (the money go-ahead)"]),
  ...[
    ["IDRIVE_E2_API_TOKEN", API_TOKEN],
    ["IDRIVE_S3_ACCESS_KEY_ID", MASTER_ID],
    ["IDRIVE_S3_SECRET_ACCESS_KEY", MASTER_SECRET],
  ]
    .filter(([, value]) => value === "")
    .map(([name]) => name),
];

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
 * Assert a call was refused by the vendor FOR ACCESS, and nothing else.
 *
 * A 403 on its own proves very little: a signature the endpoint could not
 * check, or a key id it has never heard of, also answers 403, and either one
 * would pass a boundary proof while actually measuring a broken credential. So
 * only the codes the vendor uses for "you may not touch this" are accepted, and
 * a signature or unknown-key refusal fails the test.
 * @param {{status: number, code: string|null, text: string}} answer
 * @param {string} what the operation, for the assertion message
 */
function assertRefused(answer, what) {
  assert.equal(
    answer.status,
    403,
    `${what} should be refused 403 by the real endpoint, got ${answer.status}: ${answer.text.slice(0, 200)}`,
  );
  const ACCESS_DENIAL = ["AccessDenied", "AllAccessDisabled"];
  assert.ok(
    answer.code !== null && ACCESS_DENIAL.includes(answer.code),
    `${what} should be refused for access, not for a bad credential or a bad request; the code was ${answer.code}: ${answer.text.slice(0, 200)}`,
  );
}

test("two accounts' keys cannot reach each other on the real iDrive e2", async (t) => {
  if (MISSING.length > 0) {
    // The owner's credential is not on this host (drive#462: the reseller
    // token is Nish's, and the account itself is a paid reseller contract).
    // The proof is skipped rather than faked, and the skip names every missing
    // piece — the credentials and the money go-ahead.
    return t.skip(
      `the real iDrive e2 proof needs the owner's credentials and the money go-ahead, absent here: ${MISSING.join(", ")}. See the run line at the top of this file.`,
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

  // The two accounts, each with its own bucket and its own agent key. The keys
  // are minted through the real reseller API, so the credential the rest of
  // the proof uses is the one a real customer would be handed.
  const bucketA = bucketForAccount(ACCOUNT_A);
  const bucketB = bucketForAccount(ACCOUNT_B);
  /**
   * Everything the run created, each step registered the moment it exists, so
   * a failure part-way through still leaves nothing live. A key is pushed here
   * the instant it is minted — before the next mint — so a B mint that fails
   * cannot leak A's already-minted key; a bucket is pushed before its first
   * key. Cleanup runs newest-first.
   * @type {Array<{what: string, undo: () => Promise<unknown>}>}
   */
  const cleanup = [];
  /** @type {Array<{bucket: string, keys: Array<string>}>} */
  const ownedBuckets = [];

  try {
    // Each bucket is provisioned by the master (the real `provisionBucket`,
    // versioning + SSE + the one-day hidden-version rule), exactly as the api
    // Worker does on a mint that needs one. Registered so both are removed even
    // if the second provisioning fails.
    await provisionBucket(master, { bucket: bucketA, sse: "AES256" });
    ownedBuckets.push({ bucket: bucketA, keys: [] });
    await provisionBucket(master, { bucket: bucketB, sse: "AES256" });
    ownedBuckets.push({ bucket: bucketB, keys: [] });

    const scopeA = scopeFor("agent", ACCOUNT_A);
    const scopeB = scopeFor("agent", ACCOUNT_B);
    assert.equal(scopeA.bucket, bucketA);
    assert.equal(scopeB.bucket, bucketB);

    // Mint A's agent key, register its revoke immediately, then B's. A key is
    // live at the vendor from the moment it is minted, so its revoke is queued
    // before the next mint could fail.
    const mintedA = await provider.mint(scopeA);
    ownedBuckets[0].keys.push(mintedA.accessKeyId);
    cleanup.push({
      what: `revoke key ${mintedA.accessKeyId}`,
      undo: () => provider.revoke(mintedA.accessKeyId),
    });
    const mintedB = await provider.mint(scopeB);
    ownedBuckets[1].keys.push(mintedB.accessKeyId);
    cleanup.push({
      what: `revoke key ${mintedB.accessKeyId}`,
      undo: () => provider.revoke(mintedB.accessKeyId),
    });
    const keyA = { client: clientFor(mintedA), accessKeyId: mintedA.accessKeyId };
    const keyB = { client: clientFor(mintedB), accessKeyId: mintedB.accessKeyId };

    // A real object in B's bucket, written by the master, so B has something of
    // its own to read (and A has something of B's to fail on). A matching
    // object in A's bucket is the seed for the delete check below.
    const objectKey = `${scopeB.prefix}proof-object.txt`;
    await ok(
      "the master writes B's proof object",
      await master.send("PUT", {
        bucket: bucketB,
        key: objectKey,
        body: "drive#462 two-account proof",
      }),
    );
    const seedKey = `${scopeA.prefix}seed.txt`;
    await ok(
      "the master seeds A's bucket with a deletable object",
      await master.send("PUT", { bucket: bucketA, key: seedKey, body: "seed" }),
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

    // The other direction too, and not only the listing: a boundary that holds
    // for list but not for read or write is not a boundary, and a per-account
    // bucket that leaked B->A would still pass the three above.
    assertRefused(
      await attempt(keyB.client, "GET", { bucket: bucketA, query: { "list-type": "2" } }),
      "B's key listing A's bucket",
    );
    assertRefused(
      await attempt(keyB.client, "GET", { bucket: bucketA, key: seedKey }),
      "B's key reading A's object",
    );
    assertRefused(
      await attempt(keyB.client, "PUT", {
        bucket: bucketA,
        key: `${scopeA.prefix}intruder.txt`,
        body: "should never land",
      }),
      "B's key writing into A's bucket",
    );

    // And A's own key still WORKS in A's own bucket, so the refusals above are
    // the boundary and not a key that simply cannot reach storage. This is the
    // control the proof needs: a key refused everywhere proves nothing.
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
      await keyA.client.send("GET", { bucket: bucketA, key: `${scopeA.prefix}control.txt` }),
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
    assertRefused(
      await attempt(keyA.client, "DELETE", { bucket: bucketA, key: seedKey }),
      "an agent key deleting in its own bucket",
    );
  } finally {
    // The proof leaves the account as it found it: every key it minted is
    // withdrawn at the vendor, then every owned object version and both
    // buckets are removed, newest-first. A cleanup step that fails is a real
    // finding (a credential or paid bucket still live at the vendor) and is
    // reported, not swallowed — but it does not mask the boundary assertions,
    // which have already run.
    for (const step of cleanup.reverse()) {
      await step.undo().catch((error) => {
        console.error(
          `idrive two-account proof: cleanup step "${step.what}" failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }
    for (const { bucket } of ownedBuckets) {
      // Delete every object this run wrote, then the bucket, so a run's own
      // objects do not outlive it. Listing is by the account's own prefix (the
      // one the keys above were scoped to) and the `<Key>` values are read off
      // the listing, so only the run's own objects are removed.
      const prefix = bucket === bucketA ? `u/${ACCOUNT_A}/` : `u/${ACCOUNT_B}/`;
      const listed = await attempt(master, "GET", {
        bucket,
        query: { "list-type": "2", prefix },
      }).catch(() => null);
      if (listed !== null && listed.status === 200) {
        for (const match of listed.text.matchAll(/<Key>([^<]+)<\/Key>/g)) {
          await master.send("DELETE", { bucket, key: match[1] }).catch(() => {
            console.error(`idrive two-account proof: could not remove ${bucket}/${match[1]}`);
          });
        }
      }
      await master.send("DELETE", { bucket }).catch(() => {
        console.error(`idrive two-account proof: could not remove bucket ${bucket}`);
      });
    }
  }
});
