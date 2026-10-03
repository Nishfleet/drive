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
const BEACON_SRC = "https://static.cloudflareinsights.com/beacon.min.js";

// Any beacon tag already in a page, however it is wrapped or quoted: the
// dashboard snippet a person may have pasted by hand, and this module's own
// output from an earlier build. A page that already carries one has it removed
// before the new tag goes in, so a re-build with a different token replaces the
// old token instead of sending the site's page views to a token nobody reads
// any more.
const EXISTING_BEACON =
  /[ \t]*<script\b[^>]*\bsrc=["']https:\/\/static\.cloudflareinsights\.com\/beacon\.min\.js["'][^>]*>\s*<\/script>\r?\n?/g;

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
 * and buys no measurement.
 * @param {string | undefined} setting the raw setting value
 * @returns {string} the token to render, or "" when the setting is not set
 */
export function beaconToken(setting) {
  const value = (setting === undefined ? "" : setting).trim();
  if (value === "") return "";
  if (!TOKEN_SHAPE.test(value)) {
    throw new Error(
      `${BEACON_TOKEN_SETTING} is not a Cloudflare Web Analytics beacon token: expected 32 hex characters, got ${value.length} characters. Set it to the token in the Cloudflare dashboard's beacon snippet (Web Analytics -> your site), or unset it to ship the pages with no beacon at all.`,
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
  if (token === "") return "";
  return `<script defer src="${BEACON_SRC}" data-cf-beacon='{"token": "${token}"}'></script>\n`;
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
  const head = html.indexOf("</head>");
  if (head === -1) {
    throw new Error("the page has no </head>, so there is nowhere to put the Web Analytics beacon");
  }
  const withoutOld = html.replace(EXISTING_BEACON, "");
  const close = withoutOld.indexOf("</head>");
  return `${withoutOld.slice(0, close)}${tag}${withoutOld.slice(close)}`;
}
