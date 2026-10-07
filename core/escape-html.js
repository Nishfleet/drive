// The one HTML escaper every render of store-provided text goes through
// (drive#518 review): the device approval page and the transactional emails
// both put store-provided strings into HTML, and a second escaper with a
// different character set would let one surface miss a character the other
// catches. The apostrophe is escaped even though these renders are text
// content today, so the same function stays correct if a caller later moves a
// value into an attribute.
//
// Plain data and pure renderers only -- no Worker or DOM imports -- so both
// the email module and the device routes can import it without dragging a
// runtime into the email render's load order.
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
