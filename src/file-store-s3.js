// The S3 FileStore adapter. Extracted from src/files.js (drive issue
// #617) with no behaviour change; src/files.js re-exports createS3Store,
// so no importer moved.

import { AwsClient } from "aws4fetch";
import { contentMd5 } from "../workers/api/src/s3.js";
import { FETCH_TIMEOUT_MS, fetchWithTimeoutAndRetry } from "./fetch-retry.js";
import { ChangedUnderUsError } from "./file-store.js";
import { escapeXmlText, parseListObjects } from "./file-store-xml.js";
import {
  computeHiddenAt,
  decodeEntities,
  nextContinuationToken,
  nextVersionMarkers,
  parseListVersions,
  tagValue,
  versionMarkers,
} from "./s3-listing.js";

/** @typedef {import("./file-store.js").StorageVersion} StorageVersion */
/** @typedef {import("./file-store.js").FileStore} FileStore */

/**
 * An ETag as S3 spells it in a header. A listing answers one in quotes and
 * `parseListObjects` strips them so two stores' values compare in one form, so
 * they are put back before an `If-Match` header is signed: a quote-free ETag
 * in a conditional header is not the entity tag the vendor asked for.
 * @param {string} etag
 * @returns {string}
 */
function quotedEntityTag(etag) {
  return etag.startsWith('"') ? etag : `"${etag}"`;
}
/**
 * The storage the issue names: plain S3 over HTTP, pointed at `rclone serve s3`
 * on the build host and at a real vendor's endpoint (iDrive e2, eu-west-3)
 * when `credentials` and `region` are given. The four S3 calls the page needs
 * are the four store methods; signing is `aws4fetch` (`AwsClient`), the same
 * stock signer the api Worker signs its bucket calls with, so a real account
 * speaks through the same FileStore interface as the stand-in. The keys are
 * exactly the paths the store is given — the account prefix is applied by
 * scopeStore, which is the one place it is applied.
 *
 * `bucket` is one shared namespace (the local stand-in, and tests that pin a
 * name). `bucketFor` picks a bucket from the storage key, which is how the
 * live Files page and share links follow drive#371: each account's objects
 * live in `drv-<id>`, the same name the key provider mints.
 *
 * Without a credential the requests are unsigned, which is what the local
 * stand-in answers; with one every request is signed, because a real endpoint
 * answers an unsigned call with a redirect to its website, not with a listing.
 * @param {{endpoint: string, bucket?: string, bucketFor?: (key: string) => string,
 *   fetchImpl?: typeof fetch, region?: string, timeoutMs?: number,
 *   credentials?: {accessKeyId: string, secretAccessKey: string, sessionToken?: string}}} config
 *   `timeoutMs` is the per-call deadline every storage request runs under
 *   (src/fetch-retry.js); the default is the module's FETCH_TIMEOUT_MS, and
 *   a test passes a small one to prove the abort in milliseconds.
 * @returns {FileStore}
 */
export function createS3Store(config) {
  const { endpoint, bucket, bucketFor, region, credentials, fetchImpl = fetch } = config;
  // One ceiling for every storage call this store makes: a stalled socket
  // answers named instead of holding a customer's page open forever
  // (drive#570). Configurable because a test proves the abort in milliseconds.
  const timeoutMs =
    typeof config.timeoutMs === "number" && config.timeoutMs > 0
      ? config.timeoutMs
      : FETCH_TIMEOUT_MS;
  if (!endpoint || (!bucket && typeof bucketFor !== "function")) {
    throw new Error("createS3Store needs an endpoint and a bucket.");
  }
  // One signer for the store, so every method below signs the same way and a
  // half-signed store is not a shape this can be in. A credential without a
  // region cannot be signed (the region is in the signature's scope), so that
  // pair is refused here rather than answering with a SignatureDoesNotMatch
  // the caller has to decode.
  if (Boolean(credentials) !== Boolean(region)) {
    throw new Error("createS3Store needs both a region and a credential, or neither.");
  }
  const aws = credentials
    ? new AwsClient({
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
        sessionToken: credentials.sessionToken,
        region,
        service: "s3",
        // No retry inside the signer, the same setting the api Worker's client
        // uses (workers/api/src/s3.js): a retry that succeeds after a real
        // refusal hides the refusal, and every caller above has its own named
        // failure for a non-ok answer.
        retries: 0,
      })
    : null;
  /** @param {string} path */
  const bucketOf = (path) =>
    typeof bucketFor === "function" ? bucketFor(path) : /** @type {string} */ (bucket);
  /** @param {string} path */
  const baseFor = (path) => `${String(endpoint).replace(/\/$/, "")}/${bucketOf(path)}`;
  /** @param {string} path */
  const urlFor = (path) => `${baseFor(path)}/${path.split("/").map(encodeURIComponent).join("/")}`;
  /**
   * The one request path every method below uses, so a store is either fully
   * signed or fully unsigned. A write body is sent as it is: aws4fetch signs
   * S3 with `X-Amz-Content-Sha256: UNSIGNED-PAYLOAD` (it sets that header
   * itself), so a stream is never read into isolate memory to hash it
   * (drive#539). Fetch-retry already skips the 5xx retry on a stream, because
   * the first attempt spends it. Signing is `aws.sign` then `fetchImpl`, the
   * same path `createS3Client` uses, so a test can still inject fetch and a
   * credentialed store never bypasses it through `aws.fetch`. Every caller
   * below passes a string URL. The send carries the store's one timeout and
   * one retry (src/fetch-retry.js): a stalled socket answers named after 15 s,
   * and a 5xx on a replayable body gets exactly one retried call. The signing
   * is inside the retry's per-attempt send, because a second attempt must sign
   * again - the first attempt's signed Request has a body stream already
   * consumed and its own x-amz-date, and replaying it is a SignatureDoesNotMatch,
   * not a retry.
   *
   * @type {(input: string | URL | Request, init?: RequestInit) => Promise<Response>}
   */
  const request =
    aws === null
      ? (input, init = {}) =>
          fetchWithTimeoutAndRetry(fetchImpl, input, init, {
            timeoutMs,
            label: "storage request",
          })
      : async (input, init = {}) => {
          const opts = /** @type {any} */ ({ ...init });
          if (opts.body === null) {
            delete opts.body;
          }
          const url =
            typeof input === "string"
              ? input
              : input instanceof URL
                ? input.href
                : typeof Request !== "undefined" && input instanceof Request
                  ? input.url
                  : String(input);
          return fetchWithTimeoutAndRetry(
            /** @type {typeof fetch} */ (
              /** @param {string} u @param {RequestInit} [i] */
              async (u, i) => fetchImpl(await aws.sign(u, i ?? {}))
            ),
            url,
            opts,
            { timeoutMs, label: "storage request" },
          );
        };

  return {
    /** @param {string} path */
    async list(path) {
      // `path` is a storage key (`u/<id>`, `u/<id>/Photos`); the query wants
      // exactly one trailing slash and no second one.
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const entries = [];
      let token = null;
      let seen = null;
      // Every page, not the first. S3 caps one ListObjectsV2 answer at 1,000
      // keys and answers the rest through NextContinuationToken, so a single
      // call silently truncates a folder at 1,000 files: the Files page showed
      // the first thousand and the file index (issue #18) never indexed the
      // rest, which the stand-in proof caught on a 100,000-file drive (5,000 a
      // folder -> 20,000 of 100,000 indexed). The token is looped here, once,
      // so no caller has to remember to.
      for (;;) {
        const query =
          `?list-type=2&prefix=${encodeURIComponent(prefix)}&delimiter=%2F` +
          (token === null ? "" : `&continuation-token=${encodeURIComponent(token)}`);
        const response = await request(`${baseFor(prefix)}${query}`);
        if (response.status === 404) {
          // A bucket that is not there yet is an empty drive, not a failure
          // (drive#540): a brand-new account's `drv-<id>` is created at its
          // sign-in verify (provisionAccountBucket), and an account from before
          // that existed — or on a deployment whose site Worker carries no
          // storage master credential — has no bucket until a key mint creates
          // one. S3 answers a missing bucket 404 and a missing folder 200 with
          // no keys, so a 404 here is always the bucket.
          return [];
        }
        if (!response.ok) {
          throw new Error(`storage list failed with ${response.status}`);
        }
        const xml = await response.text();
        // The base a row's key is built from: the folder key without its
        // trailing slash, so a child key is `${base}/${name}`.
        entries.push(...parseListObjects(xml, prefix, prefix.slice(0, -1)));
        token = nextContinuationToken(xml);
        if (token === null) {
          return entries;
        }
        if (token === seen) {
          // A server answering the same token forever would spin here and hold
          // the request open. A truncated folder is the one failure this file
          // exists to prevent, so it is named instead of returned.
          throw new Error(
            `storage list repeated continuation-token "${token}" for ${prefix}; the folder is not fully listed`,
          );
        }
        seen = token;
      }
    },
    async listPage(path, options = {}) {
      // ONE ListObjectsV2 call per page: `max-keys` caps the answer at what
      // the page asked for, and `continuation-token` is the store's cursor
      // passed through opaque (drive#570). The full walk `list` does is the
      // wrong tool for the Files page: a 2,500-file folder would cost three
      // storage calls and every key in the folder to show the first 200 rows.
      const limit = Math.min(Math.max(1, Math.trunc(options.limit ?? 200)), 1_000);
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const query =
        `?list-type=2&prefix=${encodeURIComponent(prefix)}&delimiter=%2F` +
        `&max-keys=${limit}` +
        (options.cursor ? `&continuation-token=${encodeURIComponent(options.cursor)}` : "");
      const response = await request(`${baseFor(prefix)}${query}`);
      if (response.status === 404) {
        // The missing bucket is an empty page, not a 500 (drive#540); the
        // long form is in `list` above.
        return { entries: [], nextCursor: null };
      }
      if (!response.ok) {
        throw new Error(`storage list failed with ${response.status}`);
      }
      const xml = await response.text();
      return {
        entries: parseListObjects(xml, prefix, prefix.slice(0, -1)),
        nextCursor: nextContinuationToken(xml),
      };
    },
    async listAll(path) {
      // The recursive walk: no delimiter, so every key under the prefix comes
      // back and the pages are looped here. This is the listing the Recently
      // deleted view reads now that a deleted file nests under
      // `.trash/<path>/<ts>` (drive#570) — `list`'s one-folder-deep answer
      // cannot see a nested key.
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const entries = [];
      let token = null;
      let seen = null;
      for (;;) {
        const query =
          `?list-type=2&prefix=${encodeURIComponent(prefix)}` +
          (token === null ? "" : `&continuation-token=${encodeURIComponent(token)}`);
        const response = await request(`${baseFor(prefix)}${query}`);
        if (response.status === 404) {
          // The missing bucket is an empty walk, not a 500 (drive#540); the
          // long form is in `list` above.
          return [];
        }
        if (!response.ok) {
          throw new Error(`storage list failed with ${response.status}`);
        }
        const xml = await response.text();
        entries.push(...parseListObjects(xml, prefix, prefix.slice(0, -1), { deep: true }));
        token = nextContinuationToken(xml);
        if (token === null) {
          return entries;
        }
        if (token === seen) {
          throw new Error(
            `storage list repeated continuation-token "${token}" for ${prefix}; the folder is not fully listed`,
          );
        }
        seen = token;
      }
    },
    async stat(path) {
      // A HEAD, not a GET: the preview's HEAD answer needs the object's
      // headers and none of its bytes (drive#570). rclone serve s3 and the
      // providers behind it both answer HEAD the same way.
      const response = await request(urlFor(path), { method: "HEAD" });
      if (response.status === 404) {
        return null;
      }
      if (!response.ok) {
        throw new Error(`storage stat failed with ${response.status}`);
      }
      return {
        contentType: response.headers.get("content-type") || "application/octet-stream",
        size: Number(response.headers.get("content-length") || 0),
        etag: response.headers.get("etag"),
      };
    },
    async read(path, options = {}) {
      // The client's Range and If-None-Match forwarded as the client sent
      // them: a seek reads its slice from storage (206), a still-valid etag
      // is refused by storage itself (304), and neither pulls the whole
      // object through this Worker just to drop most of it (drive#570).
      const headers = {};
      if (options.range) {
        headers.range = options.range;
      }
      if (options.ifNoneMatch) {
        headers["if-none-match"] = options.ifNoneMatch;
      }
      const response = await request(
        urlFor(path),
        Object.keys(headers).length > 0 ? { headers } : {},
      );
      const status = response.status;
      if (status === 404) {
        return null;
      }
      if (![200, 206, 304, 416].includes(status)) {
        throw new Error(`storage read failed with ${status}`);
      }
      const contentRange =
        status === 206 ? (response.headers.get("content-range") ?? undefined) : undefined;
      // On a 206 the Content-Length is the slice's length; the object's whole
      // size rides in `bytes s-e/total`, and `size` stays the whole size so a
      // caller can tell a slice from a short file without a second call.
      const rangeTotal = contentRange ? Number(contentRange.split("/")[1]) : Number.NaN;
      const contentLength = Number(response.headers.get("content-length") || 0);
      return {
        status,
        body:
          status === 304 || status === 416 ? null : /** @type {ReadableStream} */ (response.body),
        contentType: response.headers.get("content-type") || "application/octet-stream",
        size: Number.isFinite(rangeTotal) ? rangeTotal : contentLength,
        etag: response.headers.get("etag"),
        ...(contentRange ? { contentRange } : {}),
        ...(status !== 200 ? { contentLength } : {}),
      };
    },
    async write(path, body, contentType, options = {}) {
      /** @type {Record<string, string>} */
      const headers = { "content-type": contentType };
      if (typeof options.contentLength === "number" && Number.isFinite(options.contentLength)) {
        // The caller knows the size (the owner upload carries the browser's
        // Content-Length), so the body is sent as the stream it is and the
        // header rides along: the bytes are never read into isolate memory
        // (drive#539).
        headers["content-length"] = String(options.contentLength);
      } else if (aws !== null && body instanceof ReadableStream) {
        // A signed S3 PUT cannot carry a stream with no declared size: an
        // UNSIGNED-PAYLOAD upload with no aws-chunked framing has no length to
        // send, and an endpoint answers 411 Length Required (the MinIO stand-in
        // does, measured 2026-10-05). Buffering it here would put an unbounded
        // body into isolate memory, the exact failure drive#539 exists to
        // remove, so a caller that cannot declare a size is refused with a
        // clear error. The owner upload reads a length-less body under its own
        // ceiling and always passes a length.
        throw new TypeError("a signed stream write needs a contentLength");
      }
      const response = await request(urlFor(path), {
        method: "PUT",
        headers,
        body,
      });
      if (!response.ok) {
        throw new Error(`storage write failed with ${response.status}`);
      }
    },
    async writeIfAbsent(path, body, contentType) {
      // The stock S3 create-only request: one PUT carrying If-None-Match: *,
      // which a compliant endpoint refuses with 412 Precondition Failed when
      // the key is already there. What THIS endpoint can honestly offer is
      // narrower than the contract's words, and it is measured, not assumed:
      //
      //   - `rclone serve s3` (v1.75.1, the stand-in on the build host)
      //     answered 200 to both the absent and the already-present PUT on
      //     2026-10-05 — it ignores If-None-Match on a PUT — so a `true`
      //     from that server is not a proof of create-only;
      //   - iDrive e2, the primary vendor, was never asked: its keys are
      //     Nish's alone, and the standing direction is to build without
      //     them. Its answer to the header is unverified.
      //
      // The header still rides every call, so on any endpoint that enforces
      // the conditional the race closes at the storage itself; where one does
      // not, this degrades to the overwrite `write` always was, and the
      // provider's hide-not-delete versioning stays the backstop that makes
      // an overwrite recoverable. A caller on such an endpoint pairs a
      // pre-check `stat` (the stranger-upload route does) so an ordinary
      // duplicate is still refused there; only a true mid-race pair is left to
      // this endpoint's own answer. A 412 is the only answer that proves the
      // key was already there, so it is the only false.
      const response = await request(urlFor(path), {
        method: "PUT",
        headers: { "content-type": contentType, "if-none-match": "*" },
        body,
      });
      if (response.status === 412) {
        return false;
      }
      if (!response.ok) {
        throw new Error(`storage write failed with ${response.status}`);
      }
      return true;
    },
    async remove(path, { ifMatch } = {}) {
      // A conditional remove is the guard a delete needs. The ETag is what the
      // bytes were when the delete listed them, and a key whose bytes changed
      // since (a mount save that landed while the trash copy ran, drive issue
      // #567) is answered 412 rather than removed.
      const headers = {};
      if (typeof ifMatch === "string" && ifMatch !== "") {
        headers["if-match"] = quotedEntityTag(ifMatch);
      }
      const response = await request(urlFor(path), { method: "DELETE", headers });
      if (response.status === 412) {
        throw new ChangedUnderUsError(path);
      }
      if (!response.ok && response.status !== 404) {
        throw new Error(`storage delete failed with ${response.status}`);
      }
    },
    async listKeys(path, options = {}) {
      // Flat: no delimiter, so hidden folders (`u/<id>/.trash`) come back
      // like any other key, which is what the purge needs. `start-after` is
      // S3's own resume parameter: the provider applies it before paging, so
      // it rides only the first request of the loop and the continuation
      // token walks the rest in the same order.
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const { startAfter, limit } = options;
      const keys = [];
      let token = null;
      let seen = null;
      for (;;) {
        const query =
          `?list-type=2&prefix=${encodeURIComponent(prefix)}` +
          (token === null && startAfter !== undefined
            ? `&start-after=${encodeURIComponent(startAfter)}`
            : "") +
          (limit === undefined ? "" : `&max-keys=${limit}`) +
          (token === null ? "" : `&continuation-token=${encodeURIComponent(token)}`);
        const response = await request(`${baseFor(prefix)}${query}`);
        if (!response.ok) {
          throw new Error(`storage list failed with ${response.status}`);
        }
        const xml = await response.text();
        for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
          const key = decodeEntities(tagValue(match[1], "Key"));
          if (key !== "") {
            keys.push(key);
          }
        }
        if (limit !== undefined && keys.length >= limit) {
          return keys.slice(0, limit);
        }
        token = nextContinuationToken(xml);
        if (token === null) {
          return keys;
        }
        if (token === seen) {
          // The same repeat guard the folder listing below carries: a server
          // answering the same token forever would hold the cron open.
          throw new Error(
            `storage list repeated continuation-token "${token}" for ${prefix}; the listing is not fully read`,
          );
        }
        seen = token;
      }
    },
    /**
     * One DeleteObjects call for up to 1,000 keys — S3's own per-call
     * ceiling, and the whole point for the nightly purge (drive#565): a
     * 100,000-file account is 100 calls instead of 100,000, ten times under
     * the run's subrequest budget instead of ten times over. The answer is
     * checked per key, because DeleteObjects answers 200 with an <Error>
     * block for every key the provider refused.
     * @param {string[]} paths
     */
    async removeBatch(paths) {
      if (paths.length > REMOVE_BATCH_LIMIT) {
        throw new Error(
          `removeBatch takes at most ${REMOVE_BATCH_LIMIT} keys, got ${paths.length}`,
        );
      }
      if (paths.length === 0) {
        return;
      }
      // DeleteObjects is one bucket's call: a batch that named two buckets
      // would silently miss the second's keys, so the mix is refused.
      const firstBucket = bucketOf(paths[0]);
      for (const path of paths) {
        if (bucketOf(path) !== firstBucket) {
          throw new Error("removeBatch takes keys from one bucket");
        }
      }
      const body =
        "<Delete>" +
        paths.map((path) => `<Object><Key>${escapeXmlText(path)}</Key></Object>`).join("") +
        "</Delete>";
      // S3 refuses a Delete body without a Content-MD5, the same refusal the
      // lifecycle PUT answers, so the checksum goes with it (contentMd5, the
      // one MD5 the repo already carries).
      const response = await request(`${baseFor(paths[0])}/?delete`, {
        method: "POST",
        headers: { "content-type": "application/xml", "content-md5": await contentMd5(body) },
        body,
      });
      if (!response.ok) {
        throw new Error(`storage batch delete failed with ${response.status}`);
      }
      const xml = await response.text();
      for (const match of xml.matchAll(/<Error>([\s\S]*?)<\/Error>/g)) {
        const key = decodeEntities(tagValue(match[1], "Key"));
        const code = tagValue(match[1], "Code");
        throw new Error(`storage batch delete refused "${key}" with ${code || "an error"}`);
      }
    },
    /**
     * The copy `drive branch` makes (build step 7). A file at or under S3's
     * single-copy ceiling is one CopyObject; a larger file is a multipart copy,
     * because CopyObject copies at most 5 GiB per call and a bigger source is
     * the refusal S3 answers instead of the copy. `size` is the byte length
     * the caller's listing already carried, so the copy S3 needs for those
     * bytes is chosen without a second request per file.
     * @param {string} from
     * @param {string} to
     * @param {number} [size]
     */
    async copy(from, to, size) {
      const source = `/${bucketOf(from)}/${from.split("/").map(encodeURIComponent).join("/")}`;
      if (typeof size === "number" && size > SINGLE_COPY_LIMIT) {
        await multipartCopy(request, urlFor, source, to, size);
        return;
      }
      // S3's CopyObject can answer 200 with an <Error> body for a refused copy
      // (a multi-part copy that is still running is the other 200), so the
      // answer is read and checked rather than trusted on its status alone:
      // `drive branch` must never report success for a copy S3 refused.
      // Proven against `rclone serve s3`, 2026-10-01.
      const response = await request(urlFor(to), {
        method: "PUT",
        headers: { "x-amz-copy-source": source },
      });
      const body = await response.text();
      const code = tagValue(body, "Code");
      if (response.ok && code === "" && body.includes("<CopyObjectResult")) {
        return;
      }
      // A refusal that is the size limit is the one worth a second try: the
      // caller did not know the size (no listing carried it), so it asked S3
      // for a copy S3 will not make in one call. AWS answers that with
      // `InvalidRequest` naming the limit and B2 with `EntityTooLarge`; both
      // mean the multipart copy below is the copy that was asked for. Every
      // other refusal is reported as it is.
      const oversize =
        code === "EntityTooLarge" ||
        (code === "InvalidRequest" &&
          /larger than the maximum|too large/i.test(tagValue(body, "Message")));
      if (oversize) {
        await multipartCopy(request, urlFor, source, to, await sourceSize(request, urlFor, from));
        return;
      }
      if (!response.ok) {
        throw new Error(`storage copy failed with ${response.status}`);
      }
      if (code !== "") {
        throw new Error(`storage copy was refused: ${code}`);
      }
      throw new Error(
        "storage copy did not answer with a CopyObjectResult; the copy may still be running",
      );
    },
    /**
     * Every version of every file under one drive path, from S3's own
     * ListObjectVersions (the stock API for a versioned bucket: iDrive e2 and
     * B2 both speak it). The live ListObjectsV2 walk above cannot see a hidden
     * version, and a hidden version's stop time is what the meter bills to, so
     * the reconciler reads this instead.
     *
     * The provider's spelling of the lifecycle is this method's to know: S3
     * reports every version of a key newest first and marks it hidden at the
     * instant the next version of the same key began, which is exactly the
     * `created_at` -> `hidden_at` interval the meter bills. A delete marker is
     * the hide that ended the key's latest version. B2's ListFileVersions
     * returns the same facts under its own tags; the real provider's field
     * names are #60's to confirm (build-spec.md, open questions).
     * @param {string} path
     * @returns {Promise<import("./files.js").StorageVersion[]>}
     */
    async listVersions(path) {
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const versions = [];
      /** @type {Array<{path: string, at: number}>} */
      const markers = [];
      let keyMarker = null;
      let versionMarker = null;
      let seen = null;
      // Every page, the same reason `list` loops: S3 caps one ListObjectVersions
      // answer at 1,000 keys and answers the rest through the two markers, so a
      // single call would truncate a large account's history.
      for (;;) {
        const query =
          `?versions&prefix=${encodeURIComponent(prefix)}` +
          (keyMarker === null ? "" : `&key-marker=${encodeURIComponent(keyMarker)}`) +
          (versionMarker === null ? "" : `&version-id-marker=${encodeURIComponent(versionMarker)}`);
        const response = await request(`${baseFor(prefix)}${query}`);
        if (!response.ok) {
          throw new Error(`storage version list failed with ${response.status}`);
        }
        const xml = await response.text();
        // Rows and delete markers are collected from every page and the stops
        // are computed once, here, over the whole list: a version's stop is the
        // next version of its own key, and that pair can sit on two different
        // pages, so a per-page pass would bill an old version as still live
        // (drive issue #504). The markers are decoded with the rows, so a key
        // that pages on through an escaped character comes back the way the
        // account wrote it.
        versions.push(...parseListVersions(xml));
        markers.push(...versionMarkers(xml));
        const next = nextVersionMarkers(xml);
        keyMarker = next.keyMarker;
        versionMarker = next.versionMarker;
        if (keyMarker === "" || versionMarker === "") {
          return computeHiddenAt(versions, markers);
        }
        if (`${keyMarker}\u0000${versionMarker}` === seen) {
          throw new Error(
            `storage version list repeated markers for ${prefix}; the history is not fully listed`,
          );
        }
        seen = `${keyMarker}\u0000${versionMarker}`;
      }
    },
  };
}

/**
 * S3's single-copy ceiling. CopyObject copies at most 5 GiB per call (Amazon
 * S3, "Copying objects"; iDrive e2 and B2 publish the same limit), so a bigger
 * source is only copyable the multipart way: CreateMultipartUpload, one
 * UploadPartCopy per byte range, then CompleteMultipartUpload. In GiB, because
 * 5 GiB is the number S3 documents and every implementation measures against.
 */
const SINGLE_COPY_LIMIT = 5 * 1024 ** 3;
/** The most keys one DeleteObjects call may name: S3's own ceiling. */
const REMOVE_BATCH_LIMIT = 1000;
/** The byte range one UploadPartCopy copies. S3's floor for a copy part is
 * 5 MiB; 16 MiB puts a 10 GB branch file at 640 requests and a 6 GB one at 384,
 * which is a request count a stand-in and a real provider both answer quickly.
 */
const COPY_PART_SIZE = 16 * 1024 ** 2;
/** S3's cap on the parts in one multipart upload. A range narrower than
 * COPY_PART_SIZE for an object this large is only needed past 160 GiB, so the
 * cap is checked rather than assumed.
 */
const COPY_MAX_PARTS = 10000;

/**
 * One S3 multipart copy: CreateMultipartUpload, an UploadPartCopy for every
 * byte range of the source, then CompleteMultipartUpload with the ETag each
 * part answered. No bytes pass through here either — every call is the storage
 * copying inside itself, which is the whole point of a branch copy (build step
 * 7): a 10 GB branch must not be 10 GB through the Worker.
 *
 * Every answer is read, not trusted on its status: S3 answers 200 with an
 * `<Error>` body for a refused part and 200 with nothing at all for a part it
 * accepted but did not copy, and a copy reported as done without the object
 * behind it is the one failure a branch must never report as success.
 *
 * A failure after the upload started aborts it (`DELETE ?uploadId=`), because
 * parts of an unfinished multipart upload are still billed by every S3-shaped
 * provider, and a branch that failed must not leave a bill behind it.
 *
 * @param {(input: URL | RequestInfo, init?: RequestInit) => Promise<Response>} fetchImpl the store's one request path, signing when
 * the store holds a credential
 * @param {(path: string) => string} urlFor
 * @param {string} source the `x-amz-copy-source` header value, `/<bucket>/<key>`
 * @param {string} to the destination storage key
 * @param {number} size the source's byte length, from the listing or a HEAD
 * @returns {Promise<void>}
 */
async function multipartCopy(fetchImpl, urlFor, source, to, size) {
  const partSize = Math.max(COPY_PART_SIZE, Math.ceil(size / COPY_MAX_PARTS));
  const target = urlFor(to);
  const created = await fetchImpl(`${target}?uploads`, { method: "POST" });
  const createdBody = await created.text();
  if (!created.ok || createdBody.includes("<Error>")) {
    throw new Error(`storage multipart copy could not start: ${copyFailure(created, createdBody)}`);
  }
  const uploadId = tagValue(createdBody, "UploadId");
  if (uploadId === "") {
    throw new Error("storage multipart copy started without an upload id");
  }
  const upload = `uploadId=${encodeURIComponent(uploadId)}`;
  try {
    /** @type {string[]} one <Part> per range, in order, for the completion */
    const parts = [];
    for (let start = 0, number = 1; start < size; start += partSize, number += 1) {
      const end = Math.min(start + partSize, size) - 1;
      const copied = await fetchImpl(`${target}?partNumber=${number}&${upload}`, {
        method: "PUT",
        headers: {
          "x-amz-copy-source": source,
          "x-amz-copy-source-range": `bytes=${start}-${end}`,
        },
      });
      const copiedBody = await copied.text();
      if (!copied.ok || copiedBody.includes("<Error>")) {
        throw new Error(
          `storage multipart copy part ${number} failed: ${copyFailure(copied, copiedBody)}`,
        );
      }
      // The ETag is S3's, XML-escaped in the part's answer and read back into
      // the completion as it was answered, so the entity the server sent is the
      // entity the server gets. A part with no ETag cannot be named in the
      // completion, and a completion without it cannot be finished: naming
      // that beats completing an upload of nothing.
      const etag = tagValue(copiedBody, "ETag");
      if (etag === "" || !copiedBody.includes("<CopyPartResult")) {
        throw new Error(
          `storage multipart copy part ${number} came back without a CopyPartResult ETag; the copy cannot be completed`,
        );
      }
      parts.push(`<Part><PartNumber>${number}</PartNumber><ETag>${etag}</ETag></Part>`);
    }
    const completed = await fetchImpl(`${target}?${upload}`, {
      method: "POST",
      headers: { "content-type": "application/xml" },
      body: `<CompleteMultipartUpload>${parts.join("")}</CompleteMultipartUpload>`,
    });
    const completedBody = await completed.text();
    if (!completed.ok || completedBody.includes("<Error>")) {
      throw new Error(
        `storage multipart copy could not be completed: ${copyFailure(completed, completedBody)}`,
      );
    }
    if (!completedBody.includes("<CompleteMultipartUploadResult")) {
      throw new Error(
        "storage multipart copy did not answer with a CompleteMultipartUploadResult; the object may not be whole",
      );
    }
  } catch (error) {
    // The parts uploaded so far are still stored and billed until the upload is
    // aborted, so the abort is part of failing the copy. A failed abort is
    // logged and the copy's own error is what the caller is told — the copy
    // failed either way, and the upload id is in the line so it can be aborted
    // by hand.
    const aborted = await fetchImpl(`${target}?${upload}`, { method: "DELETE" }).catch(
      (abortError) => {
        console.error?.(
          `storage multipart copy abort failed for ${to} (${upload}): ${abortError instanceof Error ? abortError.message : String(abortError)}`,
        );
        return null;
      },
    );
    if (aborted !== null && !aborted.ok) {
      console.error?.(
        `storage multipart copy abort for ${to} (${upload}) answered ${aborted.status}; the uploaded parts are still billed`,
      );
    }
    throw error;
  }
}

/**
 * The one place a copy-shaped S3 answer becomes a sentence: a status that is
 * not 2xx, an `<Error>` body, or neither a result nor an error (the copy that
 * has not happened yet). `null` is the only answer that means the call did what
 * it was asked.
 * @param {Response} response
 * @param {string} body
 * @returns {string|null}
 */
function copyFailure(response, body) {
  const code = tagValue(body, "Code");
  if (!response.ok) {
    return `the storage answered ${response.status}${code === "" ? "" : ` with ${code}`}`;
  }
  if (code !== "") {
    return `the storage refused the copy: ${code}`;
  }
  return "the storage answered neither a result nor an error";
}

/**
 * A source object's byte length, from the one call S3 answers it with. A size
 * that cannot be read is a named failure, not a zero: a multipart copy with no
 * ranges would upload no parts and report a copy that never moved a byte.
 * @param {(input: URL | RequestInfo, init?: RequestInit) => Promise<Response>} fetchImpl
 * @param {(path: string) => string} urlFor
 * @param {string} from
 * @returns {Promise<number>}
 */
async function sourceSize(fetchImpl, urlFor, from) {
  const response = await fetchImpl(urlFor(from), { method: "HEAD" });
  const length = Number(response.headers.get("content-length") || 0);
  if (!response.ok || !(length > 0)) {
    throw new Error(
      `storage copy could not read the size of ${from} (HEAD answered ${response.status}), so the copy over the single-copy limit cannot be made`,
    );
  }
  return length;
}
