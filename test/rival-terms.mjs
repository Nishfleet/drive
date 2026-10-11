// The rival's name as patterns, shared by every test that must prove a page or
// a file does not name it. The name is assembled from pieces here on purpose:
// the repo is public, and test/no-rival-terms.test.mjs fails on the name
// anywhere in a tracked file, this one included.
//
// Say "the main competitor" (or "the competitor's docs" for a citation)
// wherever the rival has to be mentioned.

const NAME = ["Sp", "ace"].join("");

// The capitalised product name as a whole word, alone or with a product suffix
// ("<Name> AI", "<Name>FS"). It is case-sensitive so ordinary lowercase words
// (disk space, namespace, whitespace) never match.
export const RIVAL_PRODUCT = new RegExp(`\\b${NAME}(?:FS| AI)?\\b`);

// The product's file-system name or site in any case, with or without a dot
// ("<name>fs", "<name>.fs", "<name>fs.com").
export const RIVAL_SITE = new RegExp(`${NAME}\\.?fs`, "i");

/**
 * Every rival mention in one text, as {line, match} pairs.
 * @param {string} text
 * @returns {Array<{line: number, match: string}>}
 */
export function rivalHits(text) {
  const hits = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    for (const re of [RIVAL_PRODUCT, RIVAL_SITE]) {
      const found = re.exec(lines[i]);
      if (found) {
        hits.push({ line: i + 1, match: found[0] });
      }
    }
  }
  return hits;
}
