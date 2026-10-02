import assert from "node:assert/strict";
import { test } from "node:test";
import { CAPABILITIES_BY_KIND, KEY_KINDS, scopeFor } from "../src/keyprovider.js";

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
