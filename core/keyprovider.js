// Storage access goes through a KeyProvider so the stand-in and the real
// iDrive e2 / Backblaze B2 implementations are interchangeable.

/**
 * What a key may do. `delete` is the only difference between a person's device
 * key and every agent-facing key (docs/build-spec.md, "Keys and safety").
 * @typedef {"list"|"read"|"write"|"delete"} Capability
 * @typedef {{prefix: string, capabilities: ReadonlyArray<Capability>, bucket?: string}} KeyScope
 *
 * The secret is shown once and never stored by the api. `expiresAt` is the
 * epoch second the credential stops working at, or null when the kind never
 * expires: the caller (the CLI) shows it, and the store enforces it.
 * @typedef {{keyId: string, accessKeyId: string, secret: string, sessionToken?: string|null, expiresIn?: number|null, expiresAt?: number|null}} MintedKey
 *
 * What a mint answers with: the credential, and nothing else. `keyId`, the
 * api's own name for the row, is the store's to give, not the vendor's.
 * @typedef {{accessKeyId: string, secret: string, sessionToken?: string|null, expiresIn?: number|null, expiresAt?: number|null, [name: string]: unknown}} MintedCredential
 *
 * What an account-bound provider answers with: the credential plus the api's
 * own id for the row that now holds its hash. A raw storage provider persists
 * no rows, so it has no id to hand back, which is why this is a type of its
 * own rather than KeyProvider with an optional field (drive#371).
 * @typedef {{mint: (scope: KeyScope, options?: {expiresAt?: number|null}) => Promise<MintedKey>, revoke?: (keyId: string) => Promise<unknown>, swapToReadOnly?: (keyId: string) => Promise<MintedKey>}} AccountKeyProvider
 *
 * @typedef {object} KeyProvider
 * @property {(scope: KeyScope, options?: {expiresAt?: number|null}) => Promise<MintedCredential>} mint
 *   `options.expiresAt` is the epoch second a credential bounded by a clock
 *   stops at, and a provider whose vendor expires keys takes it
 * @property {(keyId: string) => Promise<void>} [revoke] withdraws the
 *   credential at the provider, so a revoked row is also a key that stops
 *   working (drive#371). A provider whose credential is bounded anyway — an STS
 *   session — has no revoke, and its caller checks for one rather than
 *   assuming it.
 * @property {(keyId: string) => Promise<MintedKey>} [swapToReadOnly] Replaces a
 *   write-capable key with a read-only one on the same prefix (cap reached).
 *   Optional because the api's own store mints the replacement itself and only
 *   needs the provider's mint: the boundary a swap keeps is the bucket, which
 *   the store rebuilds from the account id rather than asking the vendor.
 * @property {true} [namesSession] Whether this provider's mints are
 *   credentials that die on their own: the STS path (s3-keys.js) mints a
 *   session of `sessionSeconds` that the vendor itself ends, so a credential
 *   whose api row says "never expires" is a dead session wearing an immortal
 *   label. Absent means the mints do not die on their own (iDrive key pairs,
 *   the stand-in), and a null `expires_at` on a row is a deliberate permanent
 *   key. The stores read this when refusing rows minted before drive#544
 *   started recording the session on the row (drive#713).
 */

/** @typedef {"device"|"agent"|"s3"|"branch"} KeyKind */
/** @type {ReadonlyArray<KeyKind>} */
export const KEY_KINDS = ["device", "agent", "s3", "branch"];

/**
 * The bucket name prefix every customer's own bucket carries, and the one a
 * team's carries (drive#371). One bucket per account, one per team: the vendor
 * allows unlimited buckets (measured 2026-10-03, drive#173), and a key limited
 * to a bucket is a key the storage server refuses outside that bucket — which
 * is the guarantee the old `u/<id>/` prefix could not give on iDrive e2, the
 * one vendor measured that cannot scope a key to a folder.
 */
export const ACCOUNT_BUCKET_PREFIX = "drv-";
export const TEAM_BUCKET_PREFIX = "drv-t-";

/**
 * The one kind to capabilities table (docs/build-spec.md, "Keys and safety").
 * It is declared here and nowhere else: scopeFor() below builds storage scopes
 * from it, and the pricing Worker's cap logic (core/cap.js) re-exports this same
 * frozen object as WRITE_SCOPE_BY_KIND instead of keeping a second copy, so a
 * kind cannot end up with different powers in two places. The import crosses
 * the two src trees on purpose (drive#77): each Worker bundles its own module
 * copy at build time, so there is never one shared mutable instance at runtime,
 * and a change to the table reaches both Workers from this one file.
 * @type {Readonly<Record<KeyKind, ReadonlyArray<Capability>>>}
 */
export const CAPABILITIES_BY_KIND = Object.freeze({
  device: Object.freeze(
    /** @type {ReadonlyArray<Capability>} */ (["list", "read", "write", "delete"]),
  ),
  agent: Object.freeze(/** @type {ReadonlyArray<Capability>} */ (["list", "read", "write"])),
  s3: Object.freeze(/** @type {ReadonlyArray<Capability>} */ (["list", "read", "write"])),
  branch: Object.freeze(/** @type {ReadonlyArray<Capability>} */ (["list", "read", "write"])),
});

/**
 * The hour. Every machine credential — an agent tool's key, a raw s3 key, a
 * key a sandbox holds — lives this long and is renewed only while what holds
 * it is still allowed (drive issue #106).
 *
 * Space hands out a one-hour scoped credential and swaps it as the agent
 * works; ours lived until the person revoked it, so a leaked agent key was a
 * key that worked forever. The api Worker keeps only a hash, so a leaked
 * *secret* is not what this bounds: what it bounds is the credential itself,
 * which is what a sandbox environment, a shared terminal or a copied MCP
 * entry hands over.
 */
export const AGENT_KEY_TTL_SECONDS = 3600;

/**
 * How long a minted credential is good for, by kind.
 *
 * `null` is a key that never dies on its own, and only one kind earns it: a
 * person's own device. The table is the authority, exactly as
 * CAPABILITIES_BY_KIND is, so a kind cannot be given a short life in one
 * place and a long one in another. Every other kind is a machine credential,
 * so every other kind gets the hour; the two tables are pinned to each other
 * by the test in workers/api/test/keyprovider.test.js, so a kind cannot be
 * added to one without the other.
 * @type {Readonly<Record<KeyKind, number|null>>}
 */
export const KEY_TTL_SECONDS = Object.freeze({
  device: null,
  agent: AGENT_KEY_TTL_SECONDS,
  s3: AGENT_KEY_TTL_SECONDS,
  branch: AGENT_KEY_TTL_SECONDS,
});

/**
 * The seconds a kind's credential lives, or null when it never expires. An
 * unknown kind is refused here rather than answered `null`: a typo silently
 * minting an immortal credential is the failure the whole table exists to
 * stop.
 * @param {KeyKind} kind
 * @returns {number|null}
 */
export function keyTtlSeconds(kind) {
  if (!Object.hasOwn(KEY_TTL_SECONDS, kind)) {
    throw new TypeError(`No key lifetime for kind ${JSON.stringify(kind)}.`);
  }
  const ttl = KEY_TTL_SECONDS[/** @type {KeyKind} */ (kind)];
  return typeof ttl === "number" && Number.isFinite(ttl) && ttl > 0 ? ttl : null;
}

/**
 * The seconds a minted credential lives, with the kind's hour as the ceiling
 * (drive issue #106).
 *
 * A provider may name a session lifetime of its own, and a shorter one wins:
 * a session that dies in 15 minutes must not be stretched to the api's hour
 * by bookkeeping that outlives it. A longer one does not win, and that is the
 * half the issue is about — "one hour, and no longer" is a claim the api
 * makes about its own credential, so a provider session of six hours is
 * refused by the api at the hour and a tool that keeps working keeps asking
 * for a fresh credential. The api's enforcement is the bound, so the bound
 * cannot be widened from a config file.
 *
 * `null` still means the kind never expires on a provider that names no
 * session, and still only a person's own device earns it. On a provider that
 * DOES name a session, a device row records the session: the vendor ends the
 * credential when it ends, whatever the row says, which is why the mint
 * answer carries `expiresIn` (drive#544) and why a device row that pretends
 * otherwise is refused at authenticate (drive#713). The session is then the
 * row's lifetime, and renewal (drive#749) is a fresh credential under the
 * same row id before that session ends — not a moved window, because no
 * window keeps a vendor session alive.
 * @param {KeyKind} kind
 * @param {number|null|undefined} providerExpiresIn the provider session's own
 *   seconds, when it names one
 * @returns {number|null}
 */
export function mintTtlSeconds(kind, providerExpiresIn) {
  const ceiling = keyTtlSeconds(kind);
  if (ceiling === null) {
    if (
      typeof providerExpiresIn === "number" &&
      Number.isFinite(providerExpiresIn) &&
      providerExpiresIn > 0
    ) {
      return providerExpiresIn;
    }
    return null;
  }
  if (typeof providerExpiresIn !== "number" || !Number.isFinite(providerExpiresIn)) {
    return ceiling;
  }
  if (providerExpiresIn <= 0) {
    return ceiling;
  }
  return Math.min(providerExpiresIn, ceiling);
}

/**
 * The seconds a renewal may add to a row, and the ceiling on every renewal
 * that row will ever get (drive issue #106).
 *
 * A provider that names a session lifetime of its own keeps it: a credential
 * whose session dies in 15 minutes must not be renewed into an hour, because
 * the hour would be a claim the provider does not stand behind. So the row
 * carries the lifetime the mint actually gave it — the kind's hour as a
 * ceiling, the provider's own session when that is shorter — and every
 * renewal is measured from that. A row written before the column existed
 * carries nothing, and the kind's hour is then the ceiling: an old row is not
 * handed a longer life than a new one.
 *
 * @param {{kind?: string, ttlSeconds?: number|null}} device the row being renewed
 * @param {number} ceiling the kind's own lifetime
 * @returns {number}
 */
export function renewTtlSeconds(device, ceiling) {
  const row = /** @type {{ttlSeconds?: number|null}} */ (device).ttlSeconds;
  if (typeof row === "number" && Number.isFinite(row) && row > 0) {
    return Math.min(row, ceiling);
  }
  return ceiling;
}

/** @typedef {"read_only"|"read_write"} TeamRole */

/** @type {ReadonlyArray<TeamRole>} */
export const TEAM_ROLES = ["read_only", "read_write"];

/**
 * The one role to capabilities table for a team member (drive#20). A team key
 * is scoped to the team prefix `t/<teamId>/` rather than an account folder,
 * and the role is what decides its powers: a read-only member may list and
 * read the shared drive and may not write it. Declared here and nowhere else,
 * for the same reason CAPABILITIES_BY_KIND is: `teamScopeFor()` below builds
 * the scope from this table, and the storage write route reads a device's own
 * row rather than a second copy of the rule, so a role cannot end up with two
 * different powers in two places.
 * @type {Readonly<Record<TeamRole, ReadonlyArray<Capability>>>}
 */
export const TEAM_ROLE_CAPABILITIES = Object.freeze({
  read_only: Object.freeze(/** @type {ReadonlyArray<Capability>} */ (["list", "read"])),
  read_write: Object.freeze(/** @type {ReadonlyArray<Capability>} */ (["list", "read", "write"])),
});

// A prefix is the storage safety boundary: whatever lands in it can only ever
// name paths inside one account's folder. `..` and `/` are what would point a
// prefix outside it, so neither character set admits them, and the length cap
// keeps a junk id from becoming a junk key name upstream.
const ACCOUNT_ID_SAFE = /^[A-Za-z0-9_-]{1,64}$/;
const BRANCH_NAME_SAFE = /^[A-Za-z0-9_.-]{1,64}$/;
// A team id is the same shape as an account id (`newId("team")` makes
// `team_<hex>`), so it is checked with the same rule: it goes into the shared
// prefix, and a `/` or `..` in it would point that prefix at another drive.
const TEAM_ID_SAFE = /^[A-Za-z0-9_-]{1,64}$/;
// The one team prefix shape, read back out of a key row's prefix. It is the
// same shape `teamPrefix` writes (the same character class as TEAM_ID_SAFE,
// between `t/` and the trailing slash), so the segment a match captures is an
// id `checkedTeamId` already accepted when the prefix was built.
const TEAM_PREFIX_PATTERN = /^t\/([A-Za-z0-9_-]{1,64})\/$/;

/**
 * @param {unknown} accountId
 * @returns {string}
 */
function checkedAccountId(accountId) {
  if (typeof accountId !== "string" || !ACCOUNT_ID_SAFE.test(accountId)) {
    throw new TypeError(
      `An account id is 1 to 64 characters of letters, digits, dash or underscore, got ${JSON.stringify(accountId)}.`,
    );
  }
  return accountId;
}

/**
 * @param {unknown} teamId
 * @returns {string}
 */
function checkedTeamId(teamId) {
  if (typeof teamId !== "string" || !TEAM_ID_SAFE.test(teamId)) {
    throw new TypeError(
      `A team id is 1 to 64 characters of letters, digits, dash or underscore, got ${JSON.stringify(teamId)}.`,
    );
  }
  return teamId;
}

/**
 * An id as it can sit in a bucket name. S3 bucket names are lowercase letters,
 * digits and dashes (MinIO answers InvalidBucketName for anything else, and
 * the real vendors refuse it too), while sign-in ids are mixed case and may
 * carry an underscore. Only the bucket name is folded: the `u/<id>/` prefix
 * keeps the id as it is, so two ids that fold to one bucket would still be two
 * prefixes. A random 32-character id folding onto another's is not a case the
 * 62^32 space produces.
 * @param {string} id
 * @returns {string}
 */
function bucketSafe(id) {
  return id.toLowerCase().replaceAll("_", "-");
}

/**
 * The bucket one account's files live in: `drv-<accountId>`. The id is checked
 * with the same rule the prefix uses, so a bucket name cannot be built from an
 * id that would have been refused as a prefix, and the bucket and the prefix a
 * scope carries always name the same customer.
 * @param {unknown} accountId
 * @returns {string}
 */
export function bucketForAccount(accountId) {
  return `${ACCOUNT_BUCKET_PREFIX}${bucketSafe(checkedAccountId(accountId))}`;
}

/**
 * The bucket one team's shared drive lives in: `drv-t-<teamId>` (drive#371).
 * @param {unknown} teamId
 * @returns {string}
 */
export function bucketForTeam(teamId) {
  return `${TEAM_BUCKET_PREFIX}${bucketSafe(checkedTeamId(teamId))}`;
}

/**
 * The bucket one key row's own prefix puts it in (drive#462).
 *
 * A prefix `teamPrefix` built is `t/<teamId>/` and names the team's shared
 * drive, so the key belongs in the team's bucket: a cap swap that replaces
 * such a key with one scoped to the account's own bucket would move the
 * member out of the drive they share. Every other prefix is an account's
 * own — `u/<id>/` and a branch's `u/<id>/.branches/<name>/` — which is the
 * account's bucket.
 *
 * The team id is read back out of the prefix because a device row carries no
 * team column of its own (migrations/drive/0008_teams.sql puts the team in
 * the prefix, and the revokes match on that string), so the prefix is where
 * a row's team identity lives.
 * @param {unknown} accountId the row's account, for a prefix that is not a team's
 * @param {string} prefix
 * @returns {string}
 */
export function bucketForKeyPrefix(accountId, prefix) {
  const team = TEAM_PREFIX_PATTERN.exec(prefix);
  return team === null ? bucketForAccount(accountId) : bucketForTeam(team[1]);
}

/**
 * @param {unknown} role
 * @returns {TeamRole}
 */
export function checkedTeamRole(role) {
  if (typeof role !== "string" || !TEAM_ROLES.includes(/** @type {TeamRole} */ (role))) {
    throw new TypeError(
      `A team role is one of ${TEAM_ROLES.join(", ")}, got ${JSON.stringify(role)}.`,
    );
  }
  return /** @type {TeamRole} */ (role);
}

/**
 * The prefix every key on one team gets: `t/<teamId>/`, whatever the role.
 *
 * Both roles share it, which is what makes a team revoke a prefix statement
 * rather than a per-key walk: a reader's and a writer's key on the same team
 * carry the same prefix, so one `WHERE prefix = ?` covers them. The two callers
 * that revoke by team read it from here instead of writing the literal, so a
 * change to the shape of the prefix cannot leave a revoke filtering on a
 * string the mint no longer writes.
 * @param {string} teamId
 * @returns {string}
 */
export function teamPrefix(teamId) {
  return `t/${checkedTeamId(teamId)}/`;
}

/**
 * The scope a team member's key gets: the team prefix `t/<teamId>/` and the
 * capabilities their role carries. The id is checked before it goes in the
 * prefix for the same reason scopeFor() checks the account id: a `..` or a
 * slash would build a prefix pointing at another team's drive.
 * @param {TeamRole} role
 * @param {string} teamId
 * @returns {KeyScope}
 */
export function teamScopeFor(role, teamId) {
  const checked = checkedTeamRole(role);
  return {
    prefix: teamPrefix(teamId),
    capabilities: TEAM_ROLE_CAPABILITIES[checked],
    bucket: bucketForTeam(teamId),
  };
}

/**
 * @param {unknown} name
 * @returns {string}
 */
export function checkedBranchName(name) {
  if (
    typeof name !== "string" ||
    name === "." ||
    name === ".." ||
    !BRANCH_NAME_SAFE.test(name) ||
    name.includes("..")
  ) {
    throw new TypeError(
      `A branch name is 1 to 64 characters of letters, digits, dot, dash or underscore, without "." or "..", got ${JSON.stringify(name)}.`,
    );
  }
  return name;
}

/**
 * The scope a kind of key gets for an account. Both the account id and the
 * branch name are checked before they are placed in the prefix: a branch name
 * like `../../x` or `a/b`, or an account id with a slash in it, would build a
 * prefix pointing outside the account's own folder, and this is the one place
 * that would let it. The bucket is built from that same checked id, because
 * the bucket is now the boundary (drive#371).
 * @param {KeyKind} kind
 * @param {string} accountId
 * @param {{name?: string}} [options] `name` is the branch name for branch keys.
 * @returns {KeyScope}
 */
export function scopeFor(kind, accountId, options = {}) {
  if (!KEY_KINDS.includes(kind)) {
    throw new Error(`Unknown key kind: ${kind}. Known kinds: ${KEY_KINDS.join(", ")}.`);
  }
  const home = `u/${checkedAccountId(accountId)}/`;
  // A branch is a folder inside the account's own bucket, so its key is
  // limited to the account's bucket like every other kind's (drive#371).
  const bucket = bucketForAccount(accountId);
  const capabilities = CAPABILITIES_BY_KIND[kind];
  if (kind === "branch") {
    if (options === null || typeof options !== "object") {
      throw new TypeError("A branch key needs options with a branch name.");
    }
    if (!options.name) {
      throw new TypeError("A branch key needs a branch name.");
    }
    return {
      prefix: `${home}.branches/${checkedBranchName(options.name)}/`,
      capabilities,
      bucket,
    };
  }
  return { prefix: home, capabilities, bucket };
}
