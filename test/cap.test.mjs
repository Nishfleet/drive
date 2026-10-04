// Tests for cap enforcement (drive issue #52, build step 6's cap half): the
// read-only key swap at the cap, the write keys coming back when the cap is
// raised, `drive cap <dollars>`'s parsing, and the cap line `drive status`
// prints.
//
// The acceptance the issue names is the build-spec.md finish line for step 6:
// "a capped account goes read-only with no file lost and starts writing again
// once the cap is raised". The last two tests below walk exactly that: a
// default account past 1.5 TB goes read-only through enforceCap() reading
// src/billing.js's usageSummary(), nothing but the storage key is touched, and
// a raised cap puts the write capability back.
//
// The plan and its execution are pure data and an injected provider, so the
// whole state machine runs here with no storage account and no Worker (issue
// #2's key store and PR #22's KeyProvider are the wiring, not the decision).
//
// Issue #74 added the safety rule the last group of tests pins: raising the
// cap may only give back what the cap took away. A key the customer made
// read-only on purpose (`drive init --read-only`) stays read-only on every run,
// forever, because the cap records the capabilities it took and the restore
// reads them from the key row (issue #64's wiring) rather than guessing from
// the key's kind.

import assert from "node:assert/strict";
import { test } from "node:test";
import { BILLING_CONFIG, capLine, capStatus, handleUsageRequest } from "../src/billing.js";
import {
  applyCapSwap,
  capSwapPlan,
  enforceCap,
  handleCapRequest,
  isWriteCapable,
  parseCapUsd,
  READ_ONLY_CAPABILITIES,
  WRITE_SCOPE_BY_KIND,
} from "../src/cap.js";
import worker from "../src/index.js";
import { failureMessage as tableMessage } from "../src/messages.js";

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

// Minutes in an average month, so a test can say "2 TB held all month" and
// mean the metered bill and the peak are the same number.
const MINUTES_PER_MONTH = 43800;
/** @param {number} gb */
const fullMonthGbMinutes = (gb) => gb * MINUTES_PER_MONTH;

// The month's numbers as usageSummary() takes them, at a size whose invoice is
// past the $12 default cap (2000 GB bills $40, capped to the $16 ceiling) and
// under it (1200 GB bills $24, and the ceiling pins at the $12 floor).
/** @param {number} gb */
const monthUsage = (gb) => ({
  gbMinutes: fullMonthGbMinutes(gb),
  peakGb: gb,
  storedGb: gb,
  storedDaily: [],
  downloadBytes: 0,
  averageStoredGb: gb,
  capUsd: BILLING_CONFIG.defaultCapUsd,
  cardAdded: true,
});
const capUsage = () => monthUsage(2000);
const underCapUsage = () => monthUsage(1200);

// The four kinds of key the spec mints, in the shape the plan reads.
const deviceKey = {
  keyId: "k-device",
  kind: "device",
  prefix: "u/a1/",
  capabilities: ["list", "read", "write", "delete"],
};
const agentKey = {
  keyId: "k-agent",
  kind: "agent",
  prefix: "u/a1/",
  capabilities: ["list", "read", "write"],
};
const s3Key = {
  keyId: "k-s3",
  kind: "s3",
  prefix: "u/a1/",
  capabilities: ["list", "read", "write"],
};
const branchKey = {
  keyId: "k-branch",
  kind: "branch",
  prefix: "u/a1/.branches/fix/",
  capabilities: ["list", "read", "write"],
};
const readOnlyKey = {
  keyId: "k-ro",
  kind: "agent",
  prefix: "u/a1/",
  capabilities: ["list", "read"],
};

// A key row as the cap left it: read-only, carrying the record of the scope the
// cap took (issue #74). What a capped account's devices rows look like before
// the cap is raised again.
/**
 * @param {{keyId: string, kind: string, prefix: string, capabilities: readonly string[]}} key
 * @param {readonly string[]} capabilities
 */
const capped = (key, capabilities) => ({
  ...key,
  capabilities: [...READ_ONLY_CAPABILITIES],
  cappedFrom: Object.freeze([...capabilities]),
});

// A provider that records every call, so order and scope are visible.
/**
 * @param {{swapToReadOnly?: boolean}} [options]
 * @returns {{
 *   calls: Array<Record<string, unknown>>,
 *   mint: (scope: Record<string, unknown>) => Promise<{keyId: string, accessKeyId: string, secret: string}>,
 *   revoke: (keyId: string) => Promise<void>,
 *   swapToReadOnly?: (keyId: string) => Promise<{keyId: string, accessKeyId: string, secret: string}>,
 * }}
 */
function recordingProvider({ swapToReadOnly = false } = {}) {
  /** @type {Array<Record<string, unknown>>} */
  const calls = [];
  let minted = 0;
  /** @type {{
   *   calls: Array<Record<string, unknown>>,
   *   mint: (scope: Record<string, unknown>) => Promise<{keyId: string, accessKeyId: string, secret: string}>,
   *   revoke: (keyId: string) => Promise<void>,
   *   swapToReadOnly?: (keyId: string) => Promise<{keyId: string, accessKeyId: string, secret: string}>,
   * }} */
  const provider = {
    calls,
    /** @param {Record<string, unknown>} scope */
    async mint(scope) {
      calls.push({ call: "mint", ...scope });
      minted += 1;
      return { keyId: `new-${minted}`, accessKeyId: `id-${minted}`, secret: `s-${minted}` };
    },
    /** @param {string} keyId */
    async revoke(keyId) {
      calls.push({ call: "revoke", keyId });
    },
  };
  if (swapToReadOnly) {
    /** @param {string} keyId */
    provider.swapToReadOnly = async (keyId) => {
      calls.push({ call: "swapToReadOnly", keyId });
      minted += 1;
      return { keyId: `new-${minted}`, accessKeyId: `id-${minted}`, secret: `s-${minted}` };
    };
  }
  return provider;
}

test("at the cap every write-capable key is replaced by a read-only one on its own prefix", () => {
  const keys = [deviceKey, agentKey, s3Key, branchKey, readOnlyKey];
  const plan = capSwapPlan(keys, { state: "read_only" });

  assert.equal(plan.state, "read_only");
  assert.equal(
    plan.swaps.length,
    4,
    "the four write-capable keys swap; the read-only one is left alone",
  );
  const byId = Object.fromEntries(plan.swaps.map((swap) => [swap.keyId, swap]));
  assert.equal(byId["k-ro"], undefined, "a key that already cannot write is not churned");
  // A swap names the key, the scope that replaces it, and the scope it took
  // away (issue #74: the record is what the cap is allowed to give back later).
  // A deepEqual on the whole entry is the negative that matters here: no file
  // id, no path inside the prefix, nothing that a swap could delete is in the
  // plan.
  assert.deepEqual(byId["k-device"], {
    keyId: "k-device",
    kind: "device",
    prefix: "u/a1/",
    capabilities: Object.freeze(["list", "read"]),
    cappedFrom: Object.freeze(["list", "read", "write", "delete"]),
  });
  assert.deepEqual(byId["k-agent"].capabilities, READ_ONLY_CAPABILITIES);
  assert.equal(
    byId["k-branch"].prefix,
    "u/a1/.branches/fix/",
    "a branch key narrows to itself, never to the account",
  );
  // The mount holds the old key until it restarts, so a swap is a restart.
  assert.deepEqual(plan.mount, { restart: true, reason: "cap-reached" });
  assert.equal(Object.isFrozen(plan), true);
});

test("a second enforcement pass is a no-op, so no key is ever churned", () => {
  // The same account after the swap: the keys are read-only now. A timer that
  // runs hourly must find nothing to do rather than mint a second key.
  const swapped = [deviceKey, agentKey].map((key) => ({
    ...key,
    keyId: `${key.keyId}-ro`,
    capabilities: ["list", "read"],
  }));
  const plan = capSwapPlan(swapped, { state: "read_only" });
  assert.equal(plan.swaps.length, 0);
  assert.deepEqual(plan.mount, { restart: false, reason: null });
  // And an account with no keys at all, capped: nothing to swap, no restart.
  assert.equal(capSwapPlan([], { state: "read_only" }).swaps.length, 0);
});

test("raising the cap gives back exactly what the cap took, and nothing more", () => {
  // The rows a capped account holds: every key read-only, each one carrying the
  // record of the scope the cap took from it (`cappedFrom`, which the api
  // Worker stores on the devices row — issue #64's wiring).
  const capped = (
    /** @type {{keyId: string, kind: string, prefix: string, capabilities: readonly string[]}} */ key,
    /** @type {readonly string[]} */ capabilities,
  ) => ({
    ...key,
    capabilities: ["list", "read"],
    cappedFrom: capabilities,
  });
  const keys = [
    capped(deviceKey, ["list", "read", "write", "delete"]),
    capped(agentKey, ["list", "read", "write"]),
    capped(s3Key, ["list", "read", "write"]),
    capped(branchKey, ["list", "read", "write"]),
    agentKey,
  ];
  const plan = capSwapPlan(keys, { state: "active" });

  assert.equal(
    plan.swaps.length,
    4,
    "the write-capable key is already right and stays out of the plan",
  );
  const byId = Object.fromEntries(plan.swaps.map((swap) => [swap.keyId, swap.capabilities]));
  assert.deepEqual(
    byId["k-device"],
    ["list", "read", "write", "delete"],
    "a device key gets delete back",
  );
  assert.deepEqual(byId["k-agent"], ["list", "read", "write"], "an agent key never gains delete");
  assert.deepEqual(byId["k-s3"], ["list", "read", "write"]);
  assert.deepEqual(byId["k-branch"], ["list", "read", "write"]);
  const branchSwap = plan.swaps.find((swap) => swap.keyId === "k-branch");
  assert.ok(branchSwap);
  assert.equal(branchSwap.prefix, "u/a1/.branches/fix/");
  assert.deepEqual(plan.mount, { restart: true, reason: "cap-raised" });
  // The record is spent once it has been given back, so the wiring clears it
  // on the row it just minted: a later cap starts from what the key holds.
  for (const swap of plan.swaps) {
    assert.equal(swap.cappedFrom, null, `${swap.keyId} has nothing left to give back`);
  }
  // Once restored, a second pass has nothing to do either: the keys on file
  // are the ones the first pass minted, not the read-only ones it replaced.
  const restored = keys
    .filter((key) => key !== agentKey)
    .map((key) => ({
      ...key,
      capabilities: byId[key.keyId],
      cappedFrom: null,
    }));
  assert.equal(capSwapPlan(restored, { state: "active" }).swaps.length, 0);
  // A kind with no scope is a data error, not a guess, and a record cannot be
  // restored without it. A key with no record is left alone before any kind is
  // consulted: there is nothing the cap took, so there is nothing to give back.
  assert.throws(
    () =>
      capSwapPlan(
        [{ ...agentKey, kind: "mystery", capabilities: ["list", "read"], cappedFrom: ["write"] }],
        { state: "active" },
      ),
    /No write scope for key kind "mystery"/,
  );
});

test("a key the customer made read-only stays read-only, forever (issue #74)", () => {
  // `drive init --read-only` hands an agent key [list, read]. Nothing is capped
  // and nothing was taken, so there is no record to restore from: below the cap
  // the plan leaves the key exactly as it found it. The old code rebuilt the
  // kind's full scope here and handed the key back its write capability.
  const readOnlyAgent = { ...agentKey, capabilities: ["list", "read"] };
  for (const state of ["active", "read_only"]) {
    const plan = capSwapPlan([readOnlyAgent], { state });
    assert.deepEqual(plan.swaps, [], `a read-only-by-choice key is untouched at ${state}`);
    assert.deepEqual(plan.mount, { restart: false, reason: null });
  }
  // The same holds below the cap for a key the customer narrowed itself, and
  // for a row with no record at all (a key minted before devices.capabilities
  // was ever swapped): nothing is taken, so nothing comes back.
  assert.deepEqual(
    capSwapPlan([{ ...deviceKey, capabilities: ["list", "read"] }], { state: "active" }).swaps,
    [],
  );
  assert.deepEqual(
    capSwapPlan([{ ...deviceKey, capabilities: ["list", "read"] }], { state: "active" }).swaps,
    [],
  );
  // A capped key is a different thing entirely: it carries the record.
  assert.deepEqual(
    capSwapPlan([{ ...deviceKey, capabilities: ["list", "read"] }], { state: "read_only" }).swaps,
    [],
  );
});

test("the cap takes, records, and gives back one key's own scope (issue #74)", () => {
  // The round trip the issue names: at the cap and back, a key ends exactly
  // where it started — including a device key that never had delete, which the
  // old code widened on the way back up.
  const start = { ...deviceKey, capabilities: ["list", "read", "write"] };
  const capped = capSwapPlan([start], { state: "read_only" });
  assert.deepEqual(capped.swaps[0].capabilities, ["list", "read"]);
  assert.deepEqual(capped.swaps[0].cappedFrom, ["list", "read", "write"]);

  // The row the api Worker writes after that swap (issue #64 persists the new
  // key id, the capabilities and this record).
  const cappedRow = {
    ...start,
    capabilities: [...capped.swaps[0].capabilities],
    cappedFrom: capped.swaps[0].cappedFrom,
  };
  const raised = capSwapPlan([cappedRow], { state: "active" });
  assert.deepEqual(
    raised.swaps[0].capabilities,
    ["list", "read", "write"],
    "delete was never taken, so it never comes back",
  );

  const restoredRow = {
    ...cappedRow,
    capabilities: [...raised.swaps[0].capabilities],
    cappedFrom: raised.swaps[0].cappedFrom,
  };
  assert.deepEqual(restoredRow.capabilities, start.capabilities);
});

test("a record cannot widen a key past the scope its kind gets (issue #74)", () => {
  // A corrupt or hand-edited row that claims an agent key was taken down from a
  // delete scope: the restore is held to the kind's own scope, so the agent key
  // gets back what an agent key can have and no more.
  const plan = capSwapPlan(
    [
      {
        ...agentKey,
        capabilities: ["list", "read"],
        cappedFrom: ["list", "read", "write", "delete"],
      },
    ],
    {
      state: "active",
    },
  );
  assert.deepEqual(
    plan.swaps[0].capabilities,
    ["list", "read", "write"],
    "an agent key never gains delete",
  );
  // A record with nothing this kind could ever have had gives back nothing and
  // the key stays read-only: one bad row must not crash the hourly enforcement
  // run that is holding every other capped account's key read-only.
  const stuck = capSwapPlan(
    [{ ...agentKey, capabilities: ["list", "read"], cappedFrom: ["delete"] }],
    {
      state: "active",
    },
  );
  assert.deepEqual(stuck.swaps, [], "a record outside the kind's scope never widens the key");
  assert.deepEqual(stuck.mount, { restart: false, reason: null });
  // The record is a list of capability names or nothing: a half-written row is
  // a data error, never a silent "no record, carry on".
  for (const bad of [[], "write", [null], [""], 7]) {
    assert.throws(
      () =>
        capSwapPlan([{ ...agentKey, capabilities: ["list", "read"], cappedFrom: bad }], {
          state: "active",
        }),
      /cappedFrom must be a non-empty list of capability names/,
      `rejects ${JSON.stringify(bad)}`,
    );
  }
});

test("running the job twice changes nothing, in both directions (issue #74)", async () => {
  // A timer runs hourly, so every direction has to be a no-op the second time:
  // the cap must not mint a second read-only key, and a raise must not mint a
  // second write key.
  const provider = recordingProvider();
  const keys = [
    deviceKey,
    agentKey,
    { ...branchKey, keyId: "k-ro", capabilities: ["list", "read"] },
  ];
  const first = await enforceCap({ usage: capUsage(), keys }, provider);
  assert.equal(first.state, "read_only");
  assert.equal(
    first.applied.length,
    2,
    "the read-only-by-choice key is not touched by the cap either",
  );
  const rowsAfterCap = keys.map((key, index) => {
    const applied = first.applied[index];
    return applied
      ? {
          ...key,
          capabilities: [...applied.capabilities],
          cappedFrom: applied.cappedFrom,
        }
      : key;
  });
  const second = await enforceCap({ usage: capUsage(), keys: rowsAfterCap }, recordingProvider());
  assert.equal(second.applied.length, 0, "a second pass at the cap finds nothing to do");

  const raiseProvider = recordingProvider();
  const raised = await enforceCap({ usage: underCapUsage(), keys: rowsAfterCap }, raiseProvider);
  assert.equal(raised.state, "active");
  assert.equal(raised.applied.length, 2, "both keys the cap touched are restored");
  const rowsAfterRaise = rowsAfterCap.map((key) => {
    const applied = raised.applied.find((entry) => entry.keyId === key.keyId);
    return applied
      ? { ...key, capabilities: [...applied.capabilities], cappedFrom: applied.cappedFrom }
      : key;
  });
  const again = await enforceCap(
    { usage: underCapUsage(), keys: rowsAfterRaise },
    recordingProvider(),
  );
  assert.equal(again.applied.length, 0, "a second pass below the cap finds nothing to do");
  // And the read-only-by-choice key is still exactly as it was at the end.
  assert.deepEqual(rowsAfterRaise[2].capabilities, ["list", "read"]);
});

test("every kind and every starting scope comes back from a cap exactly as it was (issue #74)", () => {
  // The property the issue asks for, over every kind and every subset of the
  // scope that kind gets (plus the read-only pair and the empty set): cap, then
  // uncap, and the capabilities equal the ones the key started with. No run ever
  // widens a key, and no run ever leaves one narrower than it found it.
  // Every subset, built by adding one name at a time to a growing list of sets
  // rather than by a reduce that copies the whole list on every step: the sets
  // are the test's own scratch space, so mutating one is the cheap answer.
  /**
   * @param {readonly string[]} names
   * @returns {string[][]}
   */
  const subsets = (names) => {
    /** @type {string[][]} */
    const sets = [[]];
    for (const name of names) {
      for (const set of [...sets]) {
        sets.push([...set, name]);
      }
    }
    // A stable order makes a failure readable: the plan's own order is the
    // spec's order (list, read, write, delete).
    return sets.map((set) => names.filter((candidate) => set.includes(candidate)));
  };
  /**
   * @param {Array<{keyId: string, kind: string, prefix: string, capabilities: readonly string[], cappedFrom?: readonly string[]|null}>} keys
   * @param {{swaps: ReadonlyArray<{keyId: string, capabilities: ReadonlyArray<string>, cappedFrom?: ReadonlyArray<string>|null}>}} plan
   */
  const applyPlan = (keys, plan) =>
    keys.map((key) => {
      const swap = plan.swaps.find((entry) => entry.keyId === key.keyId);
      return swap
        ? { ...key, capabilities: [...swap.capabilities], cappedFrom: swap.cappedFrom }
        : { ...key };
    });

  let cases = 0;
  for (const [kind, scope] of Object.entries(WRITE_SCOPE_BY_KIND)) {
    for (const capabilities of [...subsets(scope), [...READ_ONLY_CAPABILITIES]]) {
      cases += 1;
      const key = { keyId: `k-${kind}`, kind, prefix: "u/a1/", capabilities };
      const atCap = capSwapPlan([key], { state: "read_only" });
      // Reaching the cap never adds a capability the key did not have.
      for (const swap of atCap.swaps) {
        assert.deepEqual(
          [...swap.capabilities].filter(
            (name) => !(/** @type {readonly string[]} */ (READ_ONLY_CAPABILITIES).includes(name)),
          ),
          [],
          `${kind} ${JSON.stringify(capabilities)} gained write at the cap`,
        );
      }
      const cappedRow = applyPlan([key], atCap)[0];
      const belowCap = capSwapPlan([cappedRow], { state: "active" });
      // Raising the cap gives back the record and nothing outside it.
      for (const swap of belowCap.swaps) {
        assert.deepEqual(
          [...swap.capabilities].filter((name) => !(cappedRow.cappedFrom ?? []).includes(name)),
          [],
          `${kind} ${JSON.stringify(capabilities)} gained ${JSON.stringify(swap.capabilities)} on the way back up`,
        );
      }
      const restoredRow = applyPlan([cappedRow], belowCap)[0];
      assert.deepEqual(
        restoredRow.capabilities,
        capabilities,
        `${kind} key does not survive a cap and a raise`,
      );
      assert.equal(
        restoredRow.cappedFrom ?? null,
        null,
        `${kind} ${JSON.stringify(capabilities)} keeps a spent record`,
      );
      // Both directions are idempotent, which is what makes an hourly timer safe.
      assert.deepEqual(
        capSwapPlan([restoredRow], { state: "active" }).swaps,
        [],
        `${kind} restored twice`,
      );
      assert.deepEqual(
        capSwapPlan([cappedRow], { state: "read_only" }).swaps,
        [],
        `${kind} capped twice`,
      );
    }
  }
  assert.ok(cases >= 40, `every kind and every subset ran: ${cases} cases`);
  // The count is read from the table, not guessed, so a kind added or removed
  // later keeps the property instead of failing the test for the wrong reason:
  // every kind's own subsets (2^n) plus the read-only pair once more.
  const expected = Object.values(WRITE_SCOPE_BY_KIND).reduce(
    (total, scope) => total + 2 ** scope.length + 1,
    0,
  );
  assert.equal(cases, expected, "the property ran over every kind's every subset");
});

test("the restore does not churn a key whose capabilities are the same names in another order (issue #74)", () => {
  // The stored list has no meaningful order, so a row reading ["read", "list"]
  // is the same scope as the record's ["list", "read"]: a second enforcement
  // pass must not mint a new key over it.
  const shuffled = [{ ...agentKey, capabilities: ["read", "list"], cappedFrom: ["list", "read"] }];
  const plan = capSwapPlan(shuffled, { state: "active" });
  assert.deepEqual(plan.swaps, [], "the same names in another order are no work");
});

test("the provider call order keeps the write key from outliving the cap", async () => {
  const provider = recordingProvider();
  const plan = capSwapPlan([deviceKey, agentKey], { state: "read_only" });
  const result = await applyCapSwap(plan, provider);

  assert.deepEqual(provider.calls, [
    { call: "revoke", keyId: "k-device" },
    { call: "mint", prefix: "u/a1/", capabilities: ["list", "read"] },
    { call: "revoke", keyId: "k-agent" },
    { call: "mint", prefix: "u/a1/", capabilities: ["list", "read"] },
  ]);
  assert.equal(result.state, "read_only");
  assert.equal(result.applied.length, 2);
  assert.deepEqual(result.applied[0].minted, {
    keyId: "new-1",
    accessKeyId: "id-1",
    secret: "s-1",
  });
  assert.equal(result.mount.restart, true, "the CLI restarts the mount with the key in `applied`");
  // Raising the cap flips the order: the write key is minted first, because
  // revoking the read-only one first would leave the mount with no key at all.
  // The key carries the cap's own record (issue #74): a read-only key with no
  // record was never capped and stays read-only, so it mints nothing.
  const raised = recordingProvider();
  await applyCapSwap(
    capSwapPlan([capped(agentKey, ["list", "read", "write"])], { state: "active" }),
    raised,
  );
  assert.deepEqual(raised.calls, [
    { call: "mint", prefix: "u/a1/", capabilities: ["list", "read", "write"] },
    { call: "revoke", keyId: "k-agent" },
  ]);
});

test("a provider's own swapToReadOnly is used for the cap swap, never for a restore", async () => {
  // workers/api/src/keyprovider.js names swapToReadOnly for exactly this call;
  // when a provider has it, enforcement must not re-do revoke-then-mint by hand.
  const provider = recordingProvider({ swapToReadOnly: true });
  await applyCapSwap(capSwapPlan([deviceKey], { state: "read_only" }), provider);
  assert.deepEqual(provider.calls, [{ call: "swapToReadOnly", keyId: "k-device" }]);

  const raised = recordingProvider({ swapToReadOnly: true });
  await applyCapSwap(
    capSwapPlan([capped(deviceKey, ["list", "read", "write", "delete"])], { state: "active" }),
    raised,
  );
  assert.deepEqual(raised.calls, [
    { call: "mint", prefix: "u/a1/", capabilities: ["list", "read", "write", "delete"] },
    { call: "revoke", keyId: "k-device" },
  ]);
});

test("a provider failure is raised, never swallowed, and the plan stays re-runnable", async () => {
  const provider = recordingProvider();
  provider.mint = async (scope) => {
    provider.calls.push({ call: "mint", ...scope });
    throw new Error("storage said no");
  };
  const plan = capSwapPlan([deviceKey], { state: "read_only" });
  await assert.rejects(() => applyCapSwap(plan, provider), /storage said no/);
  // The revoke still happened first, so the account is on the safe side of the
  // cap even though the swap failed; the api Worker retries the same plan.
  assert.deepEqual(provider.calls, [
    { call: "revoke", keyId: "k-device" },
    { call: "mint", prefix: "u/a1/", capabilities: ["list", "read"] },
  ]);
  // A provider missing half the interface is a broken wiring, not a no-op.
  await assert.rejects(
    () => applyCapSwap(plan, { revoke: async () => {} }),
    /needs mint\(scope\) and revoke\(keyId\)/,
  );
  assert.throws(() => capSwapPlan(null, { state: "read_only" }), /keys as an array/);
  assert.throws(() => capSwapPlan([], { state: "sideways" }), /"active" or "read_only"/);
  assert.throws(
    () =>
      capSwapPlan([{ kind: "device", prefix: "u/a1/", capabilities: [] }], { state: "read_only" }),
    /needs keyId/,
  );
  assert.throws(
    () =>
      capSwapPlan([{ keyId: "k", kind: "device", prefix: "", capabilities: [] }], {
        state: "read_only",
      }),
    /needs prefix/,
  );
  assert.throws(
    () =>
      capSwapPlan([{ keyId: "k", kind: "device", prefix: "u/a1/", capabilities: "write" }], {
        state: "read_only",
      }),
    /needs capabilities as a list/,
  );
});

test("a key is write-capable when it can write or delete", () => {
  // A key with only delete is still a key that can change storage, so the cap
  // has to take it away; a key whose capabilities cannot be read is not
  // claimed to be replaced.
  assert.equal(isWriteCapable({ capabilities: ["list", "read", "write"] }), true);
  assert.equal(isWriteCapable({ capabilities: ["delete"] }), true);
  assert.equal(isWriteCapable({ capabilities: ["list", "read"] }), false);
  assert.equal(isWriteCapable({}), false);
  assert.equal(isWriteCapable(null), false);
});

test("enforcement reads the month's numbers from src/billing.js capStatus()", async () => {
  /** @param {number} gb */
  const usage = (gb) => ({
    gbMinutes: fullMonthGbMinutes(gb),
    peakGb: gb,
    storedGb: gb,
    storedDaily: [],
    downloadBytes: 0,
    averageStoredGb: gb,
    capUsd: BILLING_CONFIG.defaultCapUsd,
    cardAdded: true,
  });
  const keys = [deviceKey];

  // 1.3 TB on the default $12 cap: the invoice is the $12 floor, so the cap is
  // not passed and the drive keeps writing (the orchestrator decision on #39).
  const active = await enforceCap({ usage: usage(1300), keys }, recordingProvider());
  assert.equal(active.state, "active");
  assert.equal(active.applied.length, 0);
  assert.equal(active.mount.restart, false);

  // 2 TB: the ceiling rises to $16, past the $12 cap, so the one write key is
  // replaced by a read-only key and the mount is told to restart.
  const capProvider = recordingProvider();
  const capped = await enforceCap({ usage: usage(2000), keys }, capProvider);
  assert.equal(capped.state, "read_only");
  assert.equal(capped.applied.length, 1);
  assert.deepEqual(capProvider.calls, [
    { call: "revoke", keyId: "k-device" },
    { call: "mint", prefix: "u/a1/", capabilities: ["list", "read"] },
  ]);

  // The same two conclusions the capStatus() tests pin, read through the
  // summary rule too: 2 TB at the default cap is read_only, 1.3 TB is active.
  assert.equal(capStatus(fullMonthGbMinutes(2000), 2000, 12).state, "read_only");
  assert.equal(capStatus(fullMonthGbMinutes(1300), 1300, 12).state, "active");
});

test("a card-less account goes read-only at the free $1, the same rule the usage page shows", async () => {
  // build-spec.md "Free credit": no card means a $1 cap. Enforcement must take
  // that from usageSummary(), not from a second copy of the rule.
  const account = {
    usage: {
      gbMinutes: fullMonthGbMinutes(60),
      peakGb: 60,
      storedGb: 60,
      storedDaily: [],
      downloadBytes: 0,
      averageStoredGb: 60,
      capUsd: BILLING_CONFIG.defaultCapUsd,
    },
    keys: [deviceKey],
  };
  const report = await enforceCap(account, recordingProvider());
  assert.equal(report.state, "read_only", "60 GB is over the free $1 without a card");
  assert.equal(report.applied.length, 1);
  // With the card on file the same drive is under the $12 cap and writing.
  const withCard = await enforceCap(
    { ...account, usage: { ...account.usage, cardAdded: true } },
    recordingProvider(),
  );
  assert.equal(withCard.state, "active");
  assert.equal(withCard.applied.length, 0);
});

test("drive cap takes a dollar amount and nothing else", () => {
  assert.equal(parseCapUsd("20"), 20);
  assert.equal(parseCapUsd("$20"), 20);
  assert.equal(parseCapUsd("$12.50"), 12.5);
  assert.equal(parseCapUsd("12.5"), 12.5);
  assert.equal(parseCapUsd(".5"), 0.5);
  assert.equal(parseCapUsd("0"), 0, "a stricter cap than the default is honoured, not rejected");
  assert.equal(
    parseCapUsd(20),
    20,
    "the api endpoint passes the JSON number through the same parse",
  );
  assert.equal(parseCapUsd(" 15 "), 15);
  for (const bad of [
    "",
    " ",
    "abc",
    "twenty",
    "-5",
    "1.234",
    "1,000",
    "$",
    "20 dollars",
    null,
    undefined,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ]) {
    assert.throws(
      () => parseCapUsd(bad),
      /A spending cap is a dollar amount like 20 or 12\.50/,
      `rejects ${String(bad)}`,
    );
  }
  // The error tells the person what to type next, in words that hold on either
  // surface: the usage page's slider sends the same request, so it cannot end
  // in a command only the CLI can run, and it cannot name a page a terminal
  // user cannot see (drive#421).
  assert.throws(() => parseCapUsd("abc"), /Type a number like that again/);
  // Zero is a cap, and the usage page's slider offers it (min="0"), so the
  // api has to take it: a page that offered a number the Worker refused would
  // answer the number the page itself put there (drive#421).
  assert.equal(parseCapUsd("0"), 0);
  assert.equal(parseCapUsd("0.00"), 0);
  // The culprit stays delimited, so an empty amount and a stray word do not
  // read as part of the sentence.
  assert.throws(() => parseCapUsd(""), /got ""\./);
  assert.throws(() => parseCapUsd("20 dollars"), /got "20 dollars"\./);
});

test("the cap line is one line while writing and two at the cap", () => {
  const active = capLine(capStatus(fullMonthGbMinutes(300), 300, 12));
  assert.equal(active, "Cap $12.00: $6.00 counted this month, $6.00 left.");

  const capped = capLine(capStatus(fullMonthGbMinutes(2000), 2000, 12));
  const [what, numbers] = capped.split("\n");
  // The words for a read-only drive come from the one message table, so the
  // page, the CLI and the api cannot drift apart.
  assert.equal(what, tableMessage("cap-reached"));
  assert.equal(
    numbers,
    "Cap $12.00 reached: $16.00 counted this month. " +
      "Uploads waiting in the cache stay on this Mac and go up once the cap is raised.",
  );
  // Raised again: the line goes back to one line and says there is room.
  assert.equal(
    capLine(capStatus(fullMonthGbMinutes(2000), 2000, 20)),
    "Cap $20.00: $16.00 counted this month, $4.00 left.",
  );
  for (const bad of [
    null,
    {},
    { state: "paused", capUsd: 1, countedUsd: 0, remainingUsd: 1 },
    { state: "active", capUsd: "12", countedUsd: 0, remainingUsd: 0 },
  ]) {
    assert.throws(() => capLine(bad), TypeError);
  }
});

test("the usage response carries the cap line, and the Worker routes it", async () => {
  // `drive status` is Go: it cannot import src/billing.js, so the line has to
  // travel in the response for the CLI to print the same words. The handler is
  // behind the account gate (issue #73), so the line is proven by calling it
  // as a signed-in request until the sign-in flow lands (build step 4, #5).
  const response = handleUsageRequest(new Request("https://drive.test/api/usage"), {
    id: "1",
    name: "Your drive",
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.cap.state, "active");
  assert.equal(body.capLine, "Cap $12.00: $0.00 counted this month, $12.00 left.");
  // The Worker still routes the path to the handler, and the handler's gate
  // answers 401 to an anonymous request rather than the asset layer's 404.
  const anonymous = await workerFetch(new Request("https://drive.test/api/usage"), {
    ASSETS: { fetch: () => new Response("asset") },
  });
  assert.equal(anonymous.status, 401);
  const posted = handleUsageRequest(
    new Request("https://drive.test/api/usage", { method: "POST" }),
    { id: "1", name: "Your drive" },
  );
  assert.equal(posted.status, 405);
});

test("POST /api/cap parses with parseCapUsd and persists cap_cents", async () => {
  /** @type {{id: string, cents: number}[]} */
  const stored = [];
  const capStore = {
    /**
     * @param {{id: string}} account
     * @param {number} cents
     */
    async setCapCents(account, cents) {
      stored.push({ id: account.id, cents });
    },
    async listCapKeys() {
      return [];
    },
    keyProviderFor() {
      return recordingProvider();
    },
    async setAccountState() {},
  };
  const ok = await handleCapRequest(
    new Request("https://drive.test/api/cap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount: "$20" }),
    }),
    { id: "acct-1", name: "You", email: "you@example.com" },
    capStore,
  );
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.cap.capUsd, 20);
  assert.equal(typeof body.capLine, "string");
  assert.equal(stored[0].cents, 2000);

  const bad = await handleCapRequest(
    new Request("https://drive.test/api/cap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount: "abc" }),
    }),
    { id: "acct-1", name: "You" },
    capStore,
  );
  assert.equal(bad.status, 400);
  const err = await bad.json();
  assert.match(err.error, /A spending cap is a dollar amount like 20 or 12\.50/);
  assert.match(err.error, /Type a number like that again/);

  const mangled = await handleCapRequest(
    new Request("https://drive.test/api/cap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    }),
    { id: "acct-1", name: "You" },
    capStore,
  );
  assert.equal(mangled.status, 400);
  assert.deepEqual(await mangled.json(), { error: tableMessage("json-object-needed") });

  const anon = await handleCapRequest(
    new Request("https://drive.test/api/cap", { method: "POST" }),
    null,
    capStore,
  );
  assert.equal(anon.status, 401);

  // A Worker with no account store behind it: the request is well-formed and
  // the account is identified, so the 503 is the message table's own pair and
  // not a sentence invented here. The cap did not move, and the next step is
  // not to wait and retry (drive#421).
  const unwired = await handleCapRequest(
    new Request("https://drive.test/api/cap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount: "20" }),
    }),
    { id: "acct-1", name: "You", email: "you@example.com" },
    null,
  );
  assert.equal(unwired.status, 503);
  assert.deepEqual(await unwired.json(), { error: tableMessage("cap-store-missing") });
});

test("the swap's own credential is in the answer, so the mount can sign with it", async () => {
  // The finish line of drive issue #241 is a real mount going read-only, and
  // nothing can go read-only on a mount that still holds the pre-cap key.
  // rclone's config is a local file, so the CLI has to be *told* which key to
  // write: the answer to POST /api/cap carries the credential the store just
  // minted (access key id, secret and the STS session token a scoped key
  // needs), and `drive cap` writes that into the rclone config on the restart.
  //
  // The swap is decided from the account's own month, not from a blank one:
  // `capStore.monthUsage` is the read that makes setting the cap smaller than
  // what the account already counted enforce at once (the finish line), and
  // without it `drive cap 0` on a live drive would swap nothing.
  const overCapMonth = {
    gbMinutes: fullMonthGbMinutes(2000),
    peakGb: 2000,
    storedGb: 2000,
    storedDaily: [],
    downloadBytes: 0,
    averageStoredGb: 2000,
    capUsd: BILLING_CONFIG.defaultCapUsd,
    cardAdded: true,
  };
  const deviceKeyRow = { ...deviceKey, capabilities: ["list", "read", "write", "delete"] };
  const minted = {
    keyId: "key-ro",
    accessKeyId: "ro-access-key-id",
    secret: "ro-secret",
    sessionToken: "ro-session-token",
  };
  const store = {
    async setCapCents() {},
    async listCapKeys() {
      return [deviceKeyRow];
    },
    async monthUsage() {
      return { ...overCapMonth, capUsd: 0 };
    },
    keyProviderFor() {
      return {
        mint: async () => ({ ...minted }),
        revoke: async () => {},
        swapToReadOnly: async () => ({ ...minted }),
      };
    },
    async setAccountState() {},
  };
  const swapped = await handleCapRequest(
    new Request("https://drive.test/api/cap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount: "0" }),
    }),
    { id: "acct-1" },
    store,
  );
  assert.equal(swapped.status, 200);
  assert.equal(
    swapped.headers.get("cache-control"),
    "no-store",
    "the swap answer carries the secret, so it must not be stored",
  );
  const body = await swapped.json();
  assert.equal(
    body.cap.state,
    "read_only",
    "a cap below what the month already counted is reached",
  );
  assert.equal(body.mount.restart, true);
  // The three values the mount needs to sign. The secret and the token are a
  // credential, so they are only ever in this response and in the rclone
  // config this CLI writes 0600.
  assert.deepEqual(body.credential, {
    accessKeyId: minted.accessKeyId,
    secret: minted.secret,
    sessionToken: minted.sessionToken,
  });

  // A store with no month read (a deployment without the meter tables) still
  // answers, and with nothing over the cap the answer carries no credential:
  // a second `drive cap` at the same amount must not make the CLI rewrite the
  // mount config with the key it is already holding.
  const settled = await handleCapRequest(
    new Request("https://drive.test/api/cap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount: "20" }),
    }),
    { id: "acct-1" },
    {
      ...store,
      async listCapKeys() {
        return [{ ...deviceKeyRow, capabilities: ["list", "read"] }];
      },
    },
  );
  assert.equal(settled.status, 200);
  const settledBody = await settled.json();
  assert.equal(settledBody.mount.restart, false);
  assert.equal(settledBody.credential, undefined, "nothing was swapped, so no key is handed back");
});
