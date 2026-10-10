// The public share landing page (drive#883). A share link (/s/<token>) used
// to serve the raw bytes and nothing else, so the one page a stranger lands
// on had no way to report it (drive#523 part 2). The landing page is that
// report path: our own minimal HTML, generated here, carrying the file's
// preview or its download and a prefilled report mail to the support mailbox.
//
// One route still answers, three ways, so nothing that works today changes:
//
//   - A browser navigating to /s/<token> (GET, Accept asks for text/html, no
//     flag) gets this page. The page itself reads no bytes; it checks the
//     link and the live object the way the byte path's HEAD answer does, so
//     a revoked, expired, deleted or replaced link shows the same plain
//     refusal it always did, and a page view counts no download.
//   - ?embed=1 — the page's own <img>, <video> and <audio> source, and any
//     other subresource load: the bytes, with exactly the headers the direct
//     link served before (src/share.js handleShareFileRequest: the served
//     type is the file's kind, nosniff, a sandboxed document, no-referrer).
//   - ?open=1, and every request that does not ask for text/html (curl, a
//     download manager, the CLI): the bytes, exactly the old direct-open
//     behaviour — inline when the kind previews, an attachment otherwise.
//
// Every /s/ visit passes the one share-download edge limiter, so a stranger
// with the link pays the same per-IP budget for a page view as for a byte
// read, and a page can never be a way around the limit.
//
// The page carries no script at all: its Content-Security-Policy refuses one
// (script-src 'none'), so the markup is the whole behaviour. The file's name
// is attacker-controlled text from the share row, so every place it shows is
// escapeHtml()'d (core/escape-html.js); every other word on the page is code
// or a constant from core/legal.js.

import { escapeHtml } from "../core/escape-html.js";
import { fileKind, previewDisposition, scopeStore } from "../core/files.js";
import { LEGAL_PAGES, REPORT_PATH, SUPPORT_EMAIL } from "../core/legal.js";
import { failureMessage } from "../core/messages.js";
import { clientIpKey, enforceEdgeLimits } from "../core/rate-limit.js";
import {
  expiresAtIso,
  handleShareFileRequest,
  linkIsOpen,
  plain,
  SHARE_LINK_PREFIX,
  serverFailure,
  shareContentChanged,
  validateToken,
} from "./share.js";

/** The query flag that reads the bytes as the page's own media source. */
const EMBED_FLAG = "embed";

/** The query flag that reads the bytes the way the direct link always did. */
const OPEN_FLAG = "open";

/**
 * Handles every GET on /s/<token>: the landing page for a browser that asks
 * for a document, and the bytes — unchanged, through handleShareFileRequest —
 * for everything else (HEAD, the embed and open flags, any client that does
 * not ask for text/html). The method rules stay the byte path's, so a POST
 * still gets its 405 and a HEAD still gets its headers-only answer.
 * @param {Request} request
 * @param {import("../core/files.js").FileStore} files a FileStore
 * @param {import("./share.js").LinkStore} links
 * @param {{now?: number, ipLimiter?: {limit(options: {key: string}): Promise<{success: boolean}>}, recordDownload?: (accountId: string, bytes: number) => Promise<void>}} [options]
 *   the same options the byte route passes; `recordDownload` stays on the byte
 *   path, since a page view serves no bytes to bill (drive#883)
 * @returns {Promise<Response>}
 */
export async function handleShareLinkVisit(request, files, links, options = {}) {
  const url = new URL(request.url);
  if (wantsLanding(request, url)) {
    return shareLanding(request, url, files, links, options);
  }
  return handleShareFileRequest(request, files, links, options);
}

/**
 * Whether this request is a browser navigation that should see the landing
 * page: a GET with no flag, whose Accept header asks for a document. A load
 * from <img>, <video>, curl or a download manager never sends text/html, so
 * it keeps reaching the bytes.
 * @param {Request} request
 * @param {URL} url
 */
function wantsLanding(request, url) {
  if (request.method !== "GET") {
    return false;
  }
  if (url.searchParams.has(EMBED_FLAG) || url.searchParams.has(OPEN_FLAG)) {
    return false;
  }
  return (request.headers.get("accept") ?? "").includes("text/html");
}

/**
 * The landing page itself: the same link checks the byte path makes, then our
 * page instead of the bytes. The two storage answers the byte path's HEAD
 * makes — no object, or one whose etag no longer matches the pin — refuse the
 * page the same way they refuse the bytes, so a dead link never shows a
 * working-looking page.
 * @param {Request} request
 * @param {URL} url
 * @param {import("../core/files.js").FileStore} files a FileStore
 * @param {import("./share.js").LinkStore} links
 * @param {{now?: number, ipLimiter?: {limit(options: {key: string}): Promise<{success: boolean}>}}} options
 * @returns {Promise<Response>}
 */
async function shareLanding(request, url, files, links, options) {
  const now = options.now ?? Date.now();
  const limited = await enforceEdgeLimits(
    [
      {
        binding: options.ipLimiter,
        key: clientIpKey(request, "share-download"),
        name: "SHARE_DOWNLOAD_RATE_LIMITER",
      },
    ],
    "share-download",
  );
  if (limited) {
    return limited;
  }
  const token = url.pathname.slice(SHARE_LINK_PREFIX.length + 1);
  const checked = validateToken(token);
  if (checked.error) {
    return plain(failureMessage("link-not-found"), 404);
  }
  const record = await links.shares.get(checked.token);
  if (record === null || !linkIsOpen(record, now)) {
    return plain(failureMessage("link-not-found"), 404);
  }
  // The one scoping place, the same as the byte path: the share row names the
  // owner, so the row is what the read is scoped to.
  const scoped = scopeStore(files, { id: record.accountId, name: "" });
  let stat;
  try {
    stat = await scoped.stat(record.path);
  } catch (cause) {
    return serverFailure(`reading a shared file: ${String(cause)}`);
  }
  if (!stat) {
    return plain(failureMessage("link-not-found"), 404);
  }
  if (shareContentChanged(record.etag, stat.etag)) {
    return plain(failureMessage("share-changed"), 409);
  }
  return new Response(shareLandingHtml({ record, stat, url }), {
    status: 200,
    headers: landingHeaders(),
  });
}

/**
 * The landing page's own headers. They mirror the site's static-page set
 * (public/_headers) with two hardenings this page's job asks for: no script
 * may ever run here (script-src 'none'), and the answer is noindex twice over
 * (the header and the meta), because a share link is a capability, not a
 * place for a search result to point at. no-referrer keeps the token out of
 * the next page's request when the visitor follows the mail or a footer link.
 * @returns {Record<string, string>}
 */
function landingHeaders() {
  return {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy":
      "default-src 'self'; script-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self'; media-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": "private, no-store",
    "x-robots-tag": "noindex",
  };
}

/**
 * The page markup. The file's kind decides the middle of the page, with the
 * same allowlist the preview path enforces (core/files.js): a picture, a
 * video and a sound embed from ?embed=1; a PDF and plain text open from
 * ?open=1, which is the direct link's own answer, tab-native as before; and
 * every other kind — including an .svg, which can act as a document
 * (drive#657) — gets the download link, because the page never draws a
 * stranger's bytes as a document on our origin.
 *
 * @param {{record: import("./share.js").ShareRecord, stat: {contentType?: string|null}, url: URL}} input
 * @returns {string}
 */
function shareLandingHtml({ record, stat, url }) {
  const name = escapeHtml(record.name);
  const kind = fileKind(record.name, stat.contentType ?? "");
  const inline = previewDisposition(record.name, stat.contentType ?? "") === "inline";
  const embedHref = `?${EMBED_FLAG}=1`;
  const openHref = `?${OPEN_FLAG}=1`;
  let middle;
  if (inline && kind === "image") {
    middle = `<img src="${embedHref}" alt="Shared picture: ${name}">`;
  } else if (inline && kind === "video") {
    middle = `<video controls playsinline src="${embedHref}"></video>`;
  } else if (inline && kind === "audio") {
    middle = `<audio controls src="${embedHref}"></audio>`;
  } else if (inline && kind === "pdf") {
    middle = `<p><a href="${openHref}">Open the PDF</a></p>`;
  } else if (inline && kind === "text") {
    middle = `<p><a href="${openHref}">Open the text file</a></p>`;
  } else {
    middle = `<p>This kind of file has no preview.</p>
      <p><a href="${openHref}">Download ${name}</a></p>`;
  }
  // The link a report names is the clean share URL, without whatever flag the
  // visitor's own address bar may carry.
  const shareUrl = new URL(`${SHARE_LINK_PREFIX}/${record.token}`, url.origin).toString();
  const reportHref = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent("Report a shared link")}&body=${encodeURIComponent(`Reporting this shared link:\n${shareUrl}\n\nWhat is wrong with it?`)}`;
  const footerLinks = LEGAL_PAGES.map((page) => `<a href="${page.path}">${page.label}</a>`).join(
    "\n      ",
  );
  const expiry = linkExpiryLine(record);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>Storagebun — shared file</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
body { margin: 0; min-height: 100dvh; display: grid; place-items: center; background: #faf6ee; color: #21201c; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { max-width: 44rem; padding: 2rem 1.25rem; }
.brand { color: #56514a; font-weight: 700; letter-spacing: 0.02em; margin: 0; }
h1 { font-size: 1.4rem; margin: 0.4rem 0 1rem; }
.file-name { color: #56514a; overflow-wrap: anywhere; }
img, video { max-width: 100%; height: auto; }
a { color: #1f3a5f; }
.expiry { color: #6f6a5f; }
footer { margin-top: 2.5rem; padding-top: 1rem; border-top: 1px solid #ddd5c5; display: flex; flex-wrap: wrap; gap: 0.4rem 1rem; font-size: 0.85rem; }
</style>
</head>
<body>
<main>
<p class="brand">Storagebun</p>
<h1>A file was shared with you</h1>
<p class="file-name">${name}</p>
${middle}
${expiry}
<p><a href="${reportHref}" rel="nofollow">Report this link</a> to support, or read the <a href="${REPORT_PATH}">report policy</a>.</p>
<footer><nav aria-label="Footer">
      ${footerLinks}
</nav></footer>
</main>
</body>
</html>`;
}

/**
 * The one expiry line, only when the link carries an expiry to name.
 * @param {import("./share.js").ShareRecord} record
 * @returns {string}
 */
function linkExpiryLine(record) {
  if (typeof record.expiresAt !== "number" || !Number.isFinite(record.expiresAt)) {
    return "";
  }
  return `<p class="expiry">This link expires ${escapeHtml(expiresAtIso(record.expiresAt))}.</p>`;
}
