import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";

const CHANGELOG = new URL("../docs-site/changelog.md", import.meta.url);
const SNAPSHOT = new URL("../public/whats-new.json", import.meta.url);

/** @param {string} markdown */
export function newestEntry(markdown) {
  const date = markdown.match(/^## (\d{4}-\d{2}-\d{2})$/m);
  if (!date || date.index === undefined) throw new Error("the changelog has no dated entry");
  const rest = markdown.slice(date.index + date[0].length);
  const bullet = rest.match(/^- ([\s\S]*?)(?=\n- |\n## |(?![\s\S]))/m);
  if (!bullet) throw new Error("the newest changelog entry has no bullet");
  const text = bullet[1].replace(/\s+/g, " ").trim();
  const firstSentence = text.match(/^.*?[.!?](?=\s|$)/);
  return { date: date[1], text: (firstSentence ? firstSentence[0] : text).replace(/\.$/, "") };
}

test("the home page's What's new line is the newest changelog entry", () => {
  const expected = newestEntry(readFileSync(CHANGELOG, "utf8"));
  if (process.env.UPDATE_SCREENSHOTS === "1") {
    writeFileSync(SNAPSHOT, `${JSON.stringify(expected, null, 2)}\n`);
  }
  assert.deepEqual(
    JSON.parse(readFileSync(SNAPSHOT, "utf8")),
    expected,
    "public/whats-new.json is out of date; run UPDATE_SCREENSHOTS=1 node --test test/whats-new.test.mjs",
  );
});

test("the newest entry is cut at its first sentence", () => {
  const md =
    "# Changelog\n\n## 2026-10-09\n\n- First thing happened now. More detail\n  on a second line.\n- Second item.\n\n## 2026-10-07\n\n- Old.\n";
  assert.deepEqual(newestEntry(md), { date: "2026-10-09", text: "First thing happened now" });
});
