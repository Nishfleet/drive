// The pending-close banner (drive issue #424). While an account is waiting to
// close, every signed-in page says so on screen: the date the files are
// deleted, and a Cancel link next to the sentence.
//
// Why a shared asset and not five inline scripts. The signed-in pages are
// static assets served straight from public/ (cloudflare.config.ts), so none of
// them can import a module. Each one used to carry its own inline script, and
// five copies of a banner is five things to forget on the next page: this test
// is the gate instead, and it fails CI when a signed-in page stops carrying the
// one shared script or when the shared script stops reading the endpoint's own
// words rather than carrying its own copy.
//
// What the gate proves, in order:
//   1. The banner's words are the module's (src/account-close.js), and the one
//      placeholder is the date the endpoint computes, so the page cannot show
//      a day count worked out in the browser.
//   2. Every signed-in page carries the banner element and loads the one
//      shared script — the list is walked the way test/seo.test.mjs walks the
//      site's pages, so a signed-in page added later fails here until it is in
//      the set.
//   3. The shared script is a real, served file: the copy in public/ is what
//      the pages load by that URL, so a rename that left a 404 fails.
//   4. The banner's date and cancel link are the endpoint's, rendered from one
//      payload, and the banner stays hidden for an account that is not closing.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import {
  CLOSE_CANCEL_ENDPOINT,
  CLOSE_COPY,
  CLOSE_ENDPOINT,
  CLOSE_GRACE_DAYS,
  closeAccount,
  handleCloseStatusRequest,
} from "../src/account-close.js";
import { createD1DeviceStore } from "../workers/api/src/devices.js";
import { makeMeteredDB } from "./d1-sqlite.mjs";

// The shared banner script, served from the asset layer next to the pages that
// load it. The pages reference it by this URL, so the file and the references
// cannot disagree.
const bannerScript = readFileSync(new URL("../public/close-banner.js", import.meta.url), "utf8");

const PUBLIC_DIR = new URL("../public/", import.meta.url);

/**
 * The pages a signed-in account is on, each with the file that carries it. The
 * Web Files page, the usage page, the notes starter and the first-run page are
 * the four surfaces that render the account's own data. The pricing page and
 * the sign-in page are not: they are what a stranger sees before there is an
 * account, and a close banner there would tell a signed-out reader about an
 * account it has. public/upload.html is the share-upload page, which sends
 * `credentials: "omit"` (its own script), so it is a link-holder's page and
 * never this account.
 * @type {Array<{name: string, url: URL}>}
 */
const SIGNED_IN_PAGES = [
  { name: "files.html", url: new URL("files.html", PUBLIC_DIR) },
  { name: "usage.html", url: new URL("usage.html", PUBLIC_DIR) },
  { name: "starter.html", url: new URL("starter.html", PUBLIC_DIR) },
  { name: "get-started.html", url: new URL("../get-started.html", import.meta.url) },
];

// The pages that are deliberately left out, named here so the exclusion is a
// decision on the record and not an omission: adding one of these to the banner
// set is a mistake this test would otherwise not catch.
const NOT_SIGNED_IN = ["index.html", "signin.html", "upload.html"];

test("the banner's words are the module's, and the date is the endpoint's", () => {
  // The one placeholder in the copy set. A page that rendered a day count, or
  // added the grace period to today's date in the browser, would show a
  // different day from the one the nightly cron actually purges on.
  assert.equal(
    CLOSE_COPY.pendingWhat,
    "This account closes on {purgeOn}. Your files stay visible until then.",
  );
  assert.equal(CLOSE_COPY.pendingCancel, "Cancel closing");
  for (const sentence of [CLOSE_COPY.pendingWhat, CLOSE_COPY.pendingCancel]) {
    assert.ok(sentence.length > 0, "every banner sentence is a real sentence");
  }
  // The placeholders the banner allows are exactly the date. A second one would
  // be a second value the page has to supply, and the page is the wrong place to
  // work one out.
  const placeholders = new Set(
    [...CLOSE_COPY.pendingWhat.matchAll(/\{(\w+)\}/g)].map((match) => match[1]),
  );
  assert.deepEqual([...placeholders], ["purgeOn"]);

  // Every key the banner added is one the banner actually renders, and the
  // script is the only consumer of them. A key nothing renders is a sentence
  // that will be edited in one place and stay stale in the other.
  const bannerKeys = Object.keys(CLOSE_COPY).filter((name) => name.startsWith("pending"));
  assert.deepEqual(bannerKeys.sort(), ["pendingCancel", "pendingWhat"]);
  for (const key of bannerKeys) {
    assert.ok(
      bannerScript.includes(`copy.${key}`),
      `public/close-banner.js must render CLOSE_COPY.${key}, or the key is dead copy`,
    );
  }
});

test("the GET endpoint answers a pending close with the date and the banner's words", async () => {
  const { db } = makeMeteredDB();
  const now = Date.parse("2026-10-04T12:00:00.000Z");
  const devices = createD1DeviceStore(db, { now: () => now });
  const account = { id: "acct_banner", email: "nish@example.com", name: "Nish" };
  // The real close, not a hand-written row: the date the endpoint reports is
  // the close the account really made plus the grace period, so the test would
  // catch a banner printing anything but the date the nightly cron reaches.
  const closed = await closeAccount({
    devices,
    email: {
      /** @param {unknown} _message @returns {Promise<{messageId: string}>} */
      send: (_message) => Promise.resolve({ messageId: "<banner@drive.example>" }),
    },
    mailFrom: "notifications@drive.example",
    account,
    typedEmail: "nish@example.com",
    now,
  });
  const closedAt = /** @type {number} */ (closed.closedAt);

  const response = await handleCloseStatusRequest(
    new Request(`https://drive.test${CLOSE_ENDPOINT}`),
    account,
    {
      devices,
      store: /** @type {never} */ (undefined),
      email: undefined,
      mailFrom: "",
      now: () => now,
    },
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.state, "closed");
  // The date is a real YYYY-MM-DD, and it is the close plus the grace period,
  // not a number of days the page adds itself.
  assert.match(payload.purgeOn, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(
    payload.purgeOn,
    new Date((closedAt + CLOSE_GRACE_DAYS * 86_400) * 1000).toISOString().slice(0, 10),
  );
  // The banner's words travel in the same payload as the date, so a page cannot
  // show the endpoint's date beside its own sentence.
  assert.equal(payload.copy.pendingWhat, CLOSE_COPY.pendingWhat);
  assert.equal(payload.copy.pendingCancel, CLOSE_COPY.pendingCancel);
  // The cancel link is the endpoint the page posts to, named by the same module
  // that routes it.
  assert.equal(CLOSE_CANCEL_ENDPOINT, "/api/account/close/cancel");
});

test("an account that is not closing carries no banner words to show", async () => {
  const { db } = makeMeteredDB();
  const now = Date.parse("2026-10-04T12:00:00.000Z");
  const devices = createD1DeviceStore(db, { now: () => now });
  const account = { id: "acct_active", email: "nish@example.com", name: "Nish" };
  const response = await handleCloseStatusRequest(
    new Request(`https://drive.test${CLOSE_ENDPOINT}`),
    account,
    {
      devices,
      store: /** @type {never} */ (undefined),
      email: undefined,
      mailFrom: "",
      now: () => now,
    },
  );
  const payload = await response.json();
  assert.equal(payload.state, "active");
  // No date, because there is nothing being deleted. The banner's whole subject
  // is a close that is in flight.
  assert.equal(payload.purgeOn, null);
});

test("the shared banner script reads the endpoint's words and shows the date and a cancel link", () => {
  // The one shared script: it reads the endpoint the module names, and it takes
  // every sentence and the date from the payload. These are the assertions that
  // keep a second copy of the copy out of the script.
  assert.ok(
    bannerScript.includes(`"${CLOSE_ENDPOINT}"`),
    "the script reads the endpoint the module names",
  );
  assert.ok(bannerScript.includes("purgeOn"), "the banner's date is the payload's purgeOn");
  // It renders the payload's copy rather than a sentence of its own: the two
  // strings the module pins are what it fills in.
  assert.ok(
    bannerScript.includes("pendingWhat") && bannerScript.includes("pendingCancel"),
    "the script renders the payload's pendingWhat and pendingCancel",
  );
  // The date is substituted into the payload's sentence, not concatenated onto
  // one the script wrote.
  assert.ok(
    bannerScript.includes("{purgeOn}"),
    "the script fills the module's own {purgeOn} placeholder",
  );
  // It reveals the banner only for a closing account, and it is the account
  // state that decides, so a signed-out read (401) or an active account shows
  // nothing.
  assert.ok(bannerScript.includes("state"), "the script reads the account state");
  assert.ok(bannerScript.includes("closed"), "the banner is for a closed account");
  // The banner is an alert region, so a screen reader reads the sentence and
  // the link as one interruption, and the date is in the text. The role is the
  // page's markup, so it is checked on the page, not here.
  for (const { name, url } of SIGNED_IN_PAGES) {
    const html = readFileSync(url, "utf8");
    const banner = html.slice(html.indexOf('id="close-banner"'));
    assert.match(banner, /role="status"/, `${name}'s banner is a live region`);
    assert.match(banner, /aria-live="polite"/, `${name}'s banner is a polite region`);
  }
  assert.ok(
    bannerScript.includes('"close-banner"') && bannerScript.includes("getElementById"),
    "the script finds the one element the page marks by its id",
  );
  // The two slots it fills are the two the pages carry, by the ids they use.
  for (const id of ["close-banner-what", "close-banner-cancel"]) {
    assert.ok(bannerScript.includes(id), `the script fills #${id}, the slot every page carries`);
  }
});

test("every signed-in page carries the banner element and loads the one shared script", () => {
  for (const { name, url } of SIGNED_IN_PAGES) {
    const html = readFileSync(url, "utf8");
    // The banner element, hidden until the endpoint says the account is
    // closing. A page that omits it cannot show the banner, however good the
    // script is.
    assert.match(html, /id="close-banner"/, `${name} must carry the close-banner element`);
    assert.match(html, /id="close-banner"[^>]*\bhidden\b/, `${name}'s banner starts hidden`);
    // The date and the cancel link have their own slots, so the script fills
    // them from the payload and the sentence stays the module's.
    assert.match(
      html,
      /id="close-banner-what"/,
      `${name} must have a slot for the banner sentence`,
    );
    assert.match(html, /id="close-banner-cancel"/, `${name} must have the cancel link`);
    // One shared script, loaded by the URL the asset layer serves.
    assert.match(
      html,
      /<script src="\/close-banner\.js" defer><\/script>/,
      `${name} must load the one shared banner script`,
    );
    // No second copy: a page that inlined its own banner script would be the
    // drift this shared asset exists to prevent.
    assert.doesNotMatch(
      html,
      /id="close-banner-what"[\s\S]*?function renderCloseBanner/,
      `${name} must not carry its own copy of the banner script`,
    );
  }
});

test("the pages that are not a signed-in account's carry no banner", () => {
  for (const name of NOT_SIGNED_IN) {
    const html = readFileSync(new URL(name, PUBLIC_DIR), "utf8");
    assert.doesNotMatch(
      html,
      /id="close-banner"/,
      `${name} is not a signed-in account's page and must not carry a close banner`,
    );
  }
});

test("the banner's markup is the same one on every signed-in page", () => {
  // The four elements and their order, read out of the pages, so a page that
  // renamed a slot or moved the link out of the alert cannot drift from the
  // others. The words are the endpoint's, so only the skeleton is pinned.
  /** @type {string[]} */
  let first = [];
  for (const { name, url } of SIGNED_IN_PAGES) {
    const html = readFileSync(url, "utf8");
    const banner = html.slice(html.indexOf('id="close-banner"'));
    const ids = [...banner.slice(0, banner.indexOf("</aside>")).matchAll(/id="([\w-]+)"/g)].map(
      (match) => match[1],
    );
    if (first.length === 0) {
      first = ids;
      assert.deepEqual(
        ids,
        ["close-banner", "close-banner-what", "close-banner-cancel"],
        "the banner is the alert, then the sentence, then the cancel link",
      );
    } else {
      assert.deepEqual(ids, first, `${name}'s banner must match the other signed-in pages`);
    }
  }
});

test("the shared script is one served file, and the public tree carries it", () => {
  // The pages load /close-banner.js. The asset layer serves public/ verbatim,
  // so the file has to be committed there under that name — a script that only
  // existed in a source directory would 404 on every signed-in page.
  assert.ok(
    readdirSync(PUBLIC_DIR).includes("close-banner.js"),
    "public/close-banner.js must be committed; the pages load it by that path",
  );
  // It is a plain script, not a module: a page loads it with `defer` and no
  // type, and a module would need a type="module" the pages do not carry.
  assert.doesNotMatch(
    bannerScript,
    /^\s*export\s/m,
    "the shared script is a classic script, not a module",
  );
  // No copy of the banner's own sentence lives in the script: it is the
  // payload's words. A literal sentence here would be the second source the
  // shared asset exists to remove.
  assert.doesNotMatch(
    bannerScript,
    /This account closes on/,
    "the script must not carry the banner sentence; the payload does",
  );
});
