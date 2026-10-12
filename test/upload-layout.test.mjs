// The Lighthouse gate allows a layout shift of 0.01. The drop box on the
// upload page is revealed after the link answers; if it is display:none until
// then, the status line under it jumps when it appears. It must keep its space
// (hidden but laid out), and only a closed link may take the space back.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const page = readFileSync(new URL("../public/upload.html", import.meta.url), "utf8");

test("the upload drop box keeps its space until the link answers", () => {
  assert.match(page, /\.drop\[hidden\]\s*\{\s*visibility:\s*hidden;\s*\}/);
  assert.match(page, /\.drop\.gone\[hidden\]\s*\{\s*display:\s*none;\s*\}/);
  assert.match(page, /drop\.classList\.add\("gone"\);\s*drop\.hidden = true;/);
});
