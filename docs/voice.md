# Voice guide

How Storagebun talks, on every page, email and error. One voice, so it reads like one company.

## The rules

1. **Short sentences.** One idea each. If a sentence needs a comma and a second verb, make it two.
2. **Our words.** Say "your drive", "balance", "top up", "devices". Do not say "tenant", "provision", "credits" or "plan" (there are no plans).
3. **Say what happened, then what to do.** "That did not upload. Check your connection and try again." Never only "Something went wrong".
4. **Every error has a button.** A "Try again" or the one next step. A message with no way out is a defect.
5. **Money in plain numbers.** "$15 a TB at most", "2 cents per GB", "your balance never expires". Never a unit that needs a calculator, and never a promise a test does not pin (`core/pricing.js` owns the numbers).
6. **No rival names, no hype.** No "revolutionary", "seamless", "unlimited", "world-class". Say what it does and show the measured number.
7. **The tagline once.** "A Finder drive for people and their agents." belongs in the home hero and the footer, not in every page header.
8. **Say sorry only for our faults.** A mistyped address is not our fault: "That address does not look right." A failed save is: "We could not save that. Try again."
9. **Names for buttons are verbs.** "Add $10", "Send test", "Turn off". Not "Submit", "OK" or "Click here".
10. **Dates and sizes the way a person says them.** "6 Oct 2026", "212 GB". No ISO strings and no bytes on a page a person reads.

## Words to prefer

| Say | Not |
| --- | --- |
| your drive | your bucket, your volume |
| top up | fund, deposit, recharge |
| balance | credit, wallet |
| devices and agents | clients, principals |
| turn off | revoke, deprovision (the button), though "revoked" is fine in the log |
| sign in | log in, authenticate |
| it did not work | an error occurred, request failed |

## Checks

- `test/pricing-copy.test.mjs` and `test/membership-copy.test.mjs` pin the money sentences.
- `test/shell.test.mjs` keeps one header and one footer on every page.
- `test/error-copy.test.mjs` fails when an error block on a signed-in page has no next step or no Try again button, or when a failure sentence in a page script names no next step.
- When you write new words, read them aloud once. If you would not say it to a person across a table, rewrite it.
