import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const config = JSON.parse(readFileSync(new URL("../lighthouserc.json", import.meta.url), "utf8"));
const urls = new Set(config.ci.collect.url);

test("every signed-in page and the sign-in page are measured on every PR", () => {
  for (const page of ["signin", "home", "files", "usage", "devices", "webhooks"]) {
    assert.ok(
      urls.has(`http://localhost/${page}.html`),
      `${page}.html is not in lighthouserc.json`,
    );
  }
});

test("the scoreboard lists the measured numbers for the pages", () => {
  const scoreboard = readFileSync(new URL("../docs/scoreboard.md", import.meta.url), "utf8");
  assert.match(scoreboard, /## Site speed: our own pages/);
  for (const page of ["Files", "Usage", "Devices", "Webhooks", "sign in"]) {
    assert.ok(scoreboard.includes(`- ${page}:`) || scoreboard.includes(`${page}: 100`), page);
  }
});
