// Delete says it happened and offers Undo in the same line; Undo is the same
// restore call the Recently deleted tab makes (delight item 6).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const page = readFileSync(new URL("../public/files.html", import.meta.url), "utf8");

test("a delete is followed by an Undo that restores the same path", () => {
  const remove = page.slice(
    page.indexOf("async function removeFile"),
    page.indexOf("function offerUndo"),
  );
  assert.match(remove, /say\(DELETE_COPY\.done, "done"\);\s+offerUndo\(row\);/);
  const offer = page.slice(
    page.indexOf("function offerUndo"),
    page.indexOf("async function restoreFile"),
  );
  assert.match(offer, /textContent = "Undo"/);
  assert.match(offer, /restoreFile\(row\)/);
  assert.match(offer, /statusLine\.append/);
});
