import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const config = JSON.parse(readFileSync(new URL("../lighthouserc.json", import.meta.url), "utf8"));
const urls = new Set(config.ci.collect.url);
const everyPage = config.ci.assert.assertMatrix.find(
  (/** @type {{matchingUrlPattern: string}} */ entry) => entry.matchingUrlPattern === ".*",
).assertions;

test("every signed-in page and the sign-in page are measured on every PR", () => {
  for (const page of ["signin", "home", "files", "usage", "devices", "webhooks"]) {
    assert.ok(
      urls.has(`http://localhost/${page}.html`),
      `${page}.html is not in lighthouserc.json`,
    );
  }
});

test("every measured page has a performance floor, a speed ceiling and a weight limit", () => {
  assert.ok(everyPage["categories:performance"][1].minScore >= 0.9);
  assert.ok(everyPage["largest-contentful-paint"][1].maxNumericValue <= 1500);
  assert.ok(everyPage["total-blocking-time"][1].maxNumericValue <= 150);
  assert.ok(everyPage["cumulative-layout-shift"][1].maxNumericValue <= 0.01);
  assert.ok(everyPage["total-byte-weight"][1].maxNumericValue <= 307200);
});

test("the scoreboard lists the measured numbers for the pages", () => {
  const scoreboard = readFileSync(new URL("../docs/scoreboard.md", import.meta.url), "utf8");
  assert.match(scoreboard, /## Site speed: our own pages/);
  for (const page of ["Files", "Usage", "Devices", "Webhooks", "sign in"]) {
    assert.ok(scoreboard.includes(`- ${page}:`) || scoreboard.includes(`${page}: 100`), page);
  }
});
