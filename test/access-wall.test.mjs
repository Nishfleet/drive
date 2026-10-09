// drive#870: storagebun.com must not serve the pre-launch site to a stranger.
// Cloudflare Access is dashboard config, not Worker config, so this file is
// the executable guard: a 200 from the hostname is the site itself.
//
// Nameservers are still at the registrar, so the host may redirect to a
// parking page. That is not the Worker. A 302 to the Access team host is
// the wall. workers.dev must keep answering that 302 until launch.

import assert from "node:assert/strict";
import { test } from "node:test";

const ACCESS_LOGIN = /^https:\/\/nish345\.cloudflareaccess\.com\//;
const WORKERS_DEV = "https://drive-pricing.nishant345.workers.dev/";
const CUSTOM = "https://storagebun.com/";

/** @param {string} url */
const probe = (url) =>
  fetch(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(10_000) });

test("workers.dev still sends a stranger to the Access sign-in", async () => {
  const res = await probe(WORKERS_DEV);
  assert.equal(res.status, 302, `workers.dev answered ${res.status}`);
  const location = res.headers.get("location");
  assert.ok(location, "workers.dev 302 must name the Access host");
  assert.match(location, ACCESS_LOGIN);
});

test("storagebun.com does not serve the site to a stranger", async () => {
  const res = await probe(CUSTOM);
  assert.notEqual(res.status, 200, "storagebun.com must not answer the site");
  assert.notEqual(res.status, 203, "storagebun.com must not answer the site");
  // A 302 to Access is the wall. A 302 elsewhere is the registrar still
  // answering, which is not the Worker. Requiring Access here would fail
  // every CI run until nameservers move (drive#870 / drive#872).
  if (res.status !== 302) return;
  const location = res.headers.get("location");
  assert.ok(location, "a 302 must name where it sends the stranger");
  assert.match(location, /^https:\/\//);
});
