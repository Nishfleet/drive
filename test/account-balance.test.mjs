// The account page's balance section (drive#586 part 3): the balance, the
// top-up presets and custom amount, the auto top-up switch (off by default)
// and the recent ledger lines, on /usage (TOP_UP_PAGE, where the checkout
// returns).
//
// public/usage.html is a static asset with a one-script budget
// (lighthouserc.json), so the balance section is a second inline block, marked
// data-part="balance". This file runs that block against a stub DOM and a stub
// fetch, the way test/usage.test.mjs runs the month's block, so what it proves
// is what the page does, not what its source says.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import { TOP_UP_PAGE } from "../core/ledger.js";
import { AUTO_TOPUP_ENDPOINT } from "../core/prepaid.js";
import { PREPAID } from "../core/pricing.js";
import { BALANCE_ENDPOINT, TOPUP_ENDPOINT } from "../core/topup.js";

const page = readFileSync(new URL("../public/usage.html", import.meta.url), "utf8");
const OPEN_TAG = '<script data-part="balance">';

function balanceScript() {
  const start = page.indexOf(OPEN_TAG);
  assert.ok(start >= 0, "usage.html must carry the balance block");
  return page.slice(start + OPEN_TAG.length, page.indexOf("</script>", start));
}

const IDS = Object.freeze([
  "balance-status",
  "balance-body",
  "balance-amount",
  "balance-line",
  "topup-presets",
  "topup-form",
  "topup-amount",
  "topup-error",
  "topup-pending",
  "auto-topup",
  "auto-topup-amount",
  "auto-topup-note",
  "ledger-list",
  "ledger-empty",
]);

/** @param {string} id */
function stubElement(id) {
  /** @type {Map<string, any>} */
  const children = new Map();
  const el = {
    id,
    tag: id,
    dataset: /** @type {Record<string, string>} */ ({}),
    hidden: false,
    textContent: "",
    value: "",
    min: "",
    checked: false,
    disabled: false,
    type: "",
    appended: /** @type {any[]} */ ([]),
    listeners: /** @type {Map<string, (event: any) => any>} */ (new Map()),
    append(/** @type {any[]} */ ...nodes) {
      el.appended.push(...nodes);
    },
    replaceChildren(/** @type {any[]} */ ...nodes) {
      el.appended = nodes;
    },
    addEventListener(/** @type {string} */ type, /** @type {(event: any) => any} */ fn) {
      el.listeners.set(type, fn);
    },
    setAttribute() {},
    querySelector(/** @type {string} */ selector) {
      const key = selector.replace(/^\./, "");
      if (!children.has(key)) children.set(key, stubElement(`${id}.${key}`));
      return children.get(key);
    },
  };
  return el;
}

/** One summary as GET /api/balance sends it (core/topup.js balanceSummary). */
function summary(overrides = {}) {
  return {
    auto_topup_usd: null,
    balance_cents: 1450,
    balance: "$14.50",
    balance_line: "Balance $14.50.",
    low_balance: false,
    paused: false,
    min_top_up_usd: PREPAID.minTopUpUsd,
    top_up_presets_usd: [...PREPAID.topUpPresetsUsd],
    recent: [
      {
        kind: "usage",
        amount_cents: -5,
        amount: "-$0.05",
        window_start: 1,
        reason: null,
        at: "2026-10-05T06:00:00.000Z",
      },
      {
        kind: "topup",
        amount_cents: 1500,
        amount: "$15.00",
        window_start: null,
        reason: null,
        at: "2026-10-04T09:00:00.000Z",
      },
    ],
    ...overrides,
  };
}

/**
 * Runs the balance block. `routes` answers each fetch by URL.
 * @param {Record<string, (init: any) => {status: number, body: unknown}>} routes
 * @param {{search?: string}} [options]
 */
function runBlock(routes, { search = "" } = {}) {
  /** @type {Map<string, any>} */
  const elements = new Map();
  for (const id of IDS) {
    const el = stubElement(id);
    const tag = page.match(new RegExp(`<[a-z]+[^>]*\\sid="${id}"[^>]*>`))?.[0] ?? "";
    assert.ok(tag, `usage.html must carry #${id}`);
    el.hidden = /\shidden(\s|>|=)/.test(tag);
    el.checked = /\schecked(\s|>|=)/.test(tag);
    elements.set(id, el);
  }
  /** @type {Array<{url: string, init: any}>} */
  const calls = [];
  /** @type {string[]} */
  const assigned = [];
  const sandbox = {
    URLSearchParams,
    document: {
      getElementById: (/** @type {string} */ id) => elements.get(id) ?? null,
      createElement: (/** @type {string} */ tag) => stubElement(tag),
    },
    window: {
      location: {
        search,
        assign: (/** @type {string} */ url) => assigned.push(url),
      },
    },
    fetch: async (/** @type {string} */ url, /** @type {any} */ init) => {
      calls.push({ url, init });
      const route = routes[url];
      if (!route) throw new Error(`no route for ${url}`);
      const { status, body } = route(init);
      return { ok: status >= 200 && status < 300, status, json: async () => body };
    },
  };
  vm.runInNewContext(balanceScript(), sandbox);
  return { elements, calls, assigned };
}

function settle() {
  return new Promise((resolve) => setImmediate(resolve));
}

/** @param {any} el */
function textOf(el) {
  return [el.textContent, ...el.appended.map(textOf)].join(" ").replace(/\s+/g, " ").trim();
}

const okBalance = (/** @type {object} */ overrides = {}) => ({
  [BALANCE_ENDPOINT]: () => ({ status: 200, body: summary(overrides) }),
});

test("the checkout returns to the page that carries the balance section", () => {
  assert.equal(TOP_UP_PAGE, "/usage");
  assert.ok(page.includes(`const BALANCE_ENDPOINT = "${BALANCE_ENDPOINT}";`));
  assert.ok(page.includes(`const TOPUP_ENDPOINT = "${TOPUP_ENDPOINT}";`));
  assert.ok(page.includes(`const AUTO_TOPUP_ENDPOINT = "${AUTO_TOPUP_ENDPOINT}";`));
});

test("the page shows the balance, its line and the recent ledger lines", async () => {
  const { elements } = runBlock(okBalance());
  await settle();
  assert.equal(elements.get("balance-body").hidden, false);
  assert.equal(elements.get("balance-status").hidden, true);
  assert.equal(elements.get("balance-amount").textContent, "$14.50");
  assert.equal(elements.get("balance-line").textContent, "Balance $14.50.");
  assert.equal(elements.get("balance-line").dataset.state, "ok");
  const lines = elements.get("ledger-list").appended.map(textOf);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /Storage and downloads/);
  assert.match(lines[0], /-\$0\.05/);
  assert.match(lines[0], /2026-10-05/);
  assert.match(lines[1], /Top-up/);
  assert.match(lines[1], /\+\$15\.00/);
  assert.equal(elements.get("ledger-empty").hidden, true);
});

test("the presets are $10, $25 and $50, and the custom amount starts at $10", async () => {
  const { elements } = runBlock(okBalance());
  await settle();
  const buttons = elements.get("topup-presets").appended;
  assert.deepEqual(
    buttons.map((/** @type {any} */ b) => b.textContent),
    ["Add $10", "Add $25", "Add $50"],
  );
  assert.equal(elements.get("topup-amount").min, String(PREPAID.minTopUpUsd));
});

test("a low balance and an empty one are marked, with the API's own line", async () => {
  const low = runBlock(
    okBalance({ balance: "$1.50", balance_line: "Balance $1.50. Top up.", low_balance: true }),
  );
  await settle();
  assert.equal(low.elements.get("balance-line").dataset.state, "low");
  assert.equal(low.elements.get("balance-line").textContent, "Balance $1.50. Top up.");

  const paused = runBlock(
    okBalance({ balance: "$0.00", balance_line: "Uploads are paused.", paused: true, recent: [] }),
  );
  await settle();
  assert.equal(paused.elements.get("balance-line").dataset.state, "paused");
  assert.equal(paused.elements.get("ledger-empty").hidden, false, "no lines says so");
});

test("auto top-up is off by default, in the markup and for an account without it", async () => {
  assert.doesNotMatch(page.match(/<input[^>]*id="auto-topup"[^>]*>/)?.[0] ?? "", /checked/);
  const { elements } = runBlock(okBalance());
  await settle();
  assert.equal(elements.get("auto-topup").checked, false);
  assert.equal(elements.get("auto-topup-amount").value, String(PREPAID.minTopUpUsd));
  // The trigger the switch names is the one the meter job uses.
  assert.ok(page.includes(`when the balance drops under $${PREPAID.lowBalanceUsd}`));

  const on = runBlock(okBalance({ auto_topup_usd: 25 }));
  await settle();
  assert.equal(on.elements.get("auto-topup").checked, true);
  assert.equal(on.elements.get("auto-topup-amount").value, "25");
});

test("a preset sends that amount and goes to the checkout the Worker answered", async () => {
  const { elements, calls, assigned } = runBlock({
    ...okBalance(),
    [TOPUP_ENDPOINT]: () => ({
      status: 200,
      body: { checkout_url: "https://test.checkout.dodopayments.com/s/1", amount_cents: 2500 },
    }),
  });
  await settle();
  const twentyFive = elements.get("topup-presets").appended[1];
  await twentyFive.listeners.get("click")({ preventDefault() {} });
  await settle();
  const post = calls.find((call) => call.url === TOPUP_ENDPOINT);
  assert.ok(post, "the preset posts a top-up");
  assert.equal(post.init.method, "POST");
  assert.deepEqual(JSON.parse(post.init.body), { amount_usd: "25" });
  assert.deepEqual(assigned, ["https://test.checkout.dodopayments.com/s/1"]);
});

test("a custom amount under $10 is refused on the page, without a request", async () => {
  const { elements, calls, assigned } = runBlock(okBalance());
  await settle();
  elements.get("topup-amount").value = "5";
  await elements.get("topup-form").listeners.get("submit")({ preventDefault() {} });
  await settle();
  assert.equal(
    calls.some((call) => call.url === TOPUP_ENDPOINT),
    false,
  );
  assert.equal(elements.get("topup-error").hidden, false);
  assert.equal(elements.get("topup-error").textContent, "Add $10 or more.");
  assert.deepEqual(assigned, []);
});

test("a refused top-up shows the Worker's words and never leaves the page", async () => {
  const { elements, assigned } = runBlock({
    ...okBalance(),
    [TOPUP_ENDPOINT]: () => ({ status: 503, body: { error: "Top-ups are not open yet." } }),
  });
  await settle();
  elements.get("topup-amount").value = "40";
  await elements.get("topup-form").listeners.get("submit")({ preventDefault() {} });
  await settle();
  assert.equal(elements.get("topup-error").textContent, "Top-ups are not open yet.");
  assert.deepEqual(assigned, []);

  // A checkout answer that is not an https page is not followed.
  const odd = runBlock({
    ...okBalance(),
    [TOPUP_ENDPOINT]: () => ({ status: 200, body: { checkout_url: "javascript:alert(1)" } }),
  });
  await settle();
  odd.elements.get("topup-amount").value = "40";
  await odd.elements.get("topup-form").listeners.get("submit")({ preventDefault() {} });
  await settle();
  assert.deepEqual(odd.assigned, []);
  assert.equal(odd.elements.get("topup-error").hidden, false);
});

test("the switch turns auto top-up on with the amount, and off with null", async () => {
  const { elements, calls } = runBlock({
    ...okBalance(),
    [AUTO_TOPUP_ENDPOINT]: (init) => {
      const amount = JSON.parse(init.body).amount_usd;
      return { status: 200, body: { auto_topup_usd: amount === null ? null : Number(amount) } };
    },
  });
  await settle();
  const toggle = elements.get("auto-topup");
  elements.get("auto-topup-amount").value = "25";
  toggle.checked = true;
  await toggle.listeners.get("change")({});
  await settle();
  toggle.checked = false;
  await toggle.listeners.get("change")({});
  await settle();
  const bodies = calls
    .filter((call) => call.url === AUTO_TOPUP_ENDPOINT)
    .map((call) => JSON.parse(call.init.body));
  assert.deepEqual(bodies, [{ amount_usd: "25" }, { amount_usd: null }]);
});

test("a refused switch goes back off and shows why", async () => {
  const { elements } = runBlock({
    ...okBalance(),
    [AUTO_TOPUP_ENDPOINT]: () => ({
      status: 409,
      body: { error: "Top up once first so we can save your card." },
    }),
  });
  await settle();
  const toggle = elements.get("auto-topup");
  toggle.checked = true;
  await toggle.listeners.get("change")({});
  await settle();
  assert.equal(toggle.checked, false, "the switch never shows on when the Worker said no");
  assert.equal(
    elements.get("auto-topup-note").textContent,
    "Top up once first so we can save your card.",
  );
});

test("back from the checkout, the page says the balance moves when the payment is confirmed", async () => {
  const { elements } = runBlock(okBalance(), { search: "?topup=done" });
  await settle();
  assert.equal(elements.get("topup-pending").hidden, false);
  const plain = runBlock(okBalance());
  await settle();
  assert.equal(plain.elements.get("topup-pending").hidden, true);
});

test("a signed-out read shows the Worker's words and no balance", async () => {
  const { elements } = runBlock({
    [BALANCE_ENDPOINT]: () => ({ status: 401, body: { error: "Sign in to see this." } }),
  });
  await settle();
  assert.equal(elements.get("balance-body").hidden, true);
  assert.equal(elements.get("balance-status").hidden, false);
  assert.equal(elements.get("balance-status").textContent, "Sign in to see this.");
});
