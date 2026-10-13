// The folder filter (high-end gaps item 5): typing hides rows whose name does
// not contain the text, with a sentence when none match. It is client-side, so
// the page script runs here against a small stub list.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const page = readFileSync(new URL("../public/files.html", import.meta.url), "utf8");

test("the files page carries a labelled filter box and its empty sentence", () => {
  assert.match(
    page,
    /<input class="filter" type="search" id="file-filter" aria-label="Filter this folder by name"/,
  );
  assert.match(page, /id="filter-none" hidden>No file here matches that\./);
});

test("applyFilter hides rows by name, case-insensitively, and says when none match", () => {
  const start = page.indexOf("function applyFilter()");
  const body = page.slice(start, page.indexOf("\nif (filterEl) {", start));
  const row = (/** @type {string} */ name) => ({
    id: "",
    hidden: false,
    querySelector: () => ({ textContent: name }),
  });
  const list = { children: [row("Report.PDF"), row("photo.jpg"), row("notes.txt")] };
  const filterEl = { value: "" };
  const filterNone = { hidden: true };
  const apply = new Function("list", "filterEl", "filterNone", `${body}\nreturn applyFilter;`)(
    list,
    filterEl,
    filterNone,
  );
  const hiddenNames = () =>
    list.children.filter((r) => r.hidden).map((r) => r.querySelector().textContent);

  filterEl.value = "rep";
  apply();
  assert.deepEqual(hiddenNames(), ["photo.jpg", "notes.txt"]);
  assert.equal(filterNone.hidden, true);

  filterEl.value = "zzz";
  apply();
  assert.equal(hiddenNames().length, 3);
  assert.equal(filterNone.hidden, false);

  filterEl.value = "  ";
  apply();
  assert.deepEqual(hiddenNames(), []);
  assert.equal(filterNone.hidden, true);
});
