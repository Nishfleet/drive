// The storage-server key provider (build step 1, drive#2): what it asks the
// endpoint for, and the one bucket it asks for.
//
// drive#462 was found here. The provider resolved its bucket from a
// deployment-wide `STORAGE_BUCKET`, so every key it minted was scoped to that
// one shared bucket — two accounts' files sat in the same bucket with the
// prefix as the only thing between them, and a key that could name one
// account's prefix could ask the endpoint about the other account's bytes
// with the same policy. drive#371 had already moved the boundary to the bucket
// (one bucket per account, one per team), so this file now takes the bucket
// from the scope the caller built and refuses a scope that names none.
//
// The proofs below are the table: every key provider path (device, agent, an
// s3 integration, a branch key and a team key), what policy the endpoint gets
// for it, and that no path's answer can name another account's bucket. The
// S3 calls the mint makes are the real signed stock shape
// (`s3.js` `createS3Client`, STS `AssumeRole`); only the server is a stand-in.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createIdriveKeyProvider } from "../src/idrive-keys.js";
import {
  bucketForAccount,
  bucketForTeam,
  KEY_KINDS,
  scopeFor,
  teamScopeFor,
} from "../src/keyprovider.js";
import { createS3KeyProvider, policyForScope, s3KeyProviderFromEnv } from "../src/s3-keys.js";

/**
 * One STS `AssumeRole` call as the provider made it, read off the signed
 * request the client handed to fetch. The policy here is the one the endpoint
 * will enforce, so it is the proof of what a minted key can reach.
 * @typedef {{method: string, url: string, policy: {Version: string, Statement: Array<Record<string, unknown>>}|null, durationSeconds: string, roleArn: string|null}} StsCall
 */

/**
 * An STS endpoint that records what the mint asked for and answers the way a
 * stock one does. `calls` is the proof, and `absent` drops named fields out of
 * the answer the way an endpoint answering without the whole credential does.
 * @param {StsCall[]} calls
 * @param {Array<"AccessKeyId"|"SecretAccessKey"|"SessionToken">} [absent]
 */
function stsStand(calls, absent = []) {
  return async (
    /** @type {URL | RequestInfo} */ input,
    /** @type {RequestInit|undefined} */ init,
  ) => {
    // `s3.js` signs a `Request` and hands the whole thing to fetch, so the
    // stand-in reads the signed request back.
    const signed = input instanceof Request ? input : new Request(String(input), init);
    const target = new URL(signed.url);
    const form = new URLSearchParams(await signed.clone().text());
    calls.push({
      method: signed.method,
      url: `${target.origin}${target.pathname}${target.search}`,
      policy: JSON.parse(form.get("Policy") ?? "null"),
      durationSeconds: form.get("DurationSeconds") ?? "",
      roleArn: form.get("RoleArn"),
    });
    // A credential is three fields. An endpoint that answers with fewer has not
    // minted a key, however correctly it signed the call.
    const answer = {
      AccessKeyId: "AKIASTANDINAPIA",
      SecretAccessKey: "SHOWN-ONCE-SECRET",
      SessionToken: "SESSION-TOKEN",
    };
    return new Response(
      `<AssumeRoleResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><AssumeRoleResult><Credentials>` +
        Object.entries(answer)
          .filter(([tag]) => !absent.includes(/** @type {"AccessKeyId"} */ (tag)))
          .map(([tag, value]) => `<${tag}>${value}</${tag}>`)
          .join("") +
        `</Credentials></AssumeRoleResult></AssumeRoleResponse>`,
      { status: 200, headers: { "content-type": "application/xml" } },
    );
  };
}

/**
 * The whole of this provider's configuration: the endpoint, the region and the
 * master credential. There is no bucket here, and that is the point: a
 * deployment-wide bucket cannot be the bucket a key is scoped to, because
 * every account has its own.
 * @param {typeof fetch} [fetchImpl]
 */
function providerFor(fetchImpl) {
  return createS3KeyProvider({
    endpoint: "https://storage.example.test",
    region: "eu-west-3",
    masterAccessKeyId: "AKIASTANDIN",
    masterSecretAccessKey: "standin-secret",
    fetchImpl,
  });
}

/**
 * Every key provider path a mint can take, with the bucket the storage server
 * must scope it to. This is the drive#462 table: a kind missing from it is a
 * kind nobody has proven scoped to its own bucket, and the test after it fails
 * on exactly that.
 */
const PROVIDER_PATHS = [
  {
    kind: "device",
    name: "a person's device key",
    scope: () => scopeFor("device", "acct_a1"),
    bucket: bucketForAccount("acct_a1"),
  },
  {
    kind: "agent",
    name: "an agent key",
    scope: () => scopeFor("agent", "acct_a1"),
    bucket: bucketForAccount("acct_a1"),
  },
  {
    kind: "s3",
    name: "an s3 integration key",
    scope: () => scopeFor("s3", "acct_a1"),
    bucket: bucketForAccount("acct_a1"),
  },
  {
    kind: "branch",
    name: "a branch key",
    scope: () => scopeFor("branch", "acct_a1", { name: "feature-note" }),
    bucket: bucketForAccount("acct_a1"),
  },
  {
    kind: "team",
    name: "a team key",
    scope: () => teamScopeFor("read_write", "team_t1"),
    bucket: bucketForTeam("team_t1"),
  },
];

test("the table covers every kind the api can mint", () => {
  for (const kind of KEY_KINDS) {
    assert.ok(
      PROVIDER_PATHS.some((path) => path.kind === kind),
      `${kind} has a provider path in the table above`,
    );
  }
});

test("every key provider path mints a credential for the bucket that is its own", async () => {
  for (const path of PROVIDER_PATHS) {
    /** @type {StsCall[]} */
    const calls = [];
    const minted = await providerFor(stsStand(calls)).mint(path.scope());
    const scope = path.scope();
    // The answer carries the bucket, so the store can tell the caller which
    // bucket the key it just minted reaches.
    assert.equal(minted.bucket, scope.bucket, `${path.name}: the mint names its scope's bucket`);
    assert.equal(minted.bucket, path.bucket, `${path.name}: the bucket that is the scope's own`);
    assert.notEqual(minted.bucket, "", `${path.name}: the bucket is never empty`);
    // The credential is complete, or the answer would be half-built.
    assert.match(minted.accessKeyId, /^AKIA/, `${path.name}: an access key id is in the answer`);
    assert.equal(minted.secret, "SHOWN-ONCE-SECRET", `${path.name}: the secret is in the answer`);
    assert.equal(
      minted.sessionToken,
      "SESSION-TOKEN",
      `${path.name}: a session token is in the answer`,
    );
    assert.equal(minted.expiresIn, 3600, `${path.name}: the session is one hour by default`);
    // One call, to the service root, signed for the endpoint: the shape a
    // stock STS AssumeRole has.
    assert.equal(calls.length, 1, `${path.name}: exactly one AssumeRole call`);
    assert.equal(calls[0].method, "POST", `${path.name}: the AssumeRole is a POST`);
    assert.equal(calls[0].url, "https://storage.example.test/", `${path.name}: the service root`);
    assert.equal(calls[0].durationSeconds, "3600", `${path.name}: the session has a duration`);
    // The policy the endpoint enforces acts inside that bucket and that prefix
    // and nowhere else.
    const sent = JSON.stringify(calls[0].policy ?? null);
    assert.ok(
      sent.includes(`arn:aws:s3:::${scope.bucket}`),
      `${path.name}: the policy acts on the account's own bucket`,
    );
  }
});

test("two accounts' mints name two buckets, and neither policy names the other", async () => {
  /** @type {StsCall[]} */
  const oneCalls = [];
  /** @type {StsCall[]} */
  const twoCalls = [];
  const one = await providerFor(stsStand(oneCalls)).mint(scopeFor("device", "acct_a1"));
  const providerTwo = providerFor(stsStand(twoCalls));
  const two = await providerTwo.mint(scopeFor("device", "acct_a2"));
  assert.equal(one.bucket, bucketForAccount("acct_a1"));
  assert.equal(two.bucket, bucketForAccount("acct_a2"));
  assert.notEqual(one.bucket, two.bucket, "two accounts cannot share a bucket");
  // What a key can reach is its policy, so this is the proof that no key
  // reaches another account's bucket: account one's policy carries no ARN of
  // account two's bucket, in any statement.
  for (const [name, bucket, policy] of [
    ["account one", two.bucket, oneCalls[0].policy],
    ["account two", one.bucket, twoCalls[0].policy],
  ]) {
    assert.equal(
      JSON.stringify(policy).includes(`arn:aws:s3:::${bucket}`),
      false,
      `${name}'s policy must not name the other account's bucket`,
    );
    assert.equal(
      JSON.stringify(policy).includes(`${bucket}/`),
      false,
      `${name}'s policy must not touch an object inside the other account's bucket`,
    );
  }
  // Each policy acts only in its own bucket and inside its own prefix.
  assert.ok(JSON.stringify(oneCalls[0].policy).includes(`u/acct_a1/`));
  assert.ok(JSON.stringify(twoCalls[0].policy).includes(`u/acct_a2/`));
});

test("a scope that names no bucket is refused, and nothing is minted", async () => {
  /** @type {StsCall[]} */
  const calls = [];
  // The shape drive#462 found: a scope built by a provider that only knows a
  // prefix, where the bucket used to come from the deployment's own setting.
  const prefixOnly = /** @type {import("../src/keyprovider.js").KeyScope} */ (
    /** @type {unknown} */ ({ prefix: "u/acct_a1/", capabilities: ["list", "read", "write"] })
  );
  await assert.rejects(() => providerFor(stsStand(calls)).mint(prefixOnly), /names its bucket/);
  // An empty bucket is the same refusal: a key scoped to "" would be refused by
  // the endpoint, and silently minting anything else is the shared-bucket bug.
  const emptyBucket = { ...prefixOnly, bucket: "" };
  await assert.rejects(() => providerFor(stsStand(calls)).mint(emptyBucket), /names its bucket/);
  assert.equal(calls.length, 0, "a refused scope never reaches the endpoint");
});

test("the policy the endpoint enforces comes from the one capabilities table", () => {
  const bucket = bucketForAccount("acct_a1");
  const actionsByCapability = [
    { capability: "list", actions: ["s3:ListBucket", "s3:ListBucketVersions"], onBucket: true },
    { capability: "read", actions: ["s3:GetObject", "s3:GetObjectVersion"], onBucket: false },
    {
      capability: "write",
      actions: ["s3:PutObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"],
      onBucket: false,
    },
    {
      capability: "delete",
      actions: ["s3:DeleteObject", "s3:DeleteObjectVersion"],
      onBucket: false,
    },
  ];
  for (const row of actionsByCapability) {
    const policy = policyForScope(
      {
        prefix: "u/acct_a1/",
        capabilities: [/** @type {import("../src/keyprovider.js").Capability} */ (row.capability)],
        bucket,
      },
      bucket,
    );
    if (row.onBucket) {
      // A listing is on the bucket itself, so its resource is the bucket and
      // the prefix is a condition on it.
      assert.deepEqual(policy.Statement.length, 1, `${row.capability}: one statement`);
      assert.deepEqual(
        policy.Statement[0].Action,
        row.actions,
        `${row.capability}: the actions the endpoint enforces`,
      );
      assert.deepEqual(policy.Statement[0].Resource, [`arn:aws:s3:::${bucket}`]);
      assert.deepEqual(
        /** @type {{Condition: {StringLike: {[key: string]: unknown}}}} */ (policy.Statement[0])
          .Condition.StringLike["s3:prefix"],
        ["u/acct_a1/*", "u/acct_a1"],
        `${row.capability}: the listing is narrowed to the account's own folder`,
      );
      continue;
    }
    assert.deepEqual(
      policy.Statement.flatMap((statement) => /** @type {string[]} */ (statement.Action)),
      row.actions,
      `${row.capability}: the actions the endpoint enforces`,
    );
    assert.deepEqual(
      policy.Statement.flatMap((statement) => /** @type {string[]} */ (statement.Resource)),
      [`arn:aws:s3:::${bucket}/u/acct_a1/*`],
      `${row.capability}: only objects inside this account's own bucket`,
    );
  }
  // A device key holds all four, so both statements are there; an agent key
  // holds no delete, in either spelling, in either bucket.
  const device = policyForScope(scopeFor("device", "acct_a1"), bucket);
  assert.equal(device.Statement.length, 2);
  assert.ok(JSON.stringify(device).includes("s3:DeleteObjectVersion"));
  const agent = policyForScope(scopeFor("agent", "acct_a1"), bucket);
  assert.equal(JSON.stringify(agent).includes("s3:DeleteObject"), false);
});

test("a policy for one bucket is refused a scope that names another", () => {
  // The bucket is the boundary, so a policy built for one bucket and answered
  // with another would scope a key somewhere the caller did not mean. The
  // refusal is here rather than a silent preference, so a caller that passes
  // the wrong bucket finds out at the mint.
  const scope = scopeFor("agent", "acct_a1");
  assert.throws(() => policyForScope(scope, "drv-someone-else"), /scoped to the bucket it names/);
  // The scope's own bucket is the one that builds, and a scope naming none
  // still takes the caller's (the test above does exactly that).
  const ownBucket = bucketForAccount("acct_a1");
  assert.equal(scope.bucket, ownBucket);
  assert.doesNotThrow(() => policyForScope(scope, ownBucket));
});

test("a longer session and a role ARN are the deployment's choice, not the bucket's", async () => {
  /** @type {StsCall[]} */
  const calls = [];
  const provider = createS3KeyProvider({
    endpoint: "https://storage.example.test",
    region: "eu-west-3",
    masterAccessKeyId: "AKIASTANDIN",
    masterSecretAccessKey: "standin-secret",
    sessionSeconds: 7200,
    sessionName: "drive-standin",
    roleArn: "arn:aws:iam::123456789012:role/drive",
    fetchImpl: stsStand(calls),
  });
  const minted = await provider.mint(scopeFor("device", "acct_a1"));
  assert.equal(minted.expiresIn, 7200, "the answer says how long the credential lives");
  assert.equal(calls[0].durationSeconds, "7200");
  assert.equal(calls[0].roleArn, "arn:aws:iam::123456789012:role/drive");
});

test("an incomplete credential answer is refused, not half-handed-back", async () => {
  /** @type {StsCall[]} */
  const calls = [];
  // A 200 with the session token missing: the answer is not a credential.
  await assert.rejects(
    () => providerFor(stsStand(calls, ["SessionToken"])).mint(scopeFor("device", "acct_a1")),
    /IncompleteAssumeRole/,
  );
});

test("an endpoint refusal is the failure it is", async () => {
  const provider = createS3KeyProvider({
    endpoint: "https://storage.example.test",
    region: "eu-west-3",
    masterAccessKeyId: "AKIASTANDIN",
    masterSecretAccessKey: "standin-secret",
    fetchImpl: async () =>
      new Response(
        "<Error><Code>AccessDenied</Code><Message>AssumeRole is disabled</Message></Error>",
        {
          status: 403,
          headers: { "content-type": "application/xml" },
        },
      ),
  });
  // iDrive e2 measured exactly this on the real endpoint (drive#173): its STS
  // refuses AssumeRole, so no scoped key can be minted there at all.
  await assert.rejects(
    () => provider.mint(scopeFor("device", "acct_a1")),
    /AssumeRole is disabled/,
  );
});

test("a provider without the credential is refused before it can mint", () => {
  assert.throws(
    () =>
      createS3KeyProvider({
        endpoint: "https://storage.example.test",
        region: "eu-west-3",
        masterAccessKeyId: "",
        masterSecretAccessKey: "standin-secret",
      }),
    /master credential/,
  );
  assert.throws(
    () =>
      createS3KeyProvider({
        endpoint: "https://storage.example.test",
        region: "eu-west-3",
        masterAccessKeyId: "AKIASTANDIN",
        masterSecretAccessKey: "standin-secret",
        sessionSeconds: 60,
      }),
    /sessionSeconds/,
  );
});

test("the environment gives this provider no bucket to scope a key to", () => {
  const full = {
    STORAGE_ENDPOINT: "https://storage.example.test",
    STORAGE_REGION: "eu-west-3",
    STORAGE_MASTER_ACCESS_KEY_ID: "AKIASTANDIN",
    STORAGE_MASTER_SECRET_ACCESS_KEY: "standin-secret",
  };
  assert.equal(s3KeyProviderFromEnv({}), null, "a deployment with no storage config mints no key");
  // The drive#462 shape: a deployment that set only a bucket. With the bucket
  // gone from this provider, a bucket alone no longer configures anything.
  assert.equal(s3KeyProviderFromEnv({ STORAGE_BUCKET: "drive-standin" }), null);
  const half = s3KeyProviderFromEnv({
    STORAGE_ENDPOINT: "https://storage.example.test",
    STORAGE_REGION: "eu-west-3",
    STORAGE_BUCKET: "drive-standin",
  });
  assert.throws(() => half?.mint(scopeFor("device", "acct_a1")), /half-configured/);
  const refused = /** @type {{mint: Function, revoke: Function}} */ (half);
  assert.throws(() => refused.revoke("AKIA1"), /half-configured/);
  const whole = s3KeyProviderFromEnv({ ...full, STORAGE_BUCKET: "drive-standin" });
  // A deployment-wide bucket left in the environment cannot become the bucket
  // a key is scoped to: the provider ignores it, so every mint answers the
  // scope's own bucket.
  assert.equal(typeof whole?.mint, "function", "the four settings are the whole configuration");
});

test("a provider whose mints die on their own says so, and a permanent one stays silent", () => {
  // drive#713: the stores refuse a null-expiry device row on this signal, so
  // the two halves are pinned here — the session provider names the session,
  // the permanent one does not.
  const session = createS3KeyProvider({
    endpoint: "https://storage.example.test",
    region: "eu-west-3",
    masterAccessKeyId: "AKIASTANDIN",
    masterSecretAccessKey: "standin-secret",
  });
  assert.equal(
    session.namesSession,
    true,
    "the STS path mints a session the vendor ends itself, and says so",
  );

  // The half-configured stub stands in for the same deployment while the
  // config is broken: a row it minted before the break is an STS row too.
  const half = s3KeyProviderFromEnv({
    STORAGE_ENDPOINT: "https://storage.example.test",
    STORAGE_REGION: "eu-west-3",
  });
  assert.equal(half?.namesSession, true, "the half-configured stub names the session too");

  // The deliberate permanent half: iDrive's key pairs do not die on their
  // own, so a null `expires_at` there is a real permanent key, and the
  // signal stays absent rather than false.
  const permanent = createIdriveKeyProvider({
    apiEndpoint: "https://api.example.test/api/reseller/v1",
    apiToken: "test-token",
    fetchImpl: async () => {
      throw new Error("no vendor call is needed to read the signal");
    },
  });
  assert.notEqual(
    /** @type {{namesSession?: true}} */ (permanent).namesSession,
    true,
    "iDrive's key pairs are permanent keys, not sessions",
  );
});
