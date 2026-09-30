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
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { BILLING_CONFIG, capLine, capStatus, handleUsageRequest } from "../src/billing.js";
import { failureMessage as tableMessage } from "../src/messages.js";
import {
  READ_ONLY_CAPABILITIES,
  applyCapSwap,
  capSwapPlan,
  enforceCap,
  isWriteCapable,
  parseCapUsd,
} from "../src/cap.js";

// Minutes in an average month, so a test can say "2 TB held all month" and
// mean the metered bill and the peak are the same number.
const MINUTES_PER_MONTH = 43800;
const fullMonthGbMinutes = (gb) => gb * MINUTES_PER_MONTH;

// The four kinds of key the spec mints, in the shape the plan reads.
const deviceKey = { keyId: "k-device", kind: "device", prefix: "u/a1/", capabilities: ["list", "read", "write", "delete"] };
const agentKey = { keyId: "k-agent", kind: "agent", prefix: "u/a1/", capabilities: ["list", "read", "write"] };
const s3Key = { keyId: "k-s3", kind: "s3", prefix: "u/a1/", capabilities: ["list", "read", "write"] };
const branchKey = { keyId: "k-branch", kind: "branch", prefix: "u/a1/.branches/fix/", capabilities: ["list", "read", "write"] };
const readOnlyKey = { keyId: "k-ro", kind: "agent", prefix: "u/a1/", capabilities: ["list", "read"] };

// A provider that records every call, so order and scope are visible.
function recordingProvider({ swapToReadOnly = false } = {}) {
  const calls = [];
  let minted = 0;
  const provider = {
    calls,
    async mint(scope) {
      calls.push({ call: "mint", ...scope });
      minted += 1;
      return { keyId: `new-${minted}`, accessKeyId: `id-${minted}`, secret: `s-${minted}` };
    },
    async revoke(keyId) {
      calls.push({ call: "revoke", keyId });
    },
  };
  if (swapToReadOnly) {
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
  assert.equal(plan.swaps.length, 4, "the four write-capable keys swap; the read-only one is left alone");
  const byId = Object.fromEntries(plan.swaps.map((swap) => [swap.keyId, swap]));
  assert.equal(byId["k-ro"], undefined, "a key that already cannot write is not churned");
  // A swap names only the key and the scope that replaces it. A deepEqual on
  // the whole entry is the negative that matters here: no file id, no path
  // inside the prefix, nothing that a swap could delete is in the plan.
  assert.deepEqual(byId["k-device"], {
    keyId: "k-device",
    kind: "device",
    prefix: "u/a1/",
    capabilities: Object.freeze(["list", "read"]),
  });
  assert.deepEqual(byId["k-agent"].capabilities, READ_ONLY_CAPABILITIES);
  assert.equal(byId["k-branch"].prefix, "u/a1/.branches/fix/", "a branch key narrows to itself, never to the account");
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

test("raising the cap restores each kind's own scope, and delete only comes back to a device key", () => {
  const readOnly = (key) => ({ ...key, capabilities: ["list", "read"] });
  const keys = [readOnly(deviceKey), readOnly(agentKey), readOnly(s3Key), readOnly(branchKey), agentKey];
  const plan = capSwapPlan(keys, { state: "active" });

  assert.equal(plan.swaps.length, 4, "the write-capable key is already right and stays out of the plan");
  const byId = Object.fromEntries(plan.swaps.map((swap) => [swap.keyId, swap.capabilities]));
  assert.deepEqual(byId["k-device"], ["list", "read", "write", "delete"], "a device key gets delete back");
  assert.deepEqual(byId["k-agent"], ["list", "read", "write"], "an agent key never gains delete");
  assert.deepEqual(byId["k-s3"], ["list", "read", "write"]);
  assert.deepEqual(byId["k-branch"], ["list", "read", "write"]);
  assert.equal(plan.swaps.find((swap) => swap.keyId === "k-branch").prefix, "u/a1/.branches/fix/");
  assert.deepEqual(plan.mount, { restart: true, reason: "cap-raised" });
  // Once restored, a second pass has nothing to do either: the keys on file
  // are the ones the first pass minted, not the read-only ones it replaced.
  const restored = keys.filter((key) => key !== agentKey).map((key) => ({
    ...key,
    capabilities: byId[key.keyId],
  }));
  assert.equal(capSwapPlan(restored, { state: "active" }).swaps.length, 0);
  // A kind with no scope is a data error, not a guess. The key has to be
  // read-only to reach the lookup: a write-capable key is already in the right
  // shape and the plan leaves it alone before any kind is consulted.
  assert.throws(
    () => capSwapPlan([{ ...agentKey, kind: "mystery", capabilities: ["list", "read"] }], { state: "active" }),
    /No write scope for key kind "mystery"/,
  );
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
  assert.deepEqual(result.applied[0].minted, { keyId: "new-1", accessKeyId: "id-1", secret: "s-1" });
  assert.equal(result.mount.restart, true, "the CLI restarts the mount with the key in `applied`");
  // Raising the cap flips the order: the write key is minted first, because
  // revoking the read-only one first would leave the mount with no key at all.
  const raised = recordingProvider();
  await applyCapSwap(capSwapPlan([{ ...agentKey, capabilities: ["list", "read"] }], { state: "active" }), raised);
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
  await applyCapSwap(capSwapPlan([{ ...deviceKey, capabilities: ["list", "read"] }], { state: "active" }), raised);
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
  assert.throws(() => capSwapPlan([{ kind: "device", prefix: "u/a1/", capabilities: [] }], { state: "read_only" }), /needs keyId/);
  assert.throws(
    () => capSwapPlan([{ keyId: "k", kind: "device", prefix: "", capabilities: [] }], { state: "read_only" }),
    /needs prefix/,
  );
  assert.throws(
    () => capSwapPlan([{ keyId: "k", kind: "device", prefix: "u/a1/", capabilities: "write" }], { state: "read_only" }),
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
  assert.equal(parseCapUsd(20), 20, "the api endpoint passes the JSON number through the same parse");
  assert.equal(parseCapUsd(" 15 "), 15);
  for (const bad of ["", " ", "abc", "twenty", "-5", "1.234", "1,000", "$", "20 dollars", null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => parseCapUsd(bad), /A spending cap is a dollar amount like 20 or 12\.50/, `rejects ${String(bad)}`);
  }
  // The error tells the person what to type, not just that the input was bad.
  assert.throws(() => parseCapUsd("abc"), /Run: drive cap 20/);
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
  assert.equal(capLine(capStatus(fullMonthGbMinutes(2000), 2000, 20)), "Cap $20.00: $16.00 counted this month, $4.00 left.");
  for (const bad of [null, {}, { state: "paused", capUsd: 1, countedUsd: 0, remainingUsd: 1 }, { state: "active", capUsd: "12", countedUsd: 0, remainingUsd: 0 }]) {
    assert.throws(() => capLine(bad), TypeError);
  }
});

test("the usage response carries the cap line, and the Worker routes it", async () => {
  // `drive status` is Go: it cannot import src/billing.js, so the line has to
  // travel in the response for the CLI to print the same words. The handler is
  // behind the account gate (issue #73), so the line is proven by calling it
  // as a signed-in request until the sign-in flow lands (build step 4, #5).
  const response = handleUsageRequest(
    new Request("https://drive.test/api/usage"),
    { id: "1", name: "Your drive" },
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.cap.state, "active");
  assert.equal(body.capLine, "Cap $12.00: $0.00 counted this month, $12.00 left.");
  // The Worker still routes the path to the handler, and the handler's gate
  // answers 401 to an anonymous request rather than the asset layer's 404.
  const anonymous = await worker.fetch(new Request("https://drive.test/api/usage"), {
    ASSETS: { fetch: () => new Response("asset") },
  });
  assert.equal(anonymous.status, 401);
  const posted = handleUsageRequest(
    new Request("https://drive.test/api/usage", { method: "POST" }),
    { id: "1", name: "Your drive" },
  );
  assert.equal(posted.status, 405);
});
