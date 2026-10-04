// The two standing claims every customer-facing surface must state,
// and the words that deny each (drive#418).
//
// The walkthrough of 2026-10-04 found the README saying "Every save
// keeps a version" while every docs page said "Version history is not
// in version 1", and the pricing page selling a waitlist beside a
// sign-in that lets anyone in. Neither fact changed: #9 is not built
// and the drive is not open. What drifts is the words, so the words
// live here once: the docs pages render the markers, the static
// surfaces carry the strings verbatim, and test/version-1-claims.test.mjs
// holds every surface to them.
//
// The words below must be the sentence used everywhere: edit them
// here, not in the pages. A docs page carries one marker; a surface
// that does not render markers carries the string verbatim.
export const VERSION_HISTORY = "Version history is not in version 1.";
export const NOT_OPEN = "The drive is not open yet. Sign-ups on the pricing page go to a waitlist.";

// The phrase a surface must never use to claim a feature the product
// does not have. A surface matching any of these fails the build. Keep
// this list to phrases that cannot be read as anything but the
// promise — a page that says "version history is not in version 1"
// carries none of them.
export const VERSION_HISTORY_PROMISES = Object.freeze([
  /every save keeps a version/i,
  /keeps a version/i,
  /version history is included/i,
  /every version of a file/i,
  /restore any earlier version/i,
]);
