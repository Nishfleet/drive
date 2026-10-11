// The Cloudflare Web Analytics beacon (drive issue #246).
//
// Web Analytics is switched on per site in the Cloudflare dashboard, and the
// dashboard mints the token the beacon carries. No API on this host can mint
// one (the token in ~/.config/cloudflare/deploy-ci.env is refused by
// /accounts/.../rum/site_info, 2026-10-02), so the switch lives where a token
// has to be set anyway: the build. The setting is the environment variable
// BEACON_TOKEN_SETTING, read by the `drive-web-analytics-beacon` plugin in
// vite.config.ts while it builds the site's assets.
//
// The page half and the token half are separate on purpose (Nish,
// 2026-10-03, on drive#246): the pages and this module ship switched off, and
// the page view half waits on the token Nish creates in the dashboard. So a
// build with the setting unset renders nothing at all on any page, which is
// the shape the site's own speed budget keeps it in (see below). With the
// setting set, the one deferred script is the only third-party resource the
// six pages load.
//
// Why this is a build step and not a request-time rewrite: everything that is
// not /api/* is served straight from the asset layer, so a person opening the
// pricing page pays no Worker invocation (cloudflare.config.ts). Rewriting the
// HTML per request to add an analytics script would spend a Worker invocation
// on the site's most-read page, so the one place the pages are already built is
// the one place the beacon goes in.
//
// The budget in lighthouserc.json moved with it: `third-party:count` went from
// 0 to 1 because the beacon is a third-party resource, and
// `third-party:transferSize` stays at 0 because the Lighthouse CI run collects
// against the static asset directory with no route to static.cloudflareinsights.com,
// so the request is recorded and transfers no bytes. test/web-analytics.test.mjs
// pins both numbers, so neither can be loosened without this test failing.

// The build-time setting that carries the beacon token. It is a variable, not a
// secret: the token is in the HTML of every page a visitor loads, so it is
// public by construction, and Cloudflare's own docs say so. An unset setting
// is the switched-off case and is not an error.
/**
 * The Cloudflare Web Analytics beacon (drive issue #246).
 *
 * switched off by design: Nish decided on 2026-10-03 to ship the code half now
 * and the token half later, so nothing renders until a build setting carries the
 * dashboard's token. The dashboard mints the token and no API this host can
 * reach can mint one, so the token and the real page-view proof are a separate
 * follow-up for Nish, and this module and the plugin in vite.config.ts are the
 * whole of the change.
 *
 * The module holds the parts a page must not get wrong: the token's shape, the
 * tag, where in a document the tag goes, and how a page that already carries a
 * beacon is handled. The plugin in vite.config.ts holds only which pages and
 * which build, so the six pages in BEACON_PAGES can move without touching a
 * build hook.
 */

// The build-time setting that carries the beacon token. It is a variable, not a
// secret: the token is in the HTML of every page a visitor loads, so it is
// public by construction, and Cloudflare's own docs say so. An unset setting
// is the switched-off case and is not an error.
export const BEACON_TOKEN_SETTING = "DRIVE_CF_BEACON_TOKEN";

// The pages the beacon is rendered into, as the file names the build emits: the
// five public/ assets and the one Vite entry at the repo root (get-started.html,
// drive#70). These are the six pages drive#246 names. public/starter.html is
// deliberately not among them (the issue names six) and public/og-card.html is
// the share card's source, a canvas nobody navigates to rather than a page.
// test/web-analytics.test.mjs pins this list against the tree, so a page that
// moves or is added cannot silently lose its beacon.
export const BEACON_PAGES = Object.freeze([
  "index.html",
  "signin.html",
  "files.html",
  "usage.html",
  "upload.html",
  "get-started.html",
]);

// Cloudflare's own beacon script, and the attribute the token travels in. The
// tag is Cloudflare's documented snippet verbatim apart from its line wrapping:
// `defer` so it costs no layout and no main-thread parse before the page's own
// work, and the single-quoted data attribute so the JSON inside it needs no
// HTML entity escaping.
// Cloudflare's beacon snippet, as the dashboard writes it. One string, so the
// tag, the strip and the reader are three uses of one URL.
const BEACON_SRC = "https://static.cloudflareinsights.com/beacon.min.js";

// Two patterns over that one URL, deliberately:
//
// * EXISTING_BEACON (the strip) takes a whole script element, from `<script`
//   through a tolerant `</script>` and the line under it, and it also takes an
//   opening tag that carries other attributes in any order, because the
//   dashboard snippet can be pasted by hand in any order.
// * ANY_BEACON (the reader) is the whole script element under the same host and
//   nothing more, so it counts the beacon a page carries however the opening tag
//   is arranged.
//
// test/web-analytics.test.mjs pins both against the same four shapes, so the
// agreement between them is a test rather than a hope that they stay in step.
const EXISTING_BEACON =
  /[ \t]*<script\b[^>]*\bsrc=["'][^"']*static\.cloudflareinsights\.com\/[^"']*["'][^>]*\s*>\s*<\/script\s*>\r?\n?/g;
const ANY_BEACON = /<script\b[^>]*static\.cloudflareinsights\.com\/[^>]*\s*>\s*<\/script\s*>/g;

/**
 * Every Cloudflare beacon tag a document carries, whichever way it is quoted or
 * wrapped, counting the whole element so a reader counts what a browser loads.
 * One definition, used by the build's self-check below and by
 * test/web-analytics.test.mjs, so the two cannot disagree about what a beacon is.
 * @param {string} html
 * @returns {string[]}
 */
export function beaconTagsIn(html) {
  return html.match(ANY_BEACON) ?? [];
}

/**
 * A page that carries exactly one beacon tag, or an error naming the page. This
 * is the build's own gate on the pages it just wrote out: a page that ends up
 * with two beacons (a strip that missed an old one) or with none fails the build
 * instead of shipping a page that measures nothing, or measures twice.
 *
 * It runs on the token-set path, where the beacon is meant to be there. The
 * switched-off path ships the pages untouched and carries no beacon at all, and
 * the check above (not this one) is what would fail a build that tried to render
 * a token it was not given.
 * @param {string} html the built page's HTML
 * @param {string} page the page's file name, for the error message
 * @returns {string} the same HTML
 */
export function assertSingleBeacon(html, page) {
  const count = beaconTagsIn(html).length;
  if (count !== 1) {
    throw new Error(
      `${page} carries ${count} Cloudflare Web Analytics beacon tags after the build, want exactly 1. Fix the page or ${BEACON_TOKEN_SETTING} and build again.`,
    );
  }
  return html;
}

// The shape of the token the dashboard shows: 32 hex characters. A setting that
// is set to anything else fails the build rather than shipping a beacon that
// reports nowhere, which is the failure this whole switch exists to avoid.
const TOKEN_SHAPE = /^[0-9a-f]{32}$/i;

/**
 * The beacon token a build setting carries, as the token to render, or "" when
 * the setting is unset or blank. A blank setting is the switched-off case, not a
 * mis-set one: an empty variable in a CI job means "not configured here", and a
 * token of whitespace renders nothing for the same reason.
 *
 * A value that is present but not the dashboard's 32-hex token is an error, and
 * the build fails on it: a beacon with a wrong token still loads the third-party
 * script on every page view and reports nothing, which spends the budget below
 * and buys no measurement. The message quotes the first characters to look for
 * (a truncated paste, an editor's smart quotes, a URL instead of the token), not
 * only the length, because the number alone does not say which of those it was.
 * @param {string | undefined} setting the raw setting value
 * @returns {string} the token to render, or "" when the setting is not set
 */
export function beaconToken(setting) {
  const value = (setting === undefined ? "" : setting).trim();
  if (value === "") return "";
  if (!TOKEN_SHAPE.test(value)) {
    throw new Error(
      `${BEACON_TOKEN_SETTING} is not a Cloudflare Web Analytics beacon token: expected 32 hex characters, got ${value.length} starting ${JSON.stringify(value.slice(0, 8))}. Set it to the token in the Cloudflare dashboard's beacon snippet (Web Analytics -> your site), or unset it to ship the pages with no beacon at all.`,
    );
  }
  return value;
}

/**
 * The beacon tag for a token, or "" when there is no token. One line, so a
 * second build of the same page has one line to replace.
 * @param {string} token a token from beaconToken(), or "" for no beacon
 * @returns {string}
 */
export function beaconTag(token) {
  // The shape check is here rather than in the caller's promise, so a token this
  // module did not validate cannot become a tag: the tag interpolates straight
  // into a JSON attribute, and a token holding a quote would break out of it.
  const shape = beaconToken(token);
  if (shape === "") return "";
  return `<script defer src="${BEACON_SRC}" data-cf-beacon='{"token": "${shape}"}'></script>\n`;
}

/**
 * A page's HTML with the beacon in its head: the tag immediately before
 * `</head>`, which is where Cloudflare's own instructions say it goes, and where
 * a deferred script belongs so it is discovered before the body is parsed.
 *
 * A page with no `</head>` is an error rather than a page with the beacon
 * appended: a build that quietly shipped the analytics script somewhere else, or
 * nowhere, is how a site ends up measuring nothing while the dashboard looks
 * configured.
 * @param {string} html the page's HTML
 * @param {string} token a token from beaconToken(), or "" for no beacon
 * @returns {string} the HTML to ship
 */
export function withBeacon(html, token) {
  const tag = beaconTag(token);
  if (tag === "") return html;
  // The old beacon comes out first, and the head is found in what is left, so the
  // insertion point cannot move under the strip and a page whose stripped
  // section ate the head fails the check below instead of being spliced shut.
  const withoutOld = html.replace(EXISTING_BEACON, "");
  const close = withoutOld.indexOf("</head>");
  if (close === -1) {
    throw new Error("the page has no </head>, so there is nowhere to put the Web Analytics beacon");
  }
  return `${withoutOld.slice(0, close)}${tag}${withoutOld.slice(close)}`;
}
