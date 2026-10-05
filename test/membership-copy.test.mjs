// Copy and sign-up gates for drive issue #387, updated for drive#463: card at
// sign-up, no $1 credit text, no membership, "minimum" only in "no minimum",
// and no founding cap or spots count on a public surface.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { FAQ } from "../src/docs.js";
import { EMAIL_KINDS, renderEmail } from "../src/emails.js";
import { PRICE } from "../src/pricing.js";
import { hasSignupCard, refuseSignupWithoutCard, SIGNIN_COPY } from "../src/signin.js";

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

/** @param {string} kind */
function dataFor(kind) {
  if (kind === "welcome") return {};
  if (kind === "cap-warning" || kind === "read-only") return { capUsd: 12 };
  if (kind === "payment-failed") return { amountUsd: 23.5 };
  if (kind === "monthly-receipt") {
    return {
      billUsd: 12,
      addedUsd: 12,
      balanceUsd: 12,
      meteredUsd: 16,
      ceilingUsd: 12,
      capped: true,
    };
  }
  if (kind === "charge-receipt") return { chargedUsd: 5 };
  if (kind === "card-failure-warning") return { daysLeft: 30, amountUsd: 5 };
  if (kind === "account-closed" || kind === "account-close-reminder") {
    return { graceDays: 30, reminderDays: 25, purgeOn: "3 Nov" };
  }
  throw new Error(`no test data for ${kind}`);
}

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
  assert.equal(PRICE.noMinimumLine, "No minimum. No plans.");
  assert.equal("membershipLine" in PRICE, false);
  assert.equal("freeLine" in PRICE, false);
  for (const line of [PRICE.headline, PRICE.foundingLine, PRICE.rule, PRICE.needCard]) {
    assert.doesNotMatch(line, MINIMUM_IN_PRICING);
    assert.doesNotMatch(line, MEMBERSHIP);
  }
  // The guard itself: it lets "no minimum" through and stops everything else.
  assert.doesNotMatch("No minimum. No plans.", MINIMUM_IN_PRICING);
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
  assert.ok(readme.includes(PRICE.noMinimumLine), "README is missing the no-minimum line");
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
  assert.ok(pages.some((page) => page.text.includes(PRICE.foundingLine)));
  assert.ok(pages.some((page) => page.text.includes(PRICE.noMinimumLine)));
});

test("the public site never names a rival or quotes a rival's price", () => {
  const rival = /\bSpace\b/;
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
