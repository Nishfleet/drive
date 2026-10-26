import assert from "node:assert/strict";
import { test } from "node:test";

const ACCESS_LOGIN = /^https:\/\/(nish345|storagebun)\.cloudflareaccess\.com\//;
const CUSTOM = "https://storagebun.com/";

/** @param {string} url */
const probe = (url) =>
  fetch(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(10_000) });

test("storagebun.com sends a stranger to the Access sign-in", async () => {
  const res = await probe(CUSTOM);
  assert.equal(res.status, 302, `storagebun.com answered ${res.status}`);
  const location = res.headers.get("location");
  assert.ok(location, "storagebun.com 302 must name the Access host");
  assert.match(location, ACCESS_LOGIN);
});
