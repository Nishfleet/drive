import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AGENT_KEY_TTL_SECONDS,
  CAPABILITIES_BY_KIND,
  KEY_KINDS,
  KEY_TTL_SECONDS,
  keyTtlSeconds,
  mintTtlSeconds,
  renewTtlSeconds,
  scopeFor,
} from "../../../core/keyprovider.js";

// drive#77 finding 4: the storage prefix is the safety boundary, so scopeFor
// validates the account id and the branch name instead of trusting them.

test("the one kind to capabilities table covers every kind", () => {
  assert.deepEqual(Object.keys(CAPABILITIES_BY_KIND).sort(), [...KEY_KINDS].sort());
  for (const kind of KEY_KINDS) {
    const capabilities = CAPABILITIES_BY_KIND[kind];
    assert.ok(Array.isArray(capabilities) && capabilities.length > 0, `${kind} has capabilities`);
    assert.ok(
      capabilities.includes("list") && capabilities.includes("read"),
      `${kind} can read the drive`,
    );
  }
});

test("only a device key may delete", () => {
  assert.ok(CAPABILITIES_BY_KIND.device.includes("delete"));
  for (const kind of KEY_KINDS.filter((k) => k !== "device")) {
    assert.ok(!CAPABILITIES_BY_KIND[kind].includes("delete"), `${kind} must not delete`);
  }
});

test("key scopes follow the spec", () => {
  assert.deepEqual(scopeFor("device", "a1"), {
    prefix: "u/a1/",
    capabilities: ["list", "read", "write", "delete"],
    bucket: "drv-a1",
  });
  assert.ok(!scopeFor("agent", "a1").capabilities.includes("delete"));
  assert.equal(scopeFor("s3", "a1").prefix, "u/a1/");
  assert.equal(scopeFor("branch", "a1", { name: "x" }).prefix, "u/a1/.branches/x/");
  assert.throws(() => scopeFor("branch", "a1"));
});

test("scopeFor reads its capabilities from the one table", () => {
  for (const kind of KEY_KINDS) {
    const options = kind === "branch" ? { name: "fix" } : undefined;
    assert.deepEqual(scopeFor(kind, "a1", options).capabilities, CAPABILITIES_BY_KIND[kind]);
  }
});

test("an unknown kind is refused, and not through the prototype chain", () => {
  assert.throws(
    () => scopeFor(/** @type {never} */ (/** @type {unknown} */ ("mystery")), "a1"),
    /Unknown key kind/,
  );
  assert.throws(
    () => scopeFor(/** @type {never} */ (/** @type {unknown} */ ("constructor")), "a1"),
    /Unknown key kind/,
  );
  assert.throws(
    () => scopeFor(/** @type {never} */ (/** @type {unknown} */ ("__proto__")), "a1"),
    /Unknown key kind/,
  );
});

const badAccountIds = [
  "../x",
  "a/b",
  "a/../b",
  "..",
  ".",
  "a b",
  "a\\b",
  "a%2Fb",
  "",
  null,
  undefined,
  42,
  "x".repeat(65),
];

test("an account id that could point outside its own folder is refused", () => {
  for (const accountId of badAccountIds) {
    assert.throws(
      () => scopeFor("device", /** @type {string} */ (/** @type {unknown} */ (accountId))),
      /account id/i,
      `account id ${JSON.stringify(accountId)} must be refused`,
    );
  }
});

const badBranchNames = [
  "../../x",
  "a/b",
  ".",
  "..",
  "../..",
  "x..y",
  "a b",
  "",
  "a\\b",
  null,
  "x".repeat(65),
];

test("a branch name that could point outside the branches folder is refused", () => {
  for (const name of badBranchNames) {
    assert.throws(
      () =>
        scopeFor(
          "branch",
          "a1",
          /** @type {{name?: string}} */ (/** @type {unknown} */ ({ name })),
        ),
      /branch name/i,
      `branch name ${JSON.stringify(name)} must be refused`,
    );
  }
});

test("a branch key without options at all is refused", () => {
  assert.throws(
    () => scopeFor("branch", "a1", /** @type {{name?: string}} */ (/** @type {unknown} */ (null))),
    /options/i,
  );
  assert.throws(() => scopeFor("branch", "a1", {}), /branch name/i);
});

test("an account id and branch name from the real id format are accepted", () => {
  const accountId = "acct_0123456789abcdef0123456789abcdef";
  assert.equal(scopeFor("device", accountId).prefix, `u/${accountId}/`);
  assert.equal(
    scopeFor("branch", accountId, { name: "fix-login" }).prefix,
    `u/${accountId}/.branches/fix-login/`,
  );
});

// ---- the one-hour credential (drive issue #106) ----
//
// The competitor swaps a key for a one-hour scoped credential, so a leaked agent key
// stops working on its own. The lifetime is a per-kind table for the same
// reason the capabilities are: one place a kind's rules live, so a kind cannot
// be given an hour in one file and forever in another.

test("the one lifetime table covers every kind, and only a device key never expires", () => {
  assert.deepEqual(Object.keys(KEY_TTL_SECONDS).sort(), [...KEY_KINDS].sort());
  for (const kind of KEY_KINDS) {
    if (kind === "device") {
      assert.equal(keyTtlSeconds(kind), null, "a person's own device key never expires");
      continue;
    }
    assert.equal(keyTtlSeconds(kind), 3600, `${kind} lives one hour`);
  }
});

test("an unknown kind is refused a lifetime rather than handed an immortal credential", () => {
  assert.throws(
    () => keyTtlSeconds(/** @type {import("../../../core/keyprovider.js").KeyKind} */ ("root")),
    /lifetime/i,
  );
  assert.throws(
    () =>
      mintTtlSeconds(/** @type {import("../../../core/keyprovider.js").KeyKind} */ ("root"), 900),
    /lifetime/i,
  );
  // The renewal rule is handed the kind's ceiling rather than the kind, so it
  // has no kind to refuse: refusing the unknown kind is `keyTtlSeconds`'s job
  // and it is already pinned above.
});

test("the kind's hour is the ceiling: a shorter provider session wins, a longer one cannot", () => {
  // A session the provider will drop in 15 minutes must not be stretched by
  // bookkeeping that outlives it.
  assert.equal(mintTtlSeconds("agent", 900), 900);
  assert.equal(mintTtlSeconds("s3", 1), 1);
  // And the other way is the half the issue is about: "one hour, and no
  // longer" is the api's own claim about its own credential, so a provider
  // session of six hours is refused at the hour rather than honoured.
  assert.equal(mintTtlSeconds("agent", 43200), AGENT_KEY_TTL_SECONDS);
  assert.equal(mintTtlSeconds("branch", 86400), 3600);
  // A kind with no hour of its own takes the provider's session, which is the
  // only lifetime such a credential has: the STS provider mints sessions that
  // die (s3-keys.js), and a device row read "never expires" over one would be
  // a claim the api cannot keep (drive#544).
  assert.equal(mintTtlSeconds("device", 43200), 43200);
  // Nothing named a session, so the kind's own answer stands.
  assert.equal(mintTtlSeconds("device", null), null);
  // A provider that named a lifetime which cannot be true is refused, not
  // rounded up: for a device key the kind's own answer IS "never expires", so
  // folding a broken number into the ceiling would put the one claim this row
  // must never make straight onto it (drive#544).
  for (const nonsense of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => mintTtlSeconds("device", nonsense),
      /positive number or null/,
      `mintTtlSeconds("device", ${String(nonsense)}) must be refused`,
    );
  }
  // No provider session named, or a nonsense one, falls back to the hour.
  assert.equal(mintTtlSeconds("agent", null), 3600);
  assert.equal(mintTtlSeconds("agent", undefined), 3600);
  assert.throws(() => mintTtlSeconds("agent", 0), /positive number or null/);
  assert.throws(() => mintTtlSeconds("agent", -1), /positive number or null/);
  assert.throws(() => mintTtlSeconds("agent", Number.NaN), /positive number or null/);
  assert.throws(() => mintTtlSeconds("agent", Number.POSITIVE_INFINITY), /positive number or null/);
});

test("every machine kind is capped at the hour, so no config widens it", () => {
  for (const kind of KEY_KINDS.filter((k) => k !== "device")) {
    assert.equal(mintTtlSeconds(kind, 43200), 3600, `${kind} is capped at the hour`);
    assert.equal(mintTtlSeconds(kind, 60), 60, `${kind} may still be shorter`);
  }
});

test("a renewal never outlasts the lifetime the mint gave the row", () => {
  // A provider session of 15 minutes is renewed by 15 minutes, not by the
  // hour: the renewal must not claim a life the provider does not stand behind.
  assert.equal(renewTtlSeconds({ ttlSeconds: 900 }, AGENT_KEY_TTL_SECONDS), 900);
  // The kind's hour is the ceiling, so a row that somehow carries a longer
  // lifetime is still renewed by the hour and no more.
  assert.equal(renewTtlSeconds({ ttlSeconds: 43200 }, AGENT_KEY_TTL_SECONDS), 3600);
  // A row written before the column existed carries nothing, and the hour is
  // then the ceiling: an old row is never handed a longer life than a new one.
  assert.equal(renewTtlSeconds({}, AGENT_KEY_TTL_SECONDS), 3600);
  assert.equal(renewTtlSeconds({ ttlSeconds: null }, AGENT_KEY_TTL_SECONDS), 3600);
  assert.equal(renewTtlSeconds({ ttlSeconds: 0 }, AGENT_KEY_TTL_SECONDS), 3600);
  assert.equal(renewTtlSeconds({ ttlSeconds: Number.NaN }, AGENT_KEY_TTL_SECONDS), 3600);
  // The mint and the renewal agree, which is the claim that matters: what the
  // row was minted with is exactly what a renewal adds.
  for (const provider of [null, 60, 900, 3600, 43200]) {
    const minted = mintTtlSeconds("agent", provider);
    assert.equal(
      renewTtlSeconds({ ttlSeconds: minted }, AGENT_KEY_TTL_SECONDS),
      minted,
      `provider session ${String(provider)}: the renewal matches the mint`,
    );
  }
});
