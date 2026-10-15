// The History section on /usage (retention, Nish 2026-10-14): the page shows
// the price the Worker words for a window before it asks to turn it on, and
// sends accept_price only for the window on screen. The block is the second
// inline script (data-part="balance"), run here against a stub page.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const page = readFileSync(new URL("../public/usage.html", import.meta.url), "utf8");
const OPEN_TAG = '<script data-part="balance">';
const start = page.indexOf(OPEN_TAG);
const script = page.slice(start + OPEN_TAG.length, page.indexOf("</script>", start));

/** @param {string} id */
function stubElement(id) {
  /** @type {any} */
  const el = {
    id,
    hidden: false,
    textContent: "",
    value: "",
    checked: false,
    disabled: false,
    type: "",
    name: "",
    dataset: {},
    appended: [],
    listeners: new Map(),
    append(/** @type {any[]} */ ...nodes) {
      el.appended.push(...nodes);
    },
    replaceChildren(/** @type {any[]} */ ...nodes) {
      el.appended = nodes;
    },
    addEventListener(/** @type {string} */ type, /** @type {(e: any) => any} */ fn) {
      el.listeners.set(type, fn);
    },
    setAttribute() {},
    querySelector() {
      return stubElement(`${id}.child`);
    },
  };
  return el;
}

const OPTIONS = {
  days: 3,
  options: [
    { days: 3, label: "Keep history 3 days", free: true, line: "Free line." },
    { days: 30, label: "Keep history 30 days", free: false, line: "Thirty line with $0.10." },
    { days: 365, label: "Keep history 1 year", free: false, line: "Year line with $1.21." },
  ],
};

/** @param {{post?: {status: number, body: unknown}}} [config] */
async function run(config = {}) {
  /** @type {Map<string, any>} */
  const elements = new Map();
  for (const match of page.matchAll(/\sid="([^"]+)"/g)) {
    const el = stubElement(match[1]);
    const tag = page.slice(page.lastIndexOf("<", match.index), page.indexOf(">", match.index));
    el.hidden = /\shidden(\s|>|=|$)/.test(tag);
    elements.set(match[1], el);
  }
  /** @type {Array<{url: string, init: any}>} */
  const calls = [];
  const sandbox = {
    URLSearchParams,
    JSON,
    document: {
      getElementById: (/** @type {string} */ id) => elements.get(id) ?? null,
      createElement: (/** @type {string} */ tag) => stubElement(tag),
    },
    window: { location: { search: "", assign() {} } },
    fetch: async (/** @type {string} */ url, /** @type {any} */ init) => {
      calls.push({ url, init });
      const respond = (/** @type {number} */ status, /** @type {unknown} */ body) => ({
        ok: status < 400,
        status,
        json: async () => body,
      });
      if (url === "/api/history" && init?.method === "POST") {
        const post = config.post ?? { status: 200, body: { days: JSON.parse(init.body).days } };
        return respond(post.status, post.body);
      }
      if (url === "/api/history") return respond(200, structuredClone(OPTIONS));
      return respond(500, { error: "stub" });
    },
  };
  vm.runInNewContext(script, sandbox);
  await new Promise((resolve) => setTimeout(resolve, 20));
  return { elements, calls };
}

test("the section appears with the free window and no price asked for", async () => {
  const { elements } = await run();
  assert.equal(elements.get("history-section").hidden, false);
  assert.equal(elements.get("history-now").textContent, "Free line.");
  assert.equal(elements.get("history-options").appended.length, 3);
  assert.equal(elements.get("history-save").hidden, true);
});

test("choosing a paid window shows its price first, and saving sends accept_price", async () => {
  const { elements, calls } = await run();
  const radios = elements
    .get("history-options")
    .appended.map((/** @type {any} */ l) => l.appended[0]);
  radios[1].checked = true;
  radios[1].listeners.get("change")();
  assert.equal(elements.get("history-line").textContent, "Thirty line with $0.10.");
  assert.equal(elements.get("history-save").hidden, false);
  assert.equal(calls.filter((call) => call.init?.method === "POST").length, 0, "nothing sent yet");

  await elements.get("history-save").listeners.get("click")();
  const post = calls.find((call) => call.init?.method === "POST");
  assert.deepEqual(JSON.parse(post?.init.body), { days: 30, accept_price: true });
  assert.equal(elements.get("history-status").textContent, "Saved.");
  assert.equal(elements.get("history-now").textContent, "Thirty line with $0.10.");
});

test("a refusal is shown as it is and the window does not change", async () => {
  const { elements } = await run({
    post: {
      status: 503,
      body: { error: "Longer history is not switched on yet. Nothing was changed." },
    },
  });
  const radios = elements
    .get("history-options")
    .appended.map((/** @type {any} */ l) => l.appended[0]);
  radios[2].listeners.get("change")();
  await elements.get("history-save").listeners.get("click")();
  assert.match(elements.get("history-status").textContent, /not switched on yet/);
  assert.equal(elements.get("history-now").textContent, "Free line.");
});
