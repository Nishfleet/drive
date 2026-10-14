// The signed-in Home (high-end gap 2): balance, storage, devices and one next
// step from three existing endpoints. The page's own script runs against stub
// answers, so the words and states it lands are what a person reads.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const page = readFileSync(new URL("../public/home.html", import.meta.url), "utf8");

/** @param {string} id */
function stub(id) {
  const listeners = new Map();
  return {
    id,
    hidden: new RegExp(`id="${id}"[^>]*\\shidden`).test(page),
    textContent: "",
    href: "",
    disabled: false,
    dataset: /** @type {Record<string, string>} */ ({}),
    appended: /** @type {any[]} */ ([]),
    append(/** @type {any[]} */ ...nodes) {
      this.appended.push(...nodes);
    },
    setAttribute() {},
    addEventListener: (/** @type {string} */ type, /** @type {() => void} */ fn) =>
      listeners.set(type, fn),
    querySelector: () => ({ textContent: "" }),
    listeners,
  };
}

/** @param {Record<string, {status?: number, body: unknown}>} answers */
async function run(answers) {
  const els = new Map();
  const ids = [...page.matchAll(/id="([a-z-]+)"/g)].map((m) => m[1]);
  for (const id of ids) els.set(id, stub(id));
  const sandbox = {
    document: {
      getElementById: (/** @type {string} */ id) => els.get(id) ?? stub(id),
      createElement: (/** @type {string} */ tag) => stub(tag),
    },
    location: { reload() {} },
    fetch: async (/** @type {string} */ url) => {
      const answer = answers[url];
      if (!answer) throw new Error("offline");
      const status = answer.status ?? 200;
      return { status, ok: status < 400, json: async () => answer.body };
    },
  };
  const start = page.indexOf("<script>");
  vm.runInNewContext(page.slice(start + 8, page.indexOf("</script>", start)), sandbox);
  await new Promise((resolve) => setTimeout(resolve, 20));
  return els;
}

const BALANCE = { balance: "$12.00", balance_cents: 1200, balance_line: "Enough for months." };
const USAGE = { labels: { storedNow: "40 GB", cost: "$0.80 so far" } };
const KEYS = { keys: [{ keyId: "k1" }, { keyId: "k2" }] };

test("an account with money and devices sees the numbers and Open your files", async () => {
  const els = await run({
    "/api/balance": { body: BALANCE },
    "/api/usage": { body: USAGE },
    "/api/devices": { body: KEYS },
  });
  assert.equal(els.get("balance-amount").textContent, "$12.00");
  assert.equal(els.get("stored-now").textContent, "40 GB");
  assert.equal(els.get("devices-count").textContent, "2");
  assert.equal(els.get("next-what").textContent, "Open your files");
  assert.equal(els.get("next-step").hidden, false);
});

test("a new account with no balance is told to add $10", async () => {
  const els = await run({
    "/api/balance": { body: { ...BALANCE, balance: "$0.00", balance_cents: 0 } },
    "/api/usage": { body: USAGE },
    "/api/devices": { body: { keys: [] } },
  });
  assert.equal(els.get("next-what").textContent, "Add $10 to open your drive");
  assert.equal(els.get("devices-line").textContent, "None yet.");
});

test("a failed read shows a message and a Try again button, and a 401 shows the sign-in note", async () => {
  const down = await run({});
  assert.equal(down.get("home-retry").hidden, false);
  assert.equal(down.get("home-status").hidden, false);
  const out = await run({
    "/api/balance": { status: 401, body: { error: "Sign in." } },
    "/api/usage": { status: 401, body: {} },
    "/api/devices": { status: 401, body: {} },
  });
  assert.equal(out.get("home-retry").hidden, true);
  assert.equal(out.get("nav-signin").hidden, false);
});

test("the balance tile adds the runway line, and the agents tile names the newest session", async () => {
  const els = await run({
    "/api/balance": {
      body: { ...BALANCE, runway_line: "Your $12 lasts about 7 months at your current size." },
    },
    "/api/usage": { body: USAGE },
    "/api/devices": { body: KEYS },
    "/api/rewind": {
      body: {
        rewinds: [
          { changedBy: "old", createdAt: 1, canRewind: false, files: { count: 9 } },
          {
            changedBy: "claude",
            createdAt: 5,
            canRewind: true,
            restorableUntil: "2026-10-20T00:00:00.000Z",
            files: { count: 3 },
          },
        ],
      },
    },
  });
  assert.equal(
    els.get("balance-line").textContent,
    "Enough for months. Your $12 lasts about 7 months at your current size.",
  );
  assert.equal(els.get("agents-what").textContent, "claude changed 3 files");
  assert.match(els.get("agents-line").textContent, /^One click puts your files back, until /);
  assert.equal(els.get("agents").hidden, false);
});

test("no agent sessions, or a failed read, leaves the agents tile out", async () => {
  const none = await run({
    "/api/balance": { body: BALANCE },
    "/api/usage": { body: USAGE },
    "/api/devices": { body: KEYS },
    "/api/rewind": { body: { rewinds: [] } },
  });
  assert.equal(none.get("agents").hidden, true);
  const down = await run({
    "/api/balance": { body: BALANCE },
    "/api/usage": { body: USAGE },
    "/api/devices": { body: KEYS },
  });
  assert.equal(down.get("agents").hidden, true);
  assert.equal(down.get("home-status").hidden, true);
});

test("the Get started checklist ticks itself from devices and files, and leaves when all is done", async () => {
  const base = {
    "/api/balance": { body: BALANCE },
    "/api/usage": { body: USAGE },
  };
  const fresh = await run({
    ...base,
    "/api/devices": { body: { keys: [] } },
    "/api/files": { body: { rows: [] } },
  });
  assert.equal(fresh.get("checklist").hidden, false);
  assert.equal(fresh.get("checklist-items").appended.length, 3);
  assert.ok(
    fresh
      .get("checklist-items")
      .appended.every((/** @type {any} */ li) => li.dataset.done === "false"),
  );

  const partway = await run({
    ...base,
    "/api/devices": { body: { keys: [{ kind: "device" }] } },
    "/api/files": { body: { rows: [{ name: "a" }] } },
  });
  const done = partway
    .get("checklist-items")
    .appended.map((/** @type {any} */ li) => li.dataset.done);
  assert.deepEqual(done, ["true", "true", "false"]);
  assert.equal(partway.get("checklist").hidden, false);

  const finished = await run({
    ...base,
    "/api/devices": { body: { keys: [{ kind: "device" }, { kind: "agent" }] } },
    "/api/files": { body: { rows: [{ name: "a" }] } },
  });
  assert.equal(finished.get("checklist").hidden, true);

  const failed = await run({ ...base, "/api/devices": { body: { keys: [] } } });
  assert.equal(failed.get("checklist").hidden, true);
  assert.equal(failed.get("home-status").hidden, true);
});
