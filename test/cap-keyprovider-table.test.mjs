import assert from "node:assert/strict";
import { test } from "node:test";
import { WRITE_SCOPE_BY_KIND } from "../src/cap.js";
import { CAPABILITIES_BY_KIND as KEYPROVIDER_TABLE } from "../workers/api/src/keyprovider.js";

// drive#77: the api Worker is one table of kind to capabilities, and the
// pricing Worker reads that same table rather than keeping its own copy.
//
// The check is object identity, not source text: if src/cap.js ever declared a
// second table (or re-exported a frozen copy of it), these two names would no
// longer be the same object, and the assertion fails.

test("src/cap.js holds the api Worker's table itself, not a second copy", () => {
  assert.equal(WRITE_SCOPE_BY_KIND, KEYPROVIDER_TABLE);
});

test("the shared table covers the four kinds once, with delete only on a device key", () => {
  assert.deepEqual(Object.keys(KEYPROVIDER_TABLE).sort(), ["agent", "branch", "device", "s3"]);
  for (const [kind, capabilities] of Object.entries(KEYPROVIDER_TABLE)) {
    assert.ok(capabilities.includes("list"), `${kind} can list`);
    assert.ok(capabilities.includes("read"), `${kind} can read`);
    assert.equal(capabilities.includes("delete"), kind === "device", `${kind} must not delete`);
  }
});
