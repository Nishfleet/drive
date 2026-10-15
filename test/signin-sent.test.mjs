import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const page = readFileSync(new URL("../public/signin.html", import.meta.url), "utf8");

function stub() {
  /** @type {Map<string, (event?: unknown) => void>} */
  const listeners = new Map();
  return {
    hidden: false,
    disabled: false,
    value: "",
    checked: true,
    textContent: "",
    focused: false,
    classList: { toggle() {} },
    listeners,
    focus() {
      this.focused = true;
    },
    addEventListener: (/** @type {string} */ type, /** @type {(event?: unknown) => void} */ fn) =>
      listeners.set(type, fn),
    querySelector: () => null,
  };
}

async function run() {
  const elements = new Map();
  const ticks = /** @type {Array<() => void>} */ ([]);
  const sandbox = {
    document: {
      getElementById: (/** @type {string} */ id) => {
        if (!elements.has(id)) elements.set(id, stub());
        return elements.get(id);
      },
      querySelectorAll: () => [],
    },
    window: { location: { search: "", assign() {} } },
    console,
    URLSearchParams,
    fetch: async (/** @type {string} */ url) =>
      url === "/api/signin" ? { ok: true, json: async () => ({ ok: true }) } : { ok: false },
    setInterval: (/** @type {() => void} */ fn) => {
      ticks.push(fn);
      return ticks.length;
    },
    clearInterval() {},
  };
  const start = page.indexOf("<script>");
  vm.runInNewContext(page.slice(start + 8, page.indexOf("</script>", start)), sandbox);
  await new Promise((resolve) => setTimeout(resolve, 10));
  return { elements, ticks };
}

test("after the link is sent the form gives way to a Check your email step with a resend that waits", async () => {
  const { elements, ticks } = await run();
  const form = elements.get("signin-form");
  elements.get("email").value = "me@example.com";
  form.listeners.get("submit")({ preventDefault() {} });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(form.hidden, true);
  assert.equal(elements.get("sent").hidden, false);
  assert.equal(elements.get("sent-to").textContent, "me@example.com");
  assert.equal(elements.get("sent-heading").focused, true);
  assert.equal(elements.get("sent-again").disabled, true);
  assert.equal(elements.get("sent-again").textContent, "Send it again in 30s");
  for (let i = 0; i < 30; i += 1) ticks[ticks.length - 1]();
  assert.equal(elements.get("sent-again").disabled, false);
  assert.equal(elements.get("sent-again").textContent, "Send it again");
  assert.match(elements.get("signin-status").textContent, /Check your email/);
});

test("Use a different email brings the form back", async () => {
  const { elements } = await run();
  const form = elements.get("signin-form");
  elements.get("email").value = "me@example.com";
  form.listeners.get("submit")({ preventDefault() {} });
  await new Promise((resolve) => setTimeout(resolve, 20));
  elements.get("sent-change").listeners.get("click")();
  assert.equal(form.hidden, false);
  assert.equal(elements.get("sent").hidden, true);
  assert.equal(elements.get("email").focused, true);
});

test("the sent step is hidden until a link is sent", () => {
  assert.match(page, /<div class="sent" id="sent" hidden>/);
  assert.match(page, /good for 10 minutes and works once/);
});
