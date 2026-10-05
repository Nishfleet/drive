import assert from "node:assert/strict";
import { test } from "node:test";
import { failureMessage } from "../../../src/messages.js";
import { createApp, dispatch } from "../src/index.js";
import { MIN_CLI_VERSION, parseDriveVersion, versionBelowFloor } from "../src/versiongate.js";

/** @typedef {import("../src/index.js").Ctx} Ctx */
const ctx = { env: {}, db: null, now: () => 0 };

// ---- the parse and the compare drive#560's gate answers on ----

test("a drive User-Agent names its version", () => {
  assert.equal(parseDriveVersion("drive/0.1.0 (linux/amd64)"), "0.1.0");
  assert.equal(parseDriveVersion("drive/v0.9.9 (darwin/arm64)"), "v0.9.9");
  assert.equal(
    parseDriveVersion("drive/0.1.1-0.20261005112233-abcdef (linux/amd64)"),
    "0.1.1-0.20261005112233-abcdef",
  );
});

test("a User-Agent that names no drive version is not refused", () => {
  for (const ua of [
    null,
    undefined,
    "",
    "Go-http-client/1.1",
    "curl/8.4.0",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130 Safari/537.36",
    "restic 0.16.0",
  ]) {
    assert.equal(parseDriveVersion(ua), null, `${String(ua)} must not name a drive version`);
  }
});

test("compareVersions decides the 426 the way the CLI's own compare does", () => {
  // Equal is served: the floor is the oldest build the deployment answers.
  assert.equal(versionBelowFloor("0.1.0", "0.1.0"), false);
  assert.equal(versionBelowFloor("0.1.1-0.20261005112233-abcdef", "0.1.1"), false);
  assert.equal(versionBelowFloor("v0.10.0", "0.9.9"), false);
  assert.equal(versionBelowFloor("0.2.0", "0.1.0"), false);
  assert.equal(versionBelowFloor("0.0.9", "0.1.0"), true);
  assert.equal(versionBelowFloor("0.9.9", "0.9.10"), true);
  assert.equal(versionBelowFloor("0.1", "0.1.1"), true);
});

// ---- the 426, through the Worker's own app ----

test("a request from an old drive is answered 426 with the update words", async () => {
  const res = await dispatch(
    new Request("https://x.test/v1/health", {
      headers: { "user-agent": "drive/0.0.9 (linux/amd64)" },
    }),
    ctx,
  );
  assert.equal(res.status, 426);
  assert.deepEqual(await res.json(), { error: failureMessage("cli-too-old") });
});

// The gate runs ahead of the account gate: an old CLI is told to update
// rather than asked for credentials it can already produce, which is the
// whole point of answering the version before the route runs.
test("the 426 runs before the account gate", async () => {
  const res = await dispatch(
    new Request("https://x.test/v1/keys", {
      method: "GET",
      headers: { "user-agent": "drive/0.0.9 (linux/amd64)" },
    }),
    ctx,
  );
  assert.equal(res.status, 426);
  assert.equal(res.headers.get("www-authenticate"), null);
  assert.equal((await res.json()).error, failureMessage("cli-too-old"));
});

test("the floor version and newer pass through", async () => {
  for (const version of [MIN_CLI_VERSION, "0.2.0", "0.1.1-0.20261005112233-abcdef"]) {
    const res = await dispatch(
      new Request("https://x.test/v1/health", {
        headers: { "user-agent": `drive/${version} (linux/amd64)` },
      }),
      ctx,
    );
    assert.equal(res.status, 200, `drive/${version} must pass the gate`);
  }
});

test("a browser and a health probe pass through untouched", async () => {
  const browser = await dispatch(
    new Request("https://x.test/v1/keys", {
      headers: { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36" },
    }),
    ctx,
  );
  // The gate passed; the account gate below it is the one answering 401.
  assert.equal(browser.status, 401);
  const probe = await dispatch(new Request("https://x.test/v1/health"), ctx);
  assert.equal(probe.status, 200);
});

test("the floor is a deployment setting", async () => {
  const raised = { env: { MIN_CLI_VERSION: "0.2.0" }, db: null, now: () => 0 };
  const served = await dispatch(
    new Request("https://x.test/v1/health", {
      headers: { "user-agent": "drive/0.1.0 (linux/amd64)" },
    }),
    raised,
  );
  assert.equal(served.status, 426);
  const current = await dispatch(
    new Request("https://x.test/v1/health", {
      headers: { "user-agent": "drive/0.2.0 (linux/amd64)" },
    }),
    raised,
  );
  assert.equal(current.status, 200);
});

// The registry the gate protects is still the registry the routes test walks:
// a middleware that changed the table would show up here.
test("the gate leaves the registry whole", () => {
  const registered = createApp().routes.filter((entry) => entry.method !== "ALL");
  assert.ok(
    registered.some((entry) => entry.path === "/v1/health"),
    `the health route is gone from the registry: ${JSON.stringify(registered)}`,
  );
});
