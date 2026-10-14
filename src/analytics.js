export const BEACON_TOKEN_SETTING = "DRIVE_CF_BEACON_TOKEN";

export const BEACON_PAGES = Object.freeze([
  "index.html",
  "signin.html",
  "files.html",
  "usage.html",
  "upload.html",
  "get-started.html",
]);

const BEACON_SRC = "https://static.cloudflareinsights.com/beacon.min.js";

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
  const withoutOld = html.replace(EXISTING_BEACON, "");
  const close = withoutOld.indexOf("</head>");
  if (close === -1) {
    throw new Error("the page has no </head>, so there is nowhere to put the Web Analytics beacon");
  }
  return `${withoutOld.slice(0, close)}${tag}${withoutOld.slice(close)}`;
}
