const HTML_ESCAPES = Object.freeze({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
});

/**
 * Escapes a value for HTML text or a double-quoted attribute value. One pass
 * over the string, so nothing is escaped twice and no character is left for a
 * second call to miss. Unknown values become their String() form rather than
 * throwing, so a page renders with the value visible instead of failing after
 * the data was written.
 * @param {unknown} text
 * @returns {string}
 */
export function escapeHtml(text) {
  return String(text).replace(
    /[&<>"']/g,
    (ch) => HTML_ESCAPES[/** @type {keyof typeof HTML_ESCAPES} */ (ch)],
  );
}
