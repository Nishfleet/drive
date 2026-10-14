export const SIGN_IN_COMMAND = "drive login";
export const INSTALL_COMMAND = "drive init";
export const TOP_UP_PROMPT = "Top up to keep adding files.";
export const MAX_OPEN_BRANCHES = 10;

export const FAILURE_MESSAGES = Object.freeze({
  offline: Object.freeze({
    what: "You look offline.",
    next: "Check your connection and try again.",
  }),
  "cap-reached": Object.freeze({
    what: "Your drive is read-only because it reached its spending cap; nothing was deleted.",
    next: "Raise the cap on the usage page to start writing again.",
  }),
  "key-revoked": Object.freeze({
    what: "This device's key was revoked, so it can't reach the drive.",
    next: `Run ${SIGN_IN_COMMAND} to get a new key; your files are untouched.`,
  }),
  "agent-cap-reached": Object.freeze({
    what: "This agent reached its own limit, so it can read the drive but not change it.",
    next: "Connect the tool again to give it a new key; nothing was deleted.",
  }),
  "key-count-cap": Object.freeze({
    what: "This account already holds its limit of 20 active keys.",
    next: "Revoke a key you no longer use, or let an hourly key expire, then mint again.",
  }),
  "cap-store-missing": Object.freeze({
    what: "The cap could not be saved, so the one in force is unchanged.",
    next: "Ask whoever runs this deployment to set up the account store.",
  }),
  "cap-from-page": Object.freeze({
    what: "You can only change a spending cap from the drive page.",
    next: "Open drive on this account, then move the cap slider there.",
  }),
  "disk-cache-full": Object.freeze({
    what: "The local cache is full, so new saves can't upload.",
    next: "Free up disk space on this device and try the save again.",
  }),
  "rate-limited": Object.freeze({
    what: "Too many sign-ups from your connection right now.",
    next: "Wait a minute and try again.",
  }),
  "body-too-large": Object.freeze({
    what: "That request was too large to accept.",
    next: "Send a smaller request and try again.",
  }),
  "json-object-needed": Object.freeze({
    what: "That request did not carry a JSON object.",
    next: "Send the body as a JSON object and try again.",
  }),
  "starter-create-action": Object.freeze({
    what: "That request did not ask to create the notes starter.",
    next: 'Send the body as a JSON object with action set to "create".',
  }),
  "starter-method": Object.freeze({
    what: "The starter answers a GET or a POST only.",
    next: "POST to the starter with the create action.",
  }),
  "upload-needs-name": Object.freeze({
    what: "That upload did not name a file.",
    next: "Send the name of the file you are uploading.",
  }),
  "storage-down": Object.freeze({
    what: "We can't reach storage right now.",
    next: "Wait a few minutes and try again.",
  }),
  "drive-not-configured": Object.freeze({
    what: "The drive is not configured on this deployment.",
    next: "Ask whoever runs this deployment to point it at a drive.",
  }),
  "payment-failed": Object.freeze({
    what: "Your last payment didn't go through, so billing is paused.",
    next: "Use the link in the payment email to update your card.",
  }),
  unauthorized: Object.freeze({
    what: "You are not signed in to your drive.",
    next: "Sign in, then this page updates on its own.",
  }),
  "account-closed": Object.freeze({
    what: "This account is closed, so it cannot make a new key.",
    next: "Cancel the close while the account is still in its 30-day window to use it again.",
  }),
  "cap-account-closed": Object.freeze({
    what: "This account is closed, so its spending cap cannot change.",
    next: "Cancel the close while the account is still in its 30-day window to use it again.",
  }),
  "link-not-found": Object.freeze({
    what: "That link does not open anything.",
    next: "Ask the person who sent it for a new one.",
  }),
  "upload-paused-at-cap": Object.freeze({
    what: "This drive has reached its spending cap, so it is not taking uploads right now.",
    next: "Tell the person who shared this page and try again later.",
  }),
  "upload-link-full": Object.freeze({
    what: "This link has taken all the files it can.",
    next: "Tell the person who shared this page and try again later.",
  }),
  "request-max-bytes": Object.freeze({
    what: "Set a whole number of bytes for this page's cap.",
    next: "Pick a whole number of at least 1.",
  }),
  "too-many-links": Object.freeze({
    what: "You have as many open links as one account can keep.",
    next: "Revoke a link you no longer need, then make this one.",
  }),
  "download-link-cap": Object.freeze({
    what: "This link has handed out as much of the file as it can.",
    next: "Ask the person who shared it for a new link.",
  }),
  "share-changed": Object.freeze({
    what: "This file has changed since the link was made.",
    next: "Ask the person who sent it for a new one.",
  }),
  "malware-refused": Object.freeze({
    what: "That file did not pass the safety check.",
    next: "Try a different file.",
  }),
  "upload-name-too-long": Object.freeze({
    what: "That file name is too long for this drive.",
    next: "Rename the file to 255 characters or fewer and drop it again.",
  }),
  "cross-site": Object.freeze({
    what: "That request did not come from the drive.",
    next: "Open the drive's page and try again there.",
  }),
  "branch-exists": Object.freeze({
    what: "A branch with that name is still open.",
    next: "Choose another name, or discard the open branch first.",
  }),
  "branch-limit": Object.freeze({
    what: `You have ${MAX_OPEN_BRANCHES} branches.`,
    next: "Approve or discard one first.",
  }),
  "upload-name-taken": Object.freeze({
    what: "A file with that name is already in this folder.",
    next: "Choose another name and drop the file again.",
  }),
  "branch-not-found": Object.freeze({
    what: "That branch is not in the list.",
    next: "Run drive branches to see the branches you have.",
  }),
  "key-not-found": Object.freeze({
    what: "That key is not on this account.",
    next: "Reload the devices page and pick a key that is still listed.",
  }),
  "key-path-unknown": Object.freeze({
    what: "That is not a key path.",
    next: "Open the key from the list.",
  }),
  "branch-path-unknown": Object.freeze({
    what: "That is not a branch path.",
    next: "Open the branch from the list.",
  }),
  "file-not-found": Object.freeze({
    what: "That file is not here.",
    next: "Open the folder again to see what is in it.",
  }),
  "path-too-long": Object.freeze({
    what: "That path is too long for this drive to store.",
    next: "Shorten the name or move the file to a shorter folder.",
  }),
  "delete-file-changed": Object.freeze({
    what: "That file changed while it was being deleted, so it was left alone.",
    next: "Try the delete again.",
  }),
  "restore-file-changed": Object.freeze({
    what: "That file in Recently deleted changed while it was being put back.",
    next: "Try the restore again.",
  }),
  "branch-not-open": Object.freeze({
    what: "That branch is already closed.",
    next: "Branch the folder again to make a new one.",
  }),
  "branch-source-moved": Object.freeze({
    what: "The original changed after that branch was made, so nothing was copied back.",
    next: "Discard the branch and make it again from the folder as it is now.",
  }),
  "branch-too-large": Object.freeze({
    what: "That folder has too many files to branch.",
    next: "Branch a smaller folder, or split the files first.",
  }),
  "rewind-window-closed": Object.freeze({
    what: "That agent's work is more than 30 days old, so it can't be rewound.",
    next: "Make a new branch for the folder and the agent can work in it again.",
  }),
  "sign-in-closed": Object.freeze({
    what: "Signing in is not open yet.",
    next: "Join the waitlist, and your first email will carry a sign-in link.",
  }),
  "sign-in-email-failed": Object.freeze({
    what: "Your sign-in email did not go out.",
    next: "Try again in a moment, and join the waitlist if it keeps failing.",
  }),
  "snapshot-bound": Object.freeze({
    what: "That folder has too many files for one branch.",
    next: "Branch a subfolder of it, and tell us the folder you wanted.",
  }),
  unexpected: Object.freeze({
    what: "That did not work.",
    next: "Try again in a moment.",
  }),
  "cli-too-old": Object.freeze({
    what: "This drive is too old for the server it talks to.",
    next: "Run drive update to get the current version, then run the command again.",
  }),
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
  "quote-size": Object.freeze({
    what: "That size is not a storage amount we can quote.",
    next: "Enter how many TB or GB you store, as a number of 0 or more.",
  }),
  "card-in-use": Object.freeze({
    what: "That card is already on another account.",
    next: "Sign in to the account that uses it, or use a different card.",
  }),
  "pre-charge-storage-limit": Object.freeze({
    what: "New accounts can store 1 TB until the first payment goes through.",
    next: "Ask support if you need more storage before then.",
  }),
  "topup-amount": Object.freeze({
    what: "Top-ups start at $10 and go up to $1,000.",
    next: "Pick an amount from $10 to $1,000 and try again.",
  }),
  "topup-not-open": Object.freeze({
    what: "Adding money is not open yet, and nothing was charged.",
    next: "Try again later.",
  }),
  "topup-failed": Object.freeze({
    what: "The payment page did not open, and nothing was charged.",
    next: "Try again in a minute.",
  }),
  "balance-empty": Object.freeze({
    what: "Your balance is $0, so uploads are paused while your files stay safe and downloads keep working.",
    next: TOP_UP_PROMPT,
  }),
  "size30-unpaid": Object.freeze({
    what: "This upload would raise the biggest size your drive reached in the last 30 days, and your balance cannot cover one day at the new size.",
    next: TOP_UP_PROMPT,
  }),
  "auto-topup-needs-card": Object.freeze({
    what: "Auto top-up uses the card from your first top-up, and there is none yet.",
    next: "Top up once, then turn auto top-up on.",
  }),
  "upload-paused-balance": Object.freeze({
    what: "This drive is not taking uploads right now.",
    next: "Tell the person who shared this page and try again later.",
  }),
  "portal-no-card": Object.freeze({
    what: "This account has no card or payment on file yet.",
    next: "Top up once, then the billing portal will have your card.",
  }),
  "portal-not-open": Object.freeze({
    what: "The billing portal is not open yet, and nothing was charged.",
    next: "Try again later.",
  }),
  "portal-failed": Object.freeze({
    what: "The billing portal did not open, and no card was changed.",
    next: "Try again in a minute.",
  }),
  "fair-use-pause": Object.freeze({
    what: "Uploads are paused because young deletes still count.",
    next: "You can still open, download and delete files, and nothing was charged.",
  }),
});

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
      `no failure message for "${key}"; add it to FAILURE_MESSAGES in core/messages.js`,
    );
  }
  return `${entry.what} ${entry.next}`;
}
