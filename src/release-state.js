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

// The platforms version 1 ships, read as words, from docs/build-spec.md's
// Platforms row ("macOS and Linux. No Windows in v1"). drive#776 found the
// quickstart offering Windows install in the same breath as the two platforms
// that ship, so the docs now offer the macOS and Linux packages and name the
// MSI only inside a sentence that says it is out of version 1.
export const V1_PLATFORMS = Object.freeze(["macOS", "Linux"]);

// Words that cannot be read as anything but the out-of-v1 platform and the
// installer that carries it. A block that names one of these may stay, but only
// when that block carries a denial below, and the sentence naming the MSI
// carries one itself: the drive's own code has a Windows mount behind it, and
// the honest sentence is that nothing signed ships. `winget` is deliberately
// absent: `drive update` names it as one of four package managers on the line
// it prints on every platform.
export const OUT_OF_V1_PLATFORM_WORDS = Object.freeze([/\bWindows\b/i, /\bMSI\b/, /\bWinFsp\b/i]);

// The denial such a sentence must carry, in that same sentence.
export const OUT_OF_V1_PLATFORM_DENIALS = Object.freeze([
  /not in version 1/i,
  /not a version 1/i,
  /not in v1\b/i,
  /not ready yet/i,
  /not yet released/i,
  /no published release/i,
  /\bunsigned\b/i,
]);
