// The API reference (docs-site/api.md) names every route the api Worker
// registers, so a new route cannot ship without a line on the page. The few
// routes the page lists under "Not documented yet" are named here on purpose.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { routes } from "../workers/api/src/routes.js";

const page = readFileSync(new URL("../docs-site/api.md", import.meta.url), "utf8");
const NOT_YET = new Set(["GET /v1/device/approve", "POST /v1/device/approve", "POST /v1/events"]);

test("every registered route has a heading on the API reference page", () => {
  for (const { method, path } of routes) {
    if (NOT_YET.has(`${method} ${path}`)) continue;
    assert.ok(
      page.includes(`### \`${method} ${path}\``),
      `docs-site/api.md needs a "### \`${method} ${path}\`" section`,
    );
  }
});

test("the routes the page leaves out are named in its Not documented yet list", () => {
  const tail = page.slice(page.indexOf("## Not documented yet"));
  assert.ok(tail.includes("/v1/device/approve") && tail.includes("/v1/events"));
});
