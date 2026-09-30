// The one message table (docs/build-spec.md, "Nothing missing": "Every CLI and
// web error says what happened and the one thing to do next, from one message
// table with tests"). It is plain data with no Worker or DOM imports, so the
// api Worker, the static pages and the CLI step that follows can all read the
// same words instead of each writing its own. The pricing page is a static
// asset and cannot import this module, so test/messages.test.mjs reads the
// shipped page and fails CI if its two failure strings drift from here.
//
// Every entry is `{ what, next }`:
//   what - what happened, in one sentence, in the customer's words.
//   next - the one thing to do next, in one sentence.
// The safety rules (Nish, 2026-09-30, "Safe"): a message never carries a
// secret, a key, another user's path, or raw error text. test/messages.test.mjs
// enforces both shapes on every entry, so a new entry cannot ship a stack, a
// token or a two-step fix-it list.
export const FAILURE_MESSAGES = Object.freeze({
  // The browser or the CLI cannot reach the network at all.
  offline: Object.freeze({
    what: "You look offline.",
    next: "Check your connection and try again.",
  }),
  // The account hit the spending cap, so the drive went read-only. Nothing is
  // deleted at the cap (build-spec.md, "How the money is worked out").
  "cap-reached": Object.freeze({
    what: "Your drive is read-only because it reached its spending cap; nothing was deleted.",
    next: "Raise the cap on the usage page to start writing again.",
  }),
  // The key this device (or agent, or branch) was using no longer works.
  "key-revoked": Object.freeze({
    what: "This device's key was revoked, so it can't reach the drive.",
    next: "Sign in again to get a new key; your files are untouched.",
  }),
  // rclone's local VFS cache filled the disk, so saves cannot queue.
  "disk-cache-full": Object.freeze({
    what: "The local cache is full, so new saves can't upload.",
    next: "Free up disk space on this device and try the save again.",
  }),
  // The waitlist (or another bounded form) stopped accepting this caller for
  // a moment because they sent too many requests. Nothing was stored and the
  // address on file is untouched.
  "rate-limited": Object.freeze({
    what: "Too many sign-ups from your connection right now.",
    next: "Wait a minute and try again.",
  }),
  // The request body was larger than the endpoint accepts, so it was never
  // read or stored.
  "body-too-large": Object.freeze({
    what: "That request was too large to accept.",
    next: "Send a smaller request and try again.",
  }),
  // The api Worker (or the CLI's call to it) could not reach storage.
  "storage-down": Object.freeze({
    what: "We can't reach storage right now.",
    next: "Wait a few minutes and try again.",
  }),
  // A payment did not go through, so billing is paused.
  "payment-failed": Object.freeze({
    what: "Your last payment didn't go through, so billing is paused.",
    next: "Use the link in the payment email to update your card.",
  }),
  // A request that needs the signed-in account arrived without one. This is the
  // account gate's words (issue #45, north star: Safe): the status endpoint
  // answers 401 and never device data, so nothing is leaked to an anonymous
  // caller and the one next step is to sign in.
  unauthorized: Object.freeze({
    what: "You are not signed in to your drive.",
    next: "Sign in, then this page updates on its own.",
  }),
  // A share link or upload page that does not open: unknown, revoked or past
  // its 7-day window (issue #19). One entry for all three on purpose — the
  // public routes must not tell a stranger which of those it was, and the one
  // next step is the same for every case.
  "link-not-found": Object.freeze({
    what: "That link does not open anything.",
    next: "Ask the person who sent it for a new one.",
  }),
  // The owner's drive is read-only at its spending cap, so a public upload
  // page cannot take a file. The stranger can act on neither the cap nor the
  // drive; the one thing they can do is tell the owner (issue #19).
  "upload-paused-at-cap": Object.freeze({
    what: "This drive has reached its spending cap, so it is not taking uploads right now.",
    next: "Tell the person who shared this page and try again later.",
  }),
  // Anything with no more specific entry: still says what happened and the one
  // thing to do, never the raw error. This is the page's client-side fallback
  // and the worker's last resort.
  unexpected: Object.freeze({
    what: "That did not work.",
    next: "Try again in a moment.",
  }),
});

// The words a customer reads for one failure path: "what happened" then the
// one next step. An unknown key is a programmer error and throws here rather
// than silently returning a default, because a default would hide the missing
// entry the issue made required.
export function failureMessage(key) {
  const entry = FAILURE_MESSAGES[key];
  if (!entry) {
    throw new Error(
      `no failure message for "${key}"; add it to FAILURE_MESSAGES in src/messages.js`,
    );
  }
  return `${entry.what} ${entry.next}`;
}
