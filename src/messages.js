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
// The one top-up prompt (drive#586): the $0 pause, the low balance line, the
// "$2 left" email and the CLI all say it in these words.
export const TOP_UP_PROMPT = "Top up to keep adding files.";

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
  // One agent key reached its own cap (drive issue #171), so the drive took its
  // write powers away and the tool keeps reading. Nothing was deleted, and the
  // cap is per key: the person's own keys and the other agents are untouched.
  "agent-cap-reached": Object.freeze({
    what: "This agent reached its own limit, so it can read the drive but not change it.",
    next: "Connect the tool again to give it a new key; nothing was deleted.",
  }),
  // A cap write from the usage page or `drive cap` reached a Worker with no
  // account store behind it (drive#421). The cap was not changed, so the next
  // step is not to wait and retry: this deployment has to be wired first.
  "cap-store-missing": Object.freeze({
    what: "The cap could not be saved, so the one in force is unchanged.",
    next: "Ask whoever runs this deployment to set up the account store.",
  }),
  // A cap write that arrived from another origin (drive#421). A cap write
  // swaps an account's storage keys, so a page on another origin that could
  // forge the POST could revoke a real drive's keys: the write is refused
  // rather than attempted, and the next step is where the write is allowed.
  "cap-from-page": Object.freeze({
    what: "You can only change a spending cap from the drive page.",
    next: "Open drive on this account, then move the cap slider there.",
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
  // The endpoint needs a JSON object and got a form, an array or a bare value
  // instead. Every account route refuses it the same way, so the same failure
  // says the same thing whichever route the caller reached (drive#158): the
  // account routes in src/files.js, src/signin.js and src/branches.js all call
  // this one key rather than each carrying their own copy of the sentence.
  "json-object-needed": Object.freeze({
    what: "That request did not carry a JSON object.",
    next: "Send the body as a JSON object and try again.",
  }),
  // A starter request (drive issue #15) arrived carrying valid JSON but not
  // the one action this endpoint takes, so it named nothing this route can
  // do and nothing was written to the drive.
  "starter-create-action": Object.freeze({
    what: "That request did not ask to create the notes starter.",
    next: 'Send the body as a JSON object with action set to "create".',
  }),
  // A starter request used a method the route does not take (drive issue #15;
  // the gate-walk in test/account-gate.test.mjs probes the endpoint with GET
  // and POST only, and the handler answers any other method directly).
  "starter-method": Object.freeze({
    what: "The starter answers a GET or a POST only.",
    next: "POST to the starter with the create action.",
  }),
  // An upload arrived with no file name, so there is no storage key to write it
  // under and nothing was stored.
  "upload-needs-name": Object.freeze({
    what: "That upload did not name a file.",
    next: "Send the name of the file you are uploading.",
  }),
  // The api Worker (or the CLI's call to it) could not reach storage.
  "storage-down": Object.freeze({
    what: "We can't reach storage right now.",
    next: "Wait a few minutes and try again.",
  }),
  // This deployment has no drive storage behind it at all, so no file route
  // can answer. It is a fact about the deployment and not about the call, so
  // the next step is not "try again": someone has to point this deployment at
  // a drive before any file route works.
  "drive-not-configured": Object.freeze({
    what: "The drive is not configured on this deployment.",
    next: "Ask whoever runs this deployment to point it at a drive.",
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
  // A mint, or any signed-in call that needs a live account, arrived for an
  // account whose close has landed. Close revokes every key and token
  // (drive#497), so a new one must not be handed out, and the one next step is
  // to cancel the close while the account is still inside its 30-day window.
  "account-closed": Object.freeze({
    what: "This account is closed, so it cannot make a new key.",
    next: "Cancel the close while the account is still in its 30-day window to use it again.",
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
  // A public upload request has taken as many bytes as its own total allows
  // (drive issue #208). The stranger cannot raise the cap; the owner can.
  "upload-link-full": Object.freeze({
    what: "This link has taken all the files it can.",
    next: "Tell the person who shared this page and try again later.",
  }),
  // The owner-set per-link total on POST /api/request was not a whole number
  // of bytes in range, so nothing was minted (drive issue #208).
  "request-max-bytes": Object.freeze({
    what: "Set a whole number of bytes for this page's cap.",
    next: "Pick a whole number of at least 1.",
  }),
  // A cross-site request a page made on the visitor's behalf, refused by
  // request.referrer and Origin together; the same-origin rule in
  // src/email-send.js is the pattern this words.
  "cross-site": Object.freeze({
    what: "That request did not come from the drive.",
    next: "Open the drive's page and try again there.",
  }),
  // A branch with that name is still open (build step 7, drive#8). The copy
  // already exists, so the next step is a different name rather than losing
  // the work that is in it.
  "branch-exists": Object.freeze({
    what: "A branch with that name is still open.",
    next: "Choose another name, or discard the open branch first.",
  }),
  // The account already holds the most open branches this drive keeps at once
  // (drive#553, MAX_OPEN_BRANCHES in src/branches.js). A branch is a full
  // copy, so the cap bounds the bytes one account can hold; the next step is
  // to close one of the open ones rather than lose the work in it.
  "branch-limit": Object.freeze({
    what: "You have 10 open branches, which is the most this drive keeps at once.",
    next: "Approve or discard a branch, then make a new one.",
  }),
  // An upload-request drop named a file the owner already has. Overwriting
  // that file from a public link is the bug drive#518 closes.
  "upload-name-taken": Object.freeze({
    what: "A file with that name is already in this folder.",
    next: "Choose another name and drop the file again.",
  }),
  // The branch this call named does not exist on this drive.
  "branch-not-found": Object.freeze({
    what: "That branch is not in the list.",
    next: "Run drive branches to see the branches you have.",
  }),
  // A URL with more segments than /api/branches/<name>/<action>.
  "branch-path-unknown": Object.freeze({
    what: "That is not a branch path.",
    next: "Open the branch from the list.",
  }),
  // The file this call named is not in this account's drive, on the read,
  // preview, download and delete paths alike. The file may never have been
  // there, or it may be in the trash under Recently deleted, so the next step
  // is to look rather than to send the same call again.
  "file-not-found": Object.freeze({
    what: "That file is not here.",
    next: "Open the folder again to see what is in it.",
  }),
  // The storage key this path lives at is longer than the store can hold, so the
  // file cannot be written, parked or put back. `validatePath` counts
  // characters and a key is counted in bytes, and the trash name percent-encodes
  // every non-ASCII byte into three characters, so a long path that is not ASCII
  // becomes a key the storage refuses (drive issue #567). It is the file's own
  // name that has to change, not the drive.
  "path-too-long": Object.freeze({
    what: "That path is too long for this drive to store.",
    next: "Shorten the name or move the file to a shorter folder.",
  }),
  // The bytes at this path changed while a delete was moving them, so the
  // original was left alone rather than removed: the newer bytes are a save
  // that landed while the delete ran (drive issue #567). Nothing was lost, and
  // the delete is safe to ask for again.
  "delete-file-changed": Object.freeze({
    what: "That file changed while it was being deleted, so it was left alone.",
    next: "Try the delete again.",
  }),
  // The same refusal on the restore half: the copy in Recently deleted
  // changed under the restore, so it is still parked rather than removed, and
  // the copy that ran first is what the drive holds (drive issue #567).
  "restore-file-changed": Object.freeze({
    what: "That file in Recently deleted changed while it was being put back.",
    next: "Try the restore again.",
  }),
  // The branch was already approved or discarded, so there is nothing left to
  // apply or throw away.
  "branch-not-open": Object.freeze({
    what: "That branch is already closed.",
    next: "Branch the folder again to make a new one.",
  }),
  // The original changed after the branch was taken, so the approve stopped
  // rather than copy over somebody's edit.
  "branch-source-moved": Object.freeze({
    what: "The original changed after that branch was made, so nothing was copied back.",
    next: "Discard the branch and make it again from the folder as it is now.",
  }),
  // An agent's own rewind is past the drive's 30-day window, so the copy this
  // would undo and the old versions behind it are both gone (issue #13, "the
  // 30-day undo"). Nothing was changed: the original folder is as it is.
  "rewind-window-closed": Object.freeze({
    what: "That agent's work is more than 30 days old, so it can't be rewound.",
    next: "Make a new branch for the folder and the agent can work in it again.",
  }),
  // Sign-in exists as a route, but it is not fully open yet: the account
  // store lands with D1 (drive#2) and a deployment with no mailer refuses
  // rather than reporting a code sent, and no OAuth provider is wired to
  // secrets (Nish's). This is the closed door's words, not a fake success.
  "sign-in-closed": Object.freeze({
    what: "Signing in is not open yet.",
    next: "Join the waitlist, and your first email will carry a sign-in link.",
  }),
  // The sign-in link never left the site, so the person is waiting on an
  // inbox that will stay empty: a deployment with no mailer (no EMAIL binding,
  // or no sending domain in MAIL_FROM), a provider that refused the send, and
  // a mailer that threw all reach it. The one thing to do is try again, and
  // the waitlist is the door that stays open while we fix the setting
  // (drive#431: the closed door's words told a person nothing had been sent).
  "sign-in-email-failed": Object.freeze({
    what: "Your sign-in email did not go out.",
    next: "Try again in a moment, and join the waitlist if it keeps failing.",
  }),
  // The branch's snapshot is larger than one database row holds (drive#157).
  // A branch of a folder with tens of thousands of files needs a snapshot per
  // file, and the database refuses a row that big, so the copy was made and
  // then rolled back: nothing is left half-made, and the one thing to do is
  // branch a smaller folder until the snapshot moves out of the row (issue
  // #252). The size is real, measured on this repo's own migrations.
  "snapshot-bound": Object.freeze({
    what: "That folder has too many files for one branch.",
    next: "Branch a subfolder of it, and tell us the folder you wanted.",
  }),
  // Anything with no more specific entry: still says what happened and the one
  // thing to do, never the raw error. This is the page's client-side fallback
  // and the worker's last resort.
  unexpected: Object.freeze({
    what: "That did not work.",
    next: "Try again in a moment.",
  }),
  // Close account (drive#235): the person confirms by typing their email.
  "close-confirm-email": Object.freeze({
    what: "Closing your account needs you to type your email.",
    next: "Type the email on this account and try again.",
  }),
  "close-email-mismatch": Object.freeze({
    what: "That email does not match this account.",
    next: "Type the email on this account to confirm.",
  }),
  "close-not-closed": Object.freeze({
    what: "This account is not waiting to close.",
    next: "There is nothing to cancel.",
  }),
  "close-already-purged": Object.freeze({
    what: "The files from this account have already been deleted.",
    next: "The 30-day window has ended, so closing cannot be cancelled.",
  }),
  "close-method": Object.freeze({
    what: "Closing your account answers a POST only.",
    next: "POST to close your account.",
  }),
  "close-cancel-method": Object.freeze({
    what: "Cancelling a close answers a POST only.",
    next: "POST to cancel closing your account.",
  }),
  "close-no-email": Object.freeze({
    what: "This account has no email on file.",
    next: "Add an email to this account, then type it to confirm.",
  }),
  // The public savings calculator (drive issue #14): the size was missing,
  // not a number, negative, or past the quote ceiling, so nothing was billed
  // and the one thing to do is enter a size the quote can use.
  "quote-size": Object.freeze({
    what: "That size is not a storage amount we can quote.",
    next: "Enter how many TB or GB you store, as a number of 0 or more.",
  }),
  // A second sign-up tried to use a card already on an active account
  // (drive#464). Closed accounts do not hold the fingerprint.
  "card-in-use": Object.freeze({
    what: "That card is already on another account.",
    next: "Sign in to the account that uses it, or use a different card.",
  }),
  // A new account has not been charged yet, so storage stops at 1 TB
  // (drive#464). Downloads keep working. Support can lift the limit early.
  "pre-charge-storage-limit": Object.freeze({
    what: "New accounts can store 1 TB until the first payment goes through.",
    next: "Ask support if you need more storage before then.",
  }),
  // A top-up amount outside $10 to $1,000, or not a dollar amount at all
  // (drive#586). Nothing reached the payment page.
  "topup-amount": Object.freeze({
    what: "Top-ups start at $10 and go up to $1,000.",
    next: "Pick an amount from $10 to $1,000 and try again.",
  }),
  // The payment provider is not set up on this deployment yet, so no
  // checkout can open (drive#586, the Dodo key waits on Nish, #325).
  "topup-not-open": Object.freeze({
    what: "Adding money is not open yet, and nothing was charged.",
    next: "Try again later.",
  }),
  // The provider refused or did not answer the checkout request.
  "topup-failed": Object.freeze({
    what: "The payment page did not open, and nothing was charged.",
    next: "Try again in a minute.",
  }),
  // The prepaid balance is $0 or less, so uploads and new writes pause
  // (drive#586). Reads, downloads and restore keep working, and nothing is
  // deleted. The same words on the web, in the CLI and in an agent key error.
  "balance-empty": Object.freeze({
    what: "Your balance is $0, so uploads are paused while your files stay safe and downloads keep working.",
    next: TOP_UP_PROMPT,
  }),
  // Auto top-up charges the card saved by a top-up, so it cannot be turned on
  // before the first one (drive#586).
  "auto-topup-needs-card": Object.freeze({
    what: "Auto top-up uses the card from your first top-up, and there is none yet.",
    next: "Top up once, then turn auto top-up on.",
  }),
  // The same pause seen by a stranger on a public upload page: they cannot top
  // up someone else's drive, so they are told who can act.
  "upload-paused-balance": Object.freeze({
    what: "This drive is not taking uploads right now.",
    next: "Tell the person who shared this page and try again later.",
  }),
  // The billing portal (drive#575) for an account with no Dodo customer yet:
  // there is no card to update and no invoice to read, so the next step is the
  // first top-up, which is what creates the customer.
  "portal-no-card": Object.freeze({
    what: "This account has no card or payment on file yet.",
    next: "Top up once, then the billing portal will have your card.",
  }),
  // The payment provider is not set up on this deployment yet, so no
  // customer-portal session can be created (the Dodo key waits on Nish, #325).
  "portal-not-open": Object.freeze({
    what: "The billing portal is not open yet, and nothing was charged.",
    next: "Try again later.",
  }),
  // The provider refused or did not answer the customer-portal session
  // request, so no portal opened and no card was changed.
  "portal-failed": Object.freeze({
    what: "The billing portal did not open, and no card was changed.",
    next: "Try again in a minute.",
  }),
});

// The words a customer reads for one failure path: "what happened" then the
// one next step. An unknown key is a programmer error and throws here rather
// than silently returning a default, because a default would hide the missing
// entry the issue made required.
/**
 * @param {string} key
 * @returns {string}
 */
export function failureMessage(key) {
  const entry = Object.hasOwn(FAILURE_MESSAGES, key)
    ? FAILURE_MESSAGES[/** @type {keyof typeof FAILURE_MESSAGES} */ (key)]
    : undefined;
  if (!entry) {
    throw new Error(
      `no failure message for "${key}"; add it to FAILURE_MESSAGES in src/messages.js`,
    );
  }
  return `${entry.what} ${entry.next}`;
}
