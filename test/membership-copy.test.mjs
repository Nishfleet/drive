// Copy and sign-up gates for drive issue #387, updated for drive#463: card at
// sign-up, no $1 credit text, no membership, "minimum" only in "no minimum",
// and no founding pricing, cap or spots count on a public surface (drive#586).

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { EMAIL_KINDS, renderEmail } from "../core/emails.js";
import { FAILURE_MESSAGES } from "../core/messages.js";
import { PRICE } from "../core/pricing.js";
import { FAQ } from "../src/docs.js";
import { hasSignupCard, refuseSignupWithoutCard, SIGNIN_COPY } from "../src/signin.js";
import { RIVAL_PRODUCT } from "./rival-terms.mjs";

const CREDIT_TEXT =
  /\$1\s+free|free\s+\$1|\$1\s+credit|free credit|no card needed|No card asked|No card to start/i;
// "minimum" is allowed only as "no minimum" (drive#463: "No minimum. No
// plans."). Any other use, such as a membership floor, fails.
const MINIMUM_IN_PRICING = /(?<!\bno )\bminimum\b/i;
const MEMBERSHIP = /\bmembership\b/i;
const FOUNDING_LEAK =
  /remaining[- ]spots|spots left|first 1,?000 paying|1,?000 (paying )?accounts|founding (cap|limit|spots)/i;

const publicDir = new URL("../public/", import.meta.url);
const pages = readdirSync(publicDir)
  .filter((name) => name.endsWith(".html") || name === "llms.txt")
  .map((name) => ({
    name,
    text: readFileSync(new URL(name, publicDir), "utf8"),
  }));

// The address every template footer names (drive#522), so the gates below
// read every sentence a customer can be sent.
const REPLY_TO = "support@drive.example";

// The month every date-bearing email fixture states (drive#559).
const MONTH_ISO = "2026-10-01T00:00:00.000Z";

/** @param {string} kind */
function dataFor(kind) {
  if (kind === "welcome") return { replyTo: REPLY_TO };
  if (kind === "cap-warning" || kind === "read-only") return { capUsd: 12, replyTo: REPLY_TO };
  if (kind === "payment-failed") return { amountUsd: 23.5, replyTo: REPLY_TO };
  if (kind === "monthly-receipt") {
    // drive#559: the receipt names the month it bills, so the data carries the
    // month's first instant.
    return {
      billUsd: 12,
      meteredUsd: 16,
      ceilingUsd: 12,
      capped: true,
      monthIso: MONTH_ISO,
      replyTo: REPLY_TO,
    };
  }
  if (kind === "account-closed" || kind === "account-close-reminder") {
    return { graceDays: 30, reminderDays: 25, purgeOn: "3 Nov (UTC)", replyTo: REPLY_TO };
  }
  if (kind === "files-deleted")
    return { purgedOn: "3 Nov (UTC)", graceDays: 30, replyTo: REPLY_TO };
  // drive#586: the prepaid emails, both auto top-up states, so the gates
  // read every sentence a customer can be sent.
  if (kind === "top-up-receipt")
    return { amountUsd: 25, balanceUsd: 31.5, auto: true, replyTo: REPLY_TO };
  if (kind === "low-balance") return { balanceUsd: 1.8, autoTopUpUsd: null, replyTo: REPLY_TO };
  if (kind === "device-approve-notice") {
    return {
      deviceName: "office laptop",
      requestedAt: "2026-10-05T12:00:00.000Z",
      replyTo: REPLY_TO,
    };
  }
  throw new Error(`no test data for ${kind}`);
}

// drive#466: the retired offer words fail on every shipped surface. "shipped"
// is the whole public dir (every page and llms.txt), every docs page including
// the changelog (vitepress builds all of docs-site/*.md), the README, the FAQ,
// get-started.html, the failure messages, the sign-up copy, PRICE, and every
// rendered email. The ban is on the words a
// customer reads, so source files that state the ban itself (this test, the
// pricing gate) are not scanned.
// "founding" joined the list when founding pricing was removed (drive#586):
// no shipped text may bring the offer back, in any case.
const OFFER_WORDS = [
  /\bmembership\b/i,
  /\bfree trial\b/i,
  /\b7 days free\b/i,
  /\bfirst month\b/i,
  /founding/i,
];
// drive#586: the balance is prepaid, so nothing is charged to a card after use.
// The retired "charge the card when the balance reaches $5" model must not
// come back in any wording: "charged when the balance reaches $5", "charge at
// $5", "bills under $5 roll into the next month".
const CHARGE_AT_THRESHOLD = [
  /\bcharged?\b[^.]{0,40}\b(when|once|at|after)\b[^.]{0,30}\$\d/i,
  /\bbalance (reaches|hits|gets to) \$\d/i,
  /\bunder \$\d+ roll/i,
];
const getStarted = readFileSync(new URL("../get-started.html", import.meta.url), "utf8");
const docsSiteDir = new URL("../docs-site/", import.meta.url);
const docsPages = readdirSync(docsSiteDir, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
  .map((entry) => ({
    name: `docs-site/${entry.name}`,
    text: readFileSync(new URL(entry.name, docsSiteDir), "utf8"),
  }));
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

function offerSurfaces() {
  return [
    ...pages.map((page) => [page.name, page.text]),
    ...docsPages.map((page) => [page.name, page.text]),
    ["README.md", readme],
    ["get-started.html", getStarted],
    ["FAILURE_MESSAGES", JSON.stringify(FAILURE_MESSAGES)],
    ["FAQ", FAQ.map((entry) => `${entry.question}\n${entry.answer}`).join("\n")],
    ["SIGNIN_COPY", JSON.stringify(SIGNIN_COPY)],
    ["PRICE", JSON.stringify(PRICE)],
    ...EMAIL_KINDS.flatMap((kind) => {
      const rendered = renderEmail(kind, dataFor(kind));
      return [
        [`${kind} subject`, rendered.subject],
        [`${kind} text`, rendered.text],
        [`${kind} html`, rendered.html],
      ];
    }),
  ];
}

test("no shipped page, doc or email carries the retired offer words", () => {
  for (const [name, text] of offerSurfaces()) {
    for (const stale of OFFER_WORDS) {
      assert.doesNotMatch(text, stale, `${name} carries ${stale}`);
    }
  }
});

test("the gate itself scans a surface that once carried the words", () => {
  // The guard proves it can fail: the changelog is a shipped doc, and a
  // surface that said the words must trip every phrase in OFFER_WORDS.
  for (const stale of OFFER_WORDS) {
    assert.match(
      "The membership returns: a free trial, 7 days free, the first month half price, Founding pricing.",
      stale,
    );
  }
  assert.ok(docsPages.some((page) => page.name === "docs-site/changelog.md"));
});

test("no shipped page, doc, FAQ or email charges a card at a balance threshold", () => {
  for (const [name, text] of offerSurfaces()) {
    for (const stale of CHARGE_AT_THRESHOLD) {
      assert.doesNotMatch(text, stale, `${name} carries the retired charge-at-$5 wording`);
    }
  }
});

test("the charge-at-$5 gate trips on the retired wording and passes the prepaid copy", () => {
  // The gate proves it can fail, on the exact sentence the FAQ used to carry.
  const retired = [
    "Bills under $5 roll into the next month; the card is charged when the balance reaches $5.",
    "We charge at $5.",
    "Your card is charged once you owe $5.",
  ];
  for (const sentence of retired) {
    assert.ok(
      CHARGE_AT_THRESHOLD.some((pattern) => pattern.test(sentence)),
      `the gate must catch "${sentence}"`,
    );
  }
  for (const sentence of [PRICE.headline, PRICE.needCard, PRICE.noPlansLine, PRICE.rule]) {
    for (const pattern of CHARGE_AT_THRESHOLD) {
      assert.doesNotMatch(sentence, pattern);
    }
  }
});

test("sign-up without a card is refused, in plain words", () => {
  assert.equal(hasSignupCard(undefined), false);
  assert.equal(hasSignupCard(false), false);
  assert.equal(hasSignupCard(""), false);
  assert.equal(hasSignupCard(true), true);
  assert.equal(hasSignupCard("on"), true);
  const refused = refuseSignupWithoutCard(undefined);
  assert.equal(refused, SIGNIN_COPY.needCard);
  assert.match(SIGNIN_COPY.needCard, /card/);
  assert.match(SIGNIN_COPY.needCard, /no free tier/);
  assert.equal(refuseSignupWithoutCard(true), null);
});

test("pricing copy has no membership, and says minimum only as no minimum", () => {
  assert.equal(PRICE.noPlansLine, "No plans. Your balance never expires.");
  assert.equal("membershipLine" in PRICE, false);
  assert.equal("freeLine" in PRICE, false);
  for (const line of [PRICE.headline, PRICE.rule, PRICE.needCard]) {
    assert.doesNotMatch(line, MINIMUM_IN_PRICING);
    assert.doesNotMatch(line, MEMBERSHIP);
  }
  // The guard itself: it lets "no minimum" through and stops everything else.
  assert.doesNotMatch("No plans. Your balance never expires.", MINIMUM_IN_PRICING);
  assert.match("a $10 minimum", MINIMUM_IN_PRICING);
});

test("site, FAQ, emails, build-spec and README carry no $1 credit text", () => {
  const spec = readFileSync(new URL("../docs/build-spec.md", import.meta.url), "utf8");
  const docsPricing = readFileSync(new URL("../docs-site/pricing.md", import.meta.url), "utf8");
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const surfaces = [
    ...pages.map((page) => [page.name, page.text]),
    ["docs/build-spec.md", spec],
    ["docs-site/pricing.md", docsPricing],
    ["README.md", readme],
    ["FAQ", FAQ.map((entry) => entry.answer).join("\n")],
    ["SIGNIN_COPY", JSON.stringify(SIGNIN_COPY)],
    ["PRICE", JSON.stringify(PRICE)],
    ...EMAIL_KINDS.flatMap((kind) => {
      const rendered = renderEmail(kind, dataFor(kind));
      return [
        [`${kind} subject`, rendered.subject],
        [`${kind} text`, rendered.text],
        [`${kind} html`, rendered.html],
      ];
    }),
  ];
  for (const [name, text] of surfaces) {
    assert.doesNotMatch(text, CREDIT_TEXT, `${name} still carries $1 credit text`);
  }
});

// drive#419: the README is a public surface, so its plan sentence is the
// pricing page's sentence. These two assertions are what stop it drifting back
// to the old "$1 free every month, no card needed" plan (#352, #387).
test("the README states the headline and the card at sign-up", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.ok(readme.includes(PRICE.headline), "README is missing the headline");
  assert.ok(readme.includes(PRICE.noPlansLine), "README is missing the no-minimum line");
  assert.doesNotMatch(readme, MEMBERSHIP, "README still names a membership");
  assert.ok(readme.includes(PRICE.needCard), "README is missing the card-at-sign-up line");
  assert.doesNotMatch(readme, CREDIT_TEXT, "README still carries $1 credit text");
  assert.doesNotMatch(readme, MINIMUM_IN_PRICING, "README says minimum");
});

test("the public site never contains the founding cap or a spots count", () => {
  for (const page of pages) {
    assert.doesNotMatch(page.text, FOUNDING_LEAK, page.name);
    assert.equal(page.text.includes("1,000"), false, `${page.name} leaked 1,000`);
  }
  assert.ok(pages.some((page) => page.text.includes(PRICE.noPlansLine)));
});

test("the public site never names a rival or quotes a rival's price", () => {
  const rival = RIVAL_PRODUCT;
  for (const page of pages) {
    assert.doesNotMatch(page.text, rival, page.name);
  }
  assert.doesNotMatch(FAQ.map((entry) => entry.answer).join("\n"), rival, "FAQ");
  const docsPricing = readFileSync(new URL("../docs-site/pricing.md", import.meta.url), "utf8");
  assert.doesNotMatch(docsPricing, rival);
});

test("pricing copy on the public pages never says minimum", () => {
  for (const page of pages) {
    if (page.name === "files.html" || page.name === "usage.html") continue;
    assert.doesNotMatch(page.text, MINIMUM_IN_PRICING, page.name);
    assert.doesNotMatch(page.text, MEMBERSHIP, page.name);
  }
  const docsPricing = readFileSync(new URL("../docs-site/pricing.md", import.meta.url), "utf8");
  assert.doesNotMatch(docsPricing, MINIMUM_IN_PRICING);
});
