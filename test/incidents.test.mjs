// The public incident history (public/incidents.json, read by the status
// page): hand-written after an incident, so its shape is pinned here and a
// typo cannot blank the page.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const history = JSON.parse(
  readFileSync(new URL("../public/incidents.json", import.meta.url), "utf8"),
);
const DAY = /^\d{4}-\d{2}-\d{2}$/;

test("the history has a date and a list of incidents, newest first", () => {
  assert.match(history.updated, DAY);
  assert.ok(Array.isArray(history.incidents));
  const starts = history.incidents.map((/** @type {{started: string}} */ i) => i.started);
  assert.deepEqual([...starts].sort().reverse(), starts, "newest incident first");
});

test("every incident names what happened and when, with no loose ends", () => {
  const ids = new Set();
  for (const incident of history.incidents) {
    assert.match(incident.id, /^[a-z0-9-]+$/);
    assert.ok(!ids.has(incident.id), `${incident.id} is listed twice`);
    ids.add(incident.id);
    assert.ok(typeof incident.title === "string" && incident.title.length > 0);
    assert.ok(typeof incident.summary === "string" && incident.summary.length > 0);
    assert.match(incident.started, DAY);
    assert.ok(incident.resolved === null || DAY.test(incident.resolved));
    if (incident.resolved !== null) {
      assert.ok(incident.resolved >= incident.started, `${incident.id} ends before it starts`);
    }
  }
});

test("the status page reads the history and says so when it is empty", () => {
  const page = readFileSync(new URL("../public/status.html", import.meta.url), "utf8");
  assert.match(page, /fetch\("\/incidents\.json"/);
  assert.match(page, /No incidents have been recorded/);
});
