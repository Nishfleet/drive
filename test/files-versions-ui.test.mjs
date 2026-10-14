// The Files page's "Earlier copies" action (delight item 1): it asks the
// versions route for the file, lists what comes back with a put-back button,
// and says plainly when there is nothing to put back.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const page = readFileSync(new URL("../public/files.html", import.meta.url), "utf8");

test("every file row offers Earlier copies, wired to the two routes", () => {
  assert.match(page, /const VERSIONS_ENDPOINT = "\/api\/files\/versions";/);
  assert.match(page, /const RESTORE_VERSION_ENDPOINT = "\/api\/files\/restore-version";/);
  assert.match(page, /earlier\.textContent = "Earlier copies";/);
  assert.match(page, /JSON\.stringify\(\{ path: row\.path, versionId: copy\.versionId \}\)/);
});

test("the empty answer and the put-back result are plain sentences", () => {
  assert.match(
    page,
    /No earlier copies of this file\. A copy shows up here after you save over it\./,
  );
  assert.match(page, /Put back\. The copy it replaced is under Earlier copies/);
});

test("the 3-day promise is one sentence, and the bucket keeps what the pages say", async () => {
  const { HIDDEN_VERSION_DAYS } = await import("../core/s3.js");
  const sentence = "Deleted or replaced files stay restorable for 3 days, free.";
  assert.equal(HIDDEN_VERSION_DAYS, 3);
  assert.ok(page.includes(sentence), "the Files page says it");
  for (const file of ["../public/terms.html", "../README.md"]) {
    const text = readFileSync(new URL(file, import.meta.url), "utf8").replace(/\s+/g, " ");
    assert.ok(text.includes(sentence), `${file} says it`);
  }
  assert.match(page, /permanently removed \$\{whenLabel\(copy\.restorableUntil\)\}/);
});
