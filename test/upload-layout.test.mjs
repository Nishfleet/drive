import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const page = readFileSync(new URL("../public/upload.html", import.meta.url), "utf8");

test("the upload drop box keeps its space until the link answers", () => {
  assert.match(page, /\.drop\[hidden\]\s*\{\s*visibility:\s*hidden;\s*\}/);
  assert.match(page, /\.drop\.gone\[hidden\]\s*\{\s*display:\s*none;\s*\}/);
  assert.match(page, /drop\.classList\.add\("gone"\);\s*drop\.hidden = true;/);
});
