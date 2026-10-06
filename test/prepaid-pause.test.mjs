// Tests for the prepaid pause at $0 on mount and device keys (drive#589).
//
// The swap arithmetic is core/cap.js `capSwapPlan` / `applyCapSwap`; this
// file pins the pause's own rules on top of that: the record a restore reads
// is the pause's, a second run is a no-op, a customer-made read-only key
// stays read-only, and a restore while the spending cap still holds the
// account is skipped.

import assert from "node:assert/strict";
import { test } from "node:test";
import { READ_ONLY_CAPABILITIES } from "../core/cap.js";
import { applyPrepaidPause, prepaidKeyProvider, prepaidSwapPlan } from "../core/prepaid-pause.js";

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

/**
 * @param {{swapToReadOnly?: boolean}} [options]
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

test("at $0 every write-capable key is replaced by a read-only one on its own prefix", () => {
  const keys = [deviceKey, agentKey, branchKey, readOnlyKey];
  const plan = prepaidSwapPlan(keys, true);

  assert.equal(plan.state, "read_only");
  assert.equal(
    plan.swaps.length,
    3,
    "the three write-capable keys swap; the read-only one is left alone",
  );
  assert.deepEqual(plan.mount, { restart: true, reason: "prepaid-paused" });
  const byId = Object.fromEntries(plan.swaps.map((swap) => [swap.keyId, swap]));
  assert.equal(byId["k-ro"], undefined, "a key that already cannot write is not churned");
  const deviceSwap = byId["k-device"];
  const agentSwap = byId["k-agent"];
  const branchSwap = byId["k-branch"];
  assert.ok(deviceSwap && agentSwap && branchSwap);
  assert.deepEqual([...deviceSwap.capabilities], [...READ_ONLY_CAPABILITIES]);
  assert.deepEqual([...(deviceSwap.cappedFrom ?? [])], ["list", "read", "write", "delete"]);
  assert.deepEqual([...(agentSwap.cappedFrom ?? [])], ["list", "read", "write"]);
  assert.deepEqual([...(branchSwap.cappedFrom ?? [])], ["list", "read", "write"]);
});

test("a second pause at $0 is a no-op", () => {
  const paused = [
    { ...deviceKey, capabilities: [...READ_ONLY_CAPABILITIES], cappedFrom: deviceKey.capabilities },
  ];
  const plan = prepaidSwapPlan(paused, true);
  assert.equal(plan.swaps.length, 0);
  assert.deepEqual(plan.mount, { restart: false, reason: null });
});

test("a top-up restores exactly the powers the pause took, and nothing else", () => {
  const paused = [
    {
      ...deviceKey,
      capabilities: [...READ_ONLY_CAPABILITIES],
      cappedFrom: ["list", "read", "write", "delete"],
    },
    readOnlyKey,
  ];
  const plan = prepaidSwapPlan(paused, false);
  assert.equal(plan.state, "active");
  assert.equal(plan.swaps.length, 1, "only the key the pause reduced is widened");
  assert.deepEqual(plan.mount, { restart: true, reason: "prepaid-restored" });
  assert.equal(plan.swaps[0].keyId, "k-device");
  assert.deepEqual([...plan.swaps[0].capabilities], ["list", "read", "write", "delete"]);
  assert.equal(plan.swaps[0].cappedFrom, null);
});

test("applyPrepaidPause uses the provider's swapToReadOnly at $0, never for a restore", async () => {
  const provider = recordingProvider({ swapToReadOnly: true });
  const paused = await applyPrepaidPause({
    keys: [deviceKey],
    provider,
    paused: true,
  });
  assert.equal(paused.state, "read_only");
  assert.deepEqual(provider.calls, [{ call: "swapToReadOnly", keyId: "k-device" }]);

  const raiseProvider = recordingProvider({ swapToReadOnly: true });
  const restored = await applyPrepaidPause({
    keys: [
      {
        ...deviceKey,
        capabilities: [...READ_ONLY_CAPABILITIES],
        cappedFrom: deviceKey.capabilities,
      },
    ],
    provider: raiseProvider,
    paused: false,
  });
  assert.equal(restored.state, "active");
  assert.equal(
    raiseProvider.calls.some((call) => call.call === "swapToReadOnly"),
    false,
    "a restore mints the write key first; swapToReadOnly is the pause path",
  );
  assert.equal(raiseProvider.calls[0].call, "mint");
  assert.equal(raiseProvider.calls[1].call, "revoke");
});

test("a restore while the spending cap still holds the account is skipped", async () => {
  const provider = recordingProvider({ swapToReadOnly: true });
  const report = await applyPrepaidPause({
    keys: [
      {
        ...deviceKey,
        capabilities: [...READ_ONLY_CAPABILITIES],
        cappedFrom: deviceKey.capabilities,
      },
    ],
    provider,
    paused: false,
    atCap: true,
  });
  assert.equal(report.skipped, "at-cap");
  assert.equal(report.applied.length, 0);
  assert.deepEqual(provider.calls, [], "the cap still holds writes; the pause record stays");
});

test("prepaidKeyProvider records the pause through swapPrepaidToReadOnly, not the cap swap", async () => {
  /** @type {string[]} */
  const prepaid = [];
  /** @type {string[]} */
  const cap = [];
  const devices = {
    keyProviderFor() {
      return {
        async mint() {
          return { keyId: "n", accessKeyId: "a", secret: "s" };
        },
        async revoke() {},
        async swapToReadOnly(/** @type {string} */ keyId) {
          cap.push(keyId);
          return { keyId, accessKeyId: "a", secret: "s" };
        },
        async swapPrepaidToReadOnly(/** @type {string} */ keyId) {
          prepaid.push(keyId);
          return { keyId, accessKeyId: "a", secret: "s" };
        },
      };
    },
  };
  const provider = prepaidKeyProvider(devices, "acct");
  await applyPrepaidPause({ keys: [deviceKey], provider, paused: true });
  assert.deepEqual(prepaid, ["k-device"]);
  assert.deepEqual(cap, [], "the cap's own swap is not the pause's record");
});
