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
